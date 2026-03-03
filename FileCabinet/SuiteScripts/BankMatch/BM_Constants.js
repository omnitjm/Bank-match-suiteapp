/**
 * BM_Constants.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Shared constants for the Bank Match SuiteApp.
 * All custom record/field IDs and status values are defined here.
 */
define([], function () {
    'use strict';

    /**
     * Normalize a bank transaction identifier for consistent matching.
     * Trims whitespace, uppercases, and collapses internal runs of spaces.
     * Never removes dashes or other characters — only normalizes whitespace.
     *
     * @param {string} str
     * @returns {string}
     */
    function normalizeTxnId(str) {
        if (!str) return '';
        return String(str).trim().toUpperCase().replace(/\s+/g, ' ');
    }

    return {

        // ── Normalize helper ──────────────────────────────────────────────────
        normalizeTxnId: normalizeTxnId,

        // ── Custom Transaction Body Field ─────────────────────────────────────
        // Applies to: Customer Payment, Vendor Payment, Deposit, Check, Journal Entry
        // Used by native Reconciliation Rules to match bank lines to NS transactions.
        // NEVER write to tranid — use this field instead.
        BODY_FIELD: {
            BANK_TXN_ID: 'custbody_bank_transaction_id'  // TEXT, stored value
        },

        // ── Custom Record Script IDs ─────────────────────────────────────────
        RECORDS: {
            SETTINGS:  'customrecord_bm_settings',
            BANK_TXN:  'customrecord_bm_bank_txn',
            PROPOSAL:  'customrecord_bm_proposal'
        },

        // ── Settings Record Field IDs ────────────────────────────────────────
        SETTINGS_FIELDS: {
            BANK_ACCOUNT:       'custrecord_bm_bank_account',      // SELECT → Account
            SUBSIDIARY:         'custrecord_bm_subsidiary',         // SELECT → Subsidiary
            TOLERANCE_AMT:      'custrecord_bm_tolerance_amt',      // CURRENCY  (max variance for auto-match)
            TOLERANCE_DAYS:     'custrecord_bm_tolerance_days',     // INTEGER
            APPROVER:           'custrecord_bm_approver',           // SELECT → Employee
            AUTO_SUGGEST:       'custrecord_bm_auto_suggest',       // CHECKBOX
            FEE_ACCOUNT:        'custrecord_bm_fee_account',        // SELECT → Account (variance write-off GL)
            SUSPENSE_ACCOUNT:   'custrecord_bm_suspense_account',   // SELECT → Account (manual match default)
            // Mandatory segment fallbacks — applied to all Journal Entry lines
            DEFAULT_DEPT:       'custrecord_bm_default_department', // SELECT → Department
            DEFAULT_CLASS:      'custrecord_bm_default_class',      // SELECT → Classification
            DEFAULT_LOCATION:   'custrecord_bm_default_location'    // SELECT → Location
        },

        // ── Bank Transaction Record Field IDs ────────────────────────────────
        BANK_TXN_FIELDS: {
            TXN_DATE:     'custrecord_bm_txn_date',       // DATE
            DESCRIPTION:  'custrecord_bm_txn_desc',       // TEXT
            AMOUNT:       'custrecord_bm_txn_amount',     // CURRENCY (+ credit, - debit)
            REFERENCE:    'custrecord_bm_txn_ref',        // TEXT
            CURRENCY:     'custrecord_bm_txn_currency',   // TEXT
            STATUS:       'custrecord_bm_txn_status',     // SELECT → customlist_bm_txn_status
            BANK_ACCOUNT: 'custrecord_bm_txn_bank_acct'  // SELECT → Account
        },

        // ── Match Proposal Record Field IDs ──────────────────────────────────
        PROPOSAL_FIELDS: {
            BANK_TXN:        'custrecord_bm_prop_bank_txn',    // SELECT → customrecord_bm_bank_txn
            TXN_TYPE:        'custrecord_bm_prop_txn_type',    // SELECT → customlist_bm_txn_type
            NS_RECORD_TYPE:  'custrecord_bm_prop_ns_type',     // TEXT  (invoice / vendorbill / account)
            NS_RECORD_ID:    'custrecord_bm_prop_ns_id',       // INTEGER
            NS_RECORD_REF:   'custrecord_bm_prop_ns_ref',      // TEXT  (transaction number)
            MATCH_AMOUNT:    'custrecord_bm_prop_match_amt',   // CURRENCY
            MATCH_DATE:      'custrecord_bm_prop_match_date',  // DATE   (NS record date)
            STATUS:          'custrecord_bm_prop_status',      // SELECT → customlist_bm_prop_status
            APPROVER:        'custrecord_bm_prop_approver',    // SELECT → Employee
            ADJUST_DATE:     'custrecord_bm_prop_adj_date',    // CHECKBOX (legacy, unused)
            NOTES:           'custrecord_bm_prop_notes',       // TEXTAREA
            APPLIED_DATE:    'custrecord_bm_prop_applied_dt',  // DATE
            ERROR_MSG:       'custrecord_bm_prop_error_msg',   // TEXTAREA
            BANK_AMOUNT:     'custrecord_bm_prop_bank_amt',    // CURRENCY
            BANK_DATE:       'custrecord_bm_prop_bank_date',   // DATE
            BANK_REF:        'custrecord_bm_prop_bank_ref',    // TEXT
            BANK_LINE_ID:    'custrecord_bm_prop_bank_line',   // TEXT – native bank line ID

            // ── Variance / tolerance metadata ────────────────────────────────
            HAS_VARIANCE:    'custrecord_bm_prop_has_variance', // CHECKBOX – variance detected
            VARIANCE_AMT:    'custrecord_bm_prop_variance_amt', // CURRENCY – abs(bankAmt - nsBalance)
            BANK_ACCT:       'custrecord_bm_prop_bank_acct',    // SELECT → Account (for multi-acct filter)

            // ── Idempotency & apply-locking ───────────────────────────────────
            IDEMPOTENCY_KEY: 'custrecord_bm_idempotency_key',  // TEXT – deduplication key
            APPLY_STATUS:    'custrecord_bm_apply_status',     // TEXT – Pending|Processing|Applied|Failed
            APPLY_ATTEMPTS:  'custrecord_bm_apply_attempts',   // INTEGER
            APPLY_ERROR:     'custrecord_bm_apply_error',      // TEXTAREA – last error detail
            APPLIED_TXN_ID:  'custrecord_bm_applied_txn_id'   // TEXT – NS internal ID on success
        },

        // ── Proposal Status List Values ───────────────────────────────────────
        PROPOSAL_STATUS: {
            PENDING:  '1',
            APPROVED: '2',
            REJECTED: '3',
            APPLIED:  '4',
            FAILED:   '5'
        },

        // ── Apply Lock Status Values (stored as plain text, not a list) ───────
        APPLY_STATUS: {
            PENDING:    'Pending',
            PROCESSING: 'Processing',
            APPLIED:    'Applied',
            FAILED:     'Failed'
        },

        // ── Bank Transaction Status List Values ──────────────────────────────
        TXN_STATUS: {
            UNMATCHED:  '1',
            PROPOSED:   '2',
            RECONCILED: '3',
            EXCLUDED:   '4'
        },

        // ── Transaction Type List Values ─────────────────────────────────────
        // '1' Customer Payment — create Customer Payment applied to Invoice
        // '2' Vendor Payment   — create Vendor Payment applied to Vendor Bill
        // '3' Journal Entry    — create Journal Entry against a GL account
        TXN_TYPE: {
            CUSTOMER_PAYMENT: '1',
            VENDOR_PAYMENT:   '2',
            JOURNAL_ENTRY:    '3'
        },

        // ── Skip Reason Keys (returned in RESTlet skippedReasons map) ─────────
        SKIP_REASON: {
            EXISTING_PROPOSAL: 'existing_proposal',
            NO_CANDIDATE:      'no_candidate_over_threshold',
            SETTINGS_MISSING:  'settings_missing',
            CREATION_ERROR:    'creation_error'
        },

        // ── Script / Deployment IDs ──────────────────────────────────────────
        SCRIPTS: {
            MAIN_SL:          'customscript_bm_main_sl',
            MAIN_DEPLOY:      'customdeploy_bm_main_sl',
            SETUP_SL:         'customscript_bm_setup_sl',
            SETUP_DEPLOY:     'customdeploy_bm_setup_sl',
            RECONCILE_RL:     'customscript_bm_reconcile_rl',
            RECONCILE_DEPLOY: 'customdeploy_bm_reconcile_rl'
        }
    };
});
