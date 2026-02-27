/**
 * BM_Reconcile_RL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Restlet
 *
 * Bank Match – RESTlet called by the native Match Bank Data page button.
 *
 * This RESTlet is the bridge between the native NetSuite "Match Bank Data"
 * page and our approval-gated reconciliation engine.  It is invoked via
 * AJAX from the client script we inject into the native banking page.
 *
 * ─── Endpoints ───────────────────────────────────────────────────────────────
 *   GET  action=propose_all  account=<glAccountId>
 *        → Read all unmatched bank lines for the account,
 *          run the scoring engine, create Pending Approval proposals.
 *          Returns { proposed, skipped, pendingCount }
 *
 *   GET  action=status  account=<glAccountId>
 *        → Returns { pendingCount, appliedToday } – used to update
 *          the badge on the injected button.
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

    // ── Load settings ─────────────────────────────────────────────────────
    function _getSettings() {
        var rows = search.create({
            type: C.RECORDS.SETTINGS,
            filters: [['isinactive', 'is', 'F']],
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
            type: C.RECORDS.PROPOSAL,
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
            type: C.RECORDS.PROPOSAL,
            filters: [
                ['isinactive', 'is', 'F'], 'AND',
                [PF.STATUS, 'anyof', [PS.APPLIED]], 'AND',
                [PF.APPLIED_DATE, 'onOrAfter', today]
            ],
            columns: ['internalid']
        }).run().each(function () { count++; return count < 500; });
        return count;
    }

    // ── Create one proposal record ────────────────────────────────────────
    function _createProposal(line, cand, settings) {
        var isCredit = parseFloat(line.amount) > 0;
        var txnType  = isCredit ? TT.CUSTOMER_PAYMENT : TT.BILL_PAYMENT;
        var nsType   = isCredit ? 'invoice'           : 'vendorpayment';

        var propRec = record.create({ type: C.RECORDS.PROPOSAL });
        propRec.setValue({ fieldId: PF.TXN_TYPE,       value: txnType });
        propRec.setValue({ fieldId: PF.NS_RECORD_TYPE, value: nsType });
        propRec.setValue({ fieldId: PF.NS_RECORD_ID,   value: parseInt(cand.nsId, 10) });
        propRec.setValue({ fieldId: PF.NS_RECORD_REF,  value: cand.reference || '' });
        propRec.setValue({ fieldId: PF.MATCH_AMOUNT,   value: cand.amount });
        propRec.setValue({ fieldId: PF.MATCH_DATE,     value: cand.date ? new Date(cand.date) : null });
        propRec.setValue({ fieldId: PF.STATUS,         value: PS.PENDING });
        propRec.setValue({ fieldId: PF.ADJUST_DATE,    value: false });
        propRec.setValue({ fieldId: PF.NOTES,          value: 'Auto-proposed from Match Bank Data (score ' + cand.score + ')' });
        propRec.setValue({ fieldId: PF.BANK_AMOUNT,    value: line.amount });
        propRec.setValue({ fieldId: PF.BANK_DATE,      value: line.date ? new Date(line.date) : null });
        propRec.setValue({ fieldId: PF.BANK_REF,       value: line.reference || '' });

        // Store the native bank line ID for reference
        try { propRec.setValue({ fieldId: PF.BANK_LINE_ID, value: String(line.id) }); }
        catch (e) { /* field may not exist yet */ }

        if (settings && settings.approver) {
            propRec.setValue({ fieldId: PF.APPROVER, value: settings.approver });
        }

        return propRec.save();
    }

    // ── GET handler ───────────────────────────────────────────────────────
    function doGet(params) {
        var action    = params.action    || 'status';
        var accountId = params.account   || null;
        var settings  = _getSettings();

        // ── status ────────────────────────────────────────────────────────
        if (action === 'status') {
            return JSON.stringify({
                ok:            true,
                pendingCount:  _countPending(),
                appliedToday:  _countAppliedToday(),
                settingsOk:    !!settings
            });
        }

        // ── propose_all ───────────────────────────────────────────────────
        if (action === 'propose_all') {
            if (!settings) {
                return JSON.stringify({ ok: false, error: 'Bank Match is not configured. Open Settings first.' });
            }

            var effectiveAccount = accountId || settings.bankAccount;
            var lineData  = reader.getUnmatchedLines(effectiveAccount);
            var lines     = lineData.lines;
            var proposed  = 0;
            var skipped   = 0;

            lines.forEach(function (line) {
                var isCredit   = parseFloat(line.amount) > 0;
                var candidates = isCredit
                    ? engine.findInvoiceMatches(line, settings)
                    : engine.findBillPaymentMatches(line, settings);

                // Only propose if best candidate has a meaningful score (≥ 40)
                if (!candidates.length || candidates[0].score < 40) {
                    skipped++;
                    return;
                }

                try {
                    _createProposal(line, candidates[0], settings);
                    proposed++;
                } catch (e) {
                    log.error('BM_Reconcile_RL.propose_all', 'Line ' + line.id + ': ' + e.message);
                    skipped++;
                }
            });

            log.audit('BM_Reconcile_RL', 'propose_all complete: ' + proposed + ' proposed, ' + skipped + ' skipped');

            return JSON.stringify({
                ok:           true,
                proposed:     proposed,
                skipped:      skipped,
                pendingCount: _countPending(),
                message:      proposed + ' proposal(s) created and sent for approval. ' +
                              skipped  + ' line(s) skipped (no confident match).'
            });
        }

        return JSON.stringify({ ok: false, error: 'Unknown action: ' + action });
    }

    return { get: doGet };
});
