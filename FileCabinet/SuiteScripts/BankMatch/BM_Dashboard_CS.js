/**
 * BM_Dashboard_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the main Bank Match dashboard.
 */
define(['N/url', 'N/currentRecord'], function (url, currentRecord) {
    'use strict';

    function pageInit(context) {
        // Highlight the "Pending Approvals" tab if there are pending items
    }

    function goImport() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            params:            { action: 'import' },
            returnExternalUrl: false
        });
    }

    function goSetup() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_setup_sl',
            deploymentId:      'customdeploy_bm_setup_sl',
            returnExternalUrl: false
        });
    }

    function goBack() {
        window.history.back();
    }

    return {
        pageInit:  pageInit,
        goImport:  goImport,
        goSetup:   goSetup,
        goBack:    goBack
    };
});
