/**
 * BM_Main_SL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Suitelet
 *
 * Bank Match – Reconciliation Automation Dashboard
 *
 * ─── Positioning (Phase 2) ───────────────────────────────────────────────────
 * Bank Match starts at Phase 2.  Bank statement data is already in NetSuite,
 * imported via the native "Match Bank Data" module.
 *
 * Our buttons appear directly on the native Match Bank Data page (injected by
 * BM_NativePage_CS.js).  This Suitelet is the supporting dashboard opened
 * from those buttons for:
 *   • Reviewing and approving pending proposals
 *   • Proposing a match manually for one specific bank line
 *   • Viewing reconciliation history
 *   • Quick link to settings
 *
 * ─── Routes ──────────────────────────────────────────────────────────────────
 *   (none)           GET  → Dashboard (pending approvals + history)
 *   match            GET  → Match-selection page for one bank line
 *   create_proposal  GET/POST → Create a proposal and redirect
 */
define([
    'N/ui/serverWidget',
    'N/record',
    'N/search',
    'N/url',
    'N/log',
    './BM_Constants',
    './BM_MatchEngine',
    './BM_BankLineReader',
    './BM_NativeBridge'
], function (ui, record, search, url, log, C, engine, reader, bridge) {
    'use strict';

    var SF = C.SETTINGS_FIELDS;
    var PF = C.PROPOSAL_FIELDS;
    var PS = C.PROPOSAL_STATUS;
    var TT = C.TXN_TYPE;

    var TYPE_LABELS = { '1': 'Customer Payment', '2': 'Bill Payment' };
    var PROP_LABELS = {
        '1': 'Pending Approval', '2': 'Approved',
        '3': 'Rejected',         '4': 'Applied',  '5': 'Failed'
    };

    // ── Settings ──────────────────────────────────────────────────────────
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
            approver:    r.getValue(SF.APPROVER),
            notifyEmail: r.getValue(SF.NOTIFY_EMAIL),
            autoSuggest: r.getValue(SF.AUTO_SUGGEST) === 'T'
        };
    }

    // ── Proposals search ──────────────────────────────────────────────────
    function _getProposals(statusFilter) {
        var filters = [['isinactive', 'is', 'F']];
        if (statusFilter && statusFilter.length) {
            filters.push('AND');
            filters.push([PF.STATUS, 'anyof', statusFilter]);
        }
        var results = [];
        search.create({
            type: C.RECORDS.PROPOSAL,
            filters: filters,
            columns: [
                'internalid', 'created',
                PF.TXN_TYPE, PF.NS_RECORD_REF,
                PF.BANK_DATE, PF.BANK_AMOUNT, PF.BANK_REF,
                PF.MATCH_AMOUNT, PF.STATUS, PF.ADJUST_DATE,
                PF.APPLIED_DATE, PF.ERROR_MSG
            ]
        }).run().each(function (row) {
            results.push({
                id:          row.id,
                created:     row.getValue('created'),
                txnType:     row.getValue(PF.TXN_TYPE),
                nsRef:       row.getValue(PF.NS_RECORD_REF),
                bankDate:    row.getValue(PF.BANK_DATE),
                bankAmount:  row.getValue(PF.BANK_AMOUNT),
                bankRef:     row.getValue(PF.BANK_REF),
                matchAmount: row.getValue(PF.MATCH_AMOUNT),
                status:      row.getValue(PF.STATUS),
                adjustDate:  row.getValue(PF.ADJUST_DATE),
                appliedDate: row.getValue(PF.APPLIED_DATE),
                errorMsg:    row.getValue(PF.ERROR_MSG)
            });
            return results.length < 200;
        });
        return results;
    }

    // ── URL helper ────────────────────────────────────────────────────────
    function _slUrl(params) {
        return url.resolveScript({
            scriptId:     C.SCRIPTS.MAIN_SL,
            deploymentId: C.SCRIPTS.MAIN_DEPLOY,
            params:       params,
            returnExternalUrl: false
        });
    }

    function _redirect(context, flash) {
        context.response.sendRedirect({
            type:       'SUITELET',
            identifier: C.SCRIPTS.MAIN_SL,
            id:         C.SCRIPTS.MAIN_DEPLOY,
            parameters: { flash: encodeURIComponent(flash || '') }
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Main dashboard
    // ════════════════════════════════════════════════════════════════════════
    function _renderDashboard(context, settings, flash) {
        var form = ui.createForm({ title: 'Bank Match – Reconciliation Automation' });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';

        // ─ Header buttons ─────────────────────────────────────────────────
        form.addButton({ id: 'btn_native', label: '↗ Open Match Bank Data', functionName: 'goNative' });
        form.addButton({ id: 'btn_setup',  label: '⚙ Settings',             functionName: 'goSetup' });

        // ─ Phase 2 info banner ────────────────────────────────────────────
        var inf = form.addField({ id: 'custpage_info', type: ui.FieldType.INLINEHTML, label: ' ' });
        inf.defaultValue = [
            '<div style="background:#e3f2fd;border-left:4px solid #1565c0;',
            'padding:10px 16px;border-radius:4px;margin-bottom:10px;font-size:12px;line-height:1.8;">',
            '<strong>Bank Match adds automation on top of NetSuite\'s native Match Bank Data module.</strong><br>',
            '&#x2460; Import bank data via <em>Transactions &rsaquo; Bank &rsaquo; Match Bank Data</em> as normal.<br>',
            '&#x2461; Use the <strong>&#9889; Auto-Reconcile</strong> button we inject there to propose matches.<br>',
            '&#x2462; Proposals appear below. Approver reviews and approves each one.<br>',
            '&#x2463; On approval, the Customer Payment or Bill Payment is applied in NetSuite automatically.<br>',
            '&#x2464; Return to <em>Match Bank Data</em> — your applied transactions are ready to match and submit.',
            '</div>'
        ].join('');

        if (flash) {
            var fld = form.addField({ id: 'custpage_flash', type: ui.FieldType.INLINEHTML, label: ' ' });
            fld.defaultValue = '<div style="background:#e8f5e9;border:1px solid #a5d6a7;padding:8px 14px;' +
                'border-radius:4px;margin-bottom:8px;">&#10003;&nbsp;' + flash + '</div>';
        }

        // ─ Tab: Pending Approvals ─────────────────────────────────────────
        form.addTab({ id: 'tab_pending', label: 'Pending Approvals' });

        var pending = _getProposals([PS.PENDING]);
        var sbPend  = form.addSublist({
            id:   'sl_pending',
            type: ui.SublistType.LIST,
            label: 'Proposals awaiting approval — ' + pending.length + ' pending',
            tab:  'tab_pending'
        });

        sbPend.addField({ id: 'pp_type',    type: ui.FieldType.TEXT,     label: 'Type' });
        sbPend.addField({ id: 'pp_date',    type: ui.FieldType.DATE,     label: 'Bank Date' });
        sbPend.addField({ id: 'pp_amount',  type: ui.FieldType.CURRENCY, label: 'Bank Amount' });
        sbPend.addField({ id: 'pp_ref',     type: ui.FieldType.TEXT,     label: 'Bank Ref' });
        sbPend.addField({ id: 'pp_ns',      type: ui.FieldType.TEXT,     label: 'NS Transaction' });
        sbPend.addField({ id: 'pp_adjdate', type: ui.FieldType.TEXT,     label: 'Adjust Date?' });
        sbPend.addField({ id: 'pp_open',    type: ui.FieldType.URL,      label: 'Approve / Reject' })
              .linkText = 'Open Proposal';

        pending.forEach(function (p, i) {
            sbPend.setSublistValue({ id: 'pp_type',    line: i, value: TYPE_LABELS[p.txnType] || '—' });
            sbPend.setSublistValue({ id: 'pp_date',    line: i, value: p.bankDate   || '' });
            sbPend.setSublistValue({ id: 'pp_amount',  line: i, value: p.bankAmount || 0 });
            sbPend.setSublistValue({ id: 'pp_ref',     line: i, value: p.bankRef    || '—' });
            sbPend.setSublistValue({ id: 'pp_ns',      line: i, value: p.nsRef      || '—' });
            sbPend.setSublistValue({ id: 'pp_adjdate', line: i,
                value: (p.adjustDate === 'T' || p.adjustDate === true) ? 'Yes' : '—' });
            sbPend.setSublistValue({ id: 'pp_open', line: i,
                value: '/app/common/custom/custrecordentry.nl?rectype=' +
                       encodeURIComponent(C.RECORDS.PROPOSAL) + '&id=' + p.id });
        });

        // ─ Tab: History ───────────────────────────────────────────────────
        form.addTab({ id: 'tab_history', label: 'History' });
        var history = _getProposals([PS.APPLIED, PS.REJECTED, PS.FAILED]);
        var sbHist  = form.addSublist({
            id:   'sl_history',
            type: ui.SublistType.LIST,
            label: 'Applied & rejected — ' + history.length + ' total',
            tab:  'tab_history'
        });
        sbHist.addField({ id: 'hh_type',    type: ui.FieldType.TEXT,     label: 'Type' });
        sbHist.addField({ id: 'hh_result',  type: ui.FieldType.TEXT,     label: 'Result' });
        sbHist.addField({ id: 'hh_date',    type: ui.FieldType.DATE,     label: 'Bank Date' });
        sbHist.addField({ id: 'hh_amount',  type: ui.FieldType.CURRENCY, label: 'Bank Amount' });
        sbHist.addField({ id: 'hh_ns',      type: ui.FieldType.TEXT,     label: 'NS Transaction' });
        sbHist.addField({ id: 'hh_applied', type: ui.FieldType.DATE,     label: 'Applied On' });
        sbHist.addField({ id: 'hh_error',   type: ui.FieldType.TEXT,     label: 'Error' });

        history.forEach(function (p, i) {
            sbHist.setSublistValue({ id: 'hh_type',    line: i, value: TYPE_LABELS[p.txnType] || '—' });
            sbHist.setSublistValue({ id: 'hh_result',  line: i, value: PROP_LABELS[p.status]  || p.status });
            sbHist.setSublistValue({ id: 'hh_date',    line: i, value: p.bankDate    || '' });
            sbHist.setSublistValue({ id: 'hh_amount',  line: i, value: p.bankAmount  || 0 });
            sbHist.setSublistValue({ id: 'hh_ns',      line: i, value: p.nsRef       || '—' });
            sbHist.setSublistValue({ id: 'hh_applied', line: i, value: p.appliedDate || '' });
            sbHist.setSublistValue({ id: 'hh_error',   line: i, value: p.errorMsg    || '' });
        });

        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Match selection (manual propose for one bank line)
    // ════════════════════════════════════════════════════════════════════════
    function _renderMatchPage(context, settings, params) {
        var bankLine = {
            id:          params.bankline  || '',
            date:        params.bl_date   || '',
            amount:      parseFloat(params.bl_amt || 0),
            reference:   params.bl_ref    || '',
            description: params.bl_desc   || ''
        };
        var isCredit  = bankLine.amount > 0;
        var matchType = isCredit ? 'Customer Payment → Invoice' : 'Bill Payment (Vendor)';

        var form = ui.createForm({
            title: 'Propose Match — ' + (bankLine.reference || bankLine.description || 'Bank Line')
        });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';
        form.addButton({ id: 'btn_back', label: '← Back', functionName: 'goBack' });

        // ─ Bank line summary ──────────────────────────────────────────────
        form.addFieldGroup({ id: 'grp_bl', label: 'Bank Line (from Match Bank Data)' });
        var blHtml = form.addField({ id: 'custpage_bl_html',
            type: ui.FieldType.INLINEHTML, label: ' ', container: 'grp_bl' });
        blHtml.defaultValue = [
            '<table style="font-size:13px;line-height:2;width:100%;">',
            '<tr><td style="width:130px;font-weight:600;color:#555;">Date</td>',
            '<td><strong>' + (bankLine.date || '—') + '</strong></td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Description</td>',
            '<td>' + (bankLine.description || '—') + '</td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Amount</td>',
            '<td><strong style="font-size:15px;color:' + (isCredit ? '#2e7d32' : '#c62828') + ';">',
            (isCredit ? '+' : '') + bankLine.amount.toFixed(2) + '</strong></td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Reference</td>',
            '<td>' + (bankLine.reference || '—') + '</td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Type</td>',
            '<td><span style="background:#e3f2fd;color:#1565c0;padding:2px 8px;border-radius:3px;font-size:12px;">',
            matchType + '</span></td></tr>',
            '</table>'
        ].join('');

        // ─ Scored candidates ──────────────────────────────────────────────
        var candidates = isCredit
            ? engine.findInvoiceMatches(bankLine, settings)
            : engine.findBillPaymentMatches(bankLine, settings);

        var sb = form.addSublist({
            id:   'sl_cand',
            type: ui.SublistType.LIST,
            label: (candidates.length || 'No') + ' suggested match(es) — click Select to propose'
        });
        sb.addField({ id: 'c_score',  type: ui.FieldType.INTEGER,  label: 'Score' });
        sb.addField({ id: 'c_ref',    type: ui.FieldType.TEXT,     label: isCredit ? 'Invoice #' : 'Payment #' });
        sb.addField({ id: 'c_entity', type: ui.FieldType.TEXT,     label: isCredit ? 'Customer' : 'Vendor' });
        sb.addField({ id: 'c_date',   type: ui.FieldType.DATE,     label: 'NS Date' });
        sb.addField({ id: 'c_amount', type: ui.FieldType.CURRENCY, label: 'NS Amount' });
        sb.addField({ id: 'c_select', type: ui.FieldType.URL,      label: 'Action' }).linkText = 'Select';

        candidates.forEach(function (cand, i) {
            sb.setSublistValue({ id: 'c_score',  line: i, value: cand.score });
            sb.setSublistValue({ id: 'c_ref',    line: i, value: cand.reference || '—' });
            sb.setSublistValue({ id: 'c_entity', line: i, value: cand.entity    || '—' });
            sb.setSublistValue({ id: 'c_date',   line: i, value: cand.date });
            sb.setSublistValue({ id: 'c_amount', line: i, value: cand.amount });
            sb.setSublistValue({ id: 'c_select', line: i, value: _slUrl({
                action:     'create_proposal',
                bankline:   bankLine.id,
                bl_date:    bankLine.date,
                bl_amt:     bankLine.amount,
                bl_ref:     bankLine.reference,
                ns_id:      cand.nsId,
                ns_type:    cand.nsType,
                ns_ref:     cand.reference,
                txn_type:   isCredit ? TT.CUSTOMER_PAYMENT : TT.BILL_PAYMENT,
                match_amt:  cand.amount,
                match_date: cand.date
            }) });
        });

        // ─ Manual entry ───────────────────────────────────────────────────
        form.addFieldGroup({ id: 'grp_manual', label: 'Manual Proposal' });

        form.addField({ id: 'custpage_m_ns_id', type: ui.FieldType.INTEGER,
            label: isCredit ? 'Invoice Internal ID' : 'Vendor Payment Internal ID',
            container: 'grp_manual' });
        form.addField({ id: 'custpage_m_ns_ref', type: ui.FieldType.TEXT,
            label: 'NS Transaction #', container: 'grp_manual' });

        if (!isCredit) {
            form.addField({ id: 'custpage_adj_date', type: ui.FieldType.CHECKBOX,
                label: 'Adjust Vendor Payment date in NetSuite to match bank date (' + bankLine.date + ')',
                container: 'grp_manual' })
            .helpText = 'On approval, the Vendor Payment\'s date will be updated to the bank line date.';
        }

        form.addField({ id: 'custpage_notes', type: ui.FieldType.TEXTAREA,
            label: 'Notes', container: 'grp_manual' });

        var hidden = {
            custpage_h_bankline: bankLine.id,
            custpage_h_bl_date:  bankLine.date,
            custpage_h_bl_amt:   bankLine.amount,
            custpage_h_bl_ref:   bankLine.reference,
            custpage_h_txn_type: isCredit ? TT.CUSTOMER_PAYMENT : TT.BILL_PAYMENT,
            custpage_action:     'create_proposal'
        };
        Object.keys(hidden).forEach(function (fid) {
            var f = form.addField({ id: fid, type: ui.FieldType.TEXT, label: fid });
            f.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
            f.defaultValue = String(hidden[fid]);
        });

        form.addSubmitButton({ label: 'Submit Proposal for Approval' });
        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  POST/GET: Create proposal
    // ════════════════════════════════════════════════════════════════════════
    function _handleCreateProposal(context, settings) {
        var p = context.request.parameters;

        var bankLineId = p.bankline   || p.custpage_h_bankline || '';
        var bankDate   = p.bl_date    || p.custpage_h_bl_date  || '';
        var bankAmount = parseFloat(p.bl_amt  || p.custpage_h_bl_amt  || 0);
        var bankRef    = p.bl_ref     || p.custpage_h_bl_ref   || '';
        var txnType    = p.txn_type   || p.custpage_h_txn_type || TT.CUSTOMER_PAYMENT;
        var nsId       = parseInt(p.ns_id || p.custpage_m_ns_id || 0, 10);
        var nsType     = p.ns_type || (String(txnType) === String(TT.CUSTOMER_PAYMENT) ? 'invoice' : 'vendorpayment');
        var nsRef      = p.ns_ref     || p.custpage_m_ns_ref   || '';
        var matchAmt   = parseFloat(p.match_amt  || 0) || bankAmount;
        var matchDate  = p.match_date || bankDate;
        var adjustDate = p.custpage_adj_date === 'T';
        var notes      = p.custpage_notes || '';

        if (!nsId) {
            _redirect(context, 'Please enter a valid NetSuite record ID.');
            return;
        }

        try {
            var propRec = record.create({ type: C.RECORDS.PROPOSAL });
            propRec.setValue({ fieldId: PF.TXN_TYPE,       value: txnType });
            propRec.setValue({ fieldId: PF.NS_RECORD_TYPE, value: nsType });
            propRec.setValue({ fieldId: PF.NS_RECORD_ID,   value: nsId });
            propRec.setValue({ fieldId: PF.NS_RECORD_REF,  value: nsRef });
            propRec.setValue({ fieldId: PF.MATCH_AMOUNT,   value: matchAmt });
            propRec.setValue({ fieldId: PF.MATCH_DATE,     value: matchDate ? new Date(matchDate) : null });
            propRec.setValue({ fieldId: PF.STATUS,         value: PS.PENDING });
            propRec.setValue({ fieldId: PF.ADJUST_DATE,    value: adjustDate });
            propRec.setValue({ fieldId: PF.NOTES,          value: notes });
            propRec.setValue({ fieldId: PF.BANK_AMOUNT,    value: bankAmount });
            propRec.setValue({ fieldId: PF.BANK_DATE,      value: bankDate ? new Date(bankDate) : null });
            propRec.setValue({ fieldId: PF.BANK_REF,       value: bankRef });
            try { propRec.setValue({ fieldId: PF.BANK_LINE_ID, value: String(bankLineId) }); }
            catch (e) { /* optional field */ }
            if (settings && settings.approver) propRec.setValue({ fieldId: PF.APPROVER, value: settings.approver });

            var propId = propRec.save();

            // Notify approver
            var notifyEmail = (settings && settings.notifyEmail) || '';
            if (!notifyEmail && settings && settings.approver) {
                try {
                    var emp = record.load({ type: record.Type.EMPLOYEE, id: settings.approver });
                    notifyEmail = emp.getValue('email');
                } catch (e) { /* ignore */ }
            }
            if (notifyEmail) {
                engine.notifyApprover({
                    approverEmail: notifyEmail,
                    proposalId:    propId,
                    bankRef:       bankRef || '—',
                    bankAmt:       bankAmount,
                    bankDate:      bankDate,
                    nsRef:         nsRef   || '—',
                    type:          TYPE_LABELS[String(txnType)] || txnType
                });
            }

            log.audit('BM_Main_SL', 'Proposal ' + propId + ' created');
            _redirect(context, 'Proposal submitted for approval. ' +
                'After approval, return to Match Bank Data to complete the reconciliation.');
        } catch (e) {
            log.error('BM_Main_SL._handleCreateProposal', e.message);
            _redirect(context, 'Error: ' + e.message);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Entry point
    // ════════════════════════════════════════════════════════════════════════
    function onRequest(context) {
        var req      = context.request;
        var action   = req.parameters.action || '';
        var settings = _getSettings();

        if (!settings) {
            context.response.sendRedirect({
                type: 'SUITELET', identifier: C.SCRIPTS.SETUP_SL, id: C.SCRIPTS.SETUP_DEPLOY
            });
            return;
        }

        if (req.method === 'POST' || action === 'create_proposal') {
            _handleCreateProposal(context, settings);
            return;
        }

        if (action === 'match') {
            _renderMatchPage(context, settings, req.parameters);
            return;
        }

        var flash = req.parameters.flash ? decodeURIComponent(req.parameters.flash) : null;
        _renderDashboard(context, settings, flash);
    }

    return { onRequest: onRequest };
});
