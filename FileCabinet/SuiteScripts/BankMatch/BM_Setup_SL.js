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
        var result = search.create({
            type: C.RECORDS.SETTINGS,
            filters: [['isinactive', 'is', 'F']],
            columns: Object.values(C.SETTINGS_FIELDS)
        }).run().getRange({ start: 0, end: 1 });

        if (result && result.length > 0) {
            var row = result[0];
            return {
                id:          row.id,
                bankAccount: row.getValue(C.SETTINGS_FIELDS.BANK_ACCOUNT),
                subsidiary:  row.getValue(C.SETTINGS_FIELDS.SUBSIDIARY),
                tolAmt:      row.getValue(C.SETTINGS_FIELDS.TOLERANCE_AMT),
                tolDays:     row.getValue(C.SETTINGS_FIELDS.TOLERANCE_DAYS),
                approver:    row.getValue(C.SETTINGS_FIELDS.APPROVER),
                notifyEmail: row.getValue(C.SETTINGS_FIELDS.NOTIFY_EMAIL),
                autoSuggest: row.getValue(C.SETTINGS_FIELDS.AUTO_SUGGEST)
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
            'is applied. The approver below will receive an email for each pending proposal.' +
            '</div>';

        var fldApprover = form.addField({
            id:        C.SETTINGS_FIELDS.APPROVER,
            type:      ui.FieldType.SELECT,
            label:     'Approver',
            source:    'employee',
            container: 'grp_approval'
        });
        fldApprover.isMandatory = true;

        var fldEmail = form.addField({
            id:        C.SETTINGS_FIELDS.NOTIFY_EMAIL,
            type:      ui.FieldType.EMAIL,
            label:     'Notification Email',
            container: 'grp_approval'
        });
        fldEmail.helpText = 'Override email address for approval notifications. Leave blank to use the approver\'s NetSuite email.';

        // ─ Set current values if settings exist ─────────────────────────────
        if (settings) {
            form.addField({ id: 'custpage_settings_id', type: ui.FieldType.TEXT, label: 'Settings ID' })
                .updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN })
                .defaultValue = settings.id;

            fldAccount.defaultValue    = settings.bankAccount;
            fldSub.defaultValue        = settings.subsidiary;
            fldTolAmt.defaultValue     = settings.tolAmt || '0.01';
            fldTolDays.defaultValue    = settings.tolDays || '5';
            fldApprover.defaultValue   = settings.approver;
            fldEmail.defaultValue      = settings.notifyEmail;
            fldAutoSuggest.defaultValue = settings.autoSuggest === 'T' ? 'T' : 'F';
        }

        form.addSubmitButton({ label: 'Save Settings' });
        return form;
    }

    // ── Save settings from POST ───────────────────────────────────────────
    function _saveSettings(params) {
        var settingsId = params.custpage_settings_id;
        var values = {};
        values[C.SETTINGS_FIELDS.BANK_ACCOUNT]   = params[C.SETTINGS_FIELDS.BANK_ACCOUNT];
        values[C.SETTINGS_FIELDS.SUBSIDIARY]      = params[C.SETTINGS_FIELDS.SUBSIDIARY] || '';
        values[C.SETTINGS_FIELDS.TOLERANCE_AMT]   = params[C.SETTINGS_FIELDS.TOLERANCE_AMT];
        values[C.SETTINGS_FIELDS.TOLERANCE_DAYS]  = params[C.SETTINGS_FIELDS.TOLERANCE_DAYS];
        values[C.SETTINGS_FIELDS.APPROVER]        = params[C.SETTINGS_FIELDS.APPROVER];
        values[C.SETTINGS_FIELDS.NOTIFY_EMAIL]    = params[C.SETTINGS_FIELDS.NOTIFY_EMAIL] || '';
        values[C.SETTINGS_FIELDS.AUTO_SUGGEST]    = params[C.SETTINGS_FIELDS.AUTO_SUGGEST] || 'F';

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
