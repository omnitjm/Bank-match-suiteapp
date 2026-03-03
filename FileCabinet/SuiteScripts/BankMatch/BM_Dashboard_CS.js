/**
 * BM_Dashboard_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the Bank Match Central Suitelet.
 *
 * New in this version:
 *   - goOverview()    – navigate back to the Global Overview (Master view)
 *   - fieldChanged()  – when Subsidiary changes in the workspace filters,
 *                       reload the page so the Bank Account dropdown is
 *                       re-populated server-side with only accounts for
 *                       the selected subsidiary (cascading filter)
 *   - runAutoMatch()  – now passes bank_account + subsidiary URL params
 */
define(['N/url', 'N/currentRecord'], function (url, currentRecord) {
    'use strict';

    function pageInit() { /* no init needed */ }

    // ── Navigation helpers ────────────────────────────────────────────────

    /** Open the Bank Match Settings page */
    function goSetup() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_setup_sl',
            deploymentId:      'customdeploy_bm_setup_sl',
            returnExternalUrl: false
        });
    }

    /** Navigate to the Global Overview (Master) — no bank_account param */
    function goOverview() {
        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false
        });
    }

    /** Navigate back in browser history */
    function goBack() { window.history.back(); }

    // ── Cascading Subsidiary → Bank Account filter ─────────────────────────

    /**
     * fieldChanged event.
     * When the user picks a different Subsidiary in the workspace filter,
     * reload the page with the new subsidiary param so the server can
     * re-populate the Bank Account dropdown with only accounts for that
     * subsidiary — preventing cross-subsidiary mismatches.
     */
    function fieldChanged(context) {
        if (context.fieldId !== 'custpage_filter_subsidiary') return;

        var rec         = context.currentRecord;
        var subsidiaryId  = rec.getValue({ fieldId: 'custpage_filter_subsidiary' }) || '';
        var bankAccountId = ''; // reset bank account when subsidiary changes

        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false,
            params: {
                subsidiary:   subsidiaryId,
                bank_account: bankAccountId
            }
        });
    }

    // ── Main Central page actions ─────────────────────────────────────────

    /**
     * "Run Auto-Match" button — reads filter fields and navigates to
     * action=run_automatch with bank_account + subsidiary + date range params.
     */
    function runAutoMatch() {
        var rec  = currentRecord.get();

        var acctId = rec.getValue({ fieldId: 'custpage_filter_account' })     || '';
        var subId  = rec.getValue({ fieldId: 'custpage_filter_subsidiary' })  || '';
        var fromEl = document.getElementById('custpage_filter_from');
        var toEl   = document.getElementById('custpage_filter_to');

        // Fallback: read hidden fields written by server for the current account
        if (!acctId) {
            var hAcct = document.getElementById('custpage_h_bank_account');
            if (hAcct) acctId = hAcct.value;
        }
        if (!subId) {
            var hSub = document.getElementById('custpage_h_subsidiary');
            if (hSub) subId = hSub.value;
        }

        var p = { action: 'run_automatch' };
        if (acctId)              p.bank_account = acctId;
        if (subId)               p.subsidiary   = subId;
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
     */
    function approveAll() {
        if (!confirm('Approve ALL pending proposals? This will create the corresponding ' +
                     'NetSuite transactions immediately. Continue?')) return;

        var acctId = '';
        try {
            var rec   = currentRecord.get();
            acctId = rec.getValue({ fieldId: 'custpage_filter_account' }) || '';
        } catch (e) {
            var hAcct = document.getElementById('custpage_h_bank_account');
            if (hAcct) acctId = hAcct.value;
        }

        var p = { action: 'approve_all' };
        if (acctId) p.bank_account = acctId;

        window.location.href = url.resolveScript({
            scriptId:          'customscript_bm_main_sl',
            deploymentId:      'customdeploy_bm_main_sl',
            returnExternalUrl: false,
            params:            p
        });
    }

    // ── Proposal sublist checkbox helpers ─────────────────────────────────

    function markAllApprovals()   { _toggleAllApproveCheckboxes(true);  }
    function unmarkAllApprovals() { _toggleAllApproveCheckboxes(false); }

    function _toggleAllApproveCheckboxes(checked) {
        var candidates = [];

        // Strategy 1: name attribute containing slp_approve
        var byName = document.querySelectorAll('input[type="checkbox"][name*="slp_approve"]');
        byName.forEach(function (el) { candidates.push(el); });

        // Strategy 2: within the sublist container
        if (!candidates.length) {
            var container = document.getElementById('sl_proposals');
            if (container) {
                container.querySelectorAll('input[type="checkbox"]')
                    .forEach(function (el) { candidates.push(el); });
            }
        }

        // Strategy 3: broader selector fallback
        if (!candidates.length) {
            document.querySelectorAll(
                '[id*="slp_approve"] input[type="checkbox"], input[id*="slp_approve"]'
            ).forEach(function (el) { candidates.push(el); });
        }

        candidates.forEach(function (cb) {
            if (!cb.disabled && cb.checked !== checked) cb.click();
        });
    }

    // ── Manual Match page — Option A (Customer Invoice) ───────────────────

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
                action:       'entity_invoices',
                entity_id:    entitySel.value,
                bank_account: _hidden('custpage_h_bank_account'),
                subsidiary:   _hidden('custpage_h_subsidiary'),
                bankline:     _hidden('custpage_h_bankline'),
                bl_date:      _hidden('custpage_h_bl_date'),
                bl_amt:       _hidden('custpage_h_bl_amt'),
                bl_ref:       _hidden('custpage_h_bl_ref'),
                bl_desc:      _hidden('custpage_h_bl_desc')
            }
        });
    }

    // ── Manual Match page — Option B (Vendor Bill) ────────────────────────

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
                action:       'entity_bills',
                entity_id:    entitySel.value,
                bank_account: _hidden('custpage_h_bank_account'),
                subsidiary:   _hidden('custpage_h_subsidiary'),
                bankline:     _hidden('custpage_h_bankline'),
                bl_date:      _hidden('custpage_h_bl_date'),
                bl_amt:       _hidden('custpage_h_bl_amt'),
                bl_ref:       _hidden('custpage_h_bl_ref'),
                bl_desc:      _hidden('custpage_h_bl_desc')
            }
        });
    }

    // ── Utility ───────────────────────────────────────────────────────────

    function _hidden(id) {
        var el = document.getElementById(id);
        return el ? (el.value || '') : '';
    }

    // Backward-compat aliases
    function findEntityRecords() { findInvoices(); }

    return {
        pageInit:            pageInit,
        fieldChanged:        fieldChanged,
        goSetup:             goSetup,
        goOverview:          goOverview,
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
