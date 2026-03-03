/**
 * BM_Setup_SL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Suitelet
 *
 * Bank Match – Setup / Configuration Page
 *
 * Renders a clean, native NetSuite form that lets an admin configure:
 *   • Bank Account and Subsidiary
 *   • Amount and Date tolerance for auto-matching
 *   • Approver and notification email
 *   • Auto-suggest toggle
 *
 * The settings are stored in a single customrecord_bm_settings record
 * (one per NetSuite account).
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

    // ── Load (or create) the single settings record ────────────────────────
    function _loadSettings() {
        var SF     = C.SETTINGS_FIELDS;
        var result = search.create({
            type:    C.RECORDS.SETTINGS,
            filters: [['isinactive', 'is', 'F']],
            columns: Object.values(SF)
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
                suspenseAccount: row.getValue(SF.SUSPENSE_ACCOUNT)
            };
        }
        return null;
    }

    // ── Build the settings form ────────────────────────────────────────────
    function _buildForm(settings) {
        var form = ui.createForm({ title: 'Bank Match – Setup' });
        form.clientScriptModulePath = './BM_Setup_CS.js';

        // ─ Navigation shortcut ──────────────────────────────────────────────
        form.addButton({
            id:    'btn_go_main',
            label: 'Go to Reconciliation',
            functionName: 'goToMain'
        });

        // ─ Bank & Subsidiary ────────────────────────────────────────────────
        var grpBank = form.addFieldGroup({
            id:    'grp_bank',
            label: 'Bank Settings'
        });
        grpBank.isBorderHidden = false;

        var fldAccount = form.addField({
            id:       C.SETTINGS_FIELDS.BANK_ACCOUNT,
            type:     ui.FieldType.SELECT,
            label:    'Bank Account',
            source:   'account',
            container: 'grp_bank'
        });
        fldAccount.isMandatory = true;
        fldAccount.helpText = 'Select the GL bank account used for reconciliation.';

        var fldSub = form.addField({
            id:       C.SETTINGS_FIELDS.SUBSIDIARY,
            type:     ui.FieldType.SELECT,
            label:    'Subsidiary',
            source:   'subsidiary',
            container: 'grp_bank'
        });
        fldSub.helpText = 'Leave blank to match across all subsidiaries.';

        // ─ Matching Tolerances ──────────────────────────────────────────────
        var grpMatch = form.addFieldGroup({
            id:    'grp_match',
            label: 'Matching Tolerances'
        });

        var fldTolAmt = form.addField({
            id:        C.SETTINGS_FIELDS.TOLERANCE_AMT,
            type:      ui.FieldType.CURRENCY,
            label:     'Amount Tolerance',
            container: 'grp_match'
        });
        fldTolAmt.defaultValue = '0.01';
        fldTolAmt.helpText = 'Maximum allowed difference between bank amount and NetSuite amount.';

        var fldTolDays = form.addField({
            id:        C.SETTINGS_FIELDS.TOLERANCE_DAYS,
            type:      ui.FieldType.INTEGER,
            label:     'Date Tolerance (days)',
            container: 'grp_match'
        });
        fldTolDays.defaultValue = '5';
        fldTolDays.helpText = 'Maximum number of days difference for date matching.';

        var fldAutoSuggest = form.addField({
            id:        C.SETTINGS_FIELDS.AUTO_SUGGEST,
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
            'Status to <strong>Approved</strong>.' +
            '</div>';

        var fldApprover = form.addField({
            id:        C.SETTINGS_FIELDS.APPROVER,
            type:      ui.FieldType.SELECT,
            label:     'Approver',
            source:    'employee',
            container: 'grp_approval'
        });
        fldApprover.isMandatory = true;

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
            id:        C.SETTINGS_FIELDS.FEE_ACCOUNT,
            type:      ui.FieldType.SELECT,
            label:     'Default Bank Fee Account',
            source:    'account',
            container: 'grp_gl'
        });
        fldFeeAcct.helpText = 'GL expense account for variance write-offs on tolerance matches.';

        var fldSuspenseAcct = form.addField({
            id:        C.SETTINGS_FIELDS.SUSPENSE_ACCOUNT,
            type:      ui.FieldType.SELECT,
            label:     'Default Suspense Account',
            source:    'account',
            container: 'grp_gl'
        });
        fldSuspenseAcct.helpText = 'Quick-select default GL account shown in Manual Match for unknown transactions.';

        // ─ Set current values if settings exist ─────────────────────────────
        if (settings) {
            form.addField({ id: 'custpage_settings_id', type: ui.FieldType.TEXT, label: 'Settings ID' })
                .updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN })
                .defaultValue = settings.id;

            fldAccount.defaultValue      = settings.bankAccount;
            fldSub.defaultValue          = settings.subsidiary;
            fldTolAmt.defaultValue       = settings.tolAmt     || '50.00';
            fldTolDays.defaultValue      = settings.tolDays    || '5';
            fldApprover.defaultValue     = settings.approver;
            fldAutoSuggest.defaultValue  = settings.autoSuggest === 'T' ? 'T' : 'F';
            fldFeeAcct.defaultValue      = settings.feeAccount      || '';
            fldSuspenseAcct.defaultValue = settings.suspenseAccount || '';
        } else {
            fldTolAmt.defaultValue  = '50.00';
            fldTolDays.defaultValue = '5';
        }

        form.addSubmitButton({ label: 'Save Settings' });
        return form;
    }

    // ── Save settings from POST ───────────────────────────────────────────
    function _saveSettings(params) {
        var SF         = C.SETTINGS_FIELDS;
        var settingsId = params.custpage_settings_id;
        var values = {};
        values[SF.BANK_ACCOUNT]      = params[SF.BANK_ACCOUNT];
        values[SF.SUBSIDIARY]        = params[SF.SUBSIDIARY]       || '';
        values[SF.TOLERANCE_AMT]     = params[SF.TOLERANCE_AMT];
        values[SF.TOLERANCE_DAYS]    = params[SF.TOLERANCE_DAYS];
        values[SF.APPROVER]          = params[SF.APPROVER];
        values[SF.AUTO_SUGGEST]      = params[SF.AUTO_SUGGEST]     || 'F';
        values[SF.FEE_ACCOUNT]       = params[SF.FEE_ACCOUNT]      || '';
        values[SF.SUSPENSE_ACCOUNT]  = params[SF.SUSPENSE_ACCOUNT] || '';

        if (settingsId) {
            record.submitFields({
                type:    C.RECORDS.SETTINGS,
                id:      settingsId,
                values:  values,
                options: { ignoreMandatoryFields: true }
            });
            log.audit('BM_Setup_SL', 'Settings updated, id=' + settingsId);
        } else {
            var rec = record.create({ type: C.RECORDS.SETTINGS });
            Object.keys(values).forEach(function (fid) {
                rec.setValue({ fieldId: fid, value: values[fid] });
            });
            var newId = rec.save();
            log.audit('BM_Setup_SL', 'Settings created, id=' + newId);
        }
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

        // GET
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
