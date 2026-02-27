/**
 * BM_Dashboard_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the Bank Match dashboard and match-selection pages.
 */
define(['N/url'], function (url) {
    'use strict';

    function pageInit() { /* no init needed */ }

    /** Open the native Match Bank Data page in a new tab */
    function goNative() {
        window.open('/app/accounting/transactions/bank/reconciliation/matchbankdata.nl', '_blank');
    }

    /** Open the Bank Match settings page */
    function goSetup() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_setup_sl',
            deploymentId:      'customdeploy_bm_setup_sl',
            returnExternalUrl: false
        });
    }

    /** Navigate back */
    function goBack() { window.history.back(); }

    return { pageInit: pageInit, goNative: goNative, goSetup: goSetup, goBack: goBack };
});
