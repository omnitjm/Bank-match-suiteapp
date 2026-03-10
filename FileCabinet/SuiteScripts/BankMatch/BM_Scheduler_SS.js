/**
 * BM_Scheduler_SS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ScheduledScript
 *
 * Bank Match – Scheduled Auto-Match
 *
 * Runs the waterfall matching engine for all unmatched bank lines linked to
 * the configured bank account, creating pending proposals automatically.
 *
 * ── Scheduling ────────────────────────────────────────────────────────────
 * Default schedule: daily at 10:00 AM.
 * To change the time:
 *   Customization → Scripting → Scripts → BM Scheduler → Deployments
 *   Click the deployment and adjust the schedule.
 *
 * ── Manual trigger ────────────────────────────────────────────────────────
 * The "Run Auto-Match" button on the Bank Match Central dashboard triggers
 * the same matching logic immediately, without waiting for the schedule.
 *
 * ── What it does ──────────────────────────────────────────────────────────
 * 1. Loads Bank Match Settings (bank account, tolerances, approver).
 * 2. Reads all unmatched bank lines via BankLineReader (native or custom).
 * 3. For each line, runs engine.runWaterfallMatch().
 * 4. Creates a customrecord_bm_proposal record for each new match found.
 *    Existing proposals (idempotency key match) are skipped.
 * 5. Logs a summary audit entry.
 *
 * Proposals created here are in status PENDING — the approver still reviews
 * and approves them in the Bank Match Central dashboard before any NS
 * transactions are created.
 */
