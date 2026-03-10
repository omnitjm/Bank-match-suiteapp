/**
 * BM_Reconcile_RL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Restlet
 *
 * Bank Match – RESTlet (kept for backward compatibility and API access).
 *
 * Primary auto-match triggering is now done server-side in BM_Main_SL.js
 * via the "Run Auto-Match" button. This RESTlet provides the same capability
 * via HTTP GET for programmatic / external integrations.
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
    './BM_BankLineReader'
], function (record, search, log, C, engine, reader) {
    'use strict';

    var SF = C.SETTINGS_FIELDS;
    var PF = C.PROPOSAL_FIELDS;
    var PS = C.PROPOSAL_STATUS;
    var TT = C.TXN_TYPE;
    var SR = C.SKIP_REASON;

    // ── Load settings for a bank account ───────────────────────────────────
    function _getSettings(bankAccountId) {
        var filters = [['isinactive', 'is', 'F']];
        if (bankAccountId) {
            filters.push('AND');
            filters.push([SF.BANK_ACCOUNT, 'anyof', String(bankAccountId)]);
        }
        var rows = search.create({
            type:    C.RECORDS.SETTINGS,
            filters: filters,
            columns: Object.values(SF)
        }).run().getRange({ start: 0, end: 1 });

        if (!rows || !rows.length) return null;
        var r = rows[0];
        return {
            id:          r.id,
            bankAccount: r.getValue(SF.BANK_ACCOUNT),
            subsidiary:  r.getValue(SF.SUBSIDIARY),
            tolAmt:      parseFloat(r.getValue(SF.TOLERANCE_AMT))   || 0.01,
            tolDays:     parseInt(r.getValue(SF.TOLERANCE_DAYS), 10) || 5,
            approver:    r.getValue(SF.APPROVER)
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

    // ── Create one proposal record ────────────────────────────────────────
    function _createProposal(line, cand, settings, idempKey) {
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
            value: 'Auto-proposed (score ' + cand.score + ')' });
        propRec.setValue({ fieldId: PF.BANK_AMOUNT,     value: line.amount });
        propRec.setValue({ fieldId: PF.BANK_DATE,       value: line.date ? new Date(line.date) : null });
        propRec.setValue({ fieldId: PF.BANK_REF,        value: line.reference || '' });
        propRec.setValue({ fieldId: PF.IDEMPOTENCY_KEY, value: idempKey || '' });
        propRec.setValue({ fieldId: PF.APPLY_STATUS,    value: C.APPLY_STATUS.PENDING });

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
        var settings  = _getSettings(accountId);

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

            var created        = 0;
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

                var isCredit   = parseFloat(line.amount) > 0;
                var candidates = isCredit
                    ? engine.findInvoiceMatches(line, settings)
                    : engine.findVendorBillMatches(line, settings);

                if (!candidates.length || candidates[0].score < 40) {
                    _addSkip(SR.NO_CANDIDATE);
                    return;
                }

                try {
                    _createProposal(line, candidates[0], settings, key);
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
                ' created=' + created + ' skipped=' + skipped + ' done=' + done);

            return JSON.stringify({
                ok:             true,
                processed:      page.length,
                created:        created,
                skipped:        skipped,
                skippedReasons: skippedReasons,
                nextOffset:     done ? null : nextOffset,
                done:           done,
                pendingCount:   _countPending(),
                message:        created + ' proposal(s) created, ' + skipped + ' skipped.'
            });
        }

        return JSON.stringify({ ok: false, error: 'Unknown action: ' + action });
    }

    return { get: doGet };
});
