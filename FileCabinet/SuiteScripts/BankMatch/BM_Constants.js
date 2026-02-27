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

    return {

        // ── Custom Record Script IDs ─────────────────────────────────────────
        RECORDS: {
            SETTINGS:  'customrecord_bm_settings',
            BANK_TXN:  'customrecord_bm_bank_txn',
            PROPOSAL:  'customrecord_bm_proposal'
        },

        // ── Settings Record Field IDs ────────────────────────────────────────
        SETTINGS_FIELDS: {
            BANK_ACCOUNT:    'custrecord_bm_bank_account',   // SELECT → Account
            SUBSIDIARY:      'custrecord_bm_subsidiary',      // SELECT → Subsidiary
            TOLERANCE_AMT:   'custrecord_bm_tolerance_amt',   // CURRENCY
            TOLERANCE_DAYS:  'custrecord_bm_tolerance_days',  // INTEGER
            APPROVER:        'custrecord_bm_approver',        // SELECT → Employee
            NOTIFY_EMAIL:    'custrecord_bm_notify_email',    // EMAIL
            AUTO_SUGGEST:    'custrecord_bm_auto_suggest'     // CHECKBOX
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
            BANK_TXN:      'custrecord_bm_prop_bank_txn',   // SELECT → customrecord_bm_bank_txn
            TXN_TYPE:      'custrecord_bm_prop_txn_type',   // SELECT → customlist_bm_txn_type
            NS_RECORD_TYPE:'custrecord_bm_prop_ns_type',    // TEXT  (invoice / vendorpayment)
            NS_RECORD_ID:  'custrecord_bm_prop_ns_id',      // INTEGER
            NS_RECORD_REF: 'custrecord_bm_prop_ns_ref',     // TEXT  (transaction number)
            MATCH_AMOUNT:  'custrecord_bm_prop_match_amt',  // CURRENCY
            MATCH_DATE:    'custrecord_bm_prop_match_date', // DATE   (NS record date)
            STATUS:        'custrecord_bm_prop_status',     // SELECT → customlist_bm_prop_status
            APPROVER:      'custrecord_bm_prop_approver',   // SELECT → Employee
            ADJUST_DATE:   'custrecord_bm_prop_adj_date',   // CHECKBOX
            NOTES:         'custrecord_bm_prop_notes',      // TEXTAREA
            APPLIED_DATE:  'custrecord_bm_prop_applied_dt', // DATE
            ERROR_MSG:     'custrecord_bm_prop_error_msg',  // TEXTAREA
            BANK_AMOUNT:   'custrecord_bm_prop_bank_amt',   // CURRENCY
            BANK_DATE:     'custrecord_bm_prop_bank_date',  // DATE
            BANK_REF:      'custrecord_bm_prop_bank_ref'    // TEXT
        },

        // ── Proposal Status List Values ───────────────────────────────────────
        PROPOSAL_STATUS: {
            PENDING:  '1',
            APPROVED: '2',
            REJECTED: '3',
            APPLIED:  '4',
            FAILED:   '5'
        },

        // ── Bank Transaction Status List Values ──────────────────────────────
        TXN_STATUS: {
            UNMATCHED:  '1',
            PROPOSED:   '2',
            RECONCILED: '3',
            EXCLUDED:   '4'
        },

        // ── Transaction Type List Values ─────────────────────────────────────
        TXN_TYPE: {
            CUSTOMER_PAYMENT: '1',
            BILL_PAYMENT:     '2'
        },

        // ── Script / Deployment IDs ──────────────────────────────────────────
        SCRIPTS: {
            MAIN_SL:      'customscript_bm_main_sl',
            MAIN_DEPLOY:  'customdeploy_bm_main_sl',
            SETUP_SL:     'customscript_bm_setup_sl',
            SETUP_DEPLOY: 'customdeploy_bm_setup_sl'
        }
    };
});
