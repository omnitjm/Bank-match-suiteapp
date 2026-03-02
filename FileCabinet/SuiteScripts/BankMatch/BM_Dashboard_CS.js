/**
 * BM_Dashboard_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the Bank Match Central Suitelet.
 * Handles button actions and sublist interactions in the UI.
 */
define(['N/url'], function (url) {
    'use strict';

    function pageInit() { /* no init needed */ }

    // ── Settings navigation ───────────────────────────────────────────────

    /** Open the Bank Match Settings page */
    function goSetup() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_setup_sl',
            deploymentId:      'customdeploy_bm_setup_sl',
            returnExternalUrl: false
        });
    }

    /** Navigate back in browser history */
    function goBack() { window.history.back(); }

    // ── Main Central page actions ─────────────────────────────────────────

    /**
     * "Run Auto-Match" button — reads filter fields and navigates to
     * action=run_automatch with the selected filters as URL params.
     */
    function runAutoMatch() {
        var acctEl = document.getElementById('custpage_filter_account');
        var fromEl = document.getElementById('custpage_filter_from');
        var toEl   = document.getElementById('custpage_filter_to');

        var p = { action: 'run_automatch' };
        if (acctEl && acctEl.value) p.account   = acctEl.value;
        if (fromEl && fromEl.value) p.date_from = fromEl.value;
        if (toEl   && toEl.value)   p.date_to   = toEl.value;

        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false,
            params:            p
        });
    }

    /**
     * "Approve All Pending" button — navigates to action=approve_all.
     * The server approves every pending proposal in one shot.
     */
    function approveAll() {
        if (!confirm('Approve ALL pending proposals? This will create the corresponding ' +
                     'NetSuite transactions immediately. Continue?')) return;
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false,
            params:            { action: 'approve_all' }
        });
    }

    /**
     * "Mark All" button on the Proposals sublist.
     * Checks every "Approve?" checkbox in sl_proposals.
     */
    function markAllApprovals() {
        _toggleAllApproveCheckboxes(true);
    }

    /**
     * "Clear All" button on the Proposals sublist.
     * Unchecks every "Approve?" checkbox in sl_proposals.
     */
    function unmarkAllApprovals() {
        _toggleAllApproveCheckboxes(false);
    }

    function _toggleAllApproveCheckboxes(checked) {
        // NetSuite renders INLINEEDITOR checkboxes as <input type="checkbox">
        // within the sublist table. Try multiple selector strategies.
        var candidates = [];

        // Strategy 1: find by name attribute containing slp_approve
        var byName = document.querySelectorAll('input[type="checkbox"][name*="slp_approve"]');
        byName.forEach(function (el) { candidates.push(el); });

        // Strategy 2: find within the sublist container by ID prefix
        if (!candidates.length) {
            var container = document.getElementById('sl_proposals');
            if (container) {
                var byType = container.querySelectorAll('input[type="checkbox"]');
                byType.forEach(function (el) { candidates.push(el); });
            }
        }

        // Strategy 3: broader search (fallback)
        if (!candidates.length) {
            var allChecks = document.querySelectorAll(
                '[id*="slp_approve"] input[type="checkbox"],' +
                'input[id*="slp_approve"]'
            );
            allChecks.forEach(function (el) { candidates.push(el); });
        }

        candidates.forEach(function (cb) {
            if (!cb.disabled && cb.checked !== checked) {
                cb.click(); // use click() to trigger NetSuite's onChange handlers
            }
        });
    }

    // ── Manual Match page — Option A (Customer Invoice) ───────────────────

    /**
     * "Find Open Invoices" button — reads the Customer SELECT field and
     * navigates to entity_invoices with the bank line context params.
     */
    function findInvoices() {
        var entitySel = document.getElementById('custpage_entity_a');
        if (!entitySel || !entitySel.value) {
            alert('Please select a Customer first.');
            return;
        }
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false,
            params: {
                action:    'entity_invoices',
                entity_id: entitySel.value,
                bankline:  _hidden('custpage_h_bankline'),
                bl_date:   _hidden('custpage_h_bl_date'),
                bl_amt:    _hidden('custpage_h_bl_amt'),
                bl_ref:    _hidden('custpage_h_bl_ref'),
                bl_desc:   _hidden('custpage_h_bl_desc')
            }
        });
    }

    // ── Manual Match page — Option B (Vendor Bill) ────────────────────────

    /**
     * "Find Open Bills" button — reads the Vendor SELECT field and
     * navigates to entity_bills with the bank line context params.
     */
    function findBills() {
        var entitySel = document.getElementById('custpage_entity_b');
        if (!entitySel || !entitySel.value) {
            alert('Please select a Vendor first.');
            return;
        }
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false,
            params: {
                action:    'entity_bills',
                entity_id: entitySel.value,
                bankline:  _hidden('custpage_h_bankline'),
                bl_date:   _hidden('custpage_h_bl_date'),
                bl_amt:    _hidden('custpage_h_bl_amt'),
                bl_ref:    _hidden('custpage_h_bl_ref'),
                bl_desc:   _hidden('custpage_h_bl_desc')
            }
        });
    }

    // ── Utility ───────────────────────────────────────────────────────────

    /** Read value from a hidden field by element ID */
    function _hidden(id) {
        var el = document.getElementById(id);
        return el ? (el.value || '') : '';
    }

    // ── Backward-compat alias ─────────────────────────────────────────────
    function findEntityRecords() { findInvoices(); }

    return {
        pageInit:            pageInit,
        goSetup:             goSetup,
        goBack:              goBack,
        runAutoMatch:        runAutoMatch,
        approveAll:          approveAll,
        markAllApprovals:    markAllApprovals,
        unmarkAllApprovals:  unmarkAllApprovals,
        findInvoices:        findInvoices,
        findBills:           findBills,
        findEntityRecords:   findEntityRecords
    };
});
