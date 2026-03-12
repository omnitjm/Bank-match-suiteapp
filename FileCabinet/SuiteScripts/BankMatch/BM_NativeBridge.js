/**
 * BM_NativeBridge.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Integration bridge between this SuiteApp and NetSuite's native
 * "Match Bank Data" module (Transactions > Bank > Match Bank Data).
 *
 * ─── Primary data flow (Bank Feed — RECOMMENDED) ──────────────────────────
 *
 *  STEP 1 – Set up a Bank Feed in NetSuite
 *  ─────────────────────────────────────────
 *  Navigate to: Transactions > Bank > Bank Feeds (or Setup > Accounting > Bank Feeds)
 *  Connect your bank account. NetSuite will automatically download transactions
 *  daily and load them into the BankStatementImportLine table.
 *
 *  STEP 2 – Bank Match SuiteApp reads the feed automatically
 *  ─────────────────────────────────────────────────────────
 *  BM_BankLineReader reads uncleared lines from BankStatementImportLine.
 *  The matching engine proposes Customer Payments, Vendor Payments, or
 *  Journal Entries for each unmatched bank line.
 *
 *  STEP 3 – Approver reviews and approves
 *  ───────────────────────────────────────
 *  Open Bank Match Central. Review auto-proposed matches on the
 *  "Pending Approvals" tab. Set Status = Approved.
 *
 *  STEP 4 – Done — no manual reconciliation page needed
 *  ─────────────────────────────────────────────────────
 *  On approval, BM_Proposal_UE:
 *    a) Creates the NS transaction (Customer Payment / Vendor Payment / JE)
 *    b) Stamps custbody_bank_transaction_id on the new transaction
 *    c) Auto-clears the native BankStatementImportLine record so the
 *       line is marked reconciled in NetSuite's own bank reconciliation
 *
 *  The bank statement line is cleared programmatically — the user does NOT
 *  need to open Transactions > Bank > Match Bank Data and click Run Reconciliation.
 *
 * ─── Alternative: manual CSV / OFX import (fallback) ─────────────────────
 *
 *  If a bank feed is not available for your bank, you can still import
 *  statements manually:
 *    • Go to: Transactions > Bank > Banking Import History > Upload File
 *    • Upload a CSV, OFX, QFX, or BAI2 file
 *  NetSuite loads the lines into the same BankStatementImportLine table,
 *  so Bank Match picks them up identically.
 *
 *  The generateOFX() function below converts our custom bank_txn records to
 *  OFX 1.02 SGML format for accounts that need the manual upload route.
 *
 * ─── What this module provides ───────────────────────────────────────────
 *  nativeBankFeedUrl()      – URL to configure Bank Feeds in NetSuite
 *  nativeMatchBankDataUrl() – URL to open the native Match Bank Data page
 *  nativeBankImportUrl()    – URL to open Banking Import History (manual upload)
 *  generateOFX(bankTxns)    – OFX 1.02 SGML from custom bank_txn records (fallback)
 *  loadBankTxns(statusFilter) – Load custom bank_txn records as plain objects
 */
