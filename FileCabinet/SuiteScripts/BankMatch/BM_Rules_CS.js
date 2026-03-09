/**
 * BM_Rules_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the Reconciliation Rules builder.
 */
define(['N/url'], function (url) {
    'use strict';

    function pageInit(context) {
        // Nothing needed on load
    }

    /** Navigate to the rules list page. */
    function goRules() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_rules_sl',
            deploymentId:      'customdeploy_bm_rules_sl',
            returnExternalUrl: false
        });
    }

    /** Navigate to the Settings page. */
    function goSetup() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_setup_sl',
            deploymentId:      'customdeploy_bm_setup_sl',
            returnExternalUrl: false
        });
    }

    /** Navigate to the main reconciliation dashboard. */
    function goMain() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false
        });
    }

    /** Navigate to the new-rule form. */
    function addRule() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_rules_sl',
            deploymentId:      'customdeploy_bm_rules_sl',
            params:            { action: 'new' },
            returnExternalUrl: false
        });
    }

    return {
        pageInit: pageInit,
        goRules:  goRules,
        goSetup:  goSetup,
        goMain:   goMain,
        addRule:  addRule
    };
});
