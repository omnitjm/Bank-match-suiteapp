/**
 * BM_BankLineReader.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Reads unmatched bank statement lines that the native NetSuite
 * "Match Bank Data" module has already imported.
 *
 * ─── Why this exists ──────────────────────────────────────────────────────────
 * Our SuiteApp sits on top of NetSuite's native Match Bank Data module.
 * That module is responsible for getting bank data into NetSuite (via CSV,
 * OFX, QFX, BAI2, Bank Feeds, etc.).  We read those lines and automate the
 * matching/approval/reconciliation workflow.
 *
 * ─── Access strategy (three-tier fallback) ───────────────────────────────────
 * Tier 1 – SuiteQL on BankStatementImportLine (NetSuite's internal table)
 * Tier 2 – N/search on the 'bankstatementimportline' internal record type
 * Tier 3 – N/search on our own customrecord_bm_bank_txn (if user manually
 *           entered lines or used our legacy CSV import helper)
 *
 * The caller always receives a consistent array of plain objects regardless
 * of which tier succeeded.
 */
define([
    'N/query',
    'N/search',
    'N/log',
    './BM_Constants'
], function (query, search, log, C) {
    'use strict';

    var BTF = C.BANK_TXN_FIELDS;

    // ── Normalise a row into a consistent shape ────────────────────────────
    // payee / counterparty / name fields are kept separately because they are
    // the single strongest signal for entity-based matching (Tier 4 in the
    // waterfall engine).  The native NetSuite BankStatementImportLine record
    // carries them in `name`, `customername`, or `payee` depending on the
    // source (OFX vs BAI2 vs CSV).
    function _norm(o) {
        var payee = o.payee || o.customername || o.name || '';
        return {
            id:          String(o.id || ''),
            date:        o.date        || o.trandate     || '',
            description: o.description || o.memo         || o.name || '',
            amount:      parseFloat(o.amount || 0),
            reference:   o.reference   || o.fitid        || o.fitId || '',
            currency:    o.currency    || 'USD',
            status:      o.status      || C.TXN_STATUS.UNMATCHED,
            payee:       String(payee || '').trim(),
            source:      o._source     || 'custom'   // 'native' | 'custom'
        };
    }

    // ── Tier 1: SuiteQL ────────────────────────────────────────────────────
    function _readViaSuiteQL(accountId) {
        var where = accountId
            ? "account = '" + accountId + "' AND iscleared = 'F'"
            : "iscleared = 'F'";

        // Try enriched query first (includes `customername` which is present on
        // BAI2 / proprietary feeds).  If that column is not exposed in this
        // NetSuite account, fall back to a base query that only uses `name`
        // (the OFX/QFX counterparty column, which is universally present).
        var enriched = 'SELECT id, trandate, memo, amount, currency, fitid, name, customername ' +
                       'FROM BankStatementImportLine WHERE ' + where + ' ORDER BY trandate DESC';
        var basic    = 'SELECT id, trandate, memo, amount, currency, fitid, name ' +
                       'FROM BankStatementImportLine WHERE ' + where + ' ORDER BY trandate DESC';

        function _runSql(sql, hasCustomerName) {
            var rows = [];
            var rs = query.runSuiteQL({ query: sql });
            rs.results.forEach(function (row) {
                var cols = row.values;
                rows.push(_norm({
                    id:           cols[0],
                    date:         cols[1],
                    description:  cols[2] || cols[6], // memo or name
                    amount:       cols[3],
                    currency:     cols[4],
                    reference:    cols[5],            // fitid
                    name:         cols[6],            // OFX counterparty
                    customername: hasCustomerName ? cols[7] : '',
                    _source:      'native'
                }));
            });
            return rows;
        }

        try {
            var enrichedRows = _runSql(enriched, true);
            log.debug('BM_BankLineReader',
                'Tier1 (SuiteQL+payee) returned ' + enrichedRows.length + ' lines');
            return enrichedRows.length ? enrichedRows : null;
        } catch (e1) {
            log.debug('BM_BankLineReader',
                'Tier1 enriched failed (' + e1.message + ') — retrying without customername');
            try {
                var basicRows = _runSql(basic, false);
                log.debug('BM_BankLineReader',
                    'Tier1 (SuiteQL basic) returned ' + basicRows.length + ' lines');
                return basicRows.length ? basicRows : null;
            } catch (e2) {
                log.debug('BM_BankLineReader', 'Tier1 failed entirely: ' + e2.message);
                return null;
            }
        }
    }

    // ── Tier 2: N/search internal record type ─────────────────────────────
    function _readViaSearch(accountId) {
        var filters = [];
        if (accountId) filters.push(['account', 'anyof', accountId]);

        var results = [];
        try {
            search.create({
                type: 'bankstatementimportline',
                filters: filters,
                columns: [
                    'internalid', 'trandate', 'memo',
                    'amount', 'currency', 'fitid', 'name'
                ]
            }).run().each(function (row) {
                results.push(_norm({
                    id:          row.id,
                    date:        row.getValue('trandate'),
                    description: row.getValue('memo') || row.getValue('name'),
                    amount:      row.getValue('amount'),
                    currency:    row.getValue('currency'),
                    reference:   row.getValue('fitid'),
                    name:        row.getValue('name'),   // OFX counterparty → payee
                    _source:     'native'
                }));
                return results.length < 500;
            });
            log.debug('BM_BankLineReader', 'Tier2 (N/search) returned ' + results.length + ' lines');
            return results.length ? results : null;
        } catch (e) {
            log.debug('BM_BankLineReader', 'Tier2 failed: ' + e.message);
            return null;
        }
    }

    // ── Tier 3: our own custom records ────────────────────────────────────
    function _readFromCustomRecords(accountId) {
        var filters = [
            ['isinactive', 'is', 'F'], 'AND',
            [BTF.STATUS, 'anyof', [C.TXN_STATUS.UNMATCHED, C.TXN_STATUS.PROPOSED]]
        ];
        if (accountId) {
            filters.push('AND');
            filters.push([BTF.BANK_ACCOUNT, 'anyof', accountId]);
        }

        var results = [];
        try {
            search.create({
                type: C.RECORDS.BANK_TXN,
                filters: filters,
                columns: [
                    BTF.TXN_DATE, BTF.DESCRIPTION, BTF.AMOUNT,
                    BTF.REFERENCE, BTF.CURRENCY, BTF.STATUS
                ]
            }).run().each(function (row) {
                results.push(_norm({
                    id:          row.id,
                    date:        row.getValue(BTF.TXN_DATE),
                    description: row.getValue(BTF.DESCRIPTION),
                    amount:      row.getValue(BTF.AMOUNT),
                    currency:    row.getValue(BTF.CURRENCY),
                    reference:   row.getValue(BTF.REFERENCE),
                    status:      row.getValue(BTF.STATUS),
                    _source:     'custom'
                }));
                return results.length < 500;
            });
            log.debug('BM_BankLineReader', 'Tier3 (custom records) returned ' + results.length + ' lines');
        } catch (e) {
            log.error('BM_BankLineReader', 'Tier3 failed: ' + e.message);
        }
        return results;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Read unmatched bank statement lines from the native Match Bank Data
     * module (or our own custom records as fallback).
     *
     * @param {string|number} [accountId]  Internal ID of the bank GL account.
     *                                     Leave empty to return lines for all accounts.
     * @returns {{ lines: Array, source: string }}
     *   lines  – array of normalised bank line objects
     *   source – 'native' | 'custom' | 'none'
     */
    function getUnmatchedLines(accountId) {
        var result;

        result = _readViaSuiteQL(accountId);
        if (result) return { lines: result, source: 'native' };

        result = _readViaSearch(accountId);
        if (result) return { lines: result, source: 'native' };

        result = _readFromCustomRecords(accountId);
        return { lines: result, source: result.length ? 'custom' : 'none' };
    }

    return { getUnmatchedLines: getUnmatchedLines };
});
