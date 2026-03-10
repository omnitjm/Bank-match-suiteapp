/**
 * BM_Setup_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the Setup page.
 * When the user selects a different Bank Account, the page reloads to show
 * that account's saved settings (per-account configuration).
 */
define(['N/url'], function (url) {
    'use strict';

    function pageInit(context) {
        // Nothing needed on load
    }

    /**
     * When bank account selection changes, reload the page so the server
     * loads the saved settings for that specific bank account.
     */
    function fieldChanged(context) {
        if (context.fieldId !== 'custpage_bank_acct_sel') return;
        var acctId = context.currentRecord.getValue({ fieldId: 'custpage_bank_acct_sel' });
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_setup_sl',
            deploymentId:      'customdeploy_bm_setup_sl',
            returnExternalUrl: false,
            params:            { sel_account: acctId || '' }
        });
    }

    function goToMain() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false
        });
    }

    function goToRules() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_rules_sl',
            deploymentId:      'customdeploy_bm_rules_sl',
            returnExternalUrl: false
        });
    }

    return {
        pageInit:     pageInit,
        fieldChanged: fieldChanged,
        goToMain:     goToMain,
        goToRules:    goToRules
    };
});
