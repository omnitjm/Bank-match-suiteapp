/**
 * BM_Setup_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the Setup page.
 *
 * Subsidiary cascade:
 *   When the user changes the Subsidiary dropdown, the page reloads with
 *   ?custpage_sel_sub=<subsidiaryId>.  The server then populates the Bank
 *   Account list with only bank-type accounts for that subsidiary.
 */
define(['N/url'], function (url) {
    'use strict';

    function pageInit(context) {
        // Nothing needed on load
    }

    /**
     * When Subsidiary changes, reload the page so the server can populate
     * the Bank Account dropdown with accounts for that subsidiary.
     */
    var _subReloadTimer = null;

    function fieldChanged(context) {
        if (context.fieldId !== 'custrecord_bm_subsidiary') return;

        var subId = context.currentRecord.getValue({ fieldId: 'custrecord_bm_subsidiary' });
        if (!subId) return;

        // Debounce: wait 300ms to ensure the selection is confirmed before reloading
        if (_subReloadTimer) clearTimeout(_subReloadTimer);
        _subReloadTimer = setTimeout(function () {
            var newUrl = url.resolveScript({
                scriptId:          'customscript_bm_setup_sl',
                deploymentId:      'customdeploy_bm_setup_sl',
                params:            { custpage_sel_sub: subId },
                returnExternalUrl: false
            });
            window.onbeforeunload = null;
            window.location.href = newUrl;
        }, 300);
    }

    /**
     * Navigate to the main reconciliation dashboard.
     */
    function goToMain() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false
        });
    }

    /**
     * Navigate to the Reconciliation Rules builder.
     */
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
