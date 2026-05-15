/**
 * BM_Reconcile_RL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Restlet
 *
 * Bank Match – RESTlet (kept for backward compatibility and API access).
 *
 * Primary auto-match triggering is done server-side in BM_Main_SL.js via the
 * "Run Auto-Match" button. This RESTlet provides the same capability via HTTP
 * GET for programmatic / external integrations and applies the SAME matching
 * stack as the Suitelet:
 *   1. Admin reconciliation rules (BM_RulesEngine) — skip / auto-approve /
 *      create-pending against the configured suspense account.
 *   2. Waterfall engine (BM_MatchEngine.runWaterfallMatch) — Tier 1 / 2a / 2b
 *      / 3 / 4 / 4b for everything no rule matched.
 *
 * ─── Endpoints ───────────────────────────────────────────────────────────────
 *   GET  action=status  [account=<glAccountId>]
 *        → { ok, pendingCount, appliedToday, settingsOk, canRun, message }
 *
 *   GET  action=propose_all  [account=<glAccountId>]  [limit=<n>]  [offset=<n>]
 *        → Paginated. Processes one page of unmatched bank lines.
 *          Returns {
 *            ok, processed, created, skipped,
 *            skippedReasons: { existing_proposal, no_candidate_over_threshold,
 *                              settings_missing, creation_error },
 *            nextOffset, done, pendingCount, message
 *          }
 *
 * ─── Idempotency ─────────────────────────────────────────────────────────────
 * Before creating a proposal, searches for an existing non-rejected proposal
 * with the same idempotency key. Repeated calls are safe.
 *
 * ─── Governance / batching ───────────────────────────────────────────────────
 * limit default=100, max=200. Caller loops until done=true.
 */
