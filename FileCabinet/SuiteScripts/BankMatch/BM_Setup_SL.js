/**
 * BM_Setup_SL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Suitelet
 *
 * Bank Match – Setup / Configuration Page
 *
 * Renders a clean, native NetSuite form that lets an admin configure:
 *   • Subsidiary (mandatory, first field — drives bank account list)
 *   • Bank Account (populated server-side; only type=Bank for selected subsidiary)
 *   • Amount and Date tolerance for auto-matching
 *   • Approver
 *   • Auto-suggest toggle
 *   • Scheduled auto-match time (informational — set deployment schedule to match)
 *
 * The settings are stored in a single customrecord_bm_settings record
 * (one per NetSuite account).
 *
 * Subsidiary cascade:
 *   When the user changes Subsidiary, BM_Setup_CS.js reloads the page with
 *   ?custpage_sel_sub=<id>.  The server then populates the Bank Account dropdown
 *   with only accounts of type Bank that belong to that subsidiary.
 */
define([
    'N/ui/serverWidget',
    'N/record',
    'N/search',
    'N/url',
    'N/log',
    './BM_Constants'
], function (ui, record, search, url, log, C) {
    'use strict';

    var SF = C.SETTINGS_FIELDS;

    // ── All active Bank-type accounts ─────────────────────────────────────
    function _getAllBankAccounts() {
        var accounts = [];
        try {
            search.create({
                type:    'account',
                filters: [['type', 'anyof', 'Bank'], 'AND', ['isinactive', 'is', 'F']],
                columns: ['internalid', 'name', 'acctnumber']
            }).run().each(function (row) {
                var num  = row.getValue('acctnumber');
                var name = row.getValue('name');
                accounts.push({
                    id:   row.id,
                    name: num ? num + ' ' + name : name
                });
                return true;
            });
        } catch (e) {
            log.error('BM_Setup_SL._getAllBankAccounts', e.message);
        }
        return accounts;
    }

    // ── Look up subsidiary for a given bank account ───────────────────────
    function _getSubsidiaryForAccount(accountId) {
        if (!accountId) return { id: '', name: '' };
        try {
            var results = search.create({
                type:    'account',
                filters: [['internalid', 'anyof', String(accountId)]],
                columns: ['subsidiary']
            }).run().getRange({ start: 0, end: 1 });
            if (results && results.length > 0) {
                return {
                    id:   results[0].getValue('subsidiary'),
                    name: results[0].getText('subsidiary')
                };
            }
        } catch (e) {
            log.error('BM_Setup_SL._getSubsidiaryForAccount', e.message);
        }
        return { id: '', name: '' };
    }

    // ── Load (or create) the single settings record ────────────────────────
    function _loadSettings() {
        var cols = Object.values(SF);
        var result = search.create({
            type:    C.RECORDS.SETTINGS,
            filters: [['isinactive', 'is', 'F']],
            columns: cols
        }).run().getRange({ start: 0, end: 1 });

        if (result && result.length > 0) {
            var row = result[0];
            return {
                id:              row.id,
                bankAccount:     row.getValue(SF.BANK_ACCOUNT),
                subsidiary:      row.getValue(SF.SUBSIDIARY),
                tolAmt:          row.getValue(SF.TOLERANCE_AMT),
                tolDays:         row.getValue(SF.TOLERANCE_DAYS),
                approver:        row.getValue(SF.APPROVER),
                autoSuggest:     row.getValue(SF.AUTO_SUGGEST),
                feeAccount:      row.getValue(SF.FEE_ACCOUNT),
                suspenseAccount: row.getValue(SF.SUSPENSE_ACCOUNT),
                defaultDept:     row.getValue(SF.DEFAULT_DEPT)     || '',
                defaultClass:    row.getValue(SF.DEFAULT_CLASS)    || '',
                defaultLocation: row.getValue(SF.DEFAULT_LOCATION) || '',
                scheduleTime:    row.getValue(SF.SCHEDULE_TIME)    || '10:00'
            };
        }
        return null;
    }

    // ── Build the settings form ────────────────────────────────────────────
    function _buildForm(settings) {
        var form = ui.createForm({ title: 'Bank Match – Setup' });
        form.clientScriptModulePath = './BM_Setup_CS.js';

        // ─ Navigation buttons ────────────────────────────────────────────────
        form.addButton({
            id:           'btn_go_main',
            label:        'Go to Reconciliation',
            functionName: 'goToMain'
        });
        form.addButton({
            id:           'btn_go_rules',
            label:        'Reconciliation Rules',
            functionName: 'goToRules'
        });

        // ─ Bank & Subsidiary ────────────────────────────────────────────────
        var grpBank = form.addFieldGroup({
            id:    'grp_bank',
            label: 'Bank Settings'
        });
        grpBank.isBorderHidden = false;

        // 1. Bank Account — filtered to Bank-type accounts only (no source= to avoid auto-select of first account)
        var fldAccount = form.addField({
            id:        'custpage_bank_acct_sel',
            type:      ui.FieldType.SELECT,
            label:     'Bank Account',
            container: 'grp_bank'
        });
        fldAccount.isMandatory = true;
        fldAccount.helpText    = 'Select the bank account to reconcile. Subsidiary will be set automatically on save.';
        fldAccount.addSelectOption({ value: '', text: '-- Select Bank Account --' });
        _getAllBankAccounts().forEach(function (acct) {
            fldAccount.addSelectOption({ value: String(acct.id), text: acct.name });
        });

        // 2. Subsidiary — read-only, derived from the saved bank account
        var savedSub = settings ? _getSubsidiaryForAccount(settings.bankAccount) : { name: '' };
        var fldSubDisplay = form.addField({
            id:        'custpage_sub_display',
            type:      ui.FieldType.TEXT,
            label:     'Subsidiary',
            container: 'grp_bank'
        });
        fldSubDisplay.updateDisplayType({ displayType: ui.FieldDisplayType.INLINE });
        fldSubDisplay.defaultValue = savedSub.name || '(saved after selecting bank account)';

        // Hidden field to carry the subsidiary ID through POST
        var fldSub = form.addField({
            id:        SF.SUBSIDIARY,
            type:      ui.FieldType.TEXT,
            label:     'Subsidiary ID'
        });
        fldSub.updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN });
        fldSub.defaultValue = (settings && settings.subsidiary) ? String(settings.subsidiary) : '';

        // ─ Matching Tolerances ──────────────────────────────────────────────
        var grpMatch = form.addFieldGroup({
            id:    'grp_match',
            label: 'Matching Tolerances'
        });

        var fldTolAmt = form.addField({
            id:        SF.TOLERANCE_AMT,
            type:      ui.FieldType.CURRENCY,
            label:     'Amount Tolerance',
            container: 'grp_match'
        });
        fldTolAmt.helpText = 'Maximum allowed difference between bank amount and NetSuite amount.';

        var fldTolDays = form.addField({
            id:        SF.TOLERANCE_DAYS,
            type:      ui.FieldType.INTEGER,
            label:     'Date Tolerance (days)',
            container: 'grp_match'
        });
        fldTolDays.helpText = 'Maximum number of days difference for date matching.';

        var fldAutoSuggest = form.addField({
            id:        SF.AUTO_SUGGEST,
            type:      ui.FieldType.CHECKBOX,
            label:     'Auto-suggest Matches on Import',
            container: 'grp_match'
        });
        fldAutoSuggest.helpText = 'When enabled, the system automatically proposes matches when bank lines are imported.';

        // ─ Approval ─────────────────────────────────────────────────────────
        var grpApproval = form.addFieldGroup({
            id:    'grp_approval',
            label: 'Approval Settings'
        });

        var infoField = form.addField({
            id:        'custpage_approval_note',
            type:      ui.FieldType.INLINEHTML,
            label:     ' ',
            container: 'grp_approval'
        });
        infoField.defaultValue =
            '<div style="padding:8px 0;color:#555;font-size:12px;">' +
            '&#9432;&nbsp; Approval is <strong>always required</strong> before any reconciliation ' +
            'is applied. The approver opens pending proposals in the Bank Match dashboard and sets ' +
            'Status to <strong>Approved</strong>. Upon approval, NetSuite transactions are created ' +
            'automatically — no further action needed.' +
            '</div>';

        var fldApprover = form.addField({
            id:        SF.APPROVER,
            type:      ui.FieldType.SELECT,
            label:     'Approver',
            source:    'employee',
            container: 'grp_approval'
        });
        fldApprover.isMandatory = true;

        // ─ Scheduled Auto-Match ─────────────────────────────────────────────
        var grpSchedule = form.addFieldGroup({
            id:    'grp_schedule',
            label: 'Scheduled Auto-Match'
        });

        var schedNote = form.addField({
            id:        'custpage_schedule_note',
            type:      ui.FieldType.INLINEHTML,
            label:     ' ',
            container: 'grp_schedule'
        });
        schedNote.defaultValue =
            '<div style="padding:6px 0;color:#555;font-size:12px;">' +
            '&#9432;&nbsp; The Bank Match Scheduler script (<strong>BM Scheduler</strong>) runs ' +
            'auto-match automatically every day. To change the run time, go to ' +
            '<em>Customization &rsaquo; Scripting &rsaquo; Scripts</em>, open the ' +
            '<strong>BM Scheduler</strong> deployment, and edit the schedule there.' +
            '<br>The time below is <strong>informational only</strong> — it is shown in ' +
            'the dashboard so your team knows when the next automatic run is scheduled.' +
            '</div>';

        var fldScheduleTime = form.addField({
            id:        SF.SCHEDULE_TIME,
            type:      ui.FieldType.TEXT,
            label:     'Scheduled Run Time (HH:MM)',
            container: 'grp_schedule'
        });
        fldScheduleTime.helpText =
            'For display purposes only (e.g. "10:00"). ' +
            'Set the actual schedule on the BM Scheduler script deployment.';

        // ─ Advanced: GL Accounts for variance write-off & suspense ──────────
        var grpGL = form.addFieldGroup({
            id:    'grp_gl',
            label: 'Advanced — GL Account Defaults'
        });

        var glNote = form.addField({
            id:        'custpage_gl_note',
            type:      ui.FieldType.INLINEHTML,
            label:     ' ',
            container: 'grp_gl'
        });
        glNote.defaultValue =
            '<div style="padding:6px 0;color:#555;font-size:12px;">' +
            '&#9432;&nbsp; <strong>Bank Fee Account</strong> is used to post the difference when ' +
            'an auto-match is accepted with a tolerance variance. ' +
            '<strong>Suspense Account</strong> is pre-filled in the Manual Match UI for ' +
            'unidentified bank lines.' +
            '</div>';

        var fldFeeAcct = form.addField({
            id:        SF.FEE_ACCOUNT,
            type:      ui.FieldType.SELECT,
            label:     'Default Bank Fee Account',
            source:    'account',
            container: 'grp_gl'
        });
        fldFeeAcct.helpText = 'GL expense account for variance write-offs on tolerance matches.';

        var fldSuspenseAcct = form.addField({
            id:        SF.SUSPENSE_ACCOUNT,
            type:      ui.FieldType.SELECT,
            label:     'Default Suspense Account',
            source:    'account',
            container: 'grp_gl'
        });
        fldSuspenseAcct.helpText = 'Quick-select default GL account shown in Manual Match for unknown transactions.';

        // ─ Mandatory Segment Fallbacks ──────────────────────────────────────
        var grpSeg = form.addFieldGroup({
            id:    'grp_seg',
            label: 'Mandatory Segment Defaults (Journal Entry Lines)'
        });

        var segNote = form.addField({
            id:        'custpage_seg_note',
            type:      ui.FieldType.INLINEHTML,
            label:     ' ',
            container: 'grp_seg'
        });
        segNote.defaultValue =
            '<div style="padding:6px 0;color:#555;font-size:12px;">' +
            '&#9432;&nbsp; If Department, Class, or Location are mandatory in your NetSuite account, ' +
            'configure defaults here. They are applied to every Journal Entry line that Bank Match creates ' +
            '(variance write-offs and manual GL matches). Leave blank if the segment is not in use.' +
            '</div>';

        var fldDept = form.addField({
            id:        SF.DEFAULT_DEPT,
            type:      ui.FieldType.SELECT,
            label:     'Default Department',
            source:    'department',
            container: 'grp_seg'
        });
        fldDept.helpText = 'Applied to all Journal Entry lines when department is mandatory.';

        var fldClass = form.addField({
            id:        SF.DEFAULT_CLASS,
            type:      ui.FieldType.SELECT,
            label:     'Default Class',
            source:    'classification',
            container: 'grp_seg'
        });
        fldClass.helpText = 'Applied to all Journal Entry lines when class is mandatory.';

        var fldLocation = form.addField({
            id:        SF.DEFAULT_LOCATION,
            type:      ui.FieldType.SELECT,
            label:     'Default Location',
            source:    'location',
            container: 'grp_seg'
        });
        fldLocation.helpText = 'Applied to all Journal Entry lines when location is mandatory.';

        // ─ Set current values if settings exist ─────────────────────────────
        if (settings) {
            form.addField({ id: 'custpage_settings_id', type: ui.FieldType.TEXT, label: 'Settings ID' })
                .updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN })
                .defaultValue = settings.id;

            fldSub.defaultValue          = settings.subsidiary ? String(settings.subsidiary) : '';
            fldAccount.defaultValue      = settings.bankAccount ? String(settings.bankAccount) : '';
            fldTolAmt.defaultValue       = settings.tolAmt       || '50.00';
            fldTolDays.defaultValue      = settings.tolDays      || '5';
            fldApprover.defaultValue     = settings.approver;
            fldAutoSuggest.defaultValue  = settings.autoSuggest === 'T' ? 'T' : 'F';
            fldFeeAcct.defaultValue      = settings.feeAccount       || '';
            fldSuspenseAcct.defaultValue = settings.suspenseAccount  || '';
            fldDept.defaultValue         = settings.defaultDept      || '';
            fldClass.defaultValue        = settings.defaultClass     || '';
            fldLocation.defaultValue     = settings.defaultLocation  || '';
            fldScheduleTime.defaultValue = settings.scheduleTime     || '10:00';
        } else {
            fldTolAmt.defaultValue       = '50.00';
            fldTolDays.defaultValue      = '5';
            fldScheduleTime.defaultValue = '10:00';
        }

        form.addSubmitButton({ label: 'Save Settings' });
        return form;
    }

    // ── Save settings from POST ───────────────────────────────────────────
    function _saveSettings(params) {
        log.audit('BM_Setup_SL._saveSettings params', JSON.stringify(params));
        var settingsId  = params.custpage_settings_id;
        var bankAcctId  = parseInt(params['custpage_bank_acct_sel'], 10) || '';

        // Derive subsidiary from the selected bank account
        var subId = '';
        if (bankAcctId) {
            var sub = _getSubsidiaryForAccount(bankAcctId);
            subId = sub.id ? parseInt(sub.id, 10) : '';
        }

        var rec = settingsId
            ? record.load({ type: C.RECORDS.SETTINGS, id: settingsId, isDynamic: true })
            : record.create({ type: C.RECORDS.SETTINGS, isDynamic: true });

        rec.setValue({ fieldId: SF.SUBSIDIARY,   value: subId      || '' });
        rec.setValue({ fieldId: SF.BANK_ACCOUNT, value: bankAcctId || '' });
        rec.setValue({ fieldId: SF.TOLERANCE_AMT,    value: params[SF.TOLERANCE_AMT]    || '' });
        rec.setValue({ fieldId: SF.TOLERANCE_DAYS,   value: params[SF.TOLERANCE_DAYS]   || '' });
        rec.setValue({ fieldId: SF.APPROVER,         value: parseInt(params[SF.APPROVER], 10) || '' });
        rec.setValue({ fieldId: SF.AUTO_SUGGEST,     value: params[SF.AUTO_SUGGEST] === 'T' });
        rec.setValue({ fieldId: SF.FEE_ACCOUNT,      value: params[SF.FEE_ACCOUNT]      || '' });
        rec.setValue({ fieldId: SF.SUSPENSE_ACCOUNT, value: params[SF.SUSPENSE_ACCOUNT] || '' });
        rec.setValue({ fieldId: SF.DEFAULT_DEPT,     value: params[SF.DEFAULT_DEPT]     || '' });
        rec.setValue({ fieldId: SF.DEFAULT_CLASS,    value: params[SF.DEFAULT_CLASS]    || '' });
        rec.setValue({ fieldId: SF.DEFAULT_LOCATION, value: params[SF.DEFAULT_LOCATION] || '' });
        rec.setValue({ fieldId: SF.SCHEDULE_TIME,    value: params[SF.SCHEDULE_TIME]    || '10:00' });

        var savedId = rec.save({ ignoreMandatoryFields: true });
        log.audit('BM_Setup_SL', (settingsId ? 'Settings updated' : 'Settings created') + ', id=' + savedId);
    }

    // ── Entry point ───────────────────────────────────────────────────────
    function onRequest(context) {
        var req  = context.request;
        var resp = context.response;

        if (req.method === 'POST') {
            _saveSettings(req.parameters);
            // Redirect back to setup with confirmation
            resp.sendRedirect({
                type:       'SUITELET',
                identifier: C.SCRIPTS.SETUP_SL,
                id:         C.SCRIPTS.SETUP_DEPLOY,
                parameters: { saved: '1' }
            });
            return;
        }

        var settings = _loadSettings();
        var form     = _buildForm(settings);

        if (req.parameters.saved === '1') {
            form.addPageInitMessage({
                type:    ui.MessageType.CONFIRMATION,
                title:   'Settings Saved',
                message: 'Your Bank Match settings have been saved successfully.'
            });
        }

        resp.writePage(form);
    }

    return { onRequest: onRequest };
});
