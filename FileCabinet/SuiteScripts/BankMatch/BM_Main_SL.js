/**
 * BM_Main_SL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Suitelet
 *
 * Bank Match Central — Master/Detail workspace for all bank reconciliation tasks.
 *
 * ─── Architecture ─────────────────────────────────────────────────────────────
 * View 1 – Global Overview (Master)
 *   Loads when no bank_account URL param is present.
 *   Shows a Summary Sublist of every GL bank account across all accessible
 *   Subsidiaries with: Subsidiary, Account Name, Unmatched Line Count,
 *   Pending Proposal Count, and a "Go to Matching" action link.
 *
 * View 2 – Matching Workspace (Detail)
 *   Loads when bank_account URL param is passed (e.g. after clicking "Go to
 *   Matching" from the Overview, or when a Subsidiary + Account pair is selected).
 *   Shows the full three-tab workspace filtered to that bank account:
 *     Tab 1 – Pending Approvals  (INLINEEDITOR with Approve checkboxes)
 *     Tab 2 – Unmatched Lines    (LIST with Manual Match links)
 *     Tab 3 – History            (LIST, Applied / Rejected / Failed)
 *   Top-level filter group has Subsidiary + Bank Account dropdowns.
 *   Changing Subsidiary reloads the page; only bank accounts for that subsidiary
 *   are populated in the Bank Account dropdown.
 *
 * ─── Routes (GET) ────────────────────────────────────────────────────────────
 *   (default / no bank_account param) → _renderOverview
 *   bank_account=<id>                  → _renderCentral (workspace)
 *   action=run_automatch               → _handleRunAutoMatch
 *   action=approve_all                 → _handleApproveAll
 *   action=match                       → _renderMatchPage
 *   action=entity_invoices             → _renderEntityInvoicesPage
 *   action=entity_bills                → _renderEntityBillsPage
 *   action=create_manual               → _handleCreateManual
 *
 * ─── Routes (POST) ───────────────────────────────────────────────────────────
 *   custpage_action=approve_proposals  → _handleApproveProposals
 *   custpage_action=create_manual      → _handleCreateManual (Option C)
 *
 * ─── Matching Engine ──────────────────────────────────────────────────────────
 * Auto-match now uses engine.runWaterfallMatch (Tier 1 / 2a / 2b / 3).
 * Variance metadata (hasVariance, varianceAmt) is stored in every proposal.
 * On approval, BM_Proposal_UE reads variance fields and calls applyCustomerPayment
 * / applyVendorPayment with full settings so the fee-account JE is created.
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

    var TYPE_LABELS = {
        '1': 'Customer Payment',
        '2': 'Vendor Payment',
        '3': 'Journal Entry'
    };

    var STATUS_LABELS = {
        '1': 'Pending', '2': 'Approved',
        '3': 'Rejected', '4': 'Applied', '5': 'Failed', '6': 'Reversed'
    };

    // ════════════════════════════════════════════════════════════════════════
    //  Shared helpers
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Load BM settings for a specific bank account.
     * Falls back to first active settings record if no account specified.
     * Returns null if not yet configured.
     */
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
            id:              r.id,
            bankAccount:     r.getValue(SF.BANK_ACCOUNT),
            subsidiary:      r.getValue(SF.SUBSIDIARY),
            toleranceAmt:    parseFloat(r.getValue(SF.TOLERANCE_AMT))   || 50,
            toleranceDays:   parseInt(r.getValue(SF.TOLERANCE_DAYS), 10) || 5,
            approver:        r.getValue(SF.APPROVER),
            autoSuggest:     r.getValue(SF.AUTO_SUGGEST),
            feeAccount:      r.getValue(SF.FEE_ACCOUNT)      || '',
            suspenseAccount: r.getValue(SF.SUSPENSE_ACCOUNT) || '',
            defaultDept:     r.getValue(SF.DEFAULT_DEPT)     || '',
            defaultClass:    r.getValue(SF.DEFAULT_CLASS)    || '',
            defaultLocation: r.getValue(SF.DEFAULT_LOCATION) || ''
        };
    }

    /**
     * Load ALL active settings records (one per bank account).
     * Used by the scheduler and overview for iterating across accounts.
     */
    function _getAllSettings() {
        var allSettings = [];
        search.create({
            type:    C.RECORDS.SETTINGS,
            filters: [['isinactive', 'is', 'F']],
            columns: Object.values(SF)
        }).run().each(function (r) {
            allSettings.push({
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
            });
            return true;
        });
        return allSettings;
    }

    /** Resolve the main Suitelet URL with optional params. */
    function _slUrl(params) {
        return url.resolveScript({
            scriptId:          C.SCRIPTS.MAIN_SL,
            deploymentId:      C.SCRIPTS.MAIN_DEPLOY,
            params:            params,
            returnExternalUrl: false
        });
    }

    /** Redirect to the main Suitelet workspace (or overview) with a flash message. */
    function _redirect(context, flash, bankAccountId) {
        var params = { flash: encodeURIComponent(flash || '') };
        if (bankAccountId) params.bank_account = bankAccountId;
        context.response.sendRedirect({
            type:       'SUITELET',
            identifier: C.SCRIPTS.MAIN_SL,
            id:         C.SCRIPTS.MAIN_DEPLOY,
            parameters: params
        });
    }

    // ── GL Bank Account helpers ────────────────────────────────────────────

    /**
     * Return all active GL accounts of type Bank.
     * @returns {Array}  [{ id, name, subsidiaryId, subsidiaryName }]
     */
    function _getAllBankAccounts() {
        var accounts = [];
        try {
            search.create({
                type:    'account',
                filters: [
                    ['type',       'anyof', 'Bank'], 'AND',
                    ['isinactive', 'is',    'F']
                ],
                columns: [
                    'internalid', 'name',
                    search.createColumn({ name: 'internalid', join: 'subsidiary', label: 'subId' }),
                    search.createColumn({ name: 'name',       join: 'subsidiary', label: 'subName' })
                ]
            }).run().each(function (row) {
                accounts.push({
                    id:             row.getValue('internalid'),
                    name:           row.getValue('name'),
                    subsidiaryId:   row.getValue({ name: 'internalid', join: 'subsidiary', label: 'subId' }),
                    subsidiaryName: row.getValue({ name: 'name',       join: 'subsidiary', label: 'subName' }) || '—'
                });
                return true;
            });
        } catch (e) {
            log.error('BM_Main_SL._getAllBankAccounts', e.message);
        }
        return accounts;
    }

    /**
     * Return active GL Bank accounts for a specific subsidiary (or all if no sub).
     * @param {string|number} subsidiaryId
     * @returns {Array}  [{ id, name }]
     */
    function _getBankAccountsForSubsidiary(subsidiaryId) {
        var accounts = [];
        var filters  = [
            ['type',       'anyof', 'Bank'], 'AND',
            ['isinactive', 'is',    'F']
        ];
        if (subsidiaryId) {
            filters.push('AND');
            filters.push(['subsidiary', 'anyof', String(subsidiaryId)]);
        }
        try {
            search.create({
                type:    'account',
                filters: filters,
                columns: ['internalid', 'name']
            }).run().each(function (row) {
                accounts.push({
                    id:   row.getValue('internalid'),
                    name: row.getValue('name')
                });
                return true;
            });
        } catch (e) {
            log.error('BM_Main_SL._getBankAccountsForSubsidiary', e.message);
        }
        return accounts;
    }

    /**
     * Look up the subsidiary ID of a given GL account.
     * @returns {string}  subsidiary internal ID, or ''
     */
    function _getSubsidiaryForAccount(accountId) {
        if (!accountId) return '';
        try {
            var lf = search.lookupFields({ type: 'account', id: accountId, columns: ['subsidiary'] });
            var subs = lf.subsidiary;
            return (subs && subs.length) ? subs[0].value : '';
        } catch (e) {
            return '';
        }
    }

    /**
     * Count unmatched bank lines for an account using BankStatementImportLine.
     * Falls back to BankLineReader if SuiteQL is unavailable.
     * @returns {number|string}  count or '?' on error
     */
    function _countUnmatchedLines(accountId) {
        try {
            var q = search.create({
                type:    'bankstatementimportline',
                filters: [
                    ['account', 'anyof', accountId], 'AND',
                    ['iscleared', 'is', 'F']
                ],
                columns: ['internalid']
            });
            var count = 0;
            q.run().each(function () { count++; return count < 10000; });
            return count;
        } catch (e) {
            // Fallback via reader
            try {
                return reader.getUnmatchedLines(accountId).lines.length;
            } catch (e2) {
                return '?';
            }
        }
    }

    /**
     * Count pending proposals linked to a specific bank account.
     * @returns {number}
     */
    function _countPendingProposals(accountId) {
        if (!accountId) return 0;
        var count = 0;
        try {
            search.create({
                type:    C.RECORDS.PROPOSAL,
                filters: [
                    ['isinactive', 'is',    'F'],   'AND',
                    [PF.STATUS,    'anyof', PS.PENDING], 'AND',
                    [PF.BANK_ACCT, 'anyof', accountId]
                ],
                columns: ['internalid']
            }).run().each(function () { count++; return count < 10000; });
        } catch (e) {
            log.error('BM_Main_SL._countPendingProposals', e.message);
        }
        return count;
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

    /**
     * Create a proposal record from a waterfall match result.
     * Stores variance metadata (hasVariance, varianceAmt) and bank account link.
     */
    function _createProposalRecord(line, matchResult, settings, key, bankAccountId) {
        var cand     = matchResult.candidate;
        var isCredit = parseFloat(line.amount) > 0;
        var txnType  = isCredit ? TT.CUSTOMER_PAYMENT : TT.VENDOR_PAYMENT;
        var nsType   = isCredit ? 'invoice'           : 'vendorbill';

        var propRec  = record.create({ type: C.RECORDS.PROPOSAL, isDynamic: true });
        propRec.setValue({ fieldId: PF.TXN_TYPE,        value: txnType });
        propRec.setValue({ fieldId: PF.NS_RECORD_TYPE,  value: nsType });
        propRec.setValue({ fieldId: PF.NS_RECORD_ID,    value: parseInt(cand.nsId, 10) });
        propRec.setValue({ fieldId: PF.NS_RECORD_REF,   value: cand.reference || '' });
        propRec.setValue({ fieldId: PF.MATCH_AMOUNT,    value: cand.amount });
        propRec.setValue({ fieldId: PF.MATCH_DATE,
            value: cand.date ? new Date(cand.date) : null });
        propRec.setValue({ fieldId: PF.STATUS,          value: PS.PENDING });
        propRec.setValue({ fieldId: PF.NOTES,
            value: matchResult.matchReason + ' (score ' + matchResult.score + ')' });
        propRec.setValue({ fieldId: PF.BANK_AMOUNT,     value: line.amount });
        propRec.setValue({ fieldId: PF.BANK_DATE,
            value: line.date ? new Date(line.date) : null });
        propRec.setValue({ fieldId: PF.BANK_REF,        value: line.reference || '' });
        propRec.setValue({ fieldId: PF.IDEMPOTENCY_KEY, value: key || '' });
        propRec.setValue({ fieldId: PF.APPLY_STATUS,    value: AS.PENDING });

        // Variance metadata
        propRec.setValue({ fieldId: PF.HAS_VARIANCE, value: !!matchResult.hasVariance });
        propRec.setValue({ fieldId: PF.VARIANCE_AMT, value: matchResult.varianceAmt || 0 });

        // Many-to-one: store matched NS record IDs (comma-separated)
        if (matchResult.matchedIds && matchResult.matchedIds.length > 1) {
            try {
                propRec.setValue({ fieldId: PF.MATCHED_NS_IDS, value: matchResult.matchedIds.join(',') });
            } catch (e) { /* optional field */ }
        }

        // Bank account link (for multi-account Global Overview filtering)
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

    // ── Proposal data fetchers ─────────────────────────────────────────────

    /**
     * Fetch proposals filtered by status (and optionally bank account).
     */
    function _getProposals(statusFilter, bankAccountId) {
        var filters = [['isinactive', 'is', 'F']];
        if (statusFilter && statusFilter.length) {
            filters.push('AND');
            filters.push([PF.STATUS, 'anyof', statusFilter]);
        }
        if (bankAccountId) {
            filters.push('AND');
            filters.push([PF.BANK_ACCT, 'anyof', bankAccountId]);
        }
        var results = [];
        search.create({
            type:    C.RECORDS.PROPOSAL,
            filters: filters,
            columns: [
                'internalid', 'created',
                PF.TXN_TYPE, PF.NS_RECORD_REF,
                PF.BANK_DATE, PF.BANK_AMOUNT, PF.BANK_REF,
                PF.MATCH_AMOUNT, PF.STATUS, PF.NOTES,
                PF.APPLIED_DATE, PF.ERROR_MSG, PF.APPLY_ERROR,
                PF.APPLIED_TXN_ID, PF.HAS_VARIANCE, PF.VARIANCE_AMT,
                PF.MATCHED_NS_IDS
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
                applyError:   row.getValue(PF.APPLY_ERROR),
                appliedTxnId: row.getValue(PF.APPLIED_TXN_ID),
                hasVariance:  row.getValue(PF.HAS_VARIANCE) === 'T',
                varianceAmt:  parseFloat(row.getValue(PF.VARIANCE_AMT)) || 0,
                matchedNsIds: row.getValue(PF.MATCHED_NS_IDS) || ''
            });
            return results.length < 500;
        });
        return results;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  Flash helper
    // ════════════════════════════════════════════════════════════════════════

    function _flashHtml(msg, color) {
        color = color || '#e8f5e9';
        var border = (color === '#e8f5e9') ? '#a5d6a7' : '#ef9a9a';
        return '<div style="background:' + color + ';border:1px solid ' + border + ';' +
               'padding:10px 14px;border-radius:4px;margin-bottom:8px;font-size:13px;">' +
               msg + '</div>';
    }

    // ── KPI helpers ─────────────────────────────────────────────────────────

    function _kpiCard(title, value, color) {
        return '<div style="background:#fff;border:1px solid #e0e0e0;border-top:3px solid ' +
            color + ';border-radius:4px;padding:10px 18px;min-width:120px;text-align:center;">' +
            '<div style="font-size:22px;font-weight:700;color:' + color + ';">' + value + '</div>' +
            '<div style="font-size:11px;color:#666;margin-top:2px;">' + title + '</div></div>';
    }

    function _computeKpis() {
        var totalUnmatched = 0;
        var totalPending   = 0;
        var appliedCount   = 0;
        var appliedToday   = 0;
        var reversedCount  = 0;
        var totalLines     = 0;

        var bankAccounts = _getAllBankAccounts();
        bankAccounts.forEach(function (acct) {
            var um = _countUnmatchedLines(acct.id);
            totalUnmatched += (um === '?' ? 0 : um);
            totalPending   += _countPendingProposals(acct.id);
        });
        totalLines = totalUnmatched;

        // Count applied proposals (all time)
        try {
            search.create({
                type:    C.RECORDS.PROPOSAL,
                filters: [['isinactive', 'is', 'F'], 'AND', [PF.STATUS, 'anyof', [PS.APPLIED]]],
                columns: ['internalid']
            }).run().each(function () { appliedCount++; return appliedCount < 10000; });
        } catch (e) { /* skip */ }

        // Count applied today
        try {
            var today = new Date();
            today.setHours(0, 0, 0, 0);
            search.create({
                type:    C.RECORDS.PROPOSAL,
                filters: [
                    ['isinactive', 'is', 'F'], 'AND',
                    [PF.STATUS, 'anyof', [PS.APPLIED]], 'AND',
                    [PF.APPLIED_DATE, 'onorafter', today]
                ],
                columns: ['internalid']
            }).run().each(function () { appliedToday++; return appliedToday < 10000; });
        } catch (e) { /* skip */ }

        // Count reversed
        try {
            search.create({
                type:    C.RECORDS.PROPOSAL,
                filters: [['isinactive', 'is', 'F'], 'AND', [PF.STATUS, 'anyof', [PS.REVERSED]]],
                columns: ['internalid']
            }).run().each(function () { reversedCount++; return reversedCount < 10000; });
        } catch (e) { /* skip */ }

        return {
            totalUnmatched: totalUnmatched,
            totalPending:   totalPending,
            appliedCount:   appliedCount,
            appliedToday:   appliedToday,
            reversedCount:  reversedCount,
            totalLines:     totalLines
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  VIEW 1: Global Overview (Master)
    // ════════════════════════════════════════════════════════════════════════

    function _renderOverview(context, flash) {
        var form = ui.createForm({ title: 'Bank Match Central — All Accounts' });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';

        form.addButton({
            id:           'btn_setup',
            label:        'Settings',
            functionName: 'goSetup'
        });

        if (flash) {
            var fld = form.addField({
                id:    'custpage_flash',
                type:  ui.FieldType.INLINEHTML,
                label: ' '
            });
            fld.defaultValue = _flashHtml('&#10003;&nbsp;' + flash);
        }

        // Info banner
        var banner = form.addField({
            id:    'custpage_info',
            type:  ui.FieldType.INLINEHTML,
            label: ' '
        });
        banner.defaultValue =
            '<div style="background:#f3f4f6;border-left:4px solid #1565c0;' +
            'padding:8px 14px;border-radius:4px;margin-bottom:4px;font-size:12px;">' +
            '<strong>Global Overview</strong> — Select a bank account to open its matching workspace. ' +
            'Counts reflect currently unmatched bank lines and pending approval proposals per account.' +
            '</div>';

        // ── KPI Dashboard ────────────────────────────────────────────────
        var kpiData = _computeKpis();
        var kpiField = form.addField({
            id:    'custpage_kpis',
            type:  ui.FieldType.INLINEHTML,
            label: ' '
        });
        var reconPct = kpiData.totalLines > 0
            ? Math.round((kpiData.appliedCount / (kpiData.totalLines + kpiData.appliedCount)) * 100)
            : 0;
        kpiField.defaultValue =
            '<div style="display:flex;gap:16px;margin:8px 0 12px 0;">' +
            _kpiCard('Reconciliation %', reconPct + '%', '#1565c0') +
            _kpiCard('Unmatched Lines', String(kpiData.totalUnmatched), '#e65100') +
            _kpiCard('Pending Proposals', String(kpiData.totalPending), '#f9a825') +
            _kpiCard('Applied Today', String(kpiData.appliedToday), '#2e7d32') +
            _kpiCard('Reversed', String(kpiData.reversedCount), '#c62828') +
            '</div>';

        // ── Summary Sublist ────────────────────────────────────────────────
        var sb = form.addSublist({
            id:    'sl_overview',
            type:  ui.SublistType.LIST,
            label: 'Bank Accounts Summary'
        });

        sb.addField({ id: 'ov_subsidiary', type: ui.FieldType.TEXT,    label: 'Subsidiary' });
        sb.addField({ id: 'ov_account',    type: ui.FieldType.TEXT,    label: 'Bank Account' });
        sb.addField({ id: 'ov_unmatched',  type: ui.FieldType.INTEGER, label: 'Unmatched Lines' });
        sb.addField({ id: 'ov_pending',    type: ui.FieldType.INTEGER, label: 'Pending Proposals' });
        sb.addField({ id: 'ov_action',     type: ui.FieldType.URL,     label: 'Action' }).linkText = 'Go to Matching';

        var bankAccounts = _getAllBankAccounts();
        bankAccounts.forEach(function (acct, i) {
            var unmatchedCount = _countUnmatchedLines(acct.id);
            var pendingCount   = _countPendingProposals(acct.id);

            sb.setSublistValue({ id: 'ov_subsidiary', line: i, value: acct.subsidiaryName });
            sb.setSublistValue({ id: 'ov_account',    line: i, value: acct.name });
            sb.setSublistValue({ id: 'ov_unmatched',  line: i, value: unmatchedCount === '?' ? 0 : unmatchedCount });
            sb.setSublistValue({ id: 'ov_pending',    line: i, value: pendingCount });
            sb.setSublistValue({ id: 'ov_action',     line: i, value: _slUrl({
                bank_account: acct.id,
                subsidiary:   acct.subsidiaryId || ''
            }) });
        });

        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  VIEW 2: Matching Workspace (Detail)
    // ════════════════════════════════════════════════════════════════════════

    function _renderCentral(context, settings, params, flash) {
        var bankAccountId = params.bank_account || settings.bankAccount;
        var subsidiaryId  = params.subsidiary   || _getSubsidiaryForAccount(bankAccountId) || settings.subsidiary;

        var form = ui.createForm({ title: 'Bank Match Central — Matching Workspace' });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';

        // ─ Header buttons ──────────────────────────────────────────────────
        form.addButton({ id: 'btn_overview',  label: '← All Accounts',   functionName: 'goOverview' });
        form.addButton({ id: 'btn_run_automatch', label: 'Run Auto-Match', functionName: 'runAutoMatch' });
        form.addButton({ id: 'btn_approve_all',   label: 'Approve All Pending', functionName: 'approveAll' });
        form.addButton({ id: 'btn_setup',     label: 'Settings',         functionName: 'goSetup' });

        // Hidden action field for proposal approval POST
        var hAction = form.addField({ id: 'custpage_action', type: ui.FieldType.TEXT, label: 'Action' });
        hAction.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hAction.defaultValue = 'approve_proposals';

        // ─ Filters ────────────────────────────────────────────────────────
        form.addFieldGroup({ id: 'grp_filters', label: 'Filters' });

        // Subsidiary selector — changing it reloads the page (client-side)
        var fSub = form.addField({
            id:        'custpage_filter_subsidiary',
            type:      ui.FieldType.SELECT,
            label:     'Subsidiary',
            source:    'subsidiary',
            container: 'grp_filters'
        });
        if (subsidiaryId) fSub.defaultValue = subsidiaryId;

        // Bank Account selector — populated with accounts for the selected subsidiary
        var bankAccounts = _getBankAccountsForSubsidiary(subsidiaryId);
        var fAcct = form.addField({
            id:        'custpage_filter_account',
            type:      ui.FieldType.SELECT,
            label:     'Bank Account',
            container: 'grp_filters'
        });
        // Add blank option then each bank account for the subsidiary
        fAcct.addSelectOption({ value: '', text: '— Select —' });
        bankAccounts.forEach(function (a) {
            fAcct.addSelectOption({ value: a.id, text: a.name });
        });
        if (bankAccountId) fAcct.defaultValue = bankAccountId;

        form.addField({ id: 'custpage_filter_from', type: ui.FieldType.DATE, label: 'Date From', container: 'grp_filters' });
        form.addField({ id: 'custpage_filter_to',   type: ui.FieldType.DATE, label: 'Date To',   container: 'grp_filters' });

        // Hidden fields propagated on client-side navigation
        var hBankAcct = form.addField({ id: 'custpage_h_bank_account', type: ui.FieldType.TEXT, label: 'Bank Account ID' });
        hBankAcct.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hBankAcct.defaultValue = String(bankAccountId || '');

        var hSub = form.addField({ id: 'custpage_h_subsidiary', type: ui.FieldType.TEXT, label: 'Subsidiary ID' });
        hSub.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hSub.defaultValue = String(subsidiaryId || '');

        // ─ Flash / Info ────────────────────────────────────────────────────
        if (flash) {
            var fld = form.addField({ id: 'custpage_flash', type: ui.FieldType.INLINEHTML, label: ' ' });
            fld.defaultValue = _flashHtml('&#10003;&nbsp;' + flash);
        }

        var infoBanner = form.addField({ id: 'custpage_info', type: ui.FieldType.INLINEHTML, label: ' ' });
        infoBanner.defaultValue = [
            '<div style="background:#f3f4f6;border-left:4px solid #1565c0;',
            'padding:8px 14px;border-radius:4px;margin-bottom:4px;font-size:12px;line-height:1.7;">',
            '<strong>Workflow:</strong> ',
            '&#x2460; Click <strong>Run Auto-Match</strong> to propose matches for all unmatched bank lines. ',
            '&#x2461; Review proposals and click <strong>Approve All Pending</strong> or select individually. ',
            '&#x2462; For unmatched lines, use the <strong>Manual Match →</strong> link in the Unmatched Lines tab. ',
            '&#x2463; NetSuite&rsquo;s Reconciliation Rules automatically reconcile stamped transactions. ',
            '<br>&#9888;&nbsp;<em>Variance matches</em> (Tier 2b) are auto-approved with a fee write-off JE posted to the configured Bank Fee Account.',
            '</div>'
        ].join('');

        // ── Failed proposals warning banner ────────────────────────────────
        var failed = _getProposals([PS.FAILED], bankAccountId);
        if (failed.length > 0) {
            var failFld = form.addField({
                id:    'custpage_fail_banner',
                type:  ui.FieldType.INLINEHTML,
                label: ' '
            });
            var failRows = failed.slice(0, 5).map(function (p) {
                var errText = (p.applyError || p.errorMsg || 'Unknown error').substring(0, 200);
                return '<tr>' +
                    '<td style="padding:2px 8px;font-weight:600;">' + (p.bankRef || p.id) + '</td>' +
                    '<td style="padding:2px 8px;">' + (p.bankDate || '') + '</td>' +
                    '<td style="padding:2px 8px;">' + (p.bankAmount || '') + '</td>' +
                    '<td style="padding:2px 8px;color:#b71c1c;">' +
                        errText.replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                    '</td>' +
                    '</tr>';
            }).join('');
            var moreMsg = failed.length > 5
                ? '<p style="margin:6px 0 0;font-size:11px;">… and ' + (failed.length - 5) +
                  ' more. See History tab for full list.</p>'
                : '';
            failFld.defaultValue = [
                '<div style="background:#ffebee;border:1px solid #ef9a9a;border-left:4px solid #c62828;',
                'padding:10px 14px;border-radius:4px;margin-bottom:8px;font-size:12px;">',
                '<strong style="color:#c62828;">&#9888; ' + failed.length + ' proposal(s) failed to apply.</strong>',
                ' Review the errors below and correct the underlying issue, then re-approve the proposal.',
                '<table style="margin-top:6px;width:100%;border-collapse:collapse;">',
                '<thead><tr style="color:#555;font-size:11px;text-align:left;">',
                '<th style="padding:2px 8px;">Bank Ref</th>',
                '<th style="padding:2px 8px;">Date</th>',
                '<th style="padding:2px 8px;">Amount</th>',
                '<th style="padding:2px 8px;">Error</th>',
                '</tr></thead><tbody>', failRows, '</tbody></table>',
                moreMsg,
                '</div>'
            ].join('');
        }

        // ═══════════════════════════════════════════════════════════════════
        //  Tab 1: Pending Proposals
        // ═══════════════════════════════════════════════════════════════════
        form.addTab({ id: 'tab_proposals', label: 'Pending Approvals' });

        var pending = _getProposals([PS.PENDING], bankAccountId);

        var sbProp = form.addSublist({
            id:    'sl_proposals',
            type:  ui.SublistType.INLINEEDITOR,
            label: pending.length + ' proposal(s) pending approval',
            tab:   'tab_proposals'
        });
        sbProp.addButton({ id: 'btn_mark_all',   label: 'Mark All',   functionName: 'markAllApprovals' });
        sbProp.addButton({ id: 'btn_unmark_all', label: 'Clear All',  functionName: 'unmarkAllApprovals' });

        sbProp.addField({ id: 'slp_approve', type: ui.FieldType.CHECKBOX, label: 'Approve?' });

        sbProp.addField({ id: 'slp_id', type: ui.FieldType.TEXT, label: 'ID' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });

        sbProp.addField({ id: 'slp_date',     type: ui.FieldType.DATE,     label: 'Bank Date' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_amount',   type: ui.FieldType.CURRENCY, label: 'Amount' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_ref',      type: ui.FieldType.TEXT,     label: 'Bank Ref' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_type',     type: ui.FieldType.TEXT,     label: 'Match Type' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_match',    type: ui.FieldType.TEXT,     label: 'Matched To' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_variance', type: ui.FieldType.TEXT,     label: 'Variance' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_notes',    type: ui.FieldType.TEXT,     label: 'Notes' })
              .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sbProp.addField({ id: 'slp_view',     type: ui.FieldType.URL,      label: 'View' })
              .linkText = 'Open';

        pending.forEach(function (p, i) {
            var varianceLabel = p.hasVariance
                ? '⚠ ' + (p.varianceAmt ? p.varianceAmt.toFixed(2) : '?')
                : '';
            sbProp.setSublistValue({ id: 'slp_approve', line: i, value: 'F' });
            sbProp.setSublistValue({ id: 'slp_id',      line: i, value: p.id });
            sbProp.setSublistValue({ id: 'slp_date',    line: i, value: p.bankDate   || '' });
            sbProp.setSublistValue({ id: 'slp_amount',  line: i, value: p.bankAmount || 0 });
            sbProp.setSublistValue({ id: 'slp_ref',     line: i, value: p.bankRef    || '—' });
            sbProp.setSublistValue({ id: 'slp_type',    line: i, value: TYPE_LABELS[p.txnType] || '—' });
            sbProp.setSublistValue({ id: 'slp_match',   line: i, value: p.nsRef      || '—' });
            sbProp.setSublistValue({ id: 'slp_variance',line: i, value: varianceLabel });
            sbProp.setSublistValue({ id: 'slp_notes',   line: i, value: p.notes      || '' });
            sbProp.setSublistValue({ id: 'slp_view',    line: i,
                value: '/app/common/custom/custrecordentry.nl?rectype=' +
                       encodeURIComponent(C.RECORDS.PROPOSAL) + '&id=' + p.id });
        });

        // ═══════════════════════════════════════════════════════════════════
        //  Tab 2: Unmatched Bank Lines
        // ═══════════════════════════════════════════════════════════════════
        form.addTab({ id: 'tab_unmatched', label: 'Unmatched Lines' });

        var lineData  = reader.getUnmatchedLines(bankAccountId);
        var bankLines = lineData.lines;

        // Date filter (client-side post-fetch)
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
        sbLines.addField({ id: 'ul_action', type: ui.FieldType.URL,      label: 'Action' }).linkText = 'Manual Match';

        bankLines.forEach(function (line, i) {
            sbLines.setSublistValue({ id: 'ul_date',   line: i, value: line.date        || '' });
            sbLines.setSublistValue({ id: 'ul_amount', line: i, value: line.amount      || 0 });
            sbLines.setSublistValue({ id: 'ul_desc',   line: i, value: (line.description || '—').substring(0, 80) });
            sbLines.setSublistValue({ id: 'ul_ref',    line: i, value: line.reference   || '—' });
            sbLines.setSublistValue({ id: 'ul_source', line: i, value: line.source      || '—' });
            sbLines.setSublistValue({ id: 'ul_action', line: i, value: _slUrl({
                action:       'match',
                bank_account: bankAccountId,
                subsidiary:   subsidiaryId || '',
                bankline:     line.id,
                bl_date:      line.date,
                bl_amt:       line.amount,
                bl_ref:       line.reference,
                bl_desc:      line.description
            }) });
        });

        // ═══════════════════════════════════════════════════════════════════
        //  Tab 3: History
        // ═══════════════════════════════════════════════════════════════════
        form.addTab({ id: 'tab_history', label: 'History' });

        var history = _getProposals([PS.APPLIED, PS.REJECTED, PS.FAILED, PS.REVERSED], bankAccountId);
        var sbHist  = form.addSublist({
            id:    'sl_history',
            type:  ui.SublistType.LIST,
            label: history.length + ' applied / rejected / failed / reversed',
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
        sbHist.addField({ id: 'hh_error',   type: ui.FieldType.TEXT,     label: 'Error Detail' });
        sbHist.addField({ id: 'hh_action',  type: ui.FieldType.TEXT,     label: 'Action' });

        history.forEach(function (p, i) {
            var isFailed  = p.status === PS.FAILED;
            var isReversed = p.status === PS.REVERSED;
            var statusLbl = isFailed
                ? '\u26A0 FAILED'
                : isReversed
                    ? '\u21BA REVERSED'
                    : (STATUS_LABELS[p.status] || p.status || '—');
            // Show the most specific error message available
            var errText   = (p.applyError || p.errorMsg || '').substring(0, 150);

            sbHist.setSublistValue({ id: 'hh_status',  line: i, value: statusLbl });
            sbHist.setSublistValue({ id: 'hh_type',    line: i, value: TYPE_LABELS[p.txnType]  || '—' });
            sbHist.setSublistValue({ id: 'hh_date',    line: i, value: p.bankDate     || '' });
            sbHist.setSublistValue({ id: 'hh_amount',  line: i, value: p.bankAmount   || 0 });
            sbHist.setSublistValue({ id: 'hh_ref',     line: i, value: p.bankRef      || '—' });
            sbHist.setSublistValue({ id: 'hh_match',   line: i, value: p.nsRef        || '—' });
            sbHist.setSublistValue({ id: 'hh_applied', line: i, value: p.appliedDate  || '' });
            sbHist.setSublistValue({ id: 'hh_nstxn',   line: i, value: p.appliedTxnId || '' });
            sbHist.setSublistValue({ id: 'hh_error',   line: i, value: errText });

            // Reverse link — only for Applied proposals with an NS transaction ID
            if (p.status === PS.APPLIED && p.appliedTxnId) {
                var reverseUrl = _slUrl({
                    action:       'reverse_proposal',
                    proposal_id:  p.id,
                    bank_account: bankAccountId
                });
                sbHist.setSublistValue({ id: 'hh_action', line: i,
                    value: '<a href="' + reverseUrl + '" style="color:#c62828;">Reverse</a>' });
            } else {
                sbHist.setSublistValue({ id: 'hh_action', line: i, value: '' });
            }
        });

        form.addSubmitButton({ label: 'Approve Selected Proposals' });
        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Run Auto-Match (waterfall engine)
    // ════════════════════════════════════════════════════════════════════════

    function _handleRunAutoMatch(context, settings, params) {
        var bankAccountId = params.bank_account || params.account || settings.bankAccount;
        var subsidiaryId  = params.subsidiary   || _getSubsidiaryForAccount(bankAccountId) || settings.subsidiary;
        var filterFrom    = params.date_from ? new Date(params.date_from) : null;
        var filterTo      = params.date_to   ? new Date(params.date_to)   : null;

        // Build per-account settings (subsidiary override for this account)
        var runSettings = {
            toleranceAmt:  settings.toleranceAmt,
            toleranceDays: settings.toleranceDays,
            subsidiary:    subsidiaryId || settings.subsidiary,
            feeAccount:    settings.feeAccount,
            approver:      settings.approver
        };

        var lineData = reader.getUnmatchedLines(bankAccountId);
        var allLines = lineData.lines;

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

            // Run waterfall match (Tiers 1 / 2a / 2b / 3)
            var matchResult = engine.runWaterfallMatch(line, runSettings);

            if (!matchResult) { skipped++; return; }

            try {
                _createProposalRecord(line, matchResult, runSettings, key, bankAccountId);
                created++;
            } catch (e) {
                log.error('BM_Main_SL.run_automatch', e.message);
                skipped++;
            }
        });

        log.audit('BM_Main_SL.run_automatch',
            'Bank account ' + bankAccountId + ': processed ' + allLines.length + ' lines — ' +
            created + ' proposals created, ' + skipped + ' skipped.');

        _redirect(context,
            created + ' proposal(s) created from ' + allLines.length + ' bank line(s). ' +
            skipped + ' skipped.' +
            (created > 0 ? ' Review them in the Pending Approvals tab.' : ''),
            bankAccountId);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Approve ALL pending (GET)
    // ════════════════════════════════════════════════════════════════════════

    function _handleApproveAll(context, params, bankAccountId) {
        var pending  = _getProposals([PS.PENDING], bankAccountId);
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
            (failed > 0 ? ', ' + failed + ' failed' : '') +
            '. NetSuite transactions are being created.',
            bankAccountId);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Reverse an applied proposal (GET)
    // ════════════════════════════════════════════════════════════════════════

    function _handleReverseProposal(context, params) {
        var proposalId   = params.proposal_id;
        var bankAccountId = params.bank_account || '';

        if (!proposalId) {
            _redirect(context, 'No proposal ID specified for reversal.', bankAccountId);
            return;
        }

        try {
            var propRec   = record.load({ type: C.RECORDS.PROPOSAL, id: proposalId });
            var status    = propRec.getValue(PF.STATUS);
            var txnType   = propRec.getValue(PF.TXN_TYPE);
            var appliedId = propRec.getValue(PF.APPLIED_TXN_ID);

            if (status !== PS.APPLIED) {
                _redirect(context, 'Proposal ' + proposalId + ' is not in Applied status — cannot reverse.', bankAccountId);
                return;
            }
            if (!appliedId) {
                _redirect(context, 'Proposal ' + proposalId + ' has no NS transaction ID — cannot reverse.', bankAccountId);
                return;
            }

            // Void the main NS transaction
            var voidedIds = [];
            voidedIds.push(engine.voidTransaction(txnType, appliedId));

            // Mark proposal as Reversed
            record.submitFields({
                type:    C.RECORDS.PROPOSAL,
                id:      proposalId,
                values:  {
                    [PF.STATUS]:           PS.REVERSED,
                    [PF.REVERSED_DATE]:    new Date(),
                    [PF.REVERSED_TXN_IDS]: voidedIds.join(',')
                },
                options: { ignoreMandatoryFields: true }
            });

            log.audit('BM_Main_SL.reverse', 'Proposal ' + proposalId + ' reversed. Voided: ' + voidedIds.join(','));

            _redirect(context,
                'Proposal ' + proposalId + ' reversed successfully. NS transaction ' +
                appliedId + ' has been voided.',
                bankAccountId);

        } catch (e) {
            log.error('BM_Main_SL.reverse', 'Reversal failed for proposal ' + proposalId + ': ' + e.message);
            _redirect(context,
                'Reversal failed for proposal ' + proposalId + ': ' + e.message,
                bankAccountId);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Approve SELECTED proposals (POST)
    // ════════════════════════════════════════════════════════════════════════

    function _handleApproveProposals(context) {
        var req      = context.request;
        var approved = 0;
        var failed   = 0;
        var bankAcct = req.parameters.custpage_h_bank_account || '';

        var lineCount = req.getLineCount({ group: 'sl_proposals' });
        for (var i = 0; i < lineCount; i++) {
            var isChecked = req.getSublistValue({ group: 'sl_proposals', name: 'slp_approve', line: i });
            var propId    = req.getSublistValue({ group: 'sl_proposals', name: 'slp_id',      line: i });

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
                    log.error('BM_Main_SL.approve_proposals', 'Proposal ' + propId + ': ' + e.message);
                    failed++;
                }
            }
        }

        _redirect(context,
            approved > 0
                ? approved + ' proposal(s) approved' +
                  (failed > 0 ? ', ' + failed + ' failed' : '') +
                  '. NetSuite transactions are being created.'
                : 'No proposals selected. Check the Approve? box before submitting.',
            bankAcct);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Manual Match (one bank line, 3 options)
    // ════════════════════════════════════════════════════════════════════════

    function _renderMatchPage(context, settings, params) {
        var bankAccountId = params.bank_account || settings.bankAccount;
        var subsidiaryId  = params.subsidiary   || _getSubsidiaryForAccount(bankAccountId) || settings.subsidiary;

        var bankLine = {
            id:          params.bankline || '',
            date:        params.bl_date  || '',
            amount:      parseFloat(params.bl_amt  || 0),
            reference:   params.bl_ref   || '',
            description: params.bl_desc  || ''
        };
        var isCredit = bankLine.amount > 0;
        var amtColor = isCredit ? '#2e7d32' : '#c62828';
        var amtSign  = isCredit ? '+' : '';

        var form = ui.createForm({
            title: 'Manual Match — ' + (bankLine.reference || bankLine.description || 'Bank Line')
        });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';
        form.addButton({ id: 'btn_back', label: '← Back', functionName: 'goBack' });

        // Bank line summary
        form.addFieldGroup({ id: 'grp_bl', label: 'Bank Line' });
        var blHtml = form.addField({ id: 'custpage_bl_html', type: ui.FieldType.INLINEHTML, label: ' ', container: 'grp_bl' });
        blHtml.defaultValue = [
            '<table style="font-size:13px;line-height:2;width:50%;">',
            '<tr><td style="width:120px;font-weight:600;color:#555;">Date</td><td>',      (bankLine.date || '—'),     '</td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Amount</td><td>',
            '<strong style="font-size:15px;color:' + amtColor + ';">',
            amtSign + bankLine.amount.toFixed(2), '</strong></td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Reference</td><td>', (bankLine.reference   || '—'), '</td></tr>',
            '<tr><td style="font-weight:600;color:#555;">Description</td><td>', (bankLine.description || '—'), '</td></tr>',
            '</table>'
        ].join('');

        // Hidden context fields
        var hidden = {
            custpage_h_bankline:     bankLine.id,
            custpage_h_bl_date:      bankLine.date,
            custpage_h_bl_amt:       bankLine.amount,
            custpage_h_bl_ref:       bankLine.reference,
            custpage_h_bl_desc:      bankLine.description,
            custpage_h_bank_account: bankAccountId || '',
            custpage_h_subsidiary:   subsidiaryId  || ''
        };
        Object.keys(hidden).forEach(function (fid) {
            var f = form.addField({ id: fid, type: ui.FieldType.TEXT, label: fid });
            f.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
            f.defaultValue = String(hidden[fid] || '');
        });

        // Auto-suggested matches (legacy score-based for display)
        var matchSettings = {
            toleranceAmt:  settings.toleranceAmt,
            toleranceDays: settings.toleranceDays,
            subsidiary:    subsidiaryId || settings.subsidiary
        };
        var candidates = isCredit
            ? engine.findInvoiceMatches(bankLine, matchSettings)
            : engine.findVendorBillMatches(bankLine, matchSettings);

        var topCands = candidates.filter(function (c) { return c.score >= 40; });
        if (topCands.length) {
            var suggLabel = isCredit ? 'Suggested Invoices' : 'Suggested Vendor Bills';
            var sb = form.addSublist({
                id: 'sl_suggest', type: ui.SublistType.LIST,
                label: topCands.length + ' auto-suggested match(es) — click Select to use'
            });
            sb.addField({ id: 'sg_score',  type: ui.FieldType.INTEGER,  label: 'Score' });
            sb.addField({ id: 'sg_entity', type: ui.FieldType.TEXT,     label: 'Entity' });
            sb.addField({ id: 'sg_ref',    type: ui.FieldType.TEXT,     label: suggLabel });
            sb.addField({ id: 'sg_date',   type: ui.FieldType.DATE,     label: 'Date' });
            sb.addField({ id: 'sg_amount', type: ui.FieldType.CURRENCY, label: 'Amount' });
            sb.addField({ id: 'sg_select', type: ui.FieldType.URL,      label: 'Action' }).linkText = 'Select';

            topCands.slice(0, 10).forEach(function (cand, i) {
                sb.setSublistValue({ id: 'sg_score',  line: i, value: cand.score });
                sb.setSublistValue({ id: 'sg_entity', line: i, value: cand.entity    || '—' });
                sb.setSublistValue({ id: 'sg_ref',    line: i, value: cand.reference || '—' });
                sb.setSublistValue({ id: 'sg_date',   line: i, value: cand.date });
                sb.setSublistValue({ id: 'sg_amount', line: i, value: cand.amount });
                sb.setSublistValue({ id: 'sg_select', line: i, value: _slUrl({
                    action:       'create_manual',
                    txn_type:     cand.type,
                    ns_id:        cand.nsId,
                    bank_account: bankAccountId,
                    subsidiary:   subsidiaryId || '',
                    bankline:     bankLine.id,
                    bl_date:      bankLine.date,
                    bl_amt:       bankLine.amount,
                    bl_ref:       bankLine.reference,
                    bl_desc:      bankLine.description
                }) });
            });
        }

        // Option A: Customer Invoice → Customer Payment
        form.addFieldGroup({ id: 'grp_option_a', label: 'Option A — Customer Invoice → Customer Payment' });
        form.addField({ id: 'custpage_entity_a', type: ui.FieldType.SELECT, label: 'Customer', source: 'customer', container: 'grp_option_a' });
        form.addButton({ id: 'btn_find_invoices', label: 'Find Open Invoices →', functionName: 'findInvoices' });

        // Option B: Vendor Bill → Vendor Payment
        form.addFieldGroup({ id: 'grp_option_b', label: 'Option B — Vendor Bill → Vendor Payment' });
        form.addField({ id: 'custpage_entity_b', type: ui.FieldType.SELECT, label: 'Vendor', source: 'vendor', container: 'grp_option_b' });
        form.addButton({ id: 'btn_find_bills', label: 'Find Open Bills →', functionName: 'findBills' });

        // Option C: GL Account → Journal Entry
        // Pre-fill with suspense account if configured
        form.addFieldGroup({ id: 'grp_option_c', label: 'Option C — GL Account → Journal Entry (bank fees, unknowns)' });
        var fGlAcct = form.addField({ id: 'custpage_gl_account', type: ui.FieldType.SELECT, label: 'GL Account', source: 'account', container: 'grp_option_c' });
        if (settings.suspenseAccount) fGlAcct.defaultValue = settings.suspenseAccount;
        form.addField({ id: 'custpage_gl_memo', type: ui.FieldType.TEXT, label: 'Memo (optional)', container: 'grp_option_c' });

        var hAct  = form.addField({ id: 'custpage_action_c', type: ui.FieldType.TEXT, label: 'Action' });
        hAct.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hAct.defaultValue = 'create_manual';

        var hType = form.addField({ id: 'custpage_txn_type', type: ui.FieldType.TEXT, label: 'Type' });
        hType.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hType.defaultValue = String(TT.JOURNAL_ENTRY);

        form.addSubmitButton({ label: 'Submit Option C — Create Journal Entry' });
        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Open Invoices for a Customer (Option A entity picker)
    // ════════════════════════════════════════════════════════════════════════

    function _renderEntityInvoicesPage(context, settings, params) {
        var customerId    = params.entity_id  || '';
        var bankAccountId = params.bank_account || settings.bankAccount;
        var subsidiaryId  = params.subsidiary  || _getSubsidiaryForAccount(bankAccountId) || settings.subsidiary;
        var bankLine      = {
            id:          params.bankline || '',
            date:        params.bl_date  || '',
            amount:      parseFloat(params.bl_amt  || 0),
            reference:   params.bl_ref   || '',
            description: params.bl_desc  || ''
        };

        if (!customerId) {
            _redirect(context, 'No customer selected.', bankAccountId);
            return;
        }

        var entityName = customerId;
        try {
            var lf = search.lookupFields({ type: 'customer', id: customerId, columns: ['companyname', 'entityid'] });
            entityName = lf.companyname || lf.entityid || customerId;
        } catch (e) { /* keep raw ID */ }

        // Pass subsidiary so invoices are filtered cross-subsidiary safely
        var invoices = engine.findOpenInvoicesByCustomer(customerId, subsidiaryId || settings.subsidiary);

        var form = ui.createForm({ title: 'Open Invoices — ' + entityName });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';
        form.addButton({ id: 'btn_back', label: '← Back', functionName: 'goBack' });

        var banner = form.addField({ id: 'custpage_em_banner', type: ui.FieldType.INLINEHTML, label: ' ' });
        banner.defaultValue = [
            '<div style="background:#f5f5f5;border-left:4px solid #1565c0;',
            'padding:8px 14px;border-radius:4px;font-size:12px;">',
            '<strong>Bank Line:</strong> ', (bankLine.date || '—'), ' &nbsp; ',
            '<strong style="color:#2e7d32;">+', bankLine.amount.toFixed(2), '</strong>',
            (bankLine.reference ? ' &nbsp; Ref: ' + bankLine.reference : ''),
            ' &nbsp;&mdash;&nbsp; Customer: <strong>', entityName, '</strong>',
            '</div>'
        ].join('');

        // Running-total counter — updated client-side as checkboxes are ticked
        var counterFld = form.addField({
            id:    'custpage_remaining_display',
            type:  ui.FieldType.INLINEHTML,
            label: ' '
        });
        counterFld.defaultValue =
            '<div id="custpage_remaining_counter" style="padding:6px 0;font-size:13px;">' +
            'Selected: 0.00 &nbsp;|&nbsp; ' +
            'Remaining: <strong style="color:#e65100;">' + bankLine.amount.toFixed(2) + '</strong>' +
            '</div>';

        // Hidden fields to carry context through POST
        var hBankAmt = form.addField({ id: 'custpage_bank_line_amt', type: ui.FieldType.TEXT, label: 'Bank Amt' });
        hBankAmt.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hBankAmt.defaultValue = String(bankLine.amount);

        var hiddenCtx = {
            custpage_h_bankline:     bankLine.id,
            custpage_h_bl_date:      bankLine.date,
            custpage_h_bl_amt:       String(bankLine.amount),
            custpage_h_bl_ref:       bankLine.reference,
            custpage_h_bl_desc:      bankLine.description,
            custpage_h_bank_account: bankAccountId || '',
            custpage_h_subsidiary:   subsidiaryId  || ''
        };
        Object.keys(hiddenCtx).forEach(function (fid) {
            var f = form.addField({ id: fid, type: ui.FieldType.TEXT, label: fid });
            f.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
            f.defaultValue = String(hiddenCtx[fid] || '');
        });

        var hAct = form.addField({ id: 'custpage_action', type: ui.FieldType.TEXT, label: 'Action' });
        hAct.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hAct.defaultValue = 'create_manual_multi';

        var hType = form.addField({ id: 'custpage_txn_type', type: ui.FieldType.TEXT, label: 'Type' });
        hType.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hType.defaultValue = String(TT.CUSTOMER_PAYMENT);

        // Multi-select invoice sublist (INLINEEDITOR allows checkboxes)
        var sb = form.addSublist({
            id:    'sl_invoices',
            type:  ui.SublistType.INLINEEDITOR,
            label: (invoices.length || 'No') + ' open invoice(s) — check Apply? boxes then click Create Payment'
        });

        sb.addField({ id: 'inv_chk',    type: ui.FieldType.CHECKBOX, label: 'Apply?' });

        sb.addField({ id: 'inv_nsid',   type: ui.FieldType.TEXT,     label: 'ID' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'inv_ref',    type: ui.FieldType.TEXT,     label: 'Invoice #' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'inv_date',   type: ui.FieldType.DATE,     label: 'Invoice Date' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'inv_due',    type: ui.FieldType.DATE,     label: 'Due Date' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'inv_total',  type: ui.FieldType.CURRENCY, label: 'Invoice Total' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'inv_remain', type: ui.FieldType.CURRENCY, label: 'Amt Remaining' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'inv_memo',   type: ui.FieldType.TEXT,     label: 'Memo' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });

        invoices.forEach(function (inv, i) {
            sb.setSublistValue({ id: 'inv_chk',    line: i, value: 'F' });
            sb.setSublistValue({ id: 'inv_nsid',   line: i, value: String(inv.nsId) });
            sb.setSublistValue({ id: 'inv_ref',    line: i, value: inv.reference  || '—' });
            sb.setSublistValue({ id: 'inv_date',   line: i, value: inv.date       || '' });
            sb.setSublistValue({ id: 'inv_due',    line: i, value: inv.dueDate    || '' });
            sb.setSublistValue({ id: 'inv_total',  line: i, value: inv.origAmount || 0 });
            sb.setSublistValue({ id: 'inv_remain', line: i, value: inv.amount     || 0 });
            sb.setSublistValue({ id: 'inv_memo',   line: i, value: inv.memo       || '—' });
        });

        form.addSubmitButton({ label: 'Create Customer Payment for Selected Invoice(s)' });
        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAGE: Open Bills for a Vendor (Option B entity picker)
    // ════════════════════════════════════════════════════════════════════════

    function _renderEntityBillsPage(context, settings, params) {
        var vendorId      = params.entity_id  || '';
        var bankAccountId = params.bank_account || settings.bankAccount;
        var subsidiaryId  = params.subsidiary  || _getSubsidiaryForAccount(bankAccountId) || settings.subsidiary;
        var bankLine      = {
            id:          params.bankline || '',
            date:        params.bl_date  || '',
            amount:      parseFloat(params.bl_amt  || 0),
            reference:   params.bl_ref   || '',
            description: params.bl_desc  || ''
        };

        if (!vendorId) {
            _redirect(context, 'No vendor selected.', bankAccountId);
            return;
        }

        var vendorName = vendorId;
        try {
            var lf = search.lookupFields({ type: 'vendor', id: vendorId, columns: ['companyname', 'entityid'] });
            vendorName = lf.companyname || lf.entityid || vendorId;
        } catch (e) { /* keep raw ID */ }

        // Pass subsidiary to prevent cross-subsidiary bill matching
        var bills = engine.findOpenBillsByVendor(vendorId, subsidiaryId || settings.subsidiary);

        var form = ui.createForm({ title: 'Open Bills — ' + vendorName });
        form.clientScriptModulePath = './BM_Dashboard_CS.js';
        form.addButton({ id: 'btn_back', label: '← Back', functionName: 'goBack' });

        var banner = form.addField({ id: 'custpage_em_banner', type: ui.FieldType.INLINEHTML, label: ' ' });
        banner.defaultValue = [
            '<div style="background:#f5f5f5;border-left:4px solid #c62828;',
            'padding:8px 14px;border-radius:4px;font-size:12px;">',
            '<strong>Bank Line:</strong> ', (bankLine.date || '—'), ' &nbsp; ',
            '<strong style="color:#c62828;">', bankLine.amount.toFixed(2), '</strong>',
            (bankLine.reference ? ' &nbsp; Ref: ' + bankLine.reference : ''),
            ' &nbsp;&mdash;&nbsp; Vendor: <strong>', vendorName, '</strong>',
            '</div>'
        ].join('');

        // Running-total counter — updated client-side as checkboxes are ticked
        var counterFld = form.addField({
            id:    'custpage_remaining_display',
            type:  ui.FieldType.INLINEHTML,
            label: ' '
        });
        counterFld.defaultValue =
            '<div id="custpage_remaining_counter" style="padding:6px 0;font-size:13px;">' +
            'Selected: 0.00 &nbsp;|&nbsp; ' +
            'Remaining: <strong style="color:#e65100;">' + Math.abs(bankLine.amount).toFixed(2) + '</strong>' +
            '</div>';

        // Hidden fields to carry context through POST
        var hBankAmt = form.addField({ id: 'custpage_bank_line_amt', type: ui.FieldType.TEXT, label: 'Bank Amt' });
        hBankAmt.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hBankAmt.defaultValue = String(Math.abs(bankLine.amount));

        var hiddenCtx = {
            custpage_h_bankline:     bankLine.id,
            custpage_h_bl_date:      bankLine.date,
            custpage_h_bl_amt:       String(bankLine.amount),
            custpage_h_bl_ref:       bankLine.reference,
            custpage_h_bl_desc:      bankLine.description,
            custpage_h_bank_account: bankAccountId || '',
            custpage_h_subsidiary:   subsidiaryId  || ''
        };
        Object.keys(hiddenCtx).forEach(function (fid) {
            var f = form.addField({ id: fid, type: ui.FieldType.TEXT, label: fid });
            f.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
            f.defaultValue = String(hiddenCtx[fid] || '');
        });

        var hAct = form.addField({ id: 'custpage_action', type: ui.FieldType.TEXT, label: 'Action' });
        hAct.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hAct.defaultValue = 'create_manual_multi';

        var hType = form.addField({ id: 'custpage_txn_type', type: ui.FieldType.TEXT, label: 'Type' });
        hType.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        hType.defaultValue = String(TT.VENDOR_PAYMENT);

        // Multi-select bills sublist (INLINEEDITOR allows checkboxes)
        var sb = form.addSublist({
            id:    'sl_bills',
            type:  ui.SublistType.INLINEEDITOR,
            label: (bills.length || 'No') + ' open bill(s) — check Apply? boxes then click Create Payment'
        });

        sb.addField({ id: 'bill_chk',    type: ui.FieldType.CHECKBOX, label: 'Apply?' });

        sb.addField({ id: 'bill_nsid',   type: ui.FieldType.TEXT,     label: 'ID' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'bill_ref',    type: ui.FieldType.TEXT,     label: 'Bill #' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'bill_date',   type: ui.FieldType.DATE,     label: 'Bill Date' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'bill_due',    type: ui.FieldType.DATE,     label: 'Due Date' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'bill_total',  type: ui.FieldType.CURRENCY, label: 'Bill Total' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'bill_remain', type: ui.FieldType.CURRENCY, label: 'Amt Remaining' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        sb.addField({ id: 'bill_memo',   type: ui.FieldType.TEXT,     label: 'Memo' })
          .updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });

        bills.forEach(function (bill, i) {
            sb.setSublistValue({ id: 'bill_chk',    line: i, value: 'F' });
            sb.setSublistValue({ id: 'bill_nsid',   line: i, value: String(bill.nsId) });
            sb.setSublistValue({ id: 'bill_ref',    line: i, value: bill.reference  || '—' });
            sb.setSublistValue({ id: 'bill_date',   line: i, value: bill.date       || '' });
            sb.setSublistValue({ id: 'bill_due',    line: i, value: bill.dueDate    || '' });
            sb.setSublistValue({ id: 'bill_total',  line: i, value: bill.origAmount || 0 });
            sb.setSublistValue({ id: 'bill_remain', line: i, value: bill.amount     || 0 });
            sb.setSublistValue({ id: 'bill_memo',   line: i, value: bill.memo       || '—' });
        });

        form.addSubmitButton({ label: 'Create Vendor Payment for Selected Bill(s)' });
        context.response.writePage(form);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Create Manual Match (Customer Payment / Vendor Payment / JE)
    // ════════════════════════════════════════════════════════════════════════

    function _handleCreateManual(context, settings, params) {
        var txnType       = params.txn_type          || params.custpage_txn_type   || '';
        var nsId          = params.ns_id             || params.custpage_gl_account || '';
        var bankAccountId = params.bank_account      || params.custpage_h_bank_account || settings.bankAccount;
        var bankline      = params.bankline          || params.custpage_h_bankline  || '';
        var bankDate      = params.bl_date           || params.custpage_h_bl_date   || '';
        var bankAmt       = parseFloat(params.bl_amt  || params.custpage_h_bl_amt  || 0);
        var bankRef       = params.bl_ref            || params.custpage_h_bl_ref    || '';
        var bankDesc      = params.bl_desc           || params.custpage_h_bl_desc   || '';
        var memo          = params.custpage_gl_memo  || '';

        if (!nsId) {
            _redirect(context,
                'No target record selected. Please select an Invoice, Vendor Bill, or GL Account.',
                bankAccountId);
            return;
        }

        var normRef = C.normalizeTxnId(bankRef || bankDesc);
        var proposal = {
            nsId:        nsId,
            bankAmount:  bankAmt,
            bankDate:    bankDate,
            bankRef:     bankRef || bankDesc || memo,
            notes:       memo,
            hasVariance: false,
            varianceAmt: 0
        };

        var appliedId     = null;
        var txnRecordType = null;

        try {
            if (String(txnType) === String(TT.CUSTOMER_PAYMENT)) {
                appliedId     = engine.applyCustomerPayment(proposal, settings);
                txnRecordType = record.Type.CUSTOMER_PAYMENT;

            } else if (String(txnType) === String(TT.VENDOR_PAYMENT)) {
                appliedId     = engine.applyVendorPayment(proposal, settings);
                txnRecordType = record.Type.VENDOR_PAYMENT;

            } else if (String(txnType) === String(TT.JOURNAL_ENTRY)) {
                if (!bankAccountId) {
                    throw new Error('Bank GL account is not configured in Bank Match Settings.');
                }
                appliedId     = engine.applyJournalEntry(proposal, bankAccountId, settings);
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
                TYPE_LABELS[txnType] + ' ' + appliedId + ' created for bank line ' + bankline);

            _redirect(context,
                TYPE_LABELS[txnType] + ' created (ID: ' + appliedId + '). ' +
                'Bank transaction ID stamped. Run NetSuite Reconciliation Rules to finalize.',
                bankAccountId);

        } catch (e) {
            log.error('BM_Main_SL.create_manual', e.message);
            _redirect(context,
                'ERROR creating ' + (TYPE_LABELS[txnType] || 'transaction') + ': ' + e.message,
                bankAccountId);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ACTION: Create Multi-Apply Match (one payment → many invoices/bills)
    // ════════════════════════════════════════════════════════════════════════

    function _handleCreateManualMulti(context, settings, params, req) {
        var txnType       = params.custpage_txn_type || '';
        var bankAccountId = params.custpage_h_bank_account || settings.bankAccount;
        var bankDate      = params.custpage_h_bl_date  || '';
        var bankAmt       = parseFloat(params.custpage_h_bl_amt || 0);
        var bankRef       = params.custpage_h_bl_ref   || '';
        var bankDesc      = params.custpage_h_bl_desc  || '';

        var isInv     = String(txnType) === String(TT.CUSTOMER_PAYMENT);
        var groupName = isInv ? 'sl_invoices' : 'sl_bills';
        var checkFld  = isInv ? 'inv_chk'     : 'bill_chk';
        var idFld     = isInv ? 'inv_nsid'    : 'bill_nsid';

        var lineCount = req.getLineCount({ group: groupName });
        var nsIds = [];
        for (var i = 0; i < lineCount; i++) {
            var chk  = req.getSublistValue({ group: groupName, name: checkFld, line: i });
            var nsId = req.getSublistValue({ group: groupName, name: idFld,    line: i });
            if ((chk === 'T' || chk === true) && nsId) nsIds.push(nsId);
        }

        if (!nsIds.length) {
            _redirect(context,
                'No records selected. Check at least one Apply? box before submitting.',
                bankAccountId);
            return;
        }

        var proposal = {
            bankAmount:  bankAmt,
            bankDate:    bankDate,
            bankRef:     bankRef || bankDesc,
            hasVariance: false,
            varianceAmt: 0
        };
        var normRef       = C.normalizeTxnId(bankRef || bankDesc);
        var appliedId     = null;
        var txnRecordType = null;

        try {
            if (isInv) {
                appliedId     = engine.applyCustomerPaymentMulti(proposal, settings, nsIds);
                txnRecordType = record.Type.CUSTOMER_PAYMENT;
            } else {
                appliedId     = engine.applyVendorPaymentMulti(proposal, settings, nsIds);
                txnRecordType = record.Type.VENDOR_PAYMENT;
            }

            if (normRef && appliedId) {
                record.submitFields({
                    type:    txnRecordType,
                    id:      appliedId,
                    values:  { [C.BODY_FIELD.BANK_TXN_ID]: normRef },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
            }

            log.audit('BM_Main_SL.create_manual_multi',
                TYPE_LABELS[txnType] + ' ' + appliedId + ' created, applied to ' +
                nsIds.length + ' record(s)');

            _redirect(context,
                TYPE_LABELS[txnType] + ' created (ID: ' + appliedId + ') — applied to ' +
                nsIds.length + ' record(s). Bank transaction ID stamped.',
                bankAccountId);

        } catch (e) {
            log.error('BM_Main_SL.create_manual_multi', e.message);
            _redirect(context,
                'ERROR creating multi-apply ' + (TYPE_LABELS[txnType] || 'payment') +
                ': ' + e.message,
                bankAccountId);
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  ENTRY POINT
    // ════════════════════════════════════════════════════════════════════════

    function onRequest(context) {
        var req    = context.request;
        var params = req.parameters;
        var action = params.action || '';

        // ── POST ────────────────────────────────────────────────────────────
        if (req.method === 'POST') {
            var postAction = params.custpage_action || params.custpage_action_c || '';
            var postBankAcct = params.custpage_h_bank_account || '';
            var settings0  = _getSettings(postBankAcct) || {};
            if (postAction === 'create_manual_multi') {
                _handleCreateManualMulti(context, settings0, params, req);
            } else if (postAction === 'create_manual') {
                _handleCreateManual(context, settings0, params);
            } else {
                _handleApproveProposals(context);
            }
            return;
        }

        // ── GET ─────────────────────────────────────────────────────────────
        var flash         = params.flash ? decodeURIComponent(params.flash) : '';
        var bankAccountId = params.bank_account || '';

        // No bank_account → show Global Overview (Master)
        if (!bankAccountId && action !== 'run_automatch' && action !== 'approve_all') {
            _renderOverview(context, flash);
            return;
        }

        var settings = _getSettings(bankAccountId);
        if (!settings) {
            // Redirect to setup if never configured
            context.response.sendRedirect({
                type:       'SUITELET',
                identifier: C.SCRIPTS.SETUP_SL,
                id:         C.SCRIPTS.SETUP_DEPLOY,
                parameters: {}
            });
            return;
        }

        switch (action) {
            case 'run_automatch':
                _handleRunAutoMatch(context, settings, params);
                break;

            case 'approve_all':
                _handleApproveAll(context, params, bankAccountId);
                break;

            case 'match':
                _renderMatchPage(context, settings, params);
                break;

            case 'entity_invoices':
                _renderEntityInvoicesPage(context, settings, params);
                break;

            case 'entity_bills':
                _renderEntityBillsPage(context, settings, params);
                break;

            case 'create_manual':
                _handleCreateManual(context, settings, params);
                break;

            case 'reverse_proposal':
                _handleReverseProposal(context, params);
                break;

            default:
                // Show workspace (Detail) for the given bank account
                _renderCentral(context, settings, params, flash);
        }
    }

    return { onRequest: onRequest };
});
