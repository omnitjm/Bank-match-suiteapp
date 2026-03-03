/**
 * BM_Dashboard_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Client-side logic for the Bank Match Central Suitelet.
 *
 * Features:
 *   - goOverview()    – navigate back to the Global Overview (Master view)
 *   - fieldChanged()  – (1) when Subsidiary changes, reload for cascading filter
 *                       (2) when inv_chk / bill_chk changes on multi-apply pages,
 *                           update the running Remaining Amount counter
 *   - runAutoMatch()  – passes bank_account + subsidiary URL params
 *   - Multi-apply counter helpers: _updateRemainingCounter()
 */
define(['N/url', 'N/currentRecord'], function (url, currentRecord) {
    'use strict';

    function pageInit() { /* no init needed */ }

    // ── Running-amount counter (Multi-Apply entity pages) ─────────────────

    /**
     * Recalculate the "Selected / Remaining" counter displayed above the
     * invoice or bill sublist on the multi-apply entity pages.
     *
     * @param {Record} rec         currentRecord obtained from context
     * @param {string} sublistId   'sl_invoices' or 'sl_bills'
     * @param {string} checkboxFld 'inv_chk' or 'bill_chk'
     * @param {string} amountFld   'inv_remain' or 'bill_remain'
     * @param {number} currentLine The line index that just changed (context.line)
     */
    function _updateRemainingCounter(rec, sublistId, checkboxFld, amountFld, currentLine) {
        var bankAmtEl = document.getElementById('custpage_bank_line_amt');
        if (!bankAmtEl) return;
        var bankAmt   = parseFloat(bankAmtEl.value) || 0;

        var lineCount    = rec.getLineCount({ sublistId: sublistId });
        var totalSelected = 0;

        for (var i = 0; i < lineCount; i++) {
            var chk, amt;
            try {
                if (i === currentLine) {
                    // The line being edited — read from current (uncommitted) state
                    chk = rec.getCurrentSublistValue({ sublistId: sublistId, fieldId: checkboxFld });
                    amt = parseFloat(rec.getCurrentSublistValue({ sublistId: sublistId, fieldId: amountFld })) || 0;
                } else {
                    chk = rec.getSublistValue({ sublistId: sublistId, fieldId: checkboxFld, line: i });
                    amt = parseFloat(rec.getSublistValue({ sublistId: sublistId, fieldId: amountFld, line: i })) || 0;
                }
            } catch (e) { continue; }

            if (chk === true || chk === 'T' || chk === 'true') {
                totalSelected += amt;
            }
        }

        var remaining = bankAmt - totalSelected;
        var el = document.getElementById('custpage_remaining_counter');
        if (!el) return;

        var color = Math.abs(remaining) < 0.005
            ? '#2e7d32'               // green — fully allocated
            : (remaining < 0 ? '#c62828' : '#e65100'); // red — over, orange — under

        el.innerHTML =
            'Selected: ' + totalSelected.toFixed(2) +
            ' &nbsp;|&nbsp; Remaining: <strong style="color:' + color + ';">' +
            remaining.toFixed(2) + '</strong>';
    }

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
     * fieldChanged event — handles two distinct use cases:
     *
     * 1. Multi-apply invoice/bill pages:
     *    When 'inv_chk' or 'bill_chk' changes, recalculate the running
     *    Remaining Amount counter displayed above the sublist.
     *
     * 2. Workspace Subsidiary filter:
     *    When 'custpage_filter_subsidiary' changes, reload the page so
     *    the server re-populates the Bank Account dropdown with only
     *    accounts for that subsidiary.
     */
    function fieldChanged(context) {
        var rec       = context.currentRecord;
        var sublistId = context.sublistId || '';
        var fieldId   = context.fieldId   || '';

        // Multi-apply counter — invoice page
        if (sublistId === 'sl_invoices' && fieldId === 'inv_chk') {
            _updateRemainingCounter(rec, 'sl_invoices', 'inv_chk', 'inv_remain', context.line);
            return;
        }

        // Multi-apply counter — bills page
        if (sublistId === 'sl_bills' && fieldId === 'bill_chk') {
            _updateRemainingCounter(rec, 'sl_bills', 'bill_chk', 'bill_remain', context.line);
            return;
        }

        // Subsidiary cascading filter (workspace)
        if (fieldId !== 'custpage_filter_subsidiary') return;

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
