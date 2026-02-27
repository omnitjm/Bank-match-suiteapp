/**
 * BM_Main_SL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Suitelet
 *
 * Bank Match – Main Reconciliation Dashboard
 *
 * Routes (via ?action=...):
 *   (none)           GET  → Dashboard with tabs: Bank Transactions | Import | Pending | History
 *   match            GET  → Match-selection page for one bank transaction
 *   import_csv       POST → Parse CSV and create bank transaction records
 *   create_proposal  POST → Create a match proposal (always Pending Approval)
 *   exclude          POST → Mark a bank transaction as Excluded
 */
define([
    'N/ui/serverWidget',
    'N/ui/message',
    'N/record',
    'N/search',
    'N/file',
    'N/url',
    'N/email',
    'N/runtime',
    'N/log',
    './BM_Constants',
    './BM_MatchEngine'
], function (ui, uiMsg, record, search, file, url, email, runtime, log, C, engine) {
    'use strict';

    var SF  = C.SETTINGS_FIELDS;
    var BTF = C.BANK_TXN_FIELDS;
    var PF  = C.PROPOSAL_FIELDS;
    var PS  = C.PROPOSAL_STATUS;
    var TS  = C.TXN_STATUS;
    var TT  = C.TXN_TYPE;

    // ── Settings helper ───────────────────────────────────────────────────
    function _getSettings() {
        var rows = search.create({
            type: C.RECORDS.SETTINGS,
            filters: [['isinactive', 'is', 'F']],
            columns: Object.values(SF)
        }).run().getRange({ start: 0, end: 1 });

        if (!rows || rows.length === 0) return null;
        var row = rows[0];
        return {
            id:          row.id,
            bankAccount: row.getValue(SF.BANK_ACCOUNT),
            subsidiary:  row.getValue(SF.SUBSIDIARY),
            tolAmt:      parseFloat(row.getValue(SF.TOLERANCE_AMT))  || 0.01,
            tolDays:     parseInt(row.getValue(SF.TOLERANCE_DAYS), 10) || 5,
            approver:    row.getValue(SF.APPROVER),
            notifyEmail: row.getValue(SF.NOTIFY_EMAIL),
            autoSuggest: row.getValue(SF.AUTO_SUGGEST) === 'T'
        };
    }

    // ── Bank transactions search ──────────────────────────────────────────
    function _getBankTxns(statusFilter) {
        var filters = [['isinactive', 'is', 'F']];
        if (statusFilter) {
            filters.push('AND');
            filters.push([BTF.STATUS, 'anyof', statusFilter]);
        }
        var results = [];
        search.create({
            type: C.RECORDS.BANK_TXN,
            filters: filters,
            columns: [
                'internalid', 'name',
                BTF.TXN_DATE, BTF.DESCRIPTION, BTF.AMOUNT,
                BTF.REFERENCE, BTF.CURRENCY, BTF.STATUS
            ]
        }).run().each(function (row) {
            results.push({
                id:          row.id,
                date:        row.getValue(BTF.TXN_DATE),
                description: row.getValue(BTF.DESCRIPTION),
                amount:      row.getValue(BTF.AMOUNT),
                reference:   row.getValue(BTF.REFERENCE),
                currency:    row.getValue(BTF.CURRENCY),
                status:      row.getValue(BTF.STATUS)
            });
            return results.length < 200;
        });
        return results;
    }

    // ── Proposals search ──────────────────────────────────────────────────
    function _getProposals(statusFilter) {
        var filters = [['isinactive', 'is', 'F']];
        if (statusFilter) {
            filters.push('AND');
            filters.push([PF.STATUS, 'anyof', statusFilter]);
        }
        var results = [];
        search.create({
            type: C.RECORDS.PROPOSAL,
            filters: filters,
            columns: [
                'internalid', 'name', 'created',
                PF.TXN_TYPE, PF.NS_RECORD_REF,
                PF.BANK_DATE, PF.BANK_AMOUNT, PF.BANK_REF,
                PF.MATCH_DATE, PF.MATCH_AMOUNT,
                PF.STATUS, PF.ADJUST_DATE, PF.APPLIED_DATE, PF.ERROR_MSG
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
                matchDate:   row.getValue(PF.MATCH_DATE),
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

    // ── Status label helpers ──────────────────────────────────────────────
    var STATUS_LABELS = { '1': 'Unmatched', '2': 'Proposed', '3': 'Reconciled', '4': 'Excluded' };
    var PROP_LABELS   = { '1': 'Pending Approval', '2': 'Approved', '3': 'Rejected', '4': 'Applied', '5': 'Failed' };
    var TYPE_LABELS   = { '1': 'Customer Payment', '2': 'Bill Payment' };

    function _statusBadge(code, labelMap) {
        var colors = {
            '1': '#e8920c', // orange – pending / unmatched
            '2': '#1b7bb4', // blue   – proposed / approved
            '3': '#2e7d32', // green  – reconciled
            '4': '#5a5a5a', // grey   – excluded / applied
            '5': '#c62828'  // red    – failed
        };
        var bg  = colors[String(code)] || '#999';
        var lbl = labelMap[String(code)] || code;
        return '<span style="background:' + bg + ';color:#fff;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;">' + lbl + '</span>';
    }

    // ── CSV parser ────────────────────────────────────────────────────────
    // Expected columns (case-insensitive): Date, Description, Amount, Reference
    function _parseCsv(content) {
        var lines = content.split(/\r?\n/);
        if (lines.length < 2) return [];

        var headers = lines[0].split(',').map(function (h) { return h.replace(/"/g, '').trim().toLowerCase(); });
        var idxDate = headers.indexOf('date');
        var idxDesc = headers.indexOf('description');
        var idxAmt  = headers.indexOf('amount');
        var idxRef  = headers.indexOf('reference');

        if (idxDate < 0 || idxAmt < 0) return null; // bad format

        var rows = [];
        for (var i = 1; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            // Simple CSV split (handles basic quoted fields)
            var cells = [];
            var inQ = false, cur = '';
            for (var c = 0; c < line.length; c++) {
                var ch = line[c];
                if (ch === '"') { inQ = !inQ; }
                else if (ch === ',' && !inQ) { cells.push(cur.trim()); cur = ''; }
                else { cur += ch; }
            }
            cells.push(cur.trim());

            var amt = parseFloat(String(cells[idxAmt] || '').replace(/[^0-9.\-]/g, ''));
            if (isNaN(amt)) continue;

            rows.push({
                date:        cells[idxDate] || '',
                description: idxDesc >= 0 ? cells[idxDesc] || '' : '',
                amount:      amt,
                reference:   idxRef  >= 0 ? cells[idxRef]  || '' : ''
            });
        }
        return rows;
    }

    // ── Suitelet URL helper ───────────────────────────────────────────────
    function _slUrl(params) {
        return url.resolveScript({
            scriptId:     C.SCRIPTS.MAIN_SL,
            deploymentId: C.SCRIPTS.MAIN_DEPLOY,
            params:       params,
            returnExternalUrl: false
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Dashboard
    // ════════════════════════════════════════════════════════════════════════
    function _renderDashboard(context, settings, flashMsg) {
        var form = ui.createForm({ title: 'Bank Match – Reconciliation' });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';

        // ─ Action buttons ─────────────────────────────────────────────────
        form.addButton({ id: 'btn_import',  label: '⬆ Import Bank Statement', functionName: 'goImport' });
        form.addButton({ id: 'btn_setup',   label: '⚙ Settings',              functionName: 'goSetup' });

        // ─ Optional flash banner ──────────────────────────────────────────
        if (flashMsg) {
            var bannerFld = form.addField({ id: 'custpage_banner', type: ui.FieldType.INLINEHTML, label: ' ' });
            bannerFld.defaultValue =
                '<div style="background:#e8f5e9;border:1px solid #a5d6a7;padding:10px 16px;border-radius:4px;margin-bottom:8px;">' +
                '&#10003;&nbsp;' + flashMsg + '</div>';
        }

        // ─ Tab: Unmatched Bank Transactions ──────────────────────────────
        var tabUnmatched = form.addTab({ id: 'tab_unmatched', label: 'Bank Transactions' });

        var sbUnmatched = form.addSublist({
            id:        'sl_bank',
            type:      ui.SublistType.LIST,
            label:     'Unmatched / Proposed Bank Lines',
            tab:       'tab_unmatched'
        });

        sbUnmatched.addField({ id: 'col_date',   type: ui.FieldType.DATE,      label: 'Date' });
        sbUnmatched.addField({ id: 'col_desc',   type: ui.FieldType.TEXT,      label: 'Description' });
        sbUnmatched.addField({ id: 'col_amount', type: ui.FieldType.CURRENCY,  label: 'Amount' });
        sbUnmatched.addField({ id: 'col_ref',    type: ui.FieldType.TEXT,      label: 'Reference' });
        sbUnmatched.addField({ id: 'col_status', type: ui.FieldType.TEXT,      label: 'Status' });
        sbUnmatched.addField({ id: 'col_action', type: ui.FieldType.URL,       label: 'Action' })
                   .linkText = 'Propose Match';

        var txns = _getBankTxns([TS.UNMATCHED, TS.PROPOSED]);
        txns.forEach(function (txn, i) {
            sbUnmatched.setSublistValue({ id: 'col_date',   line: i, value: txn.date });
            sbUnmatched.setSublistValue({ id: 'col_desc',   line: i, value: txn.description || '—' });
            sbUnmatched.setSublistValue({ id: 'col_amount', line: i, value: txn.amount });
            sbUnmatched.setSublistValue({ id: 'col_ref',    line: i, value: txn.reference  || '—' });
            sbUnmatched.setSublistValue({ id: 'col_status', line: i, value: STATUS_LABELS[String(txn.status)] || txn.status });
            sbUnmatched.setSublistValue({ id: 'col_action', line: i,
                value: _slUrl({ action: 'match', banktxn: txn.id }) });
        });

        // ─ Tab: Pending Approvals ─────────────────────────────────────────
        var tabPending = form.addTab({ id: 'tab_pending', label: 'Pending Approvals' });

        var sbPending = form.addSublist({
            id:   'sl_pending',
            type: ui.SublistType.LIST,
            label: 'Proposals Awaiting Approval',
            tab:  'tab_pending'
        });

        sbPending.addField({ id: 'pp_type',    type: ui.FieldType.TEXT,    label: 'Type' });
        sbPending.addField({ id: 'pp_bankdate', type: ui.FieldType.DATE,    label: 'Bank Date' });
        sbPending.addField({ id: 'pp_bankamt',  type: ui.FieldType.CURRENCY, label: 'Bank Amount' });
        sbPending.addField({ id: 'pp_bankref',  type: ui.FieldType.TEXT,    label: 'Bank Ref' });
        sbPending.addField({ id: 'pp_nsref',    type: ui.FieldType.TEXT,    label: 'NS Transaction' });
        sbPending.addField({ id: 'pp_adjdate',  type: ui.FieldType.TEXT,    label: 'Adjust Date' });
        sbPending.addField({ id: 'pp_link',     type: ui.FieldType.URL,     label: 'Open Proposal' })
                 .linkText = 'Review';

        var pending = _getProposals([PS.PENDING]);
        pending.forEach(function (p, i) {
            sbPending.setSublistValue({ id: 'pp_type',    line: i, value: TYPE_LABELS[p.txnType] || p.txnType });
            sbPending.setSublistValue({ id: 'pp_bankdate', line: i, value: p.bankDate });
            sbPending.setSublistValue({ id: 'pp_bankamt',  line: i, value: p.bankAmount });
            sbPending.setSublistValue({ id: 'pp_bankref',  line: i, value: p.bankRef || '—' });
            sbPending.setSublistValue({ id: 'pp_nsref',    line: i, value: p.nsRef   || '—' });
            sbPending.setSublistValue({ id: 'pp_adjdate',  line: i,
                value: (p.adjustDate === 'T' || p.adjustDate === true) ? 'Yes' : 'No' });
            sbPending.setSublistValue({ id: 'pp_link', line: i,
                value: '/app/common/custom/custrecordentry.nl?rectype=' +
                       encodeURIComponent(C.RECORDS.PROPOSAL) + '&id=' + p.id });
        });

        // ─ Tab: History ───────────────────────────────────────────────────
        var tabHistory = form.addTab({ id: 'tab_history', label: 'History' });

        var sbHistory = form.addSublist({
            id:   'sl_history',
            type: ui.SublistType.LIST,
            label: 'Applied & Rejected Proposals',
            tab:  'tab_history'
        });

        sbHistory.addField({ id: 'hh_type',     type: ui.FieldType.TEXT,    label: 'Type' });
        sbHistory.addField({ id: 'hh_status',   type: ui.FieldType.TEXT,    label: 'Result' });
        sbHistory.addField({ id: 'hh_bankdate', type: ui.FieldType.DATE,    label: 'Bank Date' });
        sbHistory.addField({ id: 'hh_bankamt',  type: ui.FieldType.CURRENCY, label: 'Bank Amount' });
        sbHistory.addField({ id: 'hh_bankref',  type: ui.FieldType.TEXT,    label: 'Bank Ref' });
        sbHistory.addField({ id: 'hh_nsref',    type: ui.FieldType.TEXT,    label: 'NS Transaction' });
        sbHistory.addField({ id: 'hh_applied',  type: ui.FieldType.DATE,    label: 'Applied Date' });
        sbHistory.addField({ id: 'hh_error',    type: ui.FieldType.TEXT,    label: 'Error' });

        var history = _getProposals([PS.APPLIED, PS.REJECTED, PS.FAILED]);
        history.forEach(function (p, i) {
            sbHistory.setSublistValue({ id: 'hh_type',     line: i, value: TYPE_LABELS[p.txnType] || p.txnType });
            sbHistory.setSublistValue({ id: 'hh_status',   line: i, value: PROP_LABELS[p.status]  || p.status });
            sbHistory.setSublistValue({ id: 'hh_bankdate', line: i, value: p.bankDate });
            sbHistory.setSublistValue({ id: 'hh_bankamt',  line: i, value: p.bankAmount });
            sbHistory.setSublistValue({ id: 'hh_bankref',  line: i, value: p.bankRef   || '—' });
            sbHistory.setSublistValue({ id: 'hh_nsref',    line: i, value: p.nsRef     || '—' });
            sbHistory.setSublistValue({ id: 'hh_applied',  line: i, value: p.appliedDate || '' });
            sbHistory.setSublistValue({ id: 'hh_error',    line: i, value: p.errorMsg  || '' });
        });

        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Import CSV
    // ════════════════════════════════════════════════════════════════════════
    function _renderImportPage(context, settings) {
        var form = ui.createForm({ title: 'Bank Match – Import Bank Statement' });

        form.addButton({ id: 'btn_back', label: '← Back to Dashboard',
            functionName: 'history.back' });

        var grp = form.addFieldGroup({ id: 'grp_import', label: 'CSV File Import' });

        // Instructions
        var instr = form.addField({ id: 'custpage_instr', type: ui.FieldType.INLINEHTML,
            label: ' ', container: 'grp_import' });
        instr.defaultValue =
            '<div style="background:#f5f8ff;border:1px solid #c5cee0;padding:12px 16px;border-radius:4px;margin-bottom:12px;">' +
            '<strong>CSV Format Required:</strong><br>' +
            '<code style="font-size:12px;">Date, Description, Amount, Reference</code><br><br>' +
            '<ul style="margin:4px 0 0 16px;font-size:12px;">' +
            '<li><strong>Date</strong> – transaction date (YYYY-MM-DD or MM/DD/YYYY)</li>' +
            '<li><strong>Description</strong> – bank narrative</li>' +
            '<li><strong>Amount</strong> – positive = credit (money in), negative = debit (money out)</li>' +
            '<li><strong>Reference</strong> – bank reference number (optional but improves matching)</li>' +
            '</ul></div>';

        form.addField({ id: 'custpage_file', type: ui.FieldType.FILE,
            label: 'Bank Statement CSV', container: 'grp_import' }).isMandatory = true;

        // Bank account override
        var fldAcct = form.addField({ id: 'custpage_bank_acct', type: ui.FieldType.SELECT,
            label: 'Bank Account', source: 'account', container: 'grp_import' });
        if (settings && settings.bankAccount) fldAcct.defaultValue = settings.bankAccount;

        form.addSubmitButton({ label: 'Import & Auto-suggest Matches' });
        form.addField({ id: 'custpage_action', type: ui.FieldType.TEXT, label: ' ' })
            .updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN })
            .defaultValue = 'import_csv';

        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Match selection
    // ════════════════════════════════════════════════════════════════════════
    function _renderMatchPage(context, settings, bankTxnId) {
        // Load bank transaction
        var bankTxnRec = record.load({ type: C.RECORDS.BANK_TXN, id: bankTxnId });
        var bankTxn = {
            id:          bankTxnId,
            date:        bankTxnRec.getValue(BTF.TXN_DATE),
            description: bankTxnRec.getValue(BTF.DESCRIPTION),
            amount:      parseFloat(bankTxnRec.getValue(BTF.AMOUNT)),
            reference:   bankTxnRec.getValue(BTF.REFERENCE),
            currency:    bankTxnRec.getValue(BTF.CURRENCY)
        };

        var isCredit = bankTxn.amount > 0; // credit = money received = customer payment
        var form = ui.createForm({
            title: 'Propose Match – Bank Line: ' + (bankTxn.reference || bankTxn.description)
        });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';

        form.addButton({ id: 'btn_back', label: '← Back to Dashboard',
            functionName: 'goBack' });

        // ─ Bank transaction summary ───────────────────────────────────────
        var grpBank = form.addFieldGroup({ id: 'grp_bank_summary', label: 'Bank Transaction' });

        var sumFld = form.addField({ id: 'custpage_bank_summary', type: ui.FieldType.INLINEHTML,
            label: ' ', container: 'grp_bank_summary' });
        sumFld.defaultValue =
            '<table style="font-size:13px;line-height:1.8;width:100%;">' +
            '<tr><td style="width:130px;color:#555;">Date</td><td><strong>' + bankTxn.date + '</strong></td></tr>' +
            '<tr><td style="color:#555;">Description</td><td>' + (bankTxn.description || '—') + '</td></tr>' +
            '<tr><td style="color:#555;">Amount</td><td><strong style="color:' + (isCredit ? '#2e7d32' : '#c62828') + ';">' +
            (isCredit ? '+' : '') + bankTxn.amount.toFixed(2) + ' ' + (bankTxn.currency || '') + '</strong></td></tr>' +
            '<tr><td style="color:#555;">Reference</td><td>' + (bankTxn.reference || '—') + '</td></tr>' +
            '</table>';

        // ─ Match type header ──────────────────────────────────────────────
        var matchType = isCredit ? 'Customer Payment → Invoice' : 'Bill Payment';
        var matchTypeFld = form.addField({ id: 'custpage_match_type', type: ui.FieldType.INLINEHTML, label: ' ' });
        matchTypeFld.defaultValue =
            '<div style="margin:8px 0;padding:8px 14px;background:#e3f2fd;border-left:4px solid #1565c0;border-radius:2px;font-size:13px;">' +
            '<strong>Match type:</strong> ' + matchType +
            (isCredit
                ? ' &nbsp;|&nbsp; Select the open Sales Invoice to apply this payment to.'
                : ' &nbsp;|&nbsp; Select the Vendor Payment record. You can optionally adjust its date to match the bank.') +
            '</div>';

        // ─ Find candidates ────────────────────────────────────────────────
        var candidates = isCredit
            ? engine.findInvoiceMatches(bankTxn, settings || { tolAmt: 0.01, tolDays: 5 })
            : engine.findBillPaymentMatches(bankTxn, settings || { tolAmt: 0.01, tolDays: 5 });

        // ─ Candidate sublist ──────────────────────────────────────────────
        var grpCand = form.addFieldGroup({ id: 'grp_candidates', label: 'Suggested Matches (click Select to propose)' });

        var sb = form.addSublist({
            id:   'sl_candidates',
            type: ui.SublistType.LIST,
            label: candidates.length + ' candidate(s) found'
        });

        sb.addField({ id: 'c_score',  type: ui.FieldType.INTEGER, label: 'Score' });
        sb.addField({ id: 'c_ref',    type: ui.FieldType.TEXT,    label: isCredit ? 'Invoice #' : 'Payment #' });
        sb.addField({ id: 'c_entity', type: ui.FieldType.TEXT,    label: isCredit ? 'Customer'  : 'Vendor' });
        sb.addField({ id: 'c_date',   type: ui.FieldType.DATE,    label: 'NS Date' });
        sb.addField({ id: 'c_amount', type: ui.FieldType.CURRENCY, label: 'Amount' });
        sb.addField({ id: 'c_action', type: ui.FieldType.URL,     label: 'Action' })
          .linkText = 'Select';

        candidates.forEach(function (cand, i) {
            var propParams = {
                action:     'create_proposal',
                banktxn:    bankTxnId,
                ns_id:      cand.nsId,
                ns_type:    cand.nsType,
                ns_ref:     cand.reference,
                txn_type:   isCredit ? TT.CUSTOMER_PAYMENT : TT.BILL_PAYMENT,
                match_amt:  cand.amount,
                match_date: cand.date
            };
            sb.setSublistValue({ id: 'c_score',  line: i, value: cand.score });
            sb.setSublistValue({ id: 'c_ref',    line: i, value: cand.reference || '—' });
            sb.setSublistValue({ id: 'c_entity', line: i, value: cand.entity    || '—' });
            sb.setSublistValue({ id: 'c_date',   line: i, value: cand.date });
            sb.setSublistValue({ id: 'c_amount', line: i, value: cand.amount });
            sb.setSublistValue({ id: 'c_action', line: i, value: _slUrl(propParams) });
        });

        if (candidates.length === 0) {
            var noMatch = form.addField({ id: 'custpage_nomatch', type: ui.FieldType.INLINEHTML, label: ' ' });
            noMatch.defaultValue =
                '<div style="padding:12px;color:#777;font-style:italic;">No automatic matches found within tolerance. ' +
                'You can still create a manual proposal using the form below.</div>';
        }

        // ─ Manual proposal form ───────────────────────────────────────────
        var grpManual = form.addFieldGroup({ id: 'grp_manual', label: 'Manual Proposal' });

        form.addField({ id: 'custpage_ns_id_manual', type: ui.FieldType.INTEGER,
            label: isCredit ? 'Invoice Internal ID' : 'Vendor Payment Internal ID',
            container: 'grp_manual' }).helpText = 'Enter the NetSuite internal ID if not listed above.';

        form.addField({ id: 'custpage_ns_ref_manual', type: ui.FieldType.TEXT,
            label: 'NS Transaction #', container: 'grp_manual' });

        if (!isCredit) {
            form.addField({ id: 'custpage_adj_date', type: ui.FieldType.CHECKBOX,
                label: 'Adjust Payment Date in NetSuite to Bank Date', container: 'grp_manual' })
                .helpText = 'When checked, the Vendor Payment\'s date will be updated to ' + bankTxn.date + '.';
        }

        form.addField({ id: 'custpage_notes', type: ui.FieldType.TEXTAREA,
            label: 'Notes', container: 'grp_manual' });

        // Hidden fields
        ['banktxn', 'bank_date', 'bank_amount', 'bank_ref', 'txn_type_default', 'action_manual'].forEach(function (id) {
            var fld = form.addField({ id: 'custpage_' + id, type: ui.FieldType.TEXT, label: id });
            fld.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        });

        form.addSubmitButton({ label: 'Submit Manual Proposal for Approval' });

        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  POST: Import CSV
    // ════════════════════════════════════════════════════════════════════════
    function _handleImportCsv(context, settings) {
        var req = context.request;
        var fileObj = req.files.custpage_file;
        if (!fileObj) {
            _redirect(context, 'Import failed – no file selected.');
            return;
        }

        var content = fileObj.getContents();
        var rows = _parseCsv(content);
        if (!rows) {
            _redirect(context, 'Import failed – CSV must have columns: Date, Description, Amount, Reference');
            return;
        }

        var bankAcct = req.parameters.custpage_bank_acct || (settings && settings.bankAccount) || '';
        var created = 0;
        var autoProposed = 0;

        rows.forEach(function (row) {
            try {
                var txnRec = record.create({ type: C.RECORDS.BANK_TXN });
                txnRec.setValue({ fieldId: BTF.TXN_DATE,    value: new Date(row.date) });
                txnRec.setValue({ fieldId: BTF.DESCRIPTION, value: row.description });
                txnRec.setValue({ fieldId: BTF.AMOUNT,      value: row.amount });
                txnRec.setValue({ fieldId: BTF.REFERENCE,   value: row.reference });
                txnRec.setValue({ fieldId: BTF.STATUS,      value: TS.UNMATCHED });
                if (bankAcct) txnRec.setValue({ fieldId: BTF.BANK_ACCOUNT, value: bankAcct });
                var txnId = txnRec.save();
                created++;

                // Auto-suggest if enabled
                if (settings && settings.autoSuggest) {
                    var bankTxn = { date: row.date, amount: row.amount, reference: row.reference };
                    var candidates = row.amount > 0
                        ? engine.findInvoiceMatches(bankTxn, settings)
                        : engine.findBillPaymentMatches(bankTxn, settings);

                    if (candidates.length > 0) {
                        var best = candidates[0];
                        _createProposal({
                            bankTxnId:  txnId,
                            bankDate:   row.date,
                            bankAmount: row.amount,
                            bankRef:    row.reference,
                            nsId:       best.nsId,
                            nsType:     best.nsType,
                            nsRef:      best.reference,
                            txnType:    row.amount > 0 ? TT.CUSTOMER_PAYMENT : TT.BILL_PAYMENT,
                            matchAmt:   best.amount,
                            matchDate:  best.date,
                            adjustDate: false,
                            notes:      'Auto-suggested (score ' + best.score + ')'
                        }, settings);
                        autoProposed++;

                        // Mark bank txn as Proposed
                        record.submitFields({
                            type: C.RECORDS.BANK_TXN, id: txnId,
                            values: { [BTF.STATUS]: TS.PROPOSED },
                            options: { ignoreMandatoryFields: true }
                        });
                    }
                }
            } catch (e) {
                log.error('BM_Main_SL.importCsv', 'Row error: ' + JSON.stringify(row) + ' – ' + e.message);
            }
        });

        var msg = 'Imported ' + created + ' bank lines.' +
            (autoProposed > 0 ? ' ' + autoProposed + ' match proposal(s) automatically created.' : '');
        _redirect(context, msg);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  POST: Create proposal
    // ════════════════════════════════════════════════════════════════════════
    function _handleCreateProposal(context, settings) {
        var p = context.request.parameters;

        var proposalData = {
            bankTxnId:  p.banktxn || p.custpage_banktxn,
            bankDate:   p.bank_date   || p.custpage_bank_date,
            bankAmount: p.bank_amount || p.custpage_bank_amount,
            bankRef:    p.bank_ref    || p.custpage_bank_ref,
            nsId:       p.ns_id       || p.custpage_ns_id_manual,
            nsType:     p.ns_type,
            nsRef:      p.ns_ref      || p.custpage_ns_ref_manual,
            txnType:    p.txn_type    || p.custpage_txn_type_default,
            matchAmt:   p.match_amt,
            matchDate:  p.match_date,
            adjustDate: p.custpage_adj_date === 'T',
            notes:      p.custpage_notes || ''
        };

        // If bank txn details not in params, load from record
        if (!proposalData.bankDate && proposalData.bankTxnId) {
            try {
                var txnRec = record.load({ type: C.RECORDS.BANK_TXN, id: proposalData.bankTxnId });
                proposalData.bankDate   = txnRec.getValue(BTF.TXN_DATE);
                proposalData.bankAmount = txnRec.getValue(BTF.AMOUNT);
                proposalData.bankRef    = txnRec.getValue(BTF.REFERENCE);
            } catch (e) { log.error('BM_Main_SL', 'Load bank txn: ' + e.message); }
        }

        var propId = _createProposal(proposalData, settings);
        if (propId && proposalData.bankTxnId) {
            record.submitFields({
                type: C.RECORDS.BANK_TXN, id: proposalData.bankTxnId,
                values: { [BTF.STATUS]: TS.PROPOSED },
                options: { ignoreMandatoryFields: true }
            });
        }

        _redirect(context, 'Match proposal submitted for approval.' +
            (settings && settings.approver ? ' The approver has been notified.' : ''));
    }

    // ── Create a proposal record ──────────────────────────────────────────
    function _createProposal(data, settings) {
        try {
            var approver = settings && settings.approver ? settings.approver : null;
            var rec = record.create({ type: C.RECORDS.PROPOSAL });
            rec.setValue({ fieldId: PF.BANK_TXN,       value: data.bankTxnId });
            rec.setValue({ fieldId: PF.TXN_TYPE,       value: data.txnType });
            rec.setValue({ fieldId: PF.NS_RECORD_TYPE, value: data.nsType  || '' });
            rec.setValue({ fieldId: PF.NS_RECORD_ID,   value: parseInt(data.nsId, 10) || 0 });
            rec.setValue({ fieldId: PF.NS_RECORD_REF,  value: data.nsRef   || '' });
            rec.setValue({ fieldId: PF.MATCH_AMOUNT,   value: parseFloat(data.matchAmt) || 0 });
            rec.setValue({ fieldId: PF.MATCH_DATE,     value: data.matchDate ? new Date(data.matchDate) : null });
            rec.setValue({ fieldId: PF.STATUS,         value: PS.PENDING });
            rec.setValue({ fieldId: PF.ADJUST_DATE,    value: !!data.adjustDate });
            rec.setValue({ fieldId: PF.NOTES,          value: data.notes  || '' });
            rec.setValue({ fieldId: PF.BANK_AMOUNT,    value: parseFloat(data.bankAmount) || 0 });
            rec.setValue({ fieldId: PF.BANK_DATE,      value: data.bankDate ? new Date(data.bankDate) : null });
            rec.setValue({ fieldId: PF.BANK_REF,       value: data.bankRef || '' });
            if (approver) rec.setValue({ fieldId: PF.APPROVER, value: approver });

            var propId = rec.save();

            // Notify approver
            var notifyEmail = (settings && settings.notifyEmail) || '';
            if (!notifyEmail && settings && settings.approver) {
                try {
                    var empRec = record.load({ type: record.Type.EMPLOYEE, id: settings.approver });
                    notifyEmail = empRec.getValue('email');
                } catch (e) { /* ignore */ }
            }
            if (notifyEmail) {
                var typeLabel = data.txnType === TT.CUSTOMER_PAYMENT ? 'Customer Payment' : 'Bill Payment';
                engine.notifyApprover({
                    approverEmail: notifyEmail,
                    proposalId:    propId,
                    bankRef:       data.bankRef   || '—',
                    bankAmt:       data.bankAmount,
                    bankDate:      data.bankDate,
                    nsRef:         data.nsRef     || '—',
                    type:          typeLabel
                });
            }

            log.audit('BM_Main_SL', 'Proposal created id=' + propId);
            return propId;
        } catch (e) {
            log.error('BM_Main_SL._createProposal', e.message);
            return null;
        }
    }

    // ── Redirect helper ───────────────────────────────────────────────────
    function _redirect(context, flash) {
        context.response.sendRedirect({
            type:       'SUITELET',
            identifier: C.SCRIPTS.MAIN_SL,
            id:         C.SCRIPTS.MAIN_DEPLOY,
            parameters: { flash: encodeURIComponent(flash) }
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Entry point
    // ════════════════════════════════════════════════════════════════════════
    function onRequest(context) {
        var req      = context.request;
        var action   = req.parameters.action || '';
        var settings = _getSettings();

        // Guard: redirect to setup if no settings
        if (!settings && action !== 'import_csv') {
            context.response.sendRedirect({
                type:       'SUITELET',
                identifier: C.SCRIPTS.SETUP_SL,
                id:         C.SCRIPTS.SETUP_DEPLOY
            });
            return;
        }

        if (req.method === 'POST') {
            var postAction = req.parameters.custpage_action || action;
            if (postAction === 'import_csv') { _handleImportCsv(context, settings); return; }
            if (postAction === 'create_proposal') { _handleCreateProposal(context, settings); return; }
        }

        // GET routes
        if (action === 'import') {
            _renderImportPage(context, settings);
            return;
        }
        if (action === 'match') {
            var bankTxnId = req.parameters.banktxn;
            if (!bankTxnId) { _renderDashboard(context, settings, null); return; }
            _renderMatchPage(context, settings, bankTxnId);
            return;
        }
        if (action === 'create_proposal') {
            _handleCreateProposal(context, settings);
            return;
        }

        // Default: dashboard
        var flash = req.parameters.flash ? decodeURIComponent(req.parameters.flash) : null;
        _renderDashboard(context, settings, flash);
    }

    return { onRequest: onRequest };
});
