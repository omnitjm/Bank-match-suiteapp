/**
 * BM_Main_SL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Suitelet
 *
 * Bank Match Central — the single workspace for all bank reconciliation tasks.
 *
 * ─── Architecture ─────────────────────────────────────────────────────────────
 * This Suitelet replaces the old DOM-injection approach (BM_NativePage_CS.js).
 * Everything happens here — auto-matching, proposal approval, manual matching.
 *
 * ─── Routes (GET) ────────────────────────────────────────────────────────────
 *   (default)          Main workspace: filters + Proposals sublist + Unmatched Lines
 *   action=run_automatch  Run auto-match engine, redirect with summary flash
 *   action=approve_all    Approve ALL pending proposals, redirect with summary
 *   action=match          Manual match page for one bank line (3 options)
 *   action=entity_invoices  Open Invoices for a Customer (Option A)
 *   action=entity_bills     Open Bills for a Vendor (Option B)
 *   action=create_manual    Directly create Customer Payment / Vendor Payment /
 *                           Journal Entry from URL params (Options A, B, C via GET)
 *
 * ─── Routes (POST) ───────────────────────────────────────────────────────────
 *   custpage_action=approve_proposals  Approve selected (checked) proposals
 *   custpage_action=create_manual      Create GL Journal Entry (Option C form submit)
 *
 * ─── Transaction Creation ─────────────────────────────────────────────────────
 * All three paths (auto-match approve, manual A, manual B, manual C) create the
 * correct NS transaction and stamp custbody_bank_transaction_id = normalizeTxnId(bankRef).
 * NetSuite's native Reconciliation Rules then auto-match the bank line to the
 * stamped transaction — no manual re-matching needed.
 *
 * NEVER write tranid. Only write custbody_bank_transaction_id.
 */