define([
    'N/record',
    'N/search',
    'N/log',
    'N/runtime',
    './BM_Constants',
    './BM_MatchEngine',
    './BM_BankLineReader'
], function (record, search, log, runtime, C, engine, reader) {
    'use strict';

    var SF = C.SETTINGS_FIELDS;
    var PF = C.PROPOSAL_FIELDS;
    var PS = C.PROPOSAL_STATUS;
    var AS = C.APPLY_STATUS;
    var TT = C.TXN_TYPE;

    // ── Load settings ────────────────────────────────────────────────────

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
            toleranceAmt:    parseFloat(r.getValue(SF.TOLERANCE_AMT))   || 50,
            toleranceDays:   parseInt(r.getValue(SF.TOLERANCE_DAYS), 10) || 5,
            approver:        r.getValue(SF.APPROVER),
            feeAccount:      r.getValue(SF.FEE_ACCOUNT)      || '',
            suspenseAccount: r.getValue(SF.SUSPENSE_ACCOUNT) || '',
            defaultDept:     r.getValue(SF.DEFAULT_DEPT)     || '',
            defaultClass:    r.getValue(SF.DEFAULT_CLASS)    || '',
            defaultLocation: r.getValue(SF.DEFAULT_LOCATION) || ''
        };
    }

    // ── Idempotency helpers ───────────────────────────────────────────────

    function _idempotencyKey(line) {
        if (line.id && String(line.id).trim()) {
            return 'lid:' + String(line.id).trim();
        }
        var ref = C.normalizeTxnId(line.reference || '');
        var amt = parseFloat(line.amount) || 0;
        return 'fallback:' + (line.date || '') + '|' + amt + '|' + ref;
    }

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

    // ── Create a proposal record ──────────────────────────────────────────

    function _createProposal(line, matchResult, settings, key) {
        var cand     = matchResult.candidate;
        var isCredit = parseFloat(line.amount) > 0;
        var txnType  = isCredit ? TT.CUSTOMER_PAYMENT : TT.VENDOR_PAYMENT;
        var nsType   = isCredit ? 'invoice'           : 'vendorbill';

        var propRec = record.create({ type: C.RECORDS.PROPOSAL, isDynamic: true });
        propRec.setValue({ fieldId: PF.TXN_TYPE,        value: txnType });
        propRec.setValue({ fieldId: PF.NS_RECORD_TYPE,  value: nsType });
        propRec.setValue({ fieldId: PF.NS_RECORD_ID,    value: parseInt(cand.nsId, 10) });
        propRec.setValue({ fieldId: PF.NS_RECORD_REF,   value: cand.reference || '' });
        propRec.setValue({ fieldId: PF.MATCH_AMOUNT,    value: cand.amount });
        propRec.setValue({ fieldId: PF.MATCH_DATE,
            value: cand.date ? new Date(cand.date) : null });
        propRec.setValue({ fieldId: PF.STATUS,          value: PS.PENDING });
        propRec.setValue({ fieldId: PF.NOTES,
            value: matchResult.matchReason + ' (score ' + matchResult.score + ') [scheduler]' });
        propRec.setValue({ fieldId: PF.BANK_AMOUNT,     value: line.amount });
        propRec.setValue({ fieldId: PF.BANK_DATE,
            value: line.date ? new Date(line.date) : null });
        propRec.setValue({ fieldId: PF.BANK_REF,        value: line.reference || '' });
        propRec.setValue({ fieldId: PF.IDEMPOTENCY_KEY, value: key || '' });
        propRec.setValue({ fieldId: PF.APPLY_STATUS,    value: AS.PENDING });
        propRec.setValue({ fieldId: PF.HAS_VARIANCE,    value: !!matchResult.hasVariance });
        propRec.setValue({ fieldId: PF.VARIANCE_AMT,    value: matchResult.varianceAmt || 0 });

        if (settings && settings.bankAccount) {
            try { propRec.setValue({ fieldId: PF.BANK_ACCT, value: settings.bankAccount }); } catch (e) { /* optional */ }
        }
        try {
            propRec.setValue({ fieldId: PF.BANK_LINE_ID, value: String(line.id) });
        } catch (e) { /* optional field */ }

        if (settings && settings.approver) {
            propRec.setValue({ fieldId: PF.APPROVER, value: settings.approver });
        }

        return propRec.save();
    }

    // ── Main execute function ─────────────────────────────────────────────

    function execute(context) {
        log.audit('BM_Scheduler_SS', 'Scheduled auto-match started');

        var settings = _getSettings();
        if (!settings) {
            log.error('BM_Scheduler_SS', 'No Bank Match settings found — skipping run.');
            return;
        }
        if (!settings.bankAccount) {
            log.error('BM_Scheduler_SS', 'No bank account configured in settings — skipping run.');
            return;
        }

        // Read unmatched bank lines
        var lineData = reader.getUnmatchedLines(settings.bankAccount);
        var lines    = lineData.lines;
        log.audit('BM_Scheduler_SS',
            lines.length + ' unmatched line(s) found via source: ' + lineData.source);

        var created  = 0;
        var skipped  = 0;
        var errors   = 0;
        var reasons  = {};

        lines.forEach(function (line) {
            // Governance: check remaining usage
            var remaining = runtime.getCurrentScript().getRemainingUsage();
            if (remaining < 500) {
                log.audit('BM_Scheduler_SS',
                    'Governance limit approaching (' + remaining + ' units left) — stopping early.');
                return;
            }

            var key = _idempotencyKey(line);

            // Skip if a valid proposal already exists for this line
            if (_proposalExists(key)) {
                skipped++;
                reasons.existing_proposal = (reasons.existing_proposal || 0) + 1;
                return;
            }

            // Run waterfall match
            var matchResult = null;
            try {
                matchResult = engine.runWaterfallMatch(line, settings);
            } catch (matchErr) {
                log.error('BM_Scheduler_SS', 'Match error for line ' + (line.reference || line.id) + ': ' + matchErr.message);
                errors++;
                reasons.match_error = (reasons.match_error || 0) + 1;
                return;
            }

            if (!matchResult) {
                skipped++;
                reasons.no_candidate = (reasons.no_candidate || 0) + 1;
                return;
            }

            // Create proposal
            try {
                _createProposal(line, matchResult, settings, key);
                created++;
            } catch (createErr) {
                log.error('BM_Scheduler_SS', 'Could not create proposal for line ' + (line.reference || line.id) + ': ' + createErr.message);
                errors++;
                reasons.creation_error = (reasons.creation_error || 0) + 1;
            }
        });

        log.audit('BM_Scheduler_SS', [
            'Scheduled auto-match complete.',
            'Lines: ' + lines.length,
            'Created: ' + created,
            'Skipped: ' + skipped,
            'Errors: ' + errors,
            'Reasons: ' + JSON.stringify(reasons)
        ].join(' | '));
    }

    return { execute: execute };
});
