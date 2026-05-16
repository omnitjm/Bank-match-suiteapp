/**
 * tests/run.js — offline test runner for the Bank Match matching engine.
 *
 * Runs without NetSuite, without network, and without any extra dependencies.
 * Invoke with `npm test` or `node tests/run.js`.
 *
 * Exits with code 0 on success, 1 on any failed assertion.
 *
 * Scope:
 *   - BM_MatchEngine pure functions: sanitizeMemo, extractNumericParts
 *   - BM_MatchEngine.runWaterfallMatch with mocked search candidates
 *   - BM_RulesEngine._matchesCondition for every operator / field
 */
'use strict';

const { loadModule, makeFakeSearch } = require('./loader');

let passed = 0;
let failed = 0;
const fails = [];

function eq(label, expected, actual) {
    const ok = JSON.stringify(expected) === JSON.stringify(actual);
    if (ok) {
        passed++;
        process.stdout.write('  ✓ ' + label + '\n');
    } else {
        failed++;
        fails.push({ label, expected, actual });
        process.stdout.write('  ✗ ' + label + '\n' +
            '      expected ' + JSON.stringify(expected) + '\n' +
            '      actual   ' + JSON.stringify(actual)   + '\n');
    }
}

function section(name) {
    process.stdout.write('\n' + name + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Load modules (constants is required by both engines)
// ─────────────────────────────────────────────────────────────────────────────
const CONSTANTS_PATH = 'FileCabinet/SuiteScripts/BankMatch/BM_Constants.js';
const ENGINE_PATH    = 'FileCabinet/SuiteScripts/BankMatch/BM_MatchEngine.js';
const RULES_PATH     = 'FileCabinet/SuiteScripts/BankMatch/BM_RulesEngine.js';

const constants = loadModule(CONSTANTS_PATH);
const rules     = loadModule(RULES_PATH, { './BM_Constants': constants });

// ─────────────────────────────────────────────────────────────────────────────
//  Sanitisation utilities
// ─────────────────────────────────────────────────────────────────────────────
section('BM_MatchEngine — sanitisation');
const engineDefault = loadModule(ENGINE_PATH, { './BM_Constants': constants });

eq('sanitizeMemo strips "Invoice"/"INV" noise',
    'acme 1042', engineDefault.sanitizeMemo('ACME INV-1042 Payment'));
eq('sanitizeMemo strips Nordic/EU noise',
    '12345 fra', engineDefault.sanitizeMemo('Faktura 12345 fra Nets'));
eq('sanitizeMemo empty input is empty string',
    '', engineDefault.sanitizeMemo(''));
eq('extractNumericParts picks ≥3-digit runs',
    ['1042'], engineDefault.extractNumericParts('INV-1042 Payment 99'));
eq('extractNumericParts returns [] when none',
    [], engineDefault.extractNumericParts('no numbers here'));

// ─────────────────────────────────────────────────────────────────────────────
//  Rules engine condition matcher
// ─────────────────────────────────────────────────────────────────────────────
section('BM_RulesEngine — _matchesCondition');
const rm = rules._matchesCondition;

eq('description contains hit',
    true,  rm({ condField: 'description', condOp: 'contains', condValue: 'fee' },
              { description: 'BANK FEE MONTHLY' }));
eq('description contains miss',
    false, rm({ condField: 'description', condOp: 'contains', condValue: 'fee' },
              { description: 'salary deposit' }));
eq('description regex case-insensitive',
    true,  rm({ condField: 'description', condOp: 'regex', condValue: '^ACME' },
              { description: 'acme corp payment' }));
eq('description regex no match',
    false, rm({ condField: 'description', condOp: 'regex', condValue: '^foo' },
              { description: 'bar' }));
eq('amount gte (250 >= 100)',
    true,  rm({ condField: 'amount', condOp: 'gte', condValue: '100' },
              { amount: 250 }));
eq('amount gte (50 >= 100) false',
    false, rm({ condField: 'amount', condOp: 'gte', condValue: '100' },
              { amount: 50 }));
eq('amount lte (50 <= 100)',
    true,  rm({ condField: 'amount', condOp: 'lte', condValue: '100' },
              { amount: 50 }));
eq('amount equals — sign agnostic (|−50| == 50)',
    true,  rm({ condField: 'amount', condOp: 'equals', condValue: '50' },
              { amount: -50 }));
eq('amount equals — float precision (99.991 ~ 99.99)',
    true,  rm({ condField: 'amount', condOp: 'equals', condValue: '99.99' },
              { amount: 99.991 }));
eq('reference startswith hit',
    true,  rm({ condField: 'reference', condOp: 'startswith', condValue: 'CHK-' },
              { reference: 'CHK-1042' }));
eq('reference startswith miss',
    false, rm({ condField: 'reference', condOp: 'startswith', condValue: 'CHK-' },
              { reference: 'WIRE-1' }));
eq('payee endswith case-insensitive',
    true,  rm({ condField: 'payee', condOp: 'endswith', condValue: 'GMBH' },
              { payee: 'Acme Holding GmbH' }));
eq('payee contains — missing payee field is non-match',
    false, rm({ condField: 'payee', condOp: 'contains', condValue: 'acme' },
              { description: 'no payee' }));
eq('payee equals — case-insensitive',
    true,  rm({ condField: 'payee', condOp: 'equals', condValue: 'ACME CORP' },
              { payee: 'acme corp' }));
eq('empty condition value never matches',
    false, rm({ condField: 'description', condOp: 'contains', condValue: '' },
              { description: 'anything' }));
eq('invalid regex degrades to non-match (no throw)',
    false, rm({ condField: 'description', condOp: 'regex', condValue: '[' },
              { description: 'anything' }));

// ─────────────────────────────────────────────────────────────────────────────
//  Waterfall — Tier 1 (regression): exact amount + exact tranid in memo
// ─────────────────────────────────────────────────────────────────────────────
section('BM_MatchEngine.runWaterfallMatch — Tier 1');
const fs1 = makeFakeSearch([[{
    internalid: '101', tranid: 'INV-1042', trandate: '2026-01-15',
    amountremaining: '5000.00', currency: '1', companyname: 'Acme Corp',
    entityid: 'ACME', entityInternalId: '500'
}]], []);
const engine1 = loadModule(ENGINE_PATH, { './BM_Constants': constants }, { 'N/search': fs1 });

const r1 = engine1.runWaterfallMatch(
    { date: '2026-01-15', amount: 5000, description: 'Payment ref INV-1042 thanks', reference: '' },
    { toleranceAmt: 5, toleranceDays: 5 }
);
eq('Tier 1 fires when tranid in memo + exact amount',
    { tier: 1, score: 100, hasVariance: false, nsId: '101' },
    r1 && { tier: r1.tier, score: r1.score, hasVariance: r1.hasVariance, nsId: r1.candidate.nsId });

// ─────────────────────────────────────────────────────────────────────────────
//  Waterfall — Tier 4: payee → entity lookup
// ─────────────────────────────────────────────────────────────────────────────
section('BM_MatchEngine.runWaterfallMatch — Tier 4 (payee)');
const fs2 = makeFakeSearch(
    [[{
        internalid: '102', tranid: 'INV-9999', trandate: '2026-02-01',
        amountremaining: '1200.00', currency: '1', companyname: 'Globex Inc',
        entityid: 'GLBX', entityInternalId: '601'
    }]],
    [[{ internalid: '601' }]]
);
const engine2 = loadModule(ENGINE_PATH, { './BM_Constants': constants }, { 'N/search': fs2 });

const r2 = engine2.runWaterfallMatch(
    { date: '2026-02-01', amount: 1200, description: 'random memo',
      reference: '', payee: 'Globex Inc' },
    { toleranceAmt: 5, toleranceDays: 5 }
);
eq('Tier 4 fires when payee resolves unambiguously',
    { tier: 4, score: 65, hasVariance: false, nsId: '102' },
    r2 && { tier: r2.tier, score: r2.score, hasVariance: r2.hasVariance, nsId: r2.candidate.nsId });

// ─────────────────────────────────────────────────────────────────────────────
//  Waterfall — Tier 2b: within-tolerance amount + doc-id in memo
// ─────────────────────────────────────────────────────────────────────────────
section('BM_MatchEngine.runWaterfallMatch — Tier 2b (variance)');
const fs3 = makeFakeSearch([[{
    internalid: '103', tranid: 'INV-2025', trandate: '2026-03-01',
    amountremaining: '1000.00', currency: '1', companyname: 'Initech',
    entityid: 'INI', entityInternalId: '700'
}]], []);
const engine3 = loadModule(ENGINE_PATH, { './BM_Constants': constants }, { 'N/search': fs3 });
const r3 = engine3.runWaterfallMatch(
    { date: '2026-03-01', amount: 998.50, description: 'ref 2025 short by fee',
      reference: '' },
    { toleranceAmt: 5, toleranceDays: 5 }
);
eq('Tier 2b returns variance metadata',
    { tier: 2, score: 80, hasVariance: true, variance: 1.5 },
    r3 && { tier: r3.tier, score: r3.score, hasVariance: r3.hasVariance,
            variance: Math.round(r3.varianceAmt * 100) / 100 });

// ─────────────────────────────────────────────────────────────────────────────
//  Waterfall — no candidates returns null
// ─────────────────────────────────────────────────────────────────────────────
section('BM_MatchEngine.runWaterfallMatch — no match');
const fs4 = makeFakeSearch([[]], []);
const engine4 = loadModule(ENGINE_PATH, { './BM_Constants': constants }, { 'N/search': fs4 });
const r4 = engine4.runWaterfallMatch(
    { date: '2026-04-01', amount: 99.99, description: 'no candidates', reference: '' },
    { toleranceAmt: 1, toleranceDays: 5 }
);
eq('Empty candidate list → null', null, r4);

// ─────────────────────────────────────────────────────────────────────────────
//  Summary
// ─────────────────────────────────────────────────────────────────────────────
process.stdout.write('\n' + '='.repeat(50) + '\n');
process.stdout.write(passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) process.exit(1);
