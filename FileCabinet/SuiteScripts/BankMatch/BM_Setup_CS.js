/**
 * BM_Setup_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the Setup page.
 */
define(['N/url'], function (url) {
    'use strict';

    function pageInit(context) {
        // Nothing needed on load
    }

    /**
     * Navigate to the main reconciliation dashboard.
     */
    function goToMain() {
        window.location.href = url.resolveScript({
            scriptId:   'customscript_bm_main_sl',
            deploymentId: 'customdeploy_bm_main_sl',
            returnExternalUrl: false
        });
    }

    return {
        pageInit: pageInit,
        goToMain: goToMain
    };
});
