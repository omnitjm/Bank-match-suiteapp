/**
 * BM_MatchEngine.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Core matching and transaction-creation engine for Bank Match Central.
 *
 * Responsibilities:
 *   1. findInvoiceMatches      – open Sales Invoices matching a bank credit.
 *   2. findVendorBillMatches   – open Vendor Bills matching a bank debit.
 *   3. findOpenInvoicesByCustomer – all open invoices for a given customer.
 *   4. findOpenBillsByVendor      – all open bills for a given vendor.
 *   5. applyCustomerPayment    – create Customer Payment applied to an Invoice.
 *   6. applyVendorPayment      – create Vendor Payment applied to a Vendor Bill.
 *   7. applyJournalEntry       – create Journal Entry against a GL Account.
 *
 * ALL three apply functions stamp custbody_bank_transaction_id on the
 * resulting NetSuite transaction.  NEVER write to tranid.
 */
define([
    'N/search',
    'N/record',
    'N/log',
    './BM_Constants'
], function (search, record, log, C) {
    'use strict';

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Score a candidate match (0 – 100). Higher is better.
     *   40 pts – amount closeness
     *   30 pts – date proximity
     *   30 pts – reference text overlap
     */
    function _score(bankTxn, candidate, toleranceAmt, toleranceDays) {
        var score = 0;
        var bankAmt  = Math.abs(parseFloat(bankTxn.amount)   || 0);
        var candAmt  = Math.abs(parseFloat(candidate.amount) || 0);
        var amtDiff  = Math.abs(bankAmt - candAmt);

        // Amount (40 pts)
        if (amtDiff === 0)                         score += 40;
        else if (amtDiff <= toleranceAmt * 0.25)   score += 35;
        else if (amtDiff <= toleranceAmt * 0.50)   score += 25;
        else if (amtDiff <= toleranceAmt)           score += 15;

        // Date proximity (30 pts)
        if (bankTxn.date && candidate.date) {
            var d1   = new Date(bankTxn.date);
            var d2   = new Date(candidate.date);
            var days = Math.abs((d1 - d2) / 86400000);
            if (days === 0)                         score += 30;
            else if (days <= 3)                     score += 22;
            else if (days <= 7)                     score += 14;
            else if (days <= toleranceDays)         score += 6;
        }

        // Reference (30 pts)
        if (bankTxn.reference && candidate.reference) {
            var bRef = String(bankTxn.reference).toLowerCase().replace(/\W/g, '');
            var cRef = String(candidate.reference).toLowerCase().replace(/\W/g, '');
            if (bRef && cRef) {
                if (bRef === cRef)                  score += 30;
                else if (bRef.indexOf(cRef) >= 0 ||
                         cRef.indexOf(bRef) >= 0)   score += 18;
            }
        }

        return score;
    }

    function _parseDate(str) {
        if (!str) return null;
        var d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    // ── Public API — Matching ─────────────────────────────────────────────────

    /**
     * Find open Sales Invoices whose remaining amount is within tolerance
     * of the bank credit amount.
     *
     * @param {Object} bankTxn   { date, amount, reference }
     * @param {Object} settings  { toleranceAmt, toleranceDays, subsidiary }
     * @returns {Array}  sorted candidates, best match first
     */
    function findInvoiceMatches(bankTxn, settings) {
        var amt     = Math.abs(parseFloat(bankTxn.amount) || 0);
        var tolAmt  = parseFloat(settings.toleranceAmt)   || 0;
        var tolDays = parseInt(settings.toleranceDays, 10) || 30;
        var results = [];

        var filters = [
            ['type', 'anyof', 'CustInvc'], 'AND',
            ['status', 'anyof', 'CustInvc:Open'], 'AND',
            ['amountremaining', 'between', Math.max(0, amt - tolAmt), amt + tolAmt]
        ];
        if (settings.subsidiary) {
            filters.push('AND');
            filters.push(['subsidiary', 'anyof', settings.subsidiary]);
        }

        var columns = [
            'internalid', 'tranid', 'trandate',
            'amountremaining', 'currency',
            search.createColumn({ name: 'companyname', join: 'customer' }),
            search.createColumn({ name: 'entityid',   join: 'customer' })
        ];

        try {
            search.create({ type: 'transaction', filters: filters, columns: columns })
                .run().each(function (row) {
                    var candidate = {
                        type:      C.TXN_TYPE.CUSTOMER_PAYMENT,
                        nsType:    'invoice',
                        nsId:      row.getValue('internalid'),
                        reference: row.getValue('tranid'),
                        date:      row.getValue('trandate'),
                        amount:    parseFloat(row.getValue('amountremaining')),
                        currency:  row.getValue('currency'),
                        entity:    row.getValue({ name: 'companyname', join: 'customer' }) ||
                                   row.getValue({ name: 'entityid',   join: 'customer' })
                    };
                    candidate.score = _score(bankTxn, candidate, tolAmt, tolDays);
                    results.push(candidate);
                    return true;
                });
        } catch (e) {
            log.error('BM_MatchEngine.findInvoiceMatches', e.message);
        }

        return results.sort(function (a, b) { return b.score - a.score; });
    }

    /**
     * Find open Vendor Bills whose remaining amount is within tolerance
     * of the bank debit amount.
     *
     * @param {Object} bankTxn   { date, amount, reference }
     * @param {Object} settings  { toleranceAmt, toleranceDays, subsidiary }
     * @returns {Array}  sorted candidates, best match first
     */
    function findVendorBillMatches(bankTxn, settings) {
        var amt     = Math.abs(parseFloat(bankTxn.amount) || 0);
        var tolAmt  = parseFloat(settings.toleranceAmt)   || 0;
        var tolDays = parseInt(settings.toleranceDays, 10) || 30;
        var results = [];

        var filters = [
            ['type', 'anyof', 'VendBill'], 'AND',
            ['status', 'anyof', 'VendBill:Open'], 'AND',
            ['amountremaining', 'between', Math.max(0, amt - tolAmt), amt + tolAmt]
        ];
        if (settings.subsidiary) {
            filters.push('AND');
            filters.push(['subsidiary', 'anyof', settings.subsidiary]);
        }

        var columns = [
            'internalid', 'tranid', 'trandate',
            'amountremaining', 'currency',
            search.createColumn({ name: 'companyname', join: 'vendor' }),
            search.createColumn({ name: 'entityid',   join: 'vendor' })
        ];

        try {
            search.create({ type: 'transaction', filters: filters, columns: columns })
                .run().each(function (row) {
                    var candidate = {
                        type:      C.TXN_TYPE.VENDOR_PAYMENT,
                        nsType:    'vendorbill',
                        nsId:      row.getValue('internalid'),
                        reference: row.getValue('tranid'),
                        date:      row.getValue('trandate'),
                        amount:    parseFloat(row.getValue('amountremaining')),
                        currency:  row.getValue('currency'),
                        entity:    row.getValue({ name: 'companyname', join: 'vendor' }) ||
                                   row.getValue({ name: 'entityid',   join: 'vendor' })
                    };
                    candidate.score = _score(bankTxn, candidate, tolAmt, tolDays);
                    results.push(candidate);
                    return true;
                });
        } catch (e) {
            log.error('BM_MatchEngine.findVendorBillMatches', e.message);
        }

        return results.sort(function (a, b) { return b.score - a.score; });
    }

    /**
     * Find all open Sales Invoices for a specific customer.
     *
     * @param {string|number} customerId
     * @returns {Array}  sorted by due date ascending (oldest first)
     */
    function findOpenInvoicesByCustomer(customerId) {
        var results = [];
        try {
            search.create({
                type: 'transaction',
                filters: [
                    ['type',   'anyof', 'CustInvc'],      'AND',
                    ['status', 'anyof', 'CustInvc:Open'], 'AND',
                    ['entity', 'anyof', String(customerId)]
                ],
                columns: [
                    'internalid', 'tranid', 'trandate', 'duedate',
                    'amountremaining', 'amount', 'currency', 'memo'
                ]
            }).run().each(function (row) {
                results.push({
                    nsId:       row.getValue('internalid'),
                    nsType:     'invoice',
                    reference:  row.getValue('tranid'),
                    date:       row.getValue('trandate'),
                    dueDate:    row.getValue('duedate'),
                    amount:     parseFloat(row.getValue('amountremaining')) || 0,
                    origAmount: parseFloat(row.getValue('amount'))          || 0,
                    currency:   row.getValue('currency'),
                    memo:       row.getValue('memo')
                });
                return results.length < 200;
            });
        } catch (e) {
            log.error('BM_MatchEngine.findOpenInvoicesByCustomer', e.message);
        }
        return results.sort(function (a, b) {
            var da = a.dueDate ? new Date(a.dueDate) : new Date(a.date);
            var db = b.dueDate ? new Date(b.dueDate) : new Date(b.date);
            return da - db;
        });
    }

    /**
     * Find all open Vendor Bills for a specific vendor.
     *
     * @param {string|number} vendorId
     * @returns {Array}  sorted by due date ascending (oldest first)
     */
    function findOpenBillsByVendor(vendorId) {
        var results = [];
        try {
            search.create({
                type: 'transaction',
                filters: [
                    ['type',   'anyof', 'VendBill'],      'AND',
                    ['status', 'anyof', 'VendBill:Open'], 'AND',
                    ['entity', 'anyof', String(vendorId)]
                ],
                columns: [
                    'internalid', 'tranid', 'trandate', 'duedate',
                    'amountremaining', 'amount', 'currency', 'memo'
                ]
            }).run().each(function (row) {
                results.push({
                    nsId:       row.getValue('internalid'),
                    nsType:     'vendorbill',
                    reference:  row.getValue('tranid'),
                    date:       row.getValue('trandate'),
                    dueDate:    row.getValue('duedate'),
                    amount:     parseFloat(row.getValue('amountremaining')) || 0,
                    origAmount: parseFloat(row.getValue('amount'))          || 0,
                    currency:   row.getValue('currency'),
                    memo:       row.getValue('memo')
                });
                return results.length < 200;
            });
        } catch (e) {
            log.error('BM_MatchEngine.findOpenBillsByVendor', e.message);
        }
        return results.sort(function (a, b) {
            var da = a.dueDate ? new Date(a.dueDate) : new Date(a.date);
            var db = b.dueDate ? new Date(b.dueDate) : new Date(b.date);
            return da - db;
        });
    }

    // ── Public API — Transaction Creation ─────────────────────────────────────

    /**
     * Create a Customer Payment and apply it to the matched Invoice.
     * Caller must stamp custbody_bank_transaction_id on the returned ID.
     *
     * @param {Object} proposal  { nsId: invoiceId, bankAmount, bankDate, bankRef }
     * @returns {string}  Internal ID of the new Customer Payment
     */
    function applyCustomerPayment(proposal) {
        var invoiceId  = proposal.nsId;
        var bankAmt    = parseFloat(proposal.bankAmount);
        var bankDate   = _parseDate(proposal.bankDate) || new Date();

        var invRec     = record.load({ type: record.Type.INVOICE, id: invoiceId });
        var customerId = invRec.getValue('entity');
        var currency   = invRec.getValue('currency');

        var payment = record.create({ type: record.Type.CUSTOMER_PAYMENT, isDynamic: true });
        payment.setValue({ fieldId: 'customer', value: customerId });
        payment.setValue({ fieldId: 'trandate', value: bankDate });
        payment.setValue({ fieldId: 'payment',  value: bankAmt });
        payment.setValue({ fieldId: 'currency', value: currency });
        payment.setValue({ fieldId: 'memo',
            value: 'Bank Match – bank ref: ' + (proposal.bankRef || '') });

        var lineCount = payment.getLineCount({ sublistId: 'apply' });
        for (var i = 0; i < lineCount; i++) {
            var lineId = payment.getSublistValue({
                sublistId: 'apply', fieldId: 'internalid', line: i
            });
            if (String(lineId) === String(invoiceId)) {
                payment.selectLine({ sublistId: 'apply', line: i });
                payment.setCurrentSublistValue({
                    sublistId: 'apply', fieldId: 'apply',  value: true
                });
                payment.setCurrentSublistValue({
                    sublistId: 'apply', fieldId: 'amount', value: bankAmt
                });
                payment.commitLine({ sublistId: 'apply' });
                break;
            }
        }

        var newId = payment.save({ enableSourcing: true, ignoreMandatoryFields: false });
        log.audit('BM_MatchEngine',
            'Customer Payment ' + newId + ' created and applied to Invoice ' + invoiceId);
        return String(newId);
    }

    /**
     * Create a Vendor Payment and apply it to the matched Vendor Bill.
     * Caller must stamp custbody_bank_transaction_id on the returned ID.
     *
     * @param {Object} proposal  { nsId: vendorBillId, bankAmount, bankDate, bankRef }
     * @returns {string}  Internal ID of the new Vendor Payment
     */
    function applyVendorPayment(proposal) {
        var billId   = proposal.nsId;
        var bankAmt  = parseFloat(proposal.bankAmount);
        var bankDate = _parseDate(proposal.bankDate) || new Date();

        var billRec  = record.load({ type: record.Type.VENDOR_BILL, id: billId });
        var vendorId = billRec.getValue('entity');
        var currency = billRec.getValue('currency');
        var apAcct   = billRec.getValue('account');  // AP account

        var payment = record.create({ type: record.Type.VENDOR_PAYMENT, isDynamic: true });
        payment.setValue({ fieldId: 'entity',   value: vendorId });
        payment.setValue({ fieldId: 'trandate', value: bankDate });
        payment.setValue({ fieldId: 'currency', value: currency });
        if (apAcct) payment.setValue({ fieldId: 'account', value: apAcct });
        payment.setValue({ fieldId: 'memo',
            value: 'Bank Match – bank ref: ' + (proposal.bankRef || '') });

        var lineCount = payment.getLineCount({ sublistId: 'apply' });
        for (var i = 0; i < lineCount; i++) {
            var lineId = payment.getSublistValue({
                sublistId: 'apply', fieldId: 'internalid', line: i
            });
            if (String(lineId) === String(billId)) {
                payment.selectLine({ sublistId: 'apply', line: i });
                payment.setCurrentSublistValue({
                    sublistId: 'apply', fieldId: 'apply',  value: true
                });
                payment.setCurrentSublistValue({
                    sublistId: 'apply', fieldId: 'amount', value: bankAmt
                });
                payment.commitLine({ sublistId: 'apply' });
                break;
            }
        }

        var newId = payment.save({ enableSourcing: true, ignoreMandatoryFields: false });
        log.audit('BM_MatchEngine',
            'Vendor Payment ' + newId + ' created and applied to Bill ' + billId);
        return String(newId);
    }

    /**
     * Create a Journal Entry to account for a bank transaction against a GL account.
     * Caller must stamp custbody_bank_transaction_id on the returned ID.
     *
     * Positive bankAmount (credit) → Debit bank account, Credit the GL account.
     * Negative bankAmount (debit)  → Credit bank account, Debit the GL account.
     *
     * @param {Object}       proposal       { nsId: glAccountId, bankAmount, bankDate, bankRef }
     * @param {string|number} bankGlAcctId  Bank GL account internal ID (from settings)
     * @returns {string}  Internal ID of the new Journal Entry
     */
    function applyJournalEntry(proposal, bankGlAcctId) {
        var glAccountId = proposal.nsId;
        var bankAmt     = parseFloat(proposal.bankAmount);
        var bankDate    = _parseDate(proposal.bankDate) || new Date();
        var isCredit    = bankAmt > 0;
        var absAmt      = Math.abs(bankAmt);

        var je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });
        je.setValue({ fieldId: 'trandate', value: bankDate });
        je.setValue({ fieldId: 'memo',
            value: 'Bank Match – bank ref: ' + (proposal.bankRef || '') });

        if (isCredit) {
            // Money in: Debit bank account, Credit income/GL account
            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({
                sublistId: 'line', fieldId: 'account', value: bankGlAcctId
            });
            je.setCurrentSublistValue({
                sublistId: 'line', fieldId: 'debit', value: absAmt
            });
            je.commitLine({ sublistId: 'line' });

            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({
                sublistId: 'line', fieldId: 'account', value: glAccountId
            });
            je.setCurrentSublistValue({
                sublistId: 'line', fieldId: 'credit', value: absAmt
            });
            je.commitLine({ sublistId: 'line' });
        } else {
            // Money out: Credit bank account, Debit expense/GL account
            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({
                sublistId: 'line', fieldId: 'account', value: bankGlAcctId
            });
            je.setCurrentSublistValue({
                sublistId: 'line', fieldId: 'credit', value: absAmt
            });
            je.commitLine({ sublistId: 'line' });

            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({
                sublistId: 'line', fieldId: 'account', value: glAccountId
            });
            je.setCurrentSublistValue({
                sublistId: 'line', fieldId: 'debit', value: absAmt
            });
            je.commitLine({ sublistId: 'line' });
        }

        var newId = je.save({ enableSourcing: true, ignoreMandatoryFields: false });
        log.audit('BM_MatchEngine',
            'Journal Entry ' + newId + ' created for GL account ' + glAccountId +
            ' (bank account ' + bankGlAcctId + ')');
        return String(newId);
    }

    return {
        findInvoiceMatches:         findInvoiceMatches,
        findVendorBillMatches:      findVendorBillMatches,
        findOpenInvoicesByCustomer: findOpenInvoicesByCustomer,
        findOpenBillsByVendor:      findOpenBillsByVendor,
        applyCustomerPayment:       applyCustomerPayment,
        applyVendorPayment:         applyVendorPayment,
        applyJournalEntry:          applyJournalEntry
    };
});