define([
    'N/record',
    'N/search',
    'N/log',
    './BM_Constants',
    './BM_MatchEngine',
    './BM_BankLineReader',
    './BM_RulesEngine'
], function (record, search, log, C, engine, reader, rulesEngine) {
    'use strict';

    var SF = C.SETTINGS_FIELDS;
    var PF = C.PROPOSAL_FIELDS;
    var PS = C.PROPOSAL_STATUS;
    var TT = C.TXN_TYPE;
    var AS = C.APPLY_STATUS;
    var SR = C.SKIP_REASON;

    // ── Load settings ─────────────────────────────────────────────────────
    // Returns the full settings shape used by the waterfall and rules engines.
    function _getSettings() {
        var rows = search.create({
            type:    C.RECORDS.SETTINGS,
            filters: [['isinactive', 'is', 'F']],
            columns: Object.values(SF)
        }).run().getRange({ start: 0, end: 1 });

        if (!rows || !rows.length) return null;
        var r = rows[0];
        return {
            id:              r.id,
            bankAccount:     r.getValue(SF.BANK_ACCOUNT),
            subsidiary:      r.getValue(SF.SUBSIDIARY),
            toleranceAmt:    parseFloat(r.getValue(SF.TOLERANCE_AMT))    || 0.01,
            toleranceDays:   parseInt(r.getValue(SF.TOLERANCE_DAYS), 10) || 5,
            approver:        r.getValue(SF.APPROVER),
            feeAccount:      r.getValue(SF.FEE_ACCOUNT)      || '',
            suspenseAccount: r.getValue(SF.SUSPENSE_ACCOUNT) || ''
        };
    }

    // ── Count pending proposals ───────────────────────────────────────────
    function _countPending() {
        var count = 0;
        search.create({
            type:    C.RECORDS.PROPOSAL,
            filters: [
                ['isinactive', 'is', 'F'], 'AND',
                [PF.STATUS, 'anyof', [PS.PENDING]]
            ],
            columns: ['internalid']
        }).run().each(function () { count++; return count < 500; });
        return count;
    }

    // ── Count applied today ───────────────────────────────────────────────
    function _countAppliedToday() {
        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var count = 0;
        search.create({
            type:    C.RECORDS.PROPOSAL,
            filters: [
                ['isinactive', 'is', 'F'], 'AND',
                [PF.STATUS,       'anyof',    [PS.APPLIED]], 'AND',
                [PF.APPLIED_DATE, 'onOrAfter', today]
            ],
            columns: ['internalid']
        }).run().each(function () { count++; return count < 500; });
        return count;
    }

    // ── Idempotency key ───────────────────────────────────────────────────
    function _idempotencyKey(line) {
        if (line.id && String(line.id).trim()) {
            return 'lid:' + String(line.id).trim();
        }
        var ref = C.normalizeTxnId(line.reference || '');
        var amt = parseFloat(line.amount) || 0;
        return 'fallback:' + (line.date || '') + '|' + amt + '|' + ref;
    }

    // ── Check for existing active proposal ────────────────────────────────
    function _proposalExists(key) {
        if (!key) return false;
        var found = false;
        search.create({
            type:    C.RECORDS.PROPOSAL,
            filters: [
                ['isinactive', 'is', 'F'], 'AND',
                [PF.IDEMPOTENCY_KEY, 'is', key], 'AND',
                [PF.STATUS, 'noneof', [PS.REJECTED, PS.FAILED]]
            ],
            columns: ['internalid']
        }).run().each(function () { found = true; return false; });
        return found;
    }

    // ── Create proposal from a waterfall match result ─────────────────────
    function _createProposalFromMatch(line, matchResult, settings, idempKey, bankAccountId) {
        var cand     = matchResult.candidate;
        var isCredit = parseFloat(line.amount) > 0;
        var txnType  = isCredit ? TT.CUSTOMER_PAYMENT : TT.VENDOR_PAYMENT;
        var nsType   = isCredit ? 'invoice'           : 'vendorbill';

        var propRec = record.create({ type: C.RECORDS.PROPOSAL });
        propRec.setValue({ fieldId: PF.TXN_TYPE,        value: txnType });
        propRec.setValue({ fieldId: PF.NS_RECORD_TYPE,  value: nsType });
        propRec.setValue({ fieldId: PF.NS_RECORD_ID,    value: parseInt(cand.nsId, 10) });
        propRec.setValue({ fieldId: PF.NS_RECORD_REF,   value: cand.reference || '' });
        propRec.setValue({ fieldId: PF.MATCH_AMOUNT,    value: cand.amount });
        propRec.setValue({ fieldId: PF.MATCH_DATE,      value: cand.date ? new Date(cand.date) : null });
        propRec.setValue({ fieldId: PF.STATUS,          value: PS.PENDING });
        propRec.setValue({ fieldId: PF.NOTES,
            value: matchResult.matchReason + ' (score ' + matchResult.score + ')' });
        propRec.setValue({ fieldId: PF.BANK_AMOUNT,     value: line.amount });
        propRec.setValue({ fieldId: PF.BANK_DATE,       value: line.date ? new Date(line.date) : null });
        propRec.setValue({ fieldId: PF.BANK_REF,        value: line.reference || '' });
        propRec.setValue({ fieldId: PF.IDEMPOTENCY_KEY, value: idempKey || '' });
        propRec.setValue({ fieldId: PF.APPLY_STATUS,    value: AS.PENDING });
        propRec.setValue({ fieldId: PF.HAS_VARIANCE,
            value: matchResult.hasVariance ? 'T' : 'F' });
        propRec.setValue({ fieldId: PF.VARIANCE_AMT,
            value: matchResult.varianceAmt || 0 });

        if (bankAccountId) {
            try { propRec.setValue({ fieldId: PF.BANK_ACCT, value: bankAccountId }); } catch (e) { /* optional */ }
        }
        try {
            propRec.setValue({ fieldId: PF.BANK_LINE_ID, value: String(line.id) });
        } catch (e) { /* optional field */ }

        if (settings && settings.approver) {
            propRec.setValue({ fieldId: PF.APPROVER, value: settings.approver });
        }

        return propRec.save();
    }

    // ── Create JE-type proposal from a fired admin rule ───────────────────
    function _createRuleProposal(line, ruleHit, settings, idempKey, bankAccountId) {
        if (!settings.suspenseAccount) {
            throw new Error(
                'Rule "' + ruleHit.rule.name + '" matched but no Suspense Account ' +
                'is configured in Bank Match Settings — cannot auto-create a JE proposal.'
            );
        }
        var propRec = record.create({ type: C.RECORDS.PROPOSAL });
        propRec.setValue({ fieldId: PF.TXN_TYPE,        value: TT.JOURNAL_ENTRY });
        propRec.setValue({ fieldId: PF.NS_RECORD_TYPE,  value: 'account' });
        propRec.setValue({ fieldId: PF.NS_RECORD_ID,    value: parseInt(settings.suspenseAccount, 10) });
        propRec.setValue({ fieldId: PF.NS_RECORD_REF,
            value: 'Suspense (rule: ' + ruleHit.rule.name + ')' });
        propRec.setValue({ fieldId: PF.MATCH_AMOUNT,    value: Math.abs(parseFloat(line.amount) || 0) });
        propRec.setValue({ fieldId: PF.MATCH_DATE,      value: line.date ? new Date(line.date) : null });
        propRec.setValue({ fieldId: PF.STATUS,
            value: ruleHit.action === 'auto_approve' ? PS.APPROVED : PS.PENDING });
        propRec.setValue({ fieldId: PF.NOTES,
            value: 'Rule "' + ruleHit.rule.name + '" matched (priority ' +
                   ruleHit.rule.priority + ') → ' + ruleHit.action });
        propRec.setValue({ fieldId: PF.BANK_AMOUNT,     value: line.amount });
        propRec.setValue({ fieldId: PF.BANK_DATE,       value: line.date ? new Date(line.date) : null });
        propRec.setValue({ fieldId: PF.BANK_REF,        value: line.reference || '' });
        propRec.setValue({ fieldId: PF.IDEMPOTENCY_KEY, value: idempKey || '' });
        propRec.setValue({ fieldId: PF.APPLY_STATUS,    value: AS.PENDING });
        propRec.setValue({ fieldId: PF.HAS_VARIANCE,    value: 'F' });
        propRec.setValue({ fieldId: PF.VARIANCE_AMT,    value: 0 });

        if (bankAccountId) {
            try { propRec.setValue({ fieldId: PF.BANK_ACCT, value: bankAccountId }); } catch (e) { /* optional */ }
        }
        try {
            propRec.setValue({ fieldId: PF.BANK_LINE_ID, value: String(line.id) });
        } catch (e) { /* optional field */ }

        if (settings && settings.approver) {
            propRec.setValue({ fieldId: PF.APPROVER, value: settings.approver });
        }

        return propRec.save();
    }

    // ── GET handler ───────────────────────────────────────────────────────
    function doGet(params) {
        var action    = params.action  || 'status';
        var accountId = params.account || null;
        var settings  = _getSettings();

        // ── status ────────────────────────────────────────────────────────
        if (action === 'status') {
            var settingsOk = !!settings;
            return JSON.stringify({
                ok:           true,
                pendingCount: _countPending(),
                appliedToday: _countAppliedToday(),
                settingsOk:   settingsOk,
                canRun:       settingsOk,
                message:      settingsOk ? '' :
                    'Bank Match is not configured. Open Settings first.'
            });
        }

        // ── propose_all ───────────────────────────────────────────────────
        if (action === 'propose_all') {
            if (!settings) {
                return JSON.stringify({
                    ok:             false,
                    error:          'Bank Match is not configured. Open Settings first.',
                    skippedReasons: { [SR.SETTINGS_MISSING]: 1 }
                });
            }

            var limit  = Math.min(parseInt(params.limit,  10) || 100, 200);
            var offset = Math.max(parseInt(params.offset, 10) || 0,   0);

            var effectiveAccount = accountId || settings.bankAccount;
            var lineData  = reader.getUnmatchedLines(effectiveAccount);
            var allLines  = lineData.lines;
            var total     = allLines.length;
            var page      = allLines.slice(offset, offset + limit);

            // Load admin-defined rules once per request
            var rules = rulesEngine.load(settings);

            var created        = 0;
            var ruleHits       = 0;
            var autoApproved   = 0;
            var skipped        = 0;
            var skippedReasons = {};

            function _addSkip(reason) {
                skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
                skipped++;
            }

            page.forEach(function (line) {
                var key = _idempotencyKey(line);

                if (_proposalExists(key)) {
                    _addSkip(SR.EXISTING_PROPOSAL);
                    return;
                }

                // Step 1 — admin rules win over the waterfall engine
                if (rules.count > 0) {
                    var hit = rules.evaluate(line);
                    if (hit) {
                        if (hit.action === 'skip') {
                            _addSkip(SR.NO_CANDIDATE);
                            return;
                        }
                        if (hit.action === 'auto_approve' || hit.action === 'create_pending') {
                            try {
                                _createRuleProposal(line, hit, settings, key, effectiveAccount);
                                created++;
                                ruleHits++;
                                if (hit.action === 'auto_approve') autoApproved++;
                                return;
                            } catch (ruleErr) {
                                log.error('BM_Reconcile_RL.propose_all',
                                    'Rule "' + hit.rule.name + '" failed on line ' + line.id +
                                    ': ' + ruleErr.message);
                                // Fall through to waterfall match
                            }
                        }
                    }
                }

                // Step 2 — waterfall match (Tiers 1 / 2a / 2b / 3 / 4 / 4b)
                var matchResult = engine.runWaterfallMatch(line, settings);
                if (!matchResult) {
                    _addSkip(SR.NO_CANDIDATE);
                    return;
                }

                try {
                    _createProposalFromMatch(line, matchResult, settings, key, effectiveAccount);
                    created++;
                } catch (e) {
                    log.error('BM_Reconcile_RL.propose_all',
                        'Line ' + line.id + ': ' + e.message);
                    _addSkip(SR.CREATION_ERROR);
                }
            });

            var nextOffset = offset + limit;
            var done       = nextOffset >= total;

            log.audit('BM_Reconcile_RL',
                'propose_all offset=' + offset + ' limit=' + limit +
                ' created=' + created + ' (rules ' + ruleHits + ', auto-approved ' +
                autoApproved + ') skipped=' + skipped + ' done=' + done);

            return JSON.stringify({
                ok:             true,
                processed:      page.length,
                created:        created,
                ruleHits:       ruleHits,
                autoApproved:   autoApproved,
                skipped:        skipped,
                skippedReasons: skippedReasons,
                nextOffset:     done ? null : nextOffset,
                done:           done,
                pendingCount:   _countPending(),
                message:        created + ' proposal(s) created' +
                                (ruleHits ? ' (' + ruleHits + ' by rules)' : '') +
                                ', ' + skipped + ' skipped.'
            });
        }

        return JSON.stringify({ ok: false, error: 'Unknown action: ' + action });
    }

    return { get: doGet };
});
