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

    /**
     * Called by the "Find Open Invoices / Find Vendor Payments" button on the match page.
     * Reads the entity SELECT field and navigates to the entity_match action.
     */
    function findEntityRecords() {
        var entitySel = document.getElementById('custpage_entity_sel');
        if (!entitySel || !entitySel.value) {
            alert('Please select a customer or vendor first.');
            return;
        }
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false,
            params: {
                action:    'entity_match',
                entity_id: entitySel.value,
                txn_type:  (document.getElementById('custpage_h_txn_type') || {}).value || '1',
                bankline:  (document.getElementById('custpage_h_bankline') || {}).value || '',
                bl_date:   (document.getElementById('custpage_h_bl_date')  || {}).value || '',
                bl_amt:    (document.getElementById('custpage_h_bl_amt')   || {}).value || '0',
                bl_ref:    (document.getElementById('custpage_h_bl_ref')   || {}).value || ''
            }
        });
    }

    return {
        pageInit:          pageInit,
        goNative:          goNative,
        goSetup:           goSetup,
        goBack:            goBack,
        findEntityRecords: findEntityRecords
    };
});