define([
    'N/ui/serverWidget',
    'N/record',
    'N/search',
    'N/url',
    'N/log',
    './BM_Constants',
    './BM_MatchEngine',
    './BM_BankLineReader'
], function (ui, record, search, url, log, C, engine, reader) {
    'use strict';

    var SF = C.SETTINGS_FIELDS;
    var PF = C.PROPOSAL_FIELDS;
    var PS = C.PROPOSAL_STATUS;
    var TT = C.TXN_TYPE;
    var AS = C.APPLY_STATUS;
    var SR = C.SKIP_REASON;

    var TYPE_LABELS = {
        '1': 'Customer Payment',
        '2': 'Vendor Payment',
        '3': 'Journal Entry'
    };

    var STATUS_LABELS = {
        '1': 'Pending', '2': 'Approved',
        '3': 'Rejected', '4': 'Applied', '5': 'Failed'
    };

    // ════════════════════════════════════════════════════════════════════════
    //  Shared helpers
    // ════════════════════════════════════════════════════════════════════════

    function _getSettings() {
        var rows = search.create({
            type:    C.RECORDS.SETTINGS,
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

    function _slUrl(params) {
        return url.resolveScript({
            scriptId:          C.SCRIPTS.MAIN_SL,
            deploymentId:      C.SCRIPTS.MAIN_DEPLOY,
            params:            params,
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

    // ── Auto-match proposal helpers ───────────────────────────────────────

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

    function _createProposalRecord(line, cand, settings, key) {
        var isCredit = parseFloat(line.amount) > 0;
        var txnType  = isCredit ? TT.CUSTOMER_PAYMENT : TT.VENDOR_PAYMENT;
        var nsType   = isCredit ? 'invoice'           : 'vendorbill';

        var propRec = record.create({ type: C.RECORDS.PROPOSAL });
        propRec.setValue({ fieldId: PF.TXN_TYPE,        value: txnType });
        propRec.setValue({ fieldId: PF.NS_RECORD_TYPE,  value: nsType });
        propRec.setValue({ fieldId: PF.NS_RECORD_ID,    value: parseInt(cand.nsId, 10) });
        propRec.setValue({ fieldId: PF.NS_RECORD_REF,   value: cand.reference || '' });
        propRec.setValue({ fieldId: PF.MATCH_AMOUNT,    value: cand.amount });
        propRec.setValue({ fieldId: PF.MATCH_DATE,
            value: cand.date ? new Date(cand.date) : null });
        propRec.setValue({ fieldId: PF.STATUS,          value: PS.PENDING });
        propRec.setValue({ fieldId: PF.NOTES,
            value: 'Auto-proposed (score ' + cand.score + ')' });
        propRec.setValue({ fieldId: PF.BANK_AMOUNT,     value: line.amount });
        propRec.setValue({ fieldId: PF.BANK_DATE,
            value: line.date ? new Date(line.date) : null });
        propRec.setValue({ fieldId: PF.BANK_REF,        value: line.reference || '' });
        propRec.setValue({ fieldId: PF.IDEMPOTENCY_KEY, value: key || '' });
        propRec.setValue({ fieldId: PF.APPLY_STATUS,    value: AS.PENDING });

        try {
            propRec.setValue({ fieldId: PF.BANK_LINE_ID, value: String(line.id) });
        } catch (e) { /* optional field */ }

        if (settings && settings.approver) {
            propRec.setValue({ fieldId: PF.APPROVER, value: settings.approver });
        }

        return propRec.save();
    }

    // ── Proposal data fetchers ─────────────────────────────────────────────

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
                PF.MATCH_AMOUNT, PF.STATUS, PF.NOTES,
                PF.APPLIED_DATE, PF.ERROR_MSG, PF.APPLIED_TXN_ID
            ]
        }).run().each(function (row) {
            results.push({
                id:           row.id,
                created:      row.getValue('created'),
                txnType:      row.getValue(PF.TXN_TYPE),
                nsRef:        row.getValue(PF.NS_RECORD_REF),
                bankDate:     row.getValue(PF.BANK_DATE),
                bankAmount:   row.getValue(PF.BANK_AMOUNT),
                bankRef:      row.getValue(PF.BANK_REF),
                matchAmount:  row.getValue(PF.MATCH_AMOUNT),
                status:       row.getValue(PF.STATUS),
                notes:        row.getValue(PF.NOTES),
                appliedDate:  row.getValue(PF.APPLIED_DATE),
                errorMsg:     row.getValue(PF.ERROR_MSG),
                appliedTxnId: row.getValue(PF.APPLIED_TXN_ID)
            });
            return results.length < 500;
        });
        return results;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Flash / Info helpers
    // ════════════════════════════════════════════════════════════════════════

    function _flashHtml(msg, color) {
        color = color || '#e8f5e9';
        var border = color === '#e8f5e9' ? '#a5d6a7' : '#ef9a9a';
        return '<div style="background:' + color + ';border:1px solid ' + border + ';' +
               'padding:10px 14px;border-radius:4px;margin-bottom:8px;font-size:13px;">' +
               msg + '</div>';
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Bank Match Central (main workspace)
    // ════════════════════════════════════════════════════════════════════════
    function _renderCentral(context, settings, params, flash) {
        var form = ui.createForm({ title: 'Bank Match Central' });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';

        // ─ Header action buttons ───────────────────────────────────────────
        form.addButton({
            id:           'btn_run_automatch',
            label:        'Run Auto-Match',
            functionName: 'runAutoMatch'
        });
        form.addButton({
            id:           'btn_approve_all',
            label:        'Approve All Pending',
            functionName: 'approveAll'
        });
        form.addButton({
            id:           'btn_setup',
            label:        'Settings',
            functionName: 'goSetup'
        });

        // Hidden action field (submitted with the "Approve Selected" form POST)
        var hAction = form.addField({
            id:   'custpage_action',
            type: ui.FieldType.TEXT,
            label: 'Action'
        });
        hAction.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hAction.defaultValue = 'approve_proposals';

        // ─ Filters ────────────────────────────────────────────────────────
        form.addFieldGroup({ id: 'grp_filters', label: 'Filters' });

        var fAcct = form.addField({
            id:        'custpage_filter_account',
            type:      ui.FieldType.SELECT,
            label:     'Bank Account',
            source:    'account',
            container: 'grp_filters'
        });
        if (settings.bankAccount) fAcct.defaultValue = settings.bankAccount;

        form.addField({
            id:        'custpage_filter_from',
            type:      ui.FieldType.DATE,
            label:     'Date From',
            container: 'grp_filters'
        });
        form.addField({
            id:        'custpage_filter_to',
            type:      ui.FieldType.DATE,
            label:     'Date To',
            container: 'grp_filters'
        });

        // ─ Flash / Status message ──────────────────────────────────────────
        if (flash) {
            var fld = form.addField({
                id:    'custpage_flash',
                type:  ui.FieldType.INLINEHTML,
                label: ' '
            });
            fld.defaultValue = _flashHtml('&#10003;&nbsp;' + flash);
        }

        // ─ Info banner ────────────────────────────────────────────────────
        var infoBanner = form.addField({
            id:    'custpage_info',
            type:  ui.FieldType.INLINEHTML,
            label: ' '
        });
        infoBanner.defaultValue = [
            '<div style="background:#f3f4f6;border-left:4px solid #1565c0;',
            'padding:8px 14px;border-radius:4px;margin-bottom:4px;font-size:12px;line-height:1.7;">',
            '<strong>Workflow:</strong> ',
            '&#x2460; Click <strong>Run Auto-Match</strong> to propose matches for all unmatched bank lines. ',
            '&#x2461; Review proposals below and click <strong>Approve All Pending</strong> or select individual ones. ',
            '&#x2462; For lines with no auto-match, use the <strong>Manual Match →</strong> link in the Unmatched Lines tab. ',
            '&#x2463; NetSuite&rsquo;s Reconciliation Rules automatically match the stamped transactions.',
            '</div>'
        ].join('');

        // ═══════════════════════════════════════════════════════════════════
        //  Tab 1: Pending Proposals (INLINEEDITOR with Approve checkboxes)
        // ═══════════════════════════════════════════════════════════════════
        form.addTab({ id: 'tab_proposals', label: 'Pending Approvals' });

        var pending = _getProposals([PS.PENDING]);

        var sbProp = form.addSublist({
            id:    'sl_proposals',
            type:  ui.SublistType.INLINEEDITOR,
            label: pending.length + ' proposal(s) pending approval',
            tab:   'tab_proposals'
        });
        sbProp.addButton({
            id:           'btn_mark_all',
            label:        'Mark All',
            functionName: 'markAllApprovals'
        });
        sbProp.addButton({
            id:           'btn_unmark_all',
            label:        'Clear All',
            functionName: 'unmarkAllApprovals'
        });

        // Editable checkbox column
        sbProp.addField({ id: 'slp_approve', type: ui.FieldType.CHECKBOX, label: 'Approve?' });

        // Proposal ID (hidden — needed to identify which to approve on submit)
        var slpIdFld = sbProp.addField({
            id: 'slp_id', type: ui.FieldType.TEXT, label: 'ID'
        });
        slpIdFld.updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });

        // Read-only display columns
        sbProp.addField({ id: 'slp_date',   type: ui.FieldType.DATE,     label: 'Bank Date' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_amount', type: ui.FieldType.CURRENCY, label: 'Amount' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_ref',    type: ui.FieldType.TEXT,     label: 'Bank Ref' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_type',   type: ui.FieldType.TEXT,     label: 'Match Type' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_match',  type: ui.FieldType.TEXT,     label: 'Matched To' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_notes',  type: ui.FieldType.TEXT,     label: 'Notes' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_view',   type: ui.FieldType.URL,      label: 'View' })
              .linkText = 'Open';

        pending.forEach(function (p, i) {
            sbProp.setSublistValue({ id: 'slp_approve', line: i, value: 'F' });
            sbProp.setSublistValue({ id: 'slp_id',      line: i, value: p.id });
            sbProp.setSublistValue({ id: 'slp_date',    line: i, value: p.bankDate   || '' });
            sbProp.setSublistValue({ id: 'slp_amount',  line: i, value: p.bankAmount || 0 });
            sbProp.setSublistValue({ id: 'slp_ref',     line: i, value: p.bankRef    || '—' });
            sbProp.setSublistValue({ id: 'slp_type',    line: i,
                value: TYPE_LABELS[p.txnType] || '—' });
            sbProp.setSublistValue({ id: 'slp_match',   line: i, value: p.nsRef      || '—' });
            sbProp.setSublistValue({ id: 'slp_notes',   line: i, value: p.notes      || '' });
            sbProp.setSublistValue({ id: 'slp_view',    line: i,
                value: '/app/common/custom/custrecordentry.nl?rectype=' +
                       encodeURIComponent(C.RECORDS.PROPOSAL) + '&id=' + p.id });
        });

        // ═══════════════════════════════════════════════════════════════════
        //  Tab 2: Unmatched Bank Lines
        // ═══════════════════════════════════════════════════════════════════
        form.addTab({ id: 'tab_unmatched', label: 'Unmatched Lines' });

        var accountId = params.filter_account || settings.bankAccount;
        var lineData  = reader.getUnmatchedLines(accountId);
        var bankLines = lineData.lines;

        // Optional date filter (applied after fetching all lines)
        var filterFrom = params.date_from ? new Date(params.date_from) : null;
        var filterTo   = params.date_to   ? new Date(params.date_to)   : null;
        if (filterFrom || filterTo) {
            bankLines = bankLines.filter(function (line) {
                if (!line.date) return true;
                var d = new Date(line.date);
                if (filterFrom && d < filterFrom) return false;
                if (filterTo   && d > filterTo)   return false;
                return true;
            });
        }

        var sbLines = form.addSublist({
            id:    'sl_unmatched',
            type:  ui.SublistType.LIST,
            label: bankLines.length + ' unmatched bank line(s) — click Manual Match to handle individually',
            tab:   'tab_unmatched'
        });

        sbLines.addField({ id: 'ul_date',   type: ui.FieldType.DATE,     label: 'Date' });
        sbLines.addField({ id: 'ul_amount', type: ui.FieldType.CURRENCY, label: 'Amount' });
        sbLines.addField({ id: 'ul_desc',   type: ui.FieldType.TEXT,     label: 'Description' });
        sbLines.addField({ id: 'ul_ref',    type: ui.FieldType.TEXT,     label: 'Reference' });
        sbLines.addField({ id: 'ul_source', type: ui.FieldType.TEXT,     label: 'Source' });
        sbLines.addField({ id: 'ul_action', type: ui.FieldType.URL,      label: 'Action' })
               .linkText = 'Manual Match';

        bankLines.forEach(function (line, i) {
            sbLines.setSublistValue({ id: 'ul_date',   line: i, value: line.date        || '' });
            sbLines.setSublistValue({ id: 'ul_amount', line: i, value: line.amount      || 0 });
            sbLines.setSublistValue({ id: 'ul_desc',   line: i,
                value: (line.description || '—').substring(0, 80) });
            sbLines.setSublistValue({ id: 'ul_ref',    line: i, value: line.reference   || '—' });
            sbLines.setSublistValue({ id: 'ul_source', line: i, value: line.source      || '—' });
            sbLines.setSublistValue({ id: 'ul_action', line: i, value: _slUrl({
                action:   'match',
                bankline: line.id,
                bl_date:  line.date,
                bl_amt:   line.amount,
                bl_ref:   line.reference,
                bl_desc:  line.description
            }) });
        });

        // ═══════════════════════════════════════════════════════════════════
        //  Tab 3: History
        // ═══════════════════════════════════════════════════════════════════
        form.addTab({ id: 'tab_history', label: 'History' });

        var history = _getProposals([PS.APPLIED, PS.REJECTED, PS.FAILED]);
        var sbHist  = form.addSublist({
            id:    'sl_history',
            type:  ui.SublistType.LIST,
            label: history.length + ' applied / rejected / failed',
            tab:   'tab_history'
        });

        sbHist.addField({ id: 'hh_status',  type: ui.FieldType.TEXT,     label: 'Result' });
        sbHist.addField({ id: 'hh_type',    type: ui.FieldType.TEXT,     label: 'Type' });
        sbHist.addField({ id: 'hh_date',    type: ui.FieldType.DATE,     label: 'Bank Date' });
        sbHist.addField({ id: 'hh_amount',  type: ui.FieldType.CURRENCY, label: 'Amount' });
        sbHist.addField({ id: 'hh_ref',     type: ui.FieldType.TEXT,     label: 'Bank Ref' });
        sbHist.addField({ id: 'hh_match',   type: ui.FieldType.TEXT,     label: 'NS Transaction' });
        sbHist.addField({ id: 'hh_applied', type: ui.FieldType.DATE,     label: 'Applied On' });
        sbHist.addField({ id: 'hh_nstxn',   type: ui.FieldType.TEXT,     label: 'NS ID' });
        sbHist.addField({ id: 'hh_error',   type: ui.FieldType.TEXT,     label: 'Error' });

        history.forEach(function (p, i) {
            sbHist.setSublistValue({ id: 'hh_status',  line: i,
                value: STATUS_LABELS[p.status] || p.status || '—' });
            sbHist.setSublistValue({ id: 'hh_type',    line: i,
                value: TYPE_LABELS[p.txnType] || '—' });
            sbHist.setSublistValue({ id: 'hh_date',    line: i, value: p.bankDate     || '' });
            sbHist.setSublistValue({ id: 'hh_amount',  line: i, value: p.bankAmount   || 0 });
            sbHist.setSublistValue({ id: 'hh_ref',     line: i, value: p.bankRef      || '—' });
            sbHist.setSublistValue({ id: 'hh_match',   line: i, value: p.nsRef        || '—' });
            sbHist.setSublistValue({ id: 'hh_applied', line: i, value: p.appliedDate  || '' });
            sbHist.setSublistValue({ id: 'hh_nstxn',   line: i, value: p.appliedTxnId || '' });
            sbHist.setSublistValue({ id: 'hh_error',   line: i,
                value: (p.errorMsg || '').substring(0, 100) });
        });

        form.addSubmitButton({ label: 'Approve Selected Proposals' });
        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Run Auto-Match (GET)
    // ════════════════════════════════════════════════════════════════════════
    function _handleRunAutoMatch(context, settings, params) {
        var accountId  = params.account    || settings.bankAccount;
        var filterFrom = params.date_from  ? new Date(params.date_from) : null;
        var filterTo   = params.date_to    ? new Date(params.date_to)   : null;

        var lineData  = reader.getUnmatchedLines(accountId);
        var allLines  = lineData.lines;

        // Apply date filters
        if (filterFrom || filterTo) {
            allLines = allLines.filter(function (line) {
                if (!line.date) return true;
                var d = new Date(line.date);
                if (filterFrom && d < filterFrom) return false;
                if (filterTo   && d > filterTo)   return false;
                return true;
            });
        }

        var created = 0;
        var skipped = 0;

        allLines.forEach(function (line) {
            var key = _idempotencyKey(line);
            if (_proposalExists(key)) { skipped++; return; }

            var isCredit   = parseFloat(line.amount) > 0;
            var candidates = isCredit
                ? engine.findInvoiceMatches(line, settings)
                : engine.findVendorBillMatches(line, settings);

            if (!candidates.length || candidates[0].score < 40) { skipped++; return; }

            try {
                _createProposalRecord(line, candidates[0], settings, key);
                created++;
            } catch (e) {
                log.error('BM_Main_SL.run_automatch', e.message);
                skipped++;
            }
        });

        log.audit('BM_Main_SL.run_automatch',
            'Processed ' + allLines.length + ' lines: ' + created +
            ' proposals created, ' + skipped + ' skipped.');

        _redirect(context,
            created + ' proposal(s) created from ' + allLines.length +
            ' bank line(s). ' + skipped + ' skipped.' +
            (created > 0 ? ' Review them in the Pending Approvals tab.' : ''));
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Approve ALL pending (GET)
    // ════════════════════════════════════════════════════════════════════════
    function _handleApproveAll(context, settings) {
        var pending  = _getProposals([PS.PENDING]);
        var approved = 0;
        var failed   = 0;

        pending.forEach(function (p) {
            try {
                record.submitFields({
                    type:    C.RECORDS.PROPOSAL,
                    id:      p.id,
                    values:  { [PF.STATUS]: PS.APPROVED },
                    options: { ignoreMandatoryFields: true }
                });
                approved++;
            } catch (e) {
                log.error('BM_Main_SL.approve_all', 'Proposal ' + p.id + ': ' + e.message);
                failed++;
            }
        });

        _redirect(context,
            approved + ' proposal(s) approved' +
            (failed > 0 ? ', ' + failed + ' failed' : '') + '. ' +
            'NetSuite transactions are being created and will be ready to reconcile shortly.');
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Approve SELECTED proposals (POST)
    // ════════════════════════════════════════════════════════════════════════
    function _handleApproveProposals(context) {
        var req      = context.request;
        var approved = 0;
        var failed   = 0;

        var lineCount = req.getLineCount({ group: 'sl_proposals' });
        for (var i = 0; i < lineCount; i++) {
            var isChecked = req.getSublistValue({
                group: 'sl_proposals', name: 'slp_approve', line: i
            });
            var propId = req.getSublistValue({
                group: 'sl_proposals', name: 'slp_id', line: i
            });

            if ((isChecked === 'T' || isChecked === true) && propId) {
                try {
                    record.submitFields({
                        type:    C.RECORDS.PROPOSAL,
                        id:      propId,
                        values:  { [PF.STATUS]: PS.APPROVED },
                        options: { ignoreMandatoryFields: true }
                    });
                    approved++;
                } catch (e) {
                    log.error('BM_Main_SL.approve_proposals',
                        'Proposal ' + propId + ': ' + e.message);
                    failed++;
                }
            }
        }

        _redirect(context,
            approved > 0
                ? approved + ' proposal(s) approved' +
                  (failed > 0 ? ', ' + failed + ' failed' : '') +
                  '. NetSuite transactions are being created.'
                : 'No proposals were selected. Check the Approve? box before submitting.');
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Manual Match (one bank line, 3 options)
    // ════════════════════════════════════════════════════════════════════════
    function _renderMatchPage(context, settings, params) {
        var bankLine = {
            id:          params.bankline || '',
            date:        params.bl_date  || '',
            amount:      parseFloat(params.bl_amt  || 0),
            reference:   params.bl_ref   || '',
            description: params.bl_desc  || ''
        };
        var isCredit  = bankLine.amount > 0;
        var amtColor  = isCredit ? '#2e7d32' : '#c62828';
        var amtSign   = isCredit ? '+' : '';

        var form = ui.createForm({
            title: 'Manual Match — ' +
                   (bankLine.reference || bankLine.description || 'Bank Line')
        });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';
        form.addButton({ id: 'btn_back', label: '← Back to Central', functionName: 'goBack' });

        // ─ Bank line summary ─────────────────────────────────────────────
        form.addFieldGroup({ id: 'grp_bl', label: 'Bank Line' });
        var blHtml = form.addField({
            id: 'custpage_bl_html', type: ui.FieldType.INLINEHTML,
            label: ' ', container: 'grp_bl'
        });
        blHtml.defaultValue = [
            '<table style="font-size:13px;line-height:2;width:50%;">',
            '<tr><td style="width:120px;font-weight:600;color:#555;">Date</td>',
            '<td>' + (bankLine.date || '—') + '</td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Amount</td>',
            '<td><strong style="font-size:15px;color:' + amtColor + ';">',
            amtSign + bankLine.amount.toFixed(2) + '</strong></td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Reference</td>',
            '<td>' + (bankLine.reference || '—') + '</td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Description</td>',
            '<td>' + (bankLine.description || '—') + '</td></tr>',
            '</table>'
        ].join('');

        // ─ Hidden context fields ─────────────────────────────────────────
        var hidden = {
            custpage_h_bankline: bankLine.id,
            custpage_h_bl_date:  bankLine.date,
            custpage_h_bl_amt:   bankLine.amount,
            custpage_h_bl_ref:   bankLine.reference,
            custpage_h_bl_desc:  bankLine.description
        };
        Object.keys(hidden).forEach(function (fid) {
            var f = form.addField({ id: fid, type: ui.FieldType.TEXT, label: fid });
            f.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
            f.defaultValue = String(hidden[fid] || '');
        });

        // ─ Auto-suggested matches ────────────────────────────────────────
        var candidates = isCredit
            ? engine.findInvoiceMatches(bankLine, settings)
            : engine.findVendorBillMatches(bankLine, settings);

        var topCands = candidates.filter(function (c) { return c.score >= 40; });

        if (topCands.length) {
            var suggLabel = isCredit ? 'Suggested Invoices' : 'Suggested Vendor Bills';
            var sb = form.addSublist({
                id:   'sl_suggest',
                type: ui.SublistType.LIST,
                label: topCands.length + ' auto-suggested match(es) — click Select to use'
            });
            sb.addField({ id: 'sg_score',  type: ui.FieldType.INTEGER,  label: 'Score' });
            sb.addField({ id: 'sg_entity', type: ui.FieldType.TEXT,     label: 'Entity' });
            sb.addField({ id: 'sg_ref',    type: ui.FieldType.TEXT,     label: suggLabel });
            sb.addField({ id: 'sg_date',   type: ui.FieldType.DATE,     label: 'Date' });
            sb.addField({ id: 'sg_amount', type: ui.FieldType.CURRENCY, label: 'Amount' });
            sb.addField({ id: 'sg_select', type: ui.FieldType.URL,      label: 'Action' })
              .linkText = 'Select';

            topCands.slice(0, 10).forEach(function (cand, i) {
                sb.setSublistValue({ id: 'sg_score',  line: i, value: cand.score });
                sb.setSublistValue({ id: 'sg_entity', line: i, value: cand.entity    || '—' });
                sb.setSublistValue({ id: 'sg_ref',    line: i, value: cand.reference || '—' });
                sb.setSublistValue({ id: 'sg_date',   line: i, value: cand.date });
                sb.setSublistValue({ id: 'sg_amount', line: i, value: cand.amount });
                sb.setSublistValue({ id: 'sg_select', line: i, value: _slUrl({
                    action:   'create_manual',
                    txn_type: cand.type,
                    ns_id:    cand.nsId,
                    bankline: bankLine.id,
                    bl_date:  bankLine.date,
                    bl_amt:   bankLine.amount,
                    bl_ref:   bankLine.reference,
                    bl_desc:  bankLine.description
                }) });
            });
        }

        // ─ Option A: Customer Invoice → Customer Payment ─────────────────
        form.addFieldGroup({
            id:    'grp_option_a',
            label: 'Option A — Customer Invoice → Customer Payment'
        });
        form.addField({
            id:        'custpage_entity_a',
            type:      ui.FieldType.SELECT,
            label:     'Customer',
            source:    'customer',
            container: 'grp_option_a'
        });
        form.addButton({
            id:           'btn_find_invoices',
            label:        'Find Open Invoices →',
            functionName: 'findInvoices'
        });

        // ─ Option B: Vendor Bill → Vendor Payment ────────────────────────
        form.addFieldGroup({
            id:    'grp_option_b',
            label: 'Option B — Vendor Bill → Vendor Payment'
        });
        form.addField({
            id:        'custpage_entity_b',
            type:      ui.FieldType.SELECT,
            label:     'Vendor',
            source:    'vendor',
            container: 'grp_option_b'
        });
        form.addButton({
            id:           'btn_find_bills',
            label:        'Find Open Bills →',
            functionName: 'findBills'
        });

        // ─ Option C: GL Account → Journal Entry ──────────────────────────
        form.addFieldGroup({
            id:    'grp_option_c',
            label: 'Option C — GL Account → Journal Entry (bank fees, etc.)'
        });
        form.addField({
            id:        'custpage_gl_account',
            type:      ui.FieldType.SELECT,
            label:     'GL Account',
            source:    'account',
            container: 'grp_option_c'
        });
        form.addField({
            id:        'custpage_gl_memo',
            type:      ui.FieldType.TEXT,
            label:     'Memo (optional)',
            container: 'grp_option_c'
        });

        // Hidden: action + txn_type (for Option C POST)
        var hAct = form.addField({
            id: 'custpage_action_c', type: ui.FieldType.TEXT, label: 'Action'
        });
        hAct.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hAct.defaultValue = 'create_manual';

        var hType = form.addField({
            id: 'custpage_txn_type', type: ui.FieldType.TEXT, label: 'Type'
        });
        hType.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hType.defaultValue = String(TT.JOURNAL_ENTRY);

        form.addSubmitButton({ label: 'Submit Option C — Create Journal Entry' });
        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Open Invoices for a Customer (Option A entity picker)
    // ════════════════════════════════════════════════════════════════════════
    function _renderEntityInvoicesPage(context, settings, params) {
        var customerId = params.entity_id || '';
        var bankLine   = {
            id:        params.bankline || '',
            date:      params.bl_date  || '',
            amount:    parseFloat(params.bl_amt  || 0),
            reference: params.bl_ref   || '',
            description: params.bl_desc || ''
        };

        if (!customerId) {
            _redirect(context, 'No customer selected. Please choose a customer first.');
            return;
        }

        var entityName = customerId;
        try {
            var lf = search.lookupFields({
                type: 'customer', id: customerId,
                columns: ['companyname', 'entityid']
            });
            entityName = lf.companyname || lf.entityid || customerId;
        } catch (e) { /* keep raw ID */ }

        var invoices = engine.findOpenInvoicesByCustomer(customerId);

        var form = ui.createForm({ title: 'Open Invoices — ' + entityName });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';
        form.addButton({ id: 'btn_back', label: '← Back', functionName: 'goBack' });

        var bannerFld = form.addField({
            id: 'custpage_em_banner', type: ui.FieldType.INLINEHTML, label: ' '
        });
        bannerFld.defaultValue = [
            '<div style="background:#f5f5f5;border-left:4px solid #1565c0;',
            'padding:8px 14px;border-radius:4px;font-size:12px;">',
            '<strong>Bank Line:</strong> ', (bankLine.date || '—'), ' &nbsp; ',
            '<strong style="color:#2e7d32;">+', bankLine.amount.toFixed(2), '</strong>',
            (bankLine.reference ? ' &nbsp; Ref: ' + bankLine.reference : ''),
            ' &nbsp;&mdash;&nbsp; Customer: <strong>', entityName, '</strong>',
            '</div>'
        ].join('');

        var sb = form.addSublist({
            id:    'sl_invoices',
            type:  ui.SublistType.LIST,
            label: (invoices.length || 'No') + ' open invoice(s) — click Select to create a Customer Payment'
        });

        sb.addField({ id: 'inv_ref',     type: ui.FieldType.TEXT,     label: 'Invoice #' });
        sb.addField({ id: 'inv_date',    type: ui.FieldType.DATE,     label: 'Invoice Date' });
        sb.addField({ id: 'inv_due',     type: ui.FieldType.DATE,     label: 'Due Date' });
        sb.addField({ id: 'inv_total',   type: ui.FieldType.CURRENCY, label: 'Invoice Total' });
        sb.addField({ id: 'inv_remain',  type: ui.FieldType.CURRENCY, label: 'Amount Remaining' });
        sb.addField({ id: 'inv_memo',    type: ui.FieldType.TEXT,     label: 'Memo' });
        sb.addField({ id: 'inv_select',  type: ui.FieldType.URL,      label: 'Action' }).linkText = 'Select';

        invoices.forEach(function (inv, i) {
            sb.setSublistValue({ id: 'inv_ref',    line: i, value: inv.reference  || '—' });
            sb.setSublistValue({ id: 'inv_date',   line: i, value: inv.date       || '' });
            sb.setSublistValue({ id: 'inv_due',    line: i, value: inv.dueDate    || '' });
            sb.setSublistValue({ id: 'inv_total',  line: i, value: inv.origAmount || 0 });
            sb.setSublistValue({ id: 'inv_remain', line: i, value: inv.amount     || 0 });
            sb.setSublistValue({ id: 'inv_memo',   line: i, value: inv.memo       || '—' });
            sb.setSublistValue({ id: 'inv_select', line: i, value: _slUrl({
                action:   'create_manual',
                txn_type: TT.CUSTOMER_PAYMENT,
                ns_id:    inv.nsId,
                bankline: bankLine.id,
                bl_date:  bankLine.date,
                bl_amt:   bankLine.amount,
                bl_ref:   bankLine.reference,
                bl_desc:  bankLine.description
            }) });
        });

        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Open Bills for a Vendor (Option B entity picker)
    // ════════════════════════════════════════════════════════════════════════
    function _renderEntityBillsPage(context, settings, params) {
        var vendorId = params.entity_id || '';
        var bankLine = {
            id:          params.bankline || '',
            date:        params.bl_date  || '',
            amount:      parseFloat(params.bl_amt  || 0),
            reference:   params.bl_ref   || '',
            description: params.bl_desc  || ''
        };

        if (!vendorId) {
            _redirect(context, 'No vendor selected. Please choose a vendor first.');
            return;
        }

        var vendorName = vendorId;
        try {
            var lf = search.lookupFields({
                type: 'vendor', id: vendorId,
                columns: ['companyname', 'entityid']
            });
            vendorName = lf.companyname || lf.entityid || vendorId;
        } catch (e) { /* keep raw ID */ }

        var bills = engine.findOpenBillsByVendor(vendorId);

        var form = ui.createForm({ title: 'Open Bills — ' + vendorName });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';
        form.addButton({ id: 'btn_back', label: '← Back', functionName: 'goBack' });

        var bannerFld = form.addField({
            id: 'custpage_em_banner', type: ui.FieldType.INLINEHTML, label: ' '
        });
        bannerFld.defaultValue = [
            '<div style="background:#f5f5f5;border-left:4px solid #c62828;',
            'padding:8px 14px;border-radius:4px;font-size:12px;">',
            '<strong>Bank Line:</strong> ', (bankLine.date || '—'), ' &nbsp; ',
            '<strong style="color:#c62828;">', bankLine.amount.toFixed(2), '</strong>',
            (bankLine.reference ? ' &nbsp; Ref: ' + bankLine.reference : ''),
            ' &nbsp;&mdash;&nbsp; Vendor: <strong>', vendorName, '</strong>',
            '</div>'
        ].join('');

        var sb = form.addSublist({
            id:    'sl_bills',
            type:  ui.SublistType.LIST,
            label: (bills.length || 'No') + ' open bill(s) — click Select to create a Vendor Payment'
        });

        sb.addField({ id: 'bill_ref',    type: ui.FieldType.TEXT,     label: 'Bill #' });
        sb.addField({ id: 'bill_date',   type: ui.FieldType.DATE,     label: 'Bill Date' });
        sb.addField({ id: 'bill_due',    type: ui.FieldType.DATE,     label: 'Due Date' });
        sb.addField({ id: 'bill_total',  type: ui.FieldType.CURRENCY, label: 'Bill Total' });
        sb.addField({ id: 'bill_remain', type: ui.FieldType.CURRENCY, label: 'Amount Remaining' });
        sb.addField({ id: 'bill_memo',   type: ui.FieldType.TEXT,     label: 'Memo' });
        sb.addField({ id: 'bill_select', type: ui.FieldType.URL,      label: 'Action' }).linkText = 'Select';

        bills.forEach(function (bill, i) {
            sb.setSublistValue({ id: 'bill_ref',    line: i, value: bill.reference  || '—' });
            sb.setSublistValue({ id: 'bill_date',   line: i, value: bill.date       || '' });
            sb.setSublistValue({ id: 'bill_due',    line: i, value: bill.dueDate    || '' });
            sb.setSublistValue({ id: 'bill_total',  line: i, value: bill.origAmount || 0 });
            sb.setSublistValue({ id: 'bill_remain', line: i, value: bill.amount     || 0 });
            sb.setSublistValue({ id: 'bill_memo',   line: i, value: bill.memo       || '—' });
            sb.setSublistValue({ id: 'bill_select', line: i, value: _slUrl({
                action:   'create_manual',
                txn_type: TT.VENDOR_PAYMENT,
                ns_id:    bill.nsId,
                bankline: bankLine.id,
                bl_date:  bankLine.date,
                bl_amt:   bankLine.amount,
                bl_ref:   bankLine.reference,
                bl_desc:  bankLine.description
            }) });
        });

        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Create Manual Match — Customer Payment / Vendor Payment /
    //          Journal Entry — stamps custbody_bank_transaction_id
    // ════════════════════════════════════════════════════════════════════════
    function _handleCreateManual(context, settings, params) {
        // Params can come from GET (Options A & B select links) or POST (Option C form)
        var txnType  = params.txn_type          || params.custpage_txn_type   || '';
        var nsId     = params.ns_id             || params.custpage_gl_account || '';
        var bankline = params.bankline          || params.custpage_h_bankline  || '';
        var bankDate = params.bl_date           || params.custpage_h_bl_date   || '';
        var bankAmt  = parseFloat(
            params.bl_amt  || params.custpage_h_bl_amt  || 0);
        var bankRef  = params.bl_ref            || params.custpage_h_bl_ref    || '';
        var bankDesc = params.bl_desc           || params.custpage_h_bl_desc   || '';
        var memo     = params.custpage_gl_memo  || '';

        if (!nsId) {
            _redirect(context, 'No target record selected. Please select an Invoice, ' +
                'Vendor Bill, or GL Account before submitting.');
            return;
        }

        // Normalized bank ref — written to custbody_bank_transaction_id
        var normRef = C.normalizeTxnId(bankRef || bankDesc);

        var proposal = {
            nsId:       nsId,
            bankAmount: bankAmt,
            bankDate:   bankDate,
            bankRef:    bankRef || bankDesc || memo,
            notes:      memo
        };

        var appliedId      = null;
        var txnRecordType  = null;

        try {
            if (String(txnType) === String(TT.CUSTOMER_PAYMENT)) {
                appliedId     = engine.applyCustomerPayment(proposal);
                txnRecordType = record.Type.CUSTOMER_PAYMENT;

            } else if (String(txnType) === String(TT.VENDOR_PAYMENT)) {
                appliedId     = engine.applyVendorPayment(proposal);
                txnRecordType = record.Type.VENDOR_PAYMENT;

            } else if (String(txnType) === String(TT.JOURNAL_ENTRY)) {
                if (!settings.bankAccount) {
                    throw new Error(
                        'Bank GL account is not configured in Bank Match Settings.'
                    );
                }
                appliedId     = engine.applyJournalEntry(proposal, settings.bankAccount);
                txnRecordType = record.Type.JOURNAL_ENTRY;

            } else {
                throw new Error('Unknown transaction type: ' + txnType);
            }

            // Stamp custbody_bank_transaction_id
            if (normRef && appliedId) {
                record.submitFields({
                    type:    txnRecordType,
                    id:      appliedId,
                    values:  { [C.BODY_FIELD.BANK_TXN_ID]: normRef },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
            }

            log.audit('BM_Main_SL.create_manual',
                TYPE_LABELS[txnType] + ' ' + appliedId +
                ' created for bank line ' + bankline);

            _redirect(context,
                TYPE_LABELS[txnType] + ' created (ID: ' + appliedId + '). ' +
                'The bank transaction ID has been stamped. ' +
                'Run NetSuite\'s Reconciliation Rules to finalize the match.');

        } catch (e) {
            log.error('BM_Main_SL.create_manual', e.message);
            _redirect(context, 'Error creating transaction: ' + e.message);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Entry point
    // ════════════════════════════════════════════════════════════════════════
    function onRequest(context) {
        var req      = context.request;
        var params   = req.parameters;
        var action   = params.action || '';
        var settings = _getSettings();

        if (!settings) {
            context.response.sendRedirect({
                type:       'SUITELET',
                identifier: C.SCRIPTS.SETUP_SL,
                id:         C.SCRIPTS.SETUP_DEPLOY
            });
            return;
        }

        // ── POST handlers ─────────────────────────────────────────────────
        if (req.method === 'POST') {
            var postAction = params.custpage_action || params.action || '';
            if (postAction === 'approve_proposals') {
                _handleApproveProposals(context);
            } else if (postAction === 'create_manual') {
                _handleCreateManual(context, settings, params);
            } else {
                _redirect(context, 'Unknown form action.');
            }
            return;
        }

        // ── GET handlers ──────────────────────────────────────────────────
        if (action === 'run_automatch') {
            _handleRunAutoMatch(context, settings, params);
            return;
        }
        if (action === 'approve_all') {
            _handleApproveAll(context, settings);
            return;
        }
        if (action === 'create_manual') {
            _handleCreateManual(context, settings, params);
            return;
        }
        if (action === 'match') {
            _renderMatchPage(context, settings, params);
            return;
        }
        if (action === 'entity_invoices' || action === 'entity_match') {
            _renderEntityInvoicesPage(context, settings, params);
            return;
        }
        if (action === 'entity_bills') {
            _renderEntityBillsPage(context, settings, params);
            return;
        }

        // Default: main central workspace
        var flash = params.flash ? decodeURIComponent(params.flash) : null;
        _renderCentral(context, settings, params, flash);
    }

    return { onRequest: onRequest };
});
