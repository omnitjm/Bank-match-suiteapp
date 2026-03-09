/**
 * BM_Rules_SL.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType Suitelet
 *
 * Bank Match – Reconciliation Rules Builder
 *
 * Lets admins define rules that control how the auto-match engine treats
 * bank lines.  Rules are evaluated in priority order (lowest number = first)
 * before the waterfall matching engine runs.
 *
 * ── Rule anatomy ─────────────────────────────────────────────────────────
 * Each rule has:
 *   • Name        – human-readable label
 *   • Priority    – integer; rules are evaluated lowest-first (e.g. 10 before 20)
 *   • Condition   – Field (description | amount | reference)
 *               + Operator (contains | equals | startswith | endswith | regex)
 *               + Value (text to match against)
 *   • Action      – What to do when the condition is met:
 *       auto_approve   – create a Pending proposal AND auto-approve it immediately
 *       create_pending – create a Pending proposal (default engine behaviour)
 *       skip           – ignore this bank line (mark as Excluded)
 *   • Is Active   – checkbox; inactive rules are ignored
 *
 * ── Routes ───────────────────────────────────────────────────────────────
 *   GET  (no action)        → list all rules
 *   GET  action=new         → blank create form
 *   GET  action=edit&id=X   → pre-filled edit form
 *   GET  action=delete&id=X → delete record, redirect to list
 *   POST                    → save (create or update), redirect to list
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

    var RF = C.RULE_FIELDS;

    // ── List all rules ────────────────────────────────────────────────────

    function _renderList(context, flash) {
        var form = ui.createForm({ title: 'Bank Match – Reconciliation Rules' });
        form.clientScriptModulePath = './BM_Rules_CS.js';

        form.addButton({
            id:           'btn_new_rule',
            label:        '+ Add Rule',
            functionName: 'addRule'
        });
        form.addButton({
            id:           'btn_back_setup',
            label:        '← Settings',
            functionName: 'goSetup'
        });
        form.addButton({
            id:           'btn_back_main',
            label:        'Go to Reconciliation',
            functionName: 'goMain'
        });

        if (flash) {
            var fldFlash = form.addField({
                id:    'custpage_flash',
                type:  ui.FieldType.INLINEHTML,
                label: ' '
            });
            var isError = flash.indexOf('ERROR') === 0;
            var bgColor = isError ? '#ffebee' : '#e8f5e9';
            var bColor  = isError ? '#ef9a9a' : '#a5d6a7';
            fldFlash.defaultValue =
                '<div style="background:' + bgColor + ';border:1px solid ' + bColor + ';' +
                'padding:10px 14px;border-radius:4px;margin-bottom:8px;font-size:13px;">' +
                flash + '</div>';
        }

        // Info banner
        var info = form.addField({
            id:    'custpage_info',
            type:  ui.FieldType.INLINEHTML,
            label: ' '
        });
        info.defaultValue = [
            '<div style="background:#f3f4f6;border-left:4px solid #1565c0;',
            'padding:8px 14px;border-radius:4px;margin-bottom:8px;font-size:12px;line-height:1.7;">',
            '<strong>Reconciliation Rules</strong> are evaluated in priority order before the ',
            'waterfall matching engine runs. Use them to automatically approve known transactions ',
            '(e.g. bank fees, payroll runs) or to skip lines that should never be matched.<br>',
            '<strong>Priority:</strong> lower number = evaluated first. ',
            '<strong>Actions:</strong> ',
            '<em>Auto Approve</em> — propose + immediately approve; ',
            '<em>Create Pending</em> — propose (approver reviews); ',
            '<em>Skip</em> — exclude this line from matching.',
            '</div>'
        ].join('');

        // Rules sublist
        var sb = form.addSublist({
            id:    'sl_rules',
            type:  ui.SublistType.LIST,
            label: 'Rules'
        });
        sb.addField({ id: 'rl_priority',   type: ui.FieldType.INTEGER, label: 'Priority' });
        sb.addField({ id: 'rl_name',       type: ui.FieldType.TEXT,    label: 'Name' });
        sb.addField({ id: 'rl_condition',  type: ui.FieldType.TEXT,    label: 'Condition' });
        sb.addField({ id: 'rl_action',     type: ui.FieldType.TEXT,    label: 'Action' });
        sb.addField({ id: 'rl_active',     type: ui.FieldType.TEXT,    label: 'Active' });
        sb.addField({ id: 'rl_edit',       type: ui.FieldType.URL,     label: 'Edit' }).linkText = 'Edit';
        sb.addField({ id: 'rl_delete',     type: ui.FieldType.URL,     label: 'Delete' }).linkText = 'Delete';

        // Load rules ordered by priority
        var rules = [];
        search.create({
            type:    C.RECORDS.RULE,
            filters: [['isinactive', 'is', 'F']],
            columns: [
                'internalid', RF.NAME, RF.PRIORITY,
                RF.COND_FIELD, RF.COND_OP, RF.COND_VALUE,
                RF.ACTION, RF.IS_ACTIVE,
                search.createColumn({ name: RF.PRIORITY, sort: search.Sort.ASC })
            ]
        }).run().each(function (row) {
            rules.push({
                id:         row.id,
                name:       row.getValue(RF.NAME)       || '—',
                priority:   row.getValue(RF.PRIORITY)   || 10,
                condField:  row.getValue(RF.COND_FIELD) || '',
                condOp:     row.getValue(RF.COND_OP)    || '',
                condValue:  row.getValue(RF.COND_VALUE) || '',
                action:     row.getValue(RF.ACTION)     || '',
                isActive:   row.getValue(RF.IS_ACTIVE)
            });
            return rules.length < 500;
        });

        var ACTION_LABELS = {
            auto_approve:   'Auto Approve',
            create_pending: 'Create Pending',
            skip:           'Skip'
        };
        var FIELD_LABELS = {
            description: 'Description',
            amount:      'Amount',
            reference:   'Reference'
        };
        var OP_LABELS = {
            contains:   'contains',
            equals:     '=',
            startswith: 'starts with',
            endswith:   'ends with',
            regex:      'matches regex'
        };

        var baseUrl = url.resolveScript({
            scriptId:          C.SCRIPTS.RULES_SL,
            deploymentId:      C.SCRIPTS.RULES_DEPLOY,
            returnExternalUrl: false
        });

        rules.forEach(function (r, i) {
            var condLabel = (FIELD_LABELS[r.condField] || r.condField) + ' ' +
                            (OP_LABELS[r.condOp]    || r.condOp) + ' "' +
                            (r.condValue || '') + '"';
            sb.setSublistValue({ id: 'rl_priority',  line: i, value: r.priority });
            sb.setSublistValue({ id: 'rl_name',      line: i, value: r.name });
            sb.setSublistValue({ id: 'rl_condition', line: i, value: condLabel });
            sb.setSublistValue({ id: 'rl_action',    line: i, value: ACTION_LABELS[r.action] || r.action });
            sb.setSublistValue({ id: 'rl_active',    line: i, value: (r.isActive === 'T' || r.isActive === true) ? 'Yes' : 'No' });
            sb.setSublistValue({ id: 'rl_edit',      line: i, value: baseUrl + '&action=edit&id=' + r.id });
            sb.setSublistValue({ id: 'rl_delete',    line: i, value: baseUrl + '&action=delete&id=' + r.id });
        });

        if (rules.length === 0) {
            var noRules = form.addField({
                id:    'custpage_no_rules',
                type:  ui.FieldType.INLINEHTML,
                label: ' '
            });
            noRules.defaultValue =
                '<div style="color:#555;font-size:13px;padding:8px 0;">' +
                'No rules defined yet. Click <strong>+ Add Rule</strong> to create your first rule.' +
                '</div>';
        }

        context.response.writePage(form);
    }

    // ── Build create/edit form ────────────────────────────────────────────

    function _renderEditForm(context, ruleId) {
        var isNew = !ruleId;
        var form  = ui.createForm({ title: isNew ? 'Add Reconciliation Rule' : 'Edit Reconciliation Rule' });
        form.clientScriptModulePath = './BM_Rules_CS.js';

        form.addButton({
            id:           'btn_cancel',
            label:        '← Back to Rules',
            functionName: 'goRules'
        });

        // Load existing rule if editing
        var rule = null;
        if (!isNew) {
            try {
                var ruleRec = record.load({ type: C.RECORDS.RULE, id: ruleId });
                rule = {
                    name:       ruleRec.getValue({ fieldId: RF.NAME })       || '',
                    priority:   ruleRec.getValue({ fieldId: RF.PRIORITY })   || 10,
                    condField:  ruleRec.getValue({ fieldId: RF.COND_FIELD }) || 'description',
                    condOp:     ruleRec.getValue({ fieldId: RF.COND_OP })    || 'contains',
                    condValue:  ruleRec.getValue({ fieldId: RF.COND_VALUE }) || '',
                    action:     ruleRec.getValue({ fieldId: RF.ACTION })     || 'create_pending',
                    isActive:   ruleRec.getValue({ fieldId: RF.IS_ACTIVE })
                };
            } catch (e) {
                log.error('BM_Rules_SL', 'Could not load rule ' + ruleId + ': ' + e.message);
            }
        }

        // Hidden: rule ID (for update) and action
        form.addField({ id: 'custpage_rule_id', type: ui.FieldType.TEXT, label: 'Rule ID' })
            .updateDisplayType({ displayType: ui.FieldDisplayType.HIDDEN })
            .defaultValue = ruleId || '';

        // ─ Rule Definition ────────────────────────────────────────────────
        var grpRule = form.addFieldGroup({ id: 'grp_rule', label: 'Rule Definition' });

        var fldName = form.addField({
            id:        'custpage_rule_name',
            type:      ui.FieldType.TEXT,
            label:     'Rule Name',
            container: 'grp_rule'
        });
        fldName.isMandatory = true;
        fldName.helpText    = 'A short, descriptive name (e.g. "Bank Fee – Auto Approve").';
        if (rule) fldName.defaultValue = rule.name;

        var fldPriority = form.addField({
            id:        'custpage_rule_priority',
            type:      ui.FieldType.INTEGER,
            label:     'Priority',
            container: 'grp_rule'
        });
        fldPriority.helpText    = 'Lower number = evaluated first. Default: 10.';
        fldPriority.defaultValue = rule ? String(rule.priority) : '10';

        var fldActive = form.addField({
            id:        'custpage_rule_is_active',
            type:      ui.FieldType.CHECKBOX,
            label:     'Active',
            container: 'grp_rule'
        });
        fldActive.defaultValue = (rule && (rule.isActive === 'F' || rule.isActive === false)) ? 'F' : 'T';

        // ─ Condition ─────────────────────────────────────────────────────
        var grpCond = form.addFieldGroup({ id: 'grp_cond', label: 'Condition (when this is true…)' });

        var fldCondField = form.addField({
            id:        'custpage_rule_cond_field',
            type:      ui.FieldType.SELECT,
            label:     'Bank Line Field',
            container: 'grp_cond'
        });
        fldCondField.addSelectOption({ value: 'description', text: 'Description (bank memo/narrative)' });
        fldCondField.addSelectOption({ value: 'amount',      text: 'Amount (numeric)' });
        fldCondField.addSelectOption({ value: 'reference',   text: 'Reference (bank ref / check number)' });
        if (rule) fldCondField.defaultValue = rule.condField;

        var fldCondOp = form.addField({
            id:        'custpage_rule_cond_op',
            type:      ui.FieldType.SELECT,
            label:     'Operator',
            container: 'grp_cond'
        });
        fldCondOp.addSelectOption({ value: 'contains',   text: 'contains' });
        fldCondOp.addSelectOption({ value: 'equals',     text: 'equals (exact match)' });
        fldCondOp.addSelectOption({ value: 'startswith', text: 'starts with' });
        fldCondOp.addSelectOption({ value: 'endswith',   text: 'ends with' });
        fldCondOp.addSelectOption({ value: 'regex',      text: 'matches regex' });
        if (rule) fldCondOp.defaultValue = rule.condOp;

        var fldCondValue = form.addField({
            id:        'custpage_rule_cond_value',
            type:      ui.FieldType.TEXT,
            label:     'Value',
            container: 'grp_cond'
        });
        fldCondValue.isMandatory = true;
        fldCondValue.helpText    = 'Text to match against. Case-insensitive for contains/equals/startswith/endswith.';
        if (rule) fldCondValue.defaultValue = rule.condValue;

        // ─ Action ─────────────────────────────────────────────────────────
        var grpAction = form.addFieldGroup({ id: 'grp_action', label: '… perform this action' });

        var fldAction = form.addField({
            id:        'custpage_rule_action',
            type:      ui.FieldType.SELECT,
            label:     'Action',
            container: 'grp_action'
        });
        fldAction.addSelectOption({ value: 'create_pending', text: 'Create Pending Proposal (approver reviews)' });
        fldAction.addSelectOption({ value: 'auto_approve',   text: 'Auto Approve (no manual review needed)' });
        fldAction.addSelectOption({ value: 'skip',           text: 'Skip / Exclude this bank line' });
        fldAction.helpText = '"Auto Approve" is recommended for recurring, known transactions like bank fees or payroll.';
        if (rule) fldAction.defaultValue = rule.action;

        form.addSubmitButton({ label: isNew ? 'Create Rule' : 'Save Changes' });
        context.response.writePage(form);
    }

    // ── Save rule (POST) ──────────────────────────────────────────────────

    function _saveRule(params) {
        var ruleId   = params.custpage_rule_id;
        var isActive = params.custpage_rule_is_active === 'T' ? true : false;

        var rec = ruleId
            ? record.load({ type: C.RECORDS.RULE, id: ruleId })
            : record.create({ type: C.RECORDS.RULE });

        rec.setValue({ fieldId: RF.NAME,       value: params.custpage_rule_name      || '' });
        rec.setValue({ fieldId: RF.PRIORITY,   value: parseInt(params.custpage_rule_priority, 10) || 10 });
        rec.setValue({ fieldId: RF.COND_FIELD, value: params.custpage_rule_cond_field || 'description' });
        rec.setValue({ fieldId: RF.COND_OP,    value: params.custpage_rule_cond_op    || 'contains' });
        rec.setValue({ fieldId: RF.COND_VALUE, value: params.custpage_rule_cond_value || '' });
        rec.setValue({ fieldId: RF.ACTION,     value: params.custpage_rule_action     || 'create_pending' });
        rec.setValue({ fieldId: RF.IS_ACTIVE,  value: isActive });

        var savedId = rec.save({ ignoreMandatoryFields: true });
        log.audit('BM_Rules_SL', (ruleId ? 'Rule updated' : 'Rule created') + ' id=' + savedId);
        return savedId;
    }

    // ── Delete rule ───────────────────────────────────────────────────────

    function _deleteRule(ruleId) {
        record.delete({ type: C.RECORDS.RULE, id: ruleId });
        log.audit('BM_Rules_SL', 'Rule deleted id=' + ruleId);
    }

    // ── Rules URL helper ──────────────────────────────────────────────────

    function _rulesUrl(params) {
        return url.resolveScript({
            scriptId:          C.SCRIPTS.RULES_SL,
            deploymentId:      C.SCRIPTS.RULES_DEPLOY,
            params:            params,
            returnExternalUrl: false
        });
    }

    // ── Entry point ───────────────────────────────────────────────────────

    function onRequest(context) {
        var req    = context.request;
        var resp   = context.response;
        var params = req.parameters;

        // POST — save rule
        if (req.method === 'POST') {
            try {
                _saveRule(params);
                resp.sendRedirect({
                    type:       'SUITELET',
                    identifier: C.SCRIPTS.RULES_SL,
                    id:         C.SCRIPTS.RULES_DEPLOY,
                    parameters: { flash: encodeURIComponent('Rule saved successfully.') }
                });
            } catch (e) {
                log.error('BM_Rules_SL.save', e.message);
                resp.sendRedirect({
                    type:       'SUITELET',
                    identifier: C.SCRIPTS.RULES_SL,
                    id:         C.SCRIPTS.RULES_DEPLOY,
                    parameters: { flash: encodeURIComponent('ERROR saving rule: ' + e.message) }
                });
            }
            return;
        }

        // GET
        var action = params.action || '';
        var ruleId = params.id     || '';
        var flash  = params.flash ? decodeURIComponent(params.flash) : '';

        switch (action) {
            case 'new':
                _renderEditForm(context, null);
                break;

            case 'edit':
                if (!ruleId) {
                    resp.sendRedirect({
                        type: 'SUITELET', identifier: C.SCRIPTS.RULES_SL, id: C.SCRIPTS.RULES_DEPLOY,
                        parameters: { flash: encodeURIComponent('ERROR: no rule ID specified.') }
                    });
                    return;
                }
                _renderEditForm(context, ruleId);
                break;

            case 'delete':
                if (!ruleId) {
                    resp.sendRedirect({
                        type: 'SUITELET', identifier: C.SCRIPTS.RULES_SL, id: C.SCRIPTS.RULES_DEPLOY,
                        parameters: { flash: encodeURIComponent('ERROR: no rule ID specified.') }
                    });
                    return;
                }
                try {
                    _deleteRule(ruleId);
                    resp.sendRedirect({
                        type: 'SUITELET', identifier: C.SCRIPTS.RULES_SL, id: C.SCRIPTS.RULES_DEPLOY,
                        parameters: { flash: encodeURIComponent('Rule deleted.') }
                    });
                } catch (delErr) {
                    resp.sendRedirect({
                        type: 'SUITELET', identifier: C.SCRIPTS.RULES_SL, id: C.SCRIPTS.RULES_DEPLOY,
                        parameters: { flash: encodeURIComponent('ERROR deleting rule: ' + delErr.message) }
                    });
                }
                break;

            default:
                _renderList(context, flash);
                break;
        }
    }

    return { onRequest: onRequest };
});
