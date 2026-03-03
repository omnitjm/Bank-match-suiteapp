/**
 * BM_MatchEngine.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Advanced Waterfall Matching Engine for Bank Match Central.
 *
 * NEW in this version:
 *   - Data sanitization (sanitizeMemo, extractNumericParts) — strips noise
 *     words (Invoice, INV, Faktura, Payment, Nets …) and extracts raw numbers.
 *   - Waterfall matching (runWaterfallMatch) with three tiers:
 *       Tier 1  – Exact amount + exact document number in memo  → score 100
 *       Tier 2a – Exact amount + numeric doc-ID part in memo    → score 90
 *       Tier 2b – Numeric doc-ID match, amount within tolerance → score 80, hasVariance
 *       Tier 3  – Entity name in memo + single matching amount  → score 70
 *   - Tolerance/Variance flagging: hasVariance + varianceAmt on every result.
 *   - Optimized N/search: loads ONLY candidates matching by amount±tolerance
 *     OR by tranid containing memo numeric parts — never all open transactions.
 *   - Dynamic TOLERANCE_AMOUNT from settings (no hardcoded constants).
 *   - Variance write-off via Journal Entry when applying Customer/Vendor Payment:
 *       Customer: DR Fee Account, CR AR control account (with entity)
 *       Vendor:   DR AP control account (with entity), CR Fee Account
 *
 * Public API:
 *   sanitizeMemo(text)                  – exported for reuse/testing
 *   extractNumericParts(text)           – exported for reuse/testing
 *   runWaterfallMatch(bankTxn, settings) – primary auto-match entry point
 *   findInvoiceMatches(bankTxn, settings) – legacy score-based (manual-match panel)
 *   findVendorBillMatches(bankTxn, settings) – legacy score-based (manual-match panel)
 *   findOpenInvoicesByCustomer(customerId)
 *   findOpenBillsByVendor(vendorId)
 *   applyCustomerPayment(proposal, settings) – creates payment + optional variance JE
 *   applyVendorPayment(proposal, settings)   – creates payment + optional variance JE
 *   applyJournalEntry(proposal, bankGlAcctId)
 *
 * ALL apply* functions stamp custbody_bank_transaction_id on the caller's side.
 * NEVER write to tranid.
 */
