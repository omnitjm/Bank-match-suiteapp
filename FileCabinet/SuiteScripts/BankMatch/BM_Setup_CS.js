/**
 * BM_Setup_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the Setup page.
 * User selects the Bank Account; subsidiary is derived server-side on save.
 */
define(['N/url'], function (url) {
    'use strict';

    function pageInit(context) {
        // Nothing needed on load
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
        pageInit:  pageInit,
        goToMain:  goToMain,
        goToRules: goToRules
    };
});
