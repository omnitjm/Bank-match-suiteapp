/**
 * BM_MatchEngine.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Core matching and reconciliation engine.
 *
 * Responsibilities:
 *   1. findInvoiceMatches  – search open Sales Invoices that match a bank credit.
 *   2. findBillPaymentMatches – search posted Vendor Payments that match a bank debit.
 *   3. applyCustomerPayment – create/apply a Customer Payment record to an invoice.
 *   4. applyBillPayment     – optionally adjust the Vendor Payment date to the bank date.
 */
define([
    'N/search',
    'N/record',
    'N/email',
    'N/log',
    'N/runtime',
    './BM_Constants'
], function (search, record, email, log, runtime, C) {
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
        var bankAmt  = Math.abs(parseFloat(bankTxn.amount)  || 0);
        var candAmt  = Math.abs(parseFloat(candidate.amount) || 0);
        var amtDiff  = Math.abs(bankAmt - candAmt);

        // Amount (40 pts)
        if (amtDiff === 0)                         score += 40;
        else if (amtDiff <= toleranceAmt * 0.25)   score += 35;
        else if (amtDiff <= toleranceAmt * 0.50)   score += 25;
        else if (amtDiff <= toleranceAmt)           score += 15;

        // Date proximity (30 pts)
        if (bankTxn.date && candidate.date) {
            var d1 = new Date(bankTxn.date);
            var d2 = new Date(candidate.date);
            var days = Math.abs((d1 - d2) / 86400000);
            if (days === 0)                          score += 30;
            else if (days <= 3)                      score += 22;
            else if (days <= 7)                      score += 14;
            else if (days <= toleranceDays)          score += 6;
        }

        // Reference (30 pts)
        if (bankTxn.reference && candidate.reference) {
            var bRef = String(bankTxn.reference).toLowerCase().replace(/\W/g, '');
            var cRef = String(candidate.reference).toLowerCase().replace(/\W/g, '');
            if (bRef && cRef) {
                if (bRef === cRef)                   score += 30;
                else if (bRef.indexOf(cRef) >= 0 ||
                         cRef.indexOf(bRef) >= 0)    score += 18;
            }
        }

        return score;
    }

    function _parseDate(str) {
        if (!str) return null;
        var d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Find open Sales Invoices whose remaining amount is within tolerance
     * of the bank credit amount.
     *
     * @param {Object} bankTxn   { date, amount, reference, currency }
     * @param {Object} settings  { toleranceAmt, toleranceDays, subsidiary }
     * @returns {Array}  sorted array of candidates (best match first)
     */
    function findInvoiceMatches(bankTxn, settings) {
        var amt      = Math.abs(parseFloat(bankTxn.amount) || 0);
        var tolAmt   = parseFloat(settings.toleranceAmt)  || 0;
        var tolDays  = parseInt(settings.toleranceDays, 10) || 30;
        var results  = [];

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
                        type:       C.TXN_TYPE.CUSTOMER_PAYMENT,
                        nsType:     'invoice',
                        nsId:       row.getValue('internalid'),
                        reference:  row.getValue('tranid'),
                        date:       row.getValue('trandate'),
                        amount:     parseFloat(row.getValue('amountremaining')),
                        currency:   row.getValue('currency'),
                        entity:     row.getValue({ name: 'companyname', join: 'customer' }) ||
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
     * Find posted Vendor Payments whose amount is within tolerance of the
     * bank debit amount.
     *
     * @param {Object} bankTxn   { date, amount, reference, currency }
     * @param {Object} settings  { toleranceAmt, toleranceDays, subsidiary }
     * @returns {Array}  sorted array of candidates
     */
    function findBillPaymentMatches(bankTxn, settings) {
        var amt     = Math.abs(parseFloat(bankTxn.amount) || 0);
        var tolAmt  = parseFloat(settings.toleranceAmt)  || 0;
        var tolDays = parseInt(settings.toleranceDays, 10) || 30;
        var results = [];

        var filters = [
            ['type', 'anyof', 'VendPymt'], 'AND',
            ['amount', 'between', Math.max(0, amt - tolAmt), amt + tolAmt], 'AND',
            ['mainline', 'is', 'T']
        ];
        if (settings.subsidiary) {
            filters.push('AND');
            filters.push(['subsidiary', 'anyof', settings.subsidiary]);
        }

        var columns = [
            'internalid', 'tranid', 'trandate', 'amount', 'currency',
            search.createColumn({ name: 'companyname', join: 'vendor' }),
            search.createColumn({ name: 'entityid',   join: 'vendor' })
        ];

        try {
            search.create({ type: 'transaction', filters: filters, columns: columns })
                .run().each(function (row) {
                    var candidate = {
                        type:      C.TXN_TYPE.BILL_PAYMENT,
                        nsType:    'vendorpayment',
                        nsId:      row.getValue('internalid'),
                        reference: row.getValue('tranid'),
                        date:      row.getValue('trandate'),
                        amount:    parseFloat(row.getValue('amount')),
                        currency:  row.getValue('currency'),
                        entity:    row.getValue({ name: 'companyname', join: 'vendor' }) ||
                                   row.getValue({ name: 'entityid',   join: 'vendor' })
                    };
                    candidate.score = _score(bankTxn, candidate, tolAmt, tolDays);
                    results.push(candidate);
                    return true;
                });
        } catch (e) {
            log.error('BM_MatchEngine.findBillPaymentMatches', e.message);
        }

        return results.sort(function (a, b) { return b.score - a.score; });
    }

    /**
     * Apply an approved Customer Payment proposal.
     * Creates a Customer Payment record and applies it to the matched invoice.
     *
     * @param {Object} proposal  All proposal field values
     * @returns {string}  Internal ID of the new Customer Payment record
     */
    function applyCustomerPayment(proposal) {
        var invoiceId  = proposal.nsId;
        var bankAmt    = parseFloat(proposal.bankAmount);
        var bankDate   = _parseDate(proposal.bankDate) || new Date();

        // Load invoice to get customer + currency
        var invRec     = record.load({ type: record.Type.INVOICE, id: invoiceId });
        var customerId = invRec.getValue('entity');
        var currency   = invRec.getValue('currency');

        // Create Customer Payment in dynamic mode so the Apply sublist populates
        var payment = record.create({ type: record.Type.CUSTOMER_PAYMENT, isDynamic: true });
        payment.setValue({ fieldId: 'customer',  value: customerId });
        payment.setValue({ fieldId: 'trandate',  value: bankDate });
        payment.setValue({ fieldId: 'payment',   value: bankAmt });
        payment.setValue({ fieldId: 'currency',  value: currency });
        payment.setValue({ fieldId: 'memo',
            value: 'Bank Match reconciliation – bank ref: ' + (proposal.bankRef || '') });

        // Find and check the invoice line in the Apply sublist
        var lineCount = payment.getLineCount({ sublistId: 'apply' });
        for (var i = 0; i < lineCount; i++) {
            var lineId = payment.getSublistValue({ sublistId: 'apply', fieldId: 'internalid', line: i });
            if (String(lineId) === String(invoiceId)) {
                payment.selectLine({ sublistId: 'apply', line: i });
                payment.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply',  value: true });
                payment.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'amount', value: bankAmt });
                payment.commitLine({ sublistId: 'apply' });
                break;
            }
        }

        var newId = payment.save({ enableSourcing: true, ignoreMandatoryFields: false });
        log.audit('BM_MatchEngine', 'Customer Payment ' + newId +
                  ' created and applied to Invoice ' + invoiceId);
        return String(newId);
    }

    /**
     * Reconcile an approved Bill Payment proposal.
     * If "Adjust Date" is checked, updates the Vendor Payment's trandate
     * to match the bank statement date.
     *
     * @param {Object} proposal  All proposal field values
     * @returns {boolean}
     */
    function applyBillPayment(proposal) {
        var vendorPaymentId = proposal.nsId;

        if (proposal.adjustDate) {
            var bankDate = _parseDate(proposal.bankDate) || new Date();
            record.submitFields({
                type: 'vendorpayment',
                id:   vendorPaymentId,
                values: {
                    trandate: bankDate,
                    memo: 'Date adjusted via Bank Match – bank ref: ' + (proposal.bankRef || '')
                },
                options: { enableSourcing: true, ignoreMandatoryFields: false }
            });
            log.audit('BM_MatchEngine',
                'Vendor Payment ' + vendorPaymentId + ' date adjusted to ' + proposal.bankDate);
        } else {
            log.audit('BM_MatchEngine',
                'Vendor Payment ' + vendorPaymentId + ' reconciled (no date adjustment)');
        }
        return true;
    }

    /**
     * Send an approval-request email to the approver.
     * Called when a new Proposal record is saved.
     *
     * @param {Object} opts  { approverEmail, proposalId, bankRef, bankAmt, bankDate, nsRef, type }
     */
    function notifyApprover(opts) {
        try {
            var subject = 'Bank Match – Approval Required: ' + opts.bankRef;
            var body = [
                'A new bank reconciliation proposal requires your approval.',
                '',
                'Proposal ID  : ' + opts.proposalId,
                'Type         : ' + opts.type,
                'Bank Date    : ' + opts.bankDate,
                'Bank Amount  : ' + opts.bankAmt,
                'Bank Ref     : ' + opts.bankRef,
                'NetSuite Ref : ' + opts.nsRef,
                '',
                'Please log in to NetSuite and open the proposal record to Approve or Reject.',
                '',
                'This is an automated message from the Bank Match SuiteApp.'
            ].join('\n');

            email.send({
                author:     runtime.getCurrentUser().id,
                recipients: [opts.approverEmail],
                subject:    subject,
                body:       body
            });
        } catch (e) {
            log.error('BM_MatchEngine.notifyApprover', e.message);
        }
    }

    return {
        findInvoiceMatches:     findInvoiceMatches,
        findBillPaymentMatches: findBillPaymentMatches,
        applyCustomerPayment:   applyCustomerPayment,
        applyBillPayment:       applyBillPayment,
        notifyApprover:         notifyApprover
    };
});