define([
    'N/search',
    'N/record',
    'N/log',
    './BM_Constants'
], function (search, record, log, C) {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // DATA SANITIZATION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Noise words / patterns to strip before matching.
     * Covers common bank memo prefixes across EN, DE, NL, and NO locales.
     */
    var NOISE_PATTERN = /\b(?:invoice|inv|faktura|payment|nets|ref|from|to|for|the|paid|pmnt|pmt|rcpt|bank|transfer|wire|eft|ach|debit|credit|remittance|remit|re|regarding|re:|ltd|inc|llc|gmbh|bv|as|sa)\b/gi;

    /**
     * Sanitize a bank memo or payee field.
     * Strips common noise words, removes non-alphanumeric characters,
     * and collapses whitespace.  Returns lowercase.
     *
     * @param  {string} text  Raw bank memo / payee / description
     * @returns {string}      Cleaned, lowercase, space-normalized string
     */
    function sanitizeMemo(text) {
        if (!text) return '';
        return String(text)
            .replace(NOISE_PATTERN, ' ')
            .replace(/[^a-z0-9 ]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    /**
     * Extract all numeric strings of 3+ digits from text.
     * These are used to match against the numeric parts of NS document IDs.
     *
     * @param  {string}   text  Already sanitized or raw string
     * @returns {string[]}      e.g. ['1042', '20230915']
     */
    function extractNumericParts(text) {
        if (!text) return [];
        var matches = String(text).match(/\d{3,}/g);
        return matches ? matches : [];
    }

    /**
     * Extract the trailing (most-significant) numeric segment from a NS tranid.
     * e.g. 'INV-1042'  → '1042'
     *      'BILL-00023' → '00023'
     *      '1042'       → '1042'
     *
     * @param  {string} tranid
     * @returns {string}
     */
    function _docNumericPart(tranid) {
        if (!tranid) return '';
        var nums = String(tranid).match(/\d+/g);
        return nums ? nums[nums.length - 1] : '';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // OPTIMIZED CANDIDATE SEARCH
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Targeted N/search for open Invoice or VendorBill candidates.
     *
     * Applies a compound filter to avoid loading ALL open transactions:
     *   (amountremaining BETWEEN bankAmt ± window)
     *   OR (tranid CONTAINS any 3+ digit number from bank memo)
     *
     * Window = max(toleranceAmt, 1% of bankAmt) so tiny tolerances still
     * catch near-exact matches while larger tolerances cast a wider net.
     *
     * @param {Object} bankTxn   { amount, description, reference }
     * @param {Object} settings  { toleranceAmt, subsidiary }
     * @param {string} recType   'invoice' | 'vendorbill'
     * @returns {Array}          Raw candidate objects
     */
    function _findCandidatesOptimized(bankTxn, settings, recType) {
        var bankAmt  = Math.abs(parseFloat(bankTxn.amount) || 0);
        var tolAmt   = Math.abs(parseFloat(settings.toleranceAmt) || 0);
        var isInv    = (recType === 'invoice');
        var nsType   = isInv ? 'CustInvc' : 'VendBill';
        var nsStatus = isInv ? 'CustInvc:Open' : 'VendBill:Open';
        var joinKey  = isInv ? 'customer' : 'vendor';

        // Extract 3+ digit numbers from full bank text
        var fullText = (bankTxn.description || '') + ' ' + (bankTxn.reference || '');
        var bankNums = extractNumericParts(sanitizeMemo(fullText));

        // Amount search window: at least the tolerance, never less than 1% of bankAmt
        var window   = Math.max(tolAmt, bankAmt * 0.01);
        var amtFilter = [
            'amountremaining', 'between',
            Math.max(0, bankAmt - window),
            bankAmt + window
        ];

        // Compound base filter
        var baseFilters = [
            ['type',   'anyof', nsType],   'AND',
            ['status', 'anyof', nsStatus]
        ];

        if (bankNums.length > 0) {
            // (amount in window) OR (tranid contains one of the bank numbers)
            var tranidParts = [];
            bankNums.forEach(function (n) {
                if (tranidParts.length) tranidParts.push('OR');
                tranidParts.push(['tranid', 'contains', n]);
            });
            baseFilters.push('AND');
            baseFilters.push([amtFilter, 'OR', tranidParts]);
        } else {
            baseFilters.push('AND');
            baseFilters.push(amtFilter);
        }

        if (settings.subsidiary) {
            baseFilters.push('AND');
            baseFilters.push(['subsidiary', 'anyof', settings.subsidiary]);
        }

        var columns = [
            'internalid', 'tranid', 'trandate',
            'amountremaining', 'currency',
            search.createColumn({ name: 'companyname', join: joinKey }),
            search.createColumn({ name: 'entityid',   join: joinKey }),
            search.createColumn({ name: 'internalid', join: joinKey, label: 'entityInternalId' })
        ];

        var candidates = [];
        try {
            search.create({ type: 'transaction', filters: baseFilters, columns: columns })
                .run().each(function (row) {
                    candidates.push({
                        nsType:   recType,
                        nsId:     row.getValue('internalid'),
                        reference: row.getValue('tranid'),
                        date:     row.getValue('trandate'),
                        amount:   Math.abs(parseFloat(row.getValue('amountremaining')) || 0),
                        currency: row.getValue('currency'),
                        entity:   row.getValue({ name: 'companyname', join: joinKey }) ||
                                  row.getValue({ name: 'entityid',   join: joinKey }),
                        entityId: row.getValue({ name: 'internalid', join: joinKey, label: 'entityInternalId' }),
                        type:     isInv ? C.TXN_TYPE.CUSTOMER_PAYMENT : C.TXN_TYPE.VENDOR_PAYMENT
                    });
                    return candidates.length < 500;
                });
        } catch (e) {
            log.error('BM_MatchEngine._findCandidatesOptimized', e.message);
        }
        return candidates;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // WATERFALL MATCHING  (primary auto-match entry point)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Run Waterfall matching for a single bank line.
     *
     * Tiers are evaluated in priority order and execution stops at the first hit.
     *
     * Tier 1  – Exact amount (≤0.005 diff) AND the full cleaned tranid string
     *            appears inside the cleaned bank text.
     *            → score 100, hasVariance false
     *
     * Tier 2a – Exact amount AND the trailing numeric part of the tranid
     *            (e.g. '1042' from 'INV-1042') is found in the extracted bank
     *            numbers list.
     *            → score 90, hasVariance false
     *
     * Tier 2b – Same numeric doc-ID found in bank text BUT the amount differs
     *            from the open balance by ≤ toleranceAmt ("Match with Variance").
     *            → score 80, hasVariance true, varianceAmt = abs(diff)
     *
     * Tier 3  – The entity name (customer/vendor) appears verbatim in the
     *            sanitized bank text AND there is EXACTLY ONE open transaction
     *            for that entity matching the exact bank amount.
     *            The "exactly one" requirement prevents false positives.
     *            → score 70, hasVariance false
     *
     * @param {Object} bankTxn   { date, amount, description, reference }
     * @param {Object} settings  { toleranceAmt, toleranceDays, subsidiary }
     * @returns {Object|null}
     *   On match:  { candidate, tier, hasVariance, varianceAmt, score, matchReason }
     *              candidate has shape: { nsId, nsType, type, reference, date,
     *                                     amount, currency, entity, entityId }
     *   No match:  null
     */
    function runWaterfallMatch(bankTxn, settings) {
        var bankAmt  = Math.abs(parseFloat(bankTxn.amount) || 0);
        var tolAmt   = Math.abs(parseFloat(settings.toleranceAmt) || 0);
        var isCredit = parseFloat(bankTxn.amount) > 0;
        var recType  = isCredit ? 'invoice' : 'vendorbill';

        // Build search text variants
        var rawText   = (bankTxn.description || '') + ' ' + (bankTxn.reference || '');
        var cleanText = sanitizeMemo(rawText);
        var bankNums  = extractNumericParts(cleanText);

        var candidates = _findCandidatesOptimized(bankTxn, settings, recType);
        if (!candidates.length) return null;

        var i, c;

        // ── TIER 1: Exact amount + exact document number ──────────────────────
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            if (Math.abs(c.amount - bankAmt) > 0.005) continue;

            // Full tranid cleaned vs full raw bank text cleaned
            var docClean  = String(c.reference || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            var textClean = rawText.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (docClean && docClean.length >= 3 && textClean.indexOf(docClean) >= 0) {
                return {
                    candidate:   c,
                    tier:        1,
                    hasVariance: false,
                    varianceAmt: 0,
                    score:       100,
                    matchReason: 'Tier 1: Exact amount + exact document number "' + c.reference + '" in bank text'
                };
            }
        }

        // ── TIER 2: Numeric doc-ID part in bank memo ──────────────────────────
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            var docNum = _docNumericPart(c.reference);
            if (!docNum || docNum.length < 3) continue;
            if (bankNums.indexOf(docNum) < 0) continue;    // number not in memo

            var amtDiff = Math.abs(c.amount - bankAmt);

            // Tier 2a – exact amount
            if (amtDiff <= 0.005) {
                return {
                    candidate:   c,
                    tier:        2,
                    hasVariance: false,
                    varianceAmt: 0,
                    score:       90,
                    matchReason: 'Tier 2: Exact amount + numeric doc-ID "' + docNum + '" in bank text'
                };
            }

            // Tier 2b – within tolerance (Match with Variance)
            if (tolAmt > 0 && amtDiff <= tolAmt) {
                return {
                    candidate:   c,
                    tier:        2,
                    hasVariance: true,
                    varianceAmt: amtDiff,
                    score:       80,
                    matchReason: 'Tier 2 (Match with Variance ' + amtDiff.toFixed(2) + '): ' +
                                 'Numeric doc-ID "' + docNum + '" found, amount differs by ' +
                                 amtDiff.toFixed(2)
                };
            }
        }

        // ── TIER 3: Entity name + single matching amount ──────────────────────
        // Group by entityId those candidates whose entity name appears in the
        // sanitized memo AND whose amount exactly matches the bank amount.
        var entityBuckets = {};
        for (i = 0; i < candidates.length; i++) {
            c = candidates[i];
            var entityName = String(c.entity || '').toLowerCase().trim();
            if (entityName.length < 3) continue;
            if (cleanText.indexOf(entityName) < 0) continue;       // entity not in memo
            if (Math.abs(c.amount - bankAmt) > 0.005) continue;    // amount must be exact

            var bucketKey = c.entityId || c.entity;
            if (!entityBuckets[bucketKey]) entityBuckets[bucketKey] = [];
            entityBuckets[bucketKey].push(c);
        }

        var eKeys = Object.keys(entityBuckets);
        for (var ei = 0; ei < eKeys.length; ei++) {
            var bucket = entityBuckets[eKeys[ei]];
            if (bucket.length === 1) {
                // Exactly one open transaction for this entity at this amount → safe
                return {
                    candidate:   bucket[0],
                    tier:        3,
                    hasVariance: false,
                    varianceAmt: 0,
                    score:       70,
                    matchReason: 'Tier 3: Entity "' + bucket[0].entity +
                                 '" in bank text + single open transaction at exact amount'
                };
            }
        }

        return null; // No tier matched
    }

    // ─────────────────────────────────────────────────────────────────────────
    // LEGACY SCORE-BASED MATCHING  (kept for manual-match suggestion panel)
    // ─────────────────────────────────────────────────────────────────────────

    function _score(bankTxn, candidate, toleranceAmt, toleranceDays) {
        var score   = 0;
        var bankAmt = Math.abs(parseFloat(bankTxn.amount)   || 0);
        var candAmt = Math.abs(parseFloat(candidate.amount) || 0);
        var amtDiff = Math.abs(bankAmt - candAmt);

        // Amount component (0–40 pts)
        if (amtDiff === 0)                        score += 40;
        else if (amtDiff <= toleranceAmt * 0.25)  score += 35;
        else if (amtDiff <= toleranceAmt * 0.50)  score += 25;
        else if (amtDiff <= toleranceAmt)          score += 15;

        // Date component (0–30 pts)
        if (bankTxn.date && candidate.date) {
            var days = Math.abs((new Date(bankTxn.date) - new Date(candidate.date)) / 86400000);
            if (days === 0)                 score += 30;
            else if (days <= 3)             score += 22;
            else if (days <= 7)             score += 14;
            else if (days <= toleranceDays) score += 6;
        }

        // Reference component (0–30 pts)
        if (bankTxn.reference && candidate.reference) {
            var bRef = String(bankTxn.reference).toLowerCase().replace(/\W/g, '');
            var cRef = String(candidate.reference).toLowerCase().replace(/\W/g, '');
            if (bRef && cRef) {
                if (bRef === cRef)                                              score += 30;
                else if (bRef.indexOf(cRef) >= 0 || cRef.indexOf(bRef) >= 0)  score += 18;
            }
        }
        return score;
    }

    function _parseDate(str) {
        if (!str) return null;
        var d = new Date(str);
        return isNaN(d.getTime()) ? null : d;
    }

    /**
     * Find open Invoices matching a bank credit.
     * Uses legacy score algorithm — kept for the manual-match suggestion panel.
     */
    function findInvoiceMatches(bankTxn, settings) {
        var amt     = Math.abs(parseFloat(bankTxn.amount) || 0);
        var tolAmt  = parseFloat(settings.toleranceAmt)   || 0;
        var tolDays = parseInt(settings.toleranceDays, 10) || 30;
        var results = [];

        var filters = [
            ['type',   'anyof', 'CustInvc'],      'AND',
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
     * Find open Vendor Bills matching a bank debit.
     * Uses legacy score algorithm — kept for the manual-match suggestion panel.
     */
    function findVendorBillMatches(bankTxn, settings) {
        var amt     = Math.abs(parseFloat(bankTxn.amount) || 0);
        var tolAmt  = parseFloat(settings.toleranceAmt)   || 0;
        var tolDays = parseInt(settings.toleranceDays, 10) || 30;
        var results = [];

        var filters = [
            ['type',   'anyof', 'VendBill'],      'AND',
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

    // ─────────────────────────────────────────────────────────────────────────
    // ENTITY OPEN DOCUMENT LOOKUPS  (unchanged)
    // ─────────────────────────────────────────────────────────────────────────

    function findOpenInvoicesByCustomer(customerId, subsidiary) {
        var results  = [];
        var filters  = [
            ['type',   'anyof', 'CustInvc'],      'AND',
            ['status', 'anyof', 'CustInvc:Open'], 'AND',
            ['entity', 'anyof', String(customerId)]
        ];
        if (subsidiary) {
            filters.push('AND');
            filters.push(['subsidiary', 'anyof', subsidiary]);
        }
        try {
            search.create({
                type: 'transaction',
                filters: filters,
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

    function findOpenBillsByVendor(vendorId, subsidiary) {
        var results = [];
        var filters = [
            ['type',   'anyof', 'VendBill'],      'AND',
            ['status', 'anyof', 'VendBill:Open'], 'AND',
            ['entity', 'anyof', String(vendorId)]
        ];
        if (subsidiary) {
            filters.push('AND');
            filters.push(['subsidiary', 'anyof', subsidiary]);
        }
        try {
            search.create({
                type: 'transaction',
                filters: filters,
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

    // ─────────────────────────────────────────────────────────────────────────
    // VARIANCE WRITE-OFF JOURNAL ENTRY  (internal helper)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Create a two-line Journal Entry to write off a Match-with-Variance amount.
     *
     * Customer (isAP=false):
     *   DR Fee Account (expense increases)
     *   CR AR control account + entity (reduces open customer AR)
     *
     * Vendor (isAP=true):
     *   DR AP control account + entity (reduces open vendor AP)
     *   CR Fee Account (expense decreases / income)
     *
     * @param {Date}          tranDate         Payment date
     * @param {string|number} feeAccountId     GL expense account from settings
     * @param {string|number} controlAccountId AR or AP control account from invoice/bill
     * @param {string|number} entityId         Customer or vendor internal ID
     * @param {string|number} subsidiaryId     Subsidiary (may be null in one-world)
     * @param {number}        varianceAmt      Positive amount to write off
     * @param {string}        memo             Audit memo for the JE
     * @param {boolean}       isAP             true → vendor/AP side, false → customer/AR side
     * @returns {string}  Journal Entry internal ID
     */
    function _createVarianceJE(tranDate, feeAccountId, controlAccountId, entityId,
                                subsidiaryId, varianceAmt, memo, isAP) {
        var je = record.create({ type: record.Type.JOURNAL_ENTRY, isDynamic: true });
        je.setValue({ fieldId: 'trandate', value: tranDate });
        je.setValue({ fieldId: 'memo',     value: memo });
        if (subsidiaryId) {
            try { je.setValue({ fieldId: 'subsidiary', value: subsidiaryId }); } catch (e) { /* one-world */ }
        }

        if (!isAP) {
            // Customer: DR fee account, CR AR account (with entity)
            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: feeAccountId });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit',   value: varianceAmt });
            je.commitLine({ sublistId: 'line' });

            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: controlAccountId });
            if (entityId) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: entityId });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit',  value: varianceAmt });
            je.commitLine({ sublistId: 'line' });
        } else {
            // Vendor: DR AP account (with entity), CR fee account
            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: controlAccountId });
            if (entityId) je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'entity', value: entityId });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit',   value: varianceAmt });
            je.commitLine({ sublistId: 'line' });

            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: feeAccountId });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit',  value: varianceAmt });
            je.commitLine({ sublistId: 'line' });
        }

        var jeId = je.save({ enableSourcing: true, ignoreMandatoryFields: false });
        log.audit('BM_MatchEngine._createVarianceJE',
            'Variance JE ' + jeId + ' created: ' + varianceAmt.toFixed(2) +
            ' → fee acct ' + feeAccountId + ' | ctrl acct ' + controlAccountId);
        return String(jeId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TRANSACTION CREATION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Create a Customer Payment and apply it to the matched Invoice.
     *
     * If proposal.hasVariance is true AND settings.feeAccount is configured,
     * a Journal Entry is created automatically to write off the difference:
     *   DR Bank Fee Account   (expense)
     *   CR AR control account (with entity, reduces open AR balance)
     *
     * Caller is responsible for stamping custbody_bank_transaction_id.
     *
     * @param {Object}  proposal  { nsId, bankAmount, bankDate, bankRef,
     *                              hasVariance, varianceAmt }
     * @param {Object}  [settings] { feeAccount }  — optional; needed for variance JE
     * @returns {string}  Internal ID of the new Customer Payment
     */
    function applyCustomerPayment(proposal, settings) {
        var invoiceId  = proposal.nsId;
        var bankAmt    = parseFloat(proposal.bankAmount);
        var bankDate   = _parseDate(proposal.bankDate) || new Date();

        var invRec     = record.load({ type: record.Type.INVOICE, id: invoiceId });
        var customerId = invRec.getValue('entity');
        var currency   = invRec.getValue('currency');
        var arAccount  = invRec.getValue('account');     // AR control account
        var subsidiary = invRec.getValue('subsidiary');

        var payment = record.create({ type: record.Type.CUSTOMER_PAYMENT, isDynamic: true });
        payment.setValue({ fieldId: 'customer', value: customerId });
        payment.setValue({ fieldId: 'trandate',  value: bankDate });
        payment.setValue({ fieldId: 'payment',   value: bankAmt });
        payment.setValue({ fieldId: 'currency',  value: currency });
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
            'Customer Payment ' + newId + ' created, applied to Invoice ' + invoiceId +
            ', bank amount: ' + bankAmt);

        // ── Variance write-off JE ──────────────────────────────────────────
        var varianceAmt = parseFloat(proposal.varianceAmt) || 0;
        if (proposal.hasVariance && varianceAmt > 0.001 && settings && settings.feeAccount) {
            try {
                _createVarianceJE(
                    bankDate,
                    settings.feeAccount,
                    arAccount,
                    customerId,
                    subsidiary,
                    varianceAmt,
                    'Bank Match variance write-off – bank ref: ' + (proposal.bankRef || '') +
                        ' | Customer Payment: ' + newId,
                    false
                );
            } catch (jeErr) {
                log.error('BM_MatchEngine.applyCustomerPayment',
                    'Variance JE failed (payment ' + newId + ' already saved): ' + jeErr.message);
            }
        }

        return String(newId);
    }

    /**
     * Create a Vendor Payment and apply it to the matched Vendor Bill.
     *
     * If proposal.hasVariance is true AND settings.feeAccount is configured,
     * a Journal Entry is created automatically to write off the difference:
     *   DR AP control account (with entity, reduces open AP balance)
     *   CR Bank Fee Account   (expense / income offset)
     *
     * Caller is responsible for stamping custbody_bank_transaction_id.
     *
     * @param {Object}  proposal  { nsId, bankAmount, bankDate, bankRef,
     *                              hasVariance, varianceAmt }
     * @param {Object}  [settings] { feeAccount }  — optional; needed for variance JE
     * @returns {string}  Internal ID of the new Vendor Payment
     */
    function applyVendorPayment(proposal, settings) {
        var billId     = proposal.nsId;
        var bankAmt    = parseFloat(proposal.bankAmount);
        var bankDate   = _parseDate(proposal.bankDate) || new Date();

        var billRec    = record.load({ type: record.Type.VENDOR_BILL, id: billId });
        var vendorId   = billRec.getValue('entity');
        var currency   = billRec.getValue('currency');
        var apAcct     = billRec.getValue('account');    // AP control account
        var subsidiary = billRec.getValue('subsidiary');

        var payment = record.create({ type: record.Type.VENDOR_PAYMENT, isDynamic: true });
        payment.setValue({ fieldId: 'entity',   value: vendorId });
        payment.setValue({ fieldId: 'trandate',  value: bankDate });
        payment.setValue({ fieldId: 'currency',  value: currency });
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
            'Vendor Payment ' + newId + ' created, applied to Bill ' + billId +
            ', bank amount: ' + bankAmt);

        // ── Variance write-off JE ──────────────────────────────────────────
        var varianceAmt = parseFloat(proposal.varianceAmt) || 0;
        if (proposal.hasVariance && varianceAmt > 0.001 && settings && settings.feeAccount) {
            try {
                _createVarianceJE(
                    bankDate,
                    settings.feeAccount,
                    apAcct,
                    vendorId,
                    subsidiary,
                    varianceAmt,
                    'Bank Match variance write-off – bank ref: ' + (proposal.bankRef || '') +
                        ' | Vendor Payment: ' + newId,
                    true
                );
            } catch (jeErr) {
                log.error('BM_MatchEngine.applyVendorPayment',
                    'Variance JE failed (payment ' + newId + ' already saved): ' + jeErr.message);
            }
        }

        return String(newId);
    }

    /**
     * Create a Journal Entry to account for a bank transaction against a GL account.
     * Used for unknown transactions matched to suspense / expense / income accounts.
     *
     * Positive bankAmount (credit/money in):  DR bank account, CR GL account
     * Negative bankAmount (debit/money out):  CR bank account, DR GL account
     *
     * Caller is responsible for stamping custbody_bank_transaction_id.
     *
     * @param {Object}        proposal      { nsId: glAccountId, bankAmount, bankDate, bankRef }
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
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: bankGlAcctId });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit',   value: absAmt });
            je.commitLine({ sublistId: 'line' });

            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: glAccountId });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit',  value: absAmt });
            je.commitLine({ sublistId: 'line' });
        } else {
            // Money out: Credit bank account, Debit expense/GL account
            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: bankGlAcctId });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'credit',  value: absAmt });
            je.commitLine({ sublistId: 'line' });

            je.selectNewLine({ sublistId: 'line' });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'account', value: glAccountId });
            je.setCurrentSublistValue({ sublistId: 'line', fieldId: 'debit',   value: absAmt });
            je.commitLine({ sublistId: 'line' });
        }

        var newId = je.save({ enableSourcing: true, ignoreMandatoryFields: false });
        log.audit('BM_MatchEngine',
            'Journal Entry ' + newId + ' created for GL account ' + glAccountId +
            ' (bank account ' + bankGlAcctId + ')');
        return String(newId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXPORTS
    // ─────────────────────────────────────────────────────────────────────────
    return {
        // Sanitization utilities (also exported for testing / caller use)
        sanitizeMemo:               sanitizeMemo,
        extractNumericParts:        extractNumericParts,

        // Primary auto-match entry point (waterfall, 3-tier)
        runWaterfallMatch:          runWaterfallMatch,

        // Legacy score-based match — used by manual-match suggestion panel
        findInvoiceMatches:         findInvoiceMatches,
        findVendorBillMatches:      findVendorBillMatches,

        // Entity open-document lookups (unchanged public API)
        findOpenInvoicesByCustomer: findOpenInvoicesByCustomer,
        findOpenBillsByVendor:      findOpenBillsByVendor,

        // Transaction creation
        applyCustomerPayment:       applyCustomerPayment,
        applyVendorPayment:         applyVendorPayment,
        applyJournalEntry:          applyJournalEntry
    };
});