define(['N/search', 'N/log', './BM_Constants'], function (search, log, C) {
    'use strict';

    // ── OFX date formatter ────────────────────────────────────────────────
    // OFX format: YYYYMMDDHHMMSS  (NetSuite accepts YYYYMMDD too)
    function _ofxDate(dateStr) {
        if (!dateStr) return '19700101000000';
        var d = new Date(dateStr);
        if (isNaN(d.getTime())) return '19700101000000';
        var pad = function (n) { return String(n).padStart(2, '0'); };
        return String(d.getFullYear()) +
               pad(d.getMonth() + 1) +
               pad(d.getDate()) +
               '000000';
    }

    // ── OFX transaction type ──────────────────────────────────────────────
    // OFX types: CREDIT, DEBIT, INT, DIV, FEE, SRVCHG, DEP, ATM, POS, XFER, CHECK, PAYMENT, CASH
    function _ofxTrnType(amount) {
        return parseFloat(amount) >= 0 ? 'CREDIT' : 'DEBIT';
    }

    // ── Escape OFX text (basic) ───────────────────────────────────────────
    function _esc(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * Generate an OFX 1.02 SGML file from an array of bank transaction objects.
     *
     * FALLBACK USE ONLY — only needed when a bank feed is not configured.
     * If a bank feed is set up, transactions flow directly into BankStatementImportLine
     * and this function is not required.
     *
     * Each object should have: { date, description, amount, reference, currency }
     *
     * The resulting string can be written to a file and uploaded at:
     * Transactions > Bank > Banking Import History > Upload File
     *
     * @param {Array}  bankTxns   Array of bank transaction data objects
     * @param {string} accountId  Bank account identifier (shown in OFX header)
     * @param {string} currency   Currency code, e.g. 'USD'
     * @returns {string}  OFX file content
     */
    function generateOFX(bankTxns, accountId, currency) {
        currency   = currency   || 'USD';
        accountId  = accountId  || 'CHECKING';

        var now     = _ofxDate(new Date().toISOString());
        var minDate = now;
        var maxDate = now;

        // Determine date range
        bankTxns.forEach(function (t) {
            var d = _ofxDate(t.date);
            if (d < minDate) minDate = d;
            if (d > maxDate) maxDate = d;
        });

        // Build transaction list
        var txnLines = bankTxns.map(function (t, idx) {
            var amt     = parseFloat(t.amount) || 0;
            var fitId   = t.reference || ('BM' + String(idx + 1).padStart(6, '0'));
            var name    = _esc(t.description || t.reference || 'Bank Transaction');
            var memo    = _esc(t.reference   || t.description || '');
            return [
                '<STMTTRN>',
                '<TRNTYPE>'  + _ofxTrnType(amt)            + '</TRNTYPE>',
                '<DTPOSTED>' + _ofxDate(t.date)            + '</DTPOSTED>',
                '<TRNAMT>'   + amt.toFixed(2)               + '</TRNAMT>',
                '<FITID>'    + _esc(fitId)                  + '</FITID>',
                '<NAME>'     + name                         + '</NAME>',
                '<MEMO>'     + memo                         + '</MEMO>',
                '</STMTTRN>'
            ].join('\n');
        }).join('\n');

        // Build full OFX 1.02 document
        var ofx = [
            'OFXHEADER:100',
            'DATA:OFXSGML',
            'VERSION:102',
            'SECURITY:NONE',
            'ENCODING:UTF-8',
            'CHARSET:1252',
            'COMPRESSION:NONE',
            'OLDFILEUID:NONE',
            'NEWFILEUID:NONE',
            '',
            '<OFX>',
            '<SIGNONMSGSRSV1>',
            '<SONRS>',
            '<STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
            '<DTSERVER>' + now + '</DTSERVER>',
            '<LANGUAGE>ENG</LANGUAGE>',
            '</SONRS>',
            '</SIGNONMSGSRSV1>',
            '<BANKMSGSRSV1>',
            '<STMTTRNRS>',
            '<TRNUID>1001</TRNUID>',
            '<STMTRS>',
            '<CURDEF>' + _esc(currency) + '</CURDEF>',
            '<BANKACCTFROM>',
            '<BANKID>000000000</BANKID>',
            '<ACCTID>' + _esc(accountId) + '</ACCTID>',
            '<ACCTTYPE>CHECKING</ACCTTYPE>',
            '</BANKACCTFROM>',
            '<BANKTRANLIST>',
            '<DTSTART>' + minDate + '</DTSTART>',
            '<DTEND>'   + maxDate + '</DTEND>',
            txnLines,
            '</BANKTRANLIST>',
            '<LEDGERBAL>',
            '<BALAMT>0.00</BALAMT>',
            '<DTASOF>' + now + '</DTASOF>',
            '</LEDGERBAL>',
            '</STMTRS>',
            '</STMTTRNRS>',
            '</BANKMSGSRSV1>',
            '</OFX>'
        ].join('\n');

        return ofx;
    }

    /**
     * Load all unreconciled bank transaction records and return as plain objects.
     * @param {Array} statusFilter  Array of status codes, e.g. ['1','2']
     * @returns {Array}
     */
    function loadBankTxns(statusFilter) {
        var BTF = C.BANK_TXN_FIELDS;
        var filters = [['isinactive', 'is', 'F']];
        if (statusFilter && statusFilter.length) {
            filters.push('AND');
            filters.push([BTF.STATUS, 'anyof', statusFilter]);
        }
        var results = [];
        try {
            search.create({
                type: C.RECORDS.BANK_TXN,
                filters: filters,
                columns: [
                    BTF.TXN_DATE, BTF.DESCRIPTION,
                    BTF.AMOUNT,   BTF.REFERENCE,
                    BTF.CURRENCY, BTF.STATUS
                ]
            }).run().each(function (row) {
                results.push({
                    id:          row.id,
                    date:        row.getValue(BTF.TXN_DATE),
                    description: row.getValue(BTF.DESCRIPTION),
                    amount:      row.getValue(BTF.AMOUNT),
                    reference:   row.getValue(BTF.REFERENCE),
                    currency:    row.getValue(BTF.CURRENCY),
                    status:      row.getValue(BTF.STATUS)
                });
                return results.length < 500;
            });
        } catch (e) {
            log.error('BM_NativeBridge.loadBankTxns', e.message);
        }
        return results;
    }

    /**
     * Returns the URL to configure Bank Feeds in NetSuite.
     * Bank feeds are the recommended way to get bank statement lines into
     * BankStatementImportLine so Bank Match can process them automatically.
     *
     * Navigate here to connect your bank account to NetSuite's direct feed.
     */
    function nativeBankFeedUrl() {
        return '/app/accounting/transactions/bank/reconciliation/bankfeeds.nl';
    }

    /**
     * Returns the path to NetSuite's native Match Bank Data page.
     * Optional accountId (internal ID of the bank account) pre-selects the account.
     *
     * Note: When Bank Match auto-clears lines on approval, you typically do not
     * need to visit this page. It is available for manual review or if your
     * NetSuite version does not support programmatic line clearing.
     */
    function nativeMatchBankDataUrl(accountId) {
        var base = '/app/accounting/transactions/bank/reconciliation/matchbankdata.nl';
        return accountId ? base + '?account=' + encodeURIComponent(accountId) : base;
    }

    /**
     * Returns the path to NetSuite's Banking Import History page.
     * Use this for manual CSV/OFX/QFX/BAI2 uploads when a bank feed is not available.
     */
    function nativeBankImportUrl() {
        return '/app/accounting/transactions/bank/reconciliation/bankingimporthistory.nl';
    }

    return {
        generateOFX:             generateOFX,
        loadBankTxns:            loadBankTxns,
        nativeBankFeedUrl:       nativeBankFeedUrl,
        nativeMatchBankDataUrl:  nativeMatchBankDataUrl,
        nativeBankImportUrl:     nativeBankImportUrl
    };
});
