/**
 * tests/loader.js
 *
 * Minimal loader that lets us require SuiteScript 2.1 modules (which wrap
 * their body in `define([deps], function(...){})`) from a plain Node.js
 * test process — no NetSuite CLI, no SDF, no network.
 *
 * The loader resolves `N/*` dependencies to stub objects whose behaviour can
 * be overridden per test (most importantly N/search, where tests inject
 * canned candidate rows).
 *
 * Use:
 *   const { loadModule } = require('./loader');
 *   const constants  = loadModule('FileCabinet/SuiteScripts/BankMatch/BM_Constants.js');
 *   const engine     = loadModule('.../BM_MatchEngine.js',
 *                                 { './BM_Constants': constants },
 *                                 { 'N/search': fakeSearch });
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DEFAULT_NS_STUBS = {
    'N/search': {
        Sort: { ASC: 'ASC', DESC: 'DESC' },
        createColumn: (opts) => opts,
        create: () => ({ run: () => ({ each: () => {}, getRange: () => [] }) })
    },
    'N/log':    { audit: () => {}, debug: () => {}, error: () => {} },
    'N/record': { create: () => ({ setValue: () => {}, save: () => 1 }) },
    'N/query':  { runSuiteQL: () => ({ results: [] }) },
    'N/url':    { resolveScript: () => '' },
    'N/ui/serverWidget': {}
};

function loadModule(filePath, projectDeps, nsOverrides) {
    projectDeps = projectDeps || {};
    nsOverrides = nsOverrides || {};

    const abs = path.resolve(filePath);
    const src = fs.readFileSync(abs, 'utf8');
    const fn  = new Function('define', src);
    let result = null;

    fn(function (deps, factory) {
        const resolved = deps.map((d) => {
            if (Object.prototype.hasOwnProperty.call(projectDeps, d))  return projectDeps[d];
            if (Object.prototype.hasOwnProperty.call(nsOverrides, d))  return nsOverrides[d];
            if (Object.prototype.hasOwnProperty.call(DEFAULT_NS_STUBS, d)) return DEFAULT_NS_STUBS[d];
            return {};
        });
        result = factory.apply(null, resolved);
    });
    return result;
}

/**
 * Build a fake N/search that returns canned rows depending on the type
 * requested.  Pass two arrays of arrays — one for `transaction` searches
 * (waterfall candidate searches) and one for entity searches
 * (customer/vendor lookups in Tier 4).  Each inner array is consumed in
 * call order.
 */
function makeFakeSearch(transactionRowSets, entityRowSets) {
    let txnIdx = 0;
    let entIdx = 0;
    return {
        Sort: { ASC: 'ASC', DESC: 'DESC' },
        createColumn: (opts) => opts,
        create(opts) {
            let rows;
            if (opts.type === 'transaction') {
                rows = transactionRowSets[txnIdx++] || [];
            } else {
                rows = entityRowSets[entIdx++] || [];
            }
            return {
                run: () => ({
                    each(cb) {
                        for (let i = 0; i < rows.length; i++) {
                            const row = rows[i];
                            const cont = cb({
                                id: row.id || row.internalid,
                                getValue(key) {
                                    const k = typeof key === 'string'
                                        ? key
                                        : (key.label || key.name);
                                    return row[k];
                                }
                            });
                            if (cont === false) break;
                        }
                    },
                    getRange: () => rows.map((row) => ({
                        id: row.id || row.internalid,
                        getValue(key) {
                            const k = typeof key === 'string' ? key : (key.label || key.name);
                            return row[k];
                        }
                    }))
                })
            };
        }
    };
}

module.exports = { loadModule, makeFakeSearch, DEFAULT_NS_STUBS };
