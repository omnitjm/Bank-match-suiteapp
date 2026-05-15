/**
 * BM_RulesEngine.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Evaluates admin-defined reconciliation rules (customrecord_bm_rule) against
 * incoming bank lines BEFORE the waterfall matching engine runs.
 *
 * Rules are loaded once per auto-match run, cached on the returned evaluator,
 * and then applied to each bank line in priority order (lowest number first).
 * The first matching rule wins — subsequent rules are not evaluated.
 *
 * ─── Why this module exists ──────────────────────────────────────────────────
 * The customrecord_bm_rule record and BM_Rules_SL admin UI have always existed
 * but were never connected to the matching engine.  This module is the missing
 * link: it lets admins handle predictable bank lines (bank fees, payroll runs,
 * known transfers) automatically and skip lines that should never be matched
 * by the engine.
 *
 * ─── Rule semantics ──────────────────────────────────────────────────────────
 *   Condition fields:  description | amount | reference | payee
 *   Operators:         contains | equals | startswith | endswith | regex
 *                      (numeric operators on `amount`: equals, gte, lte)
 *   Actions:
 *     skip            – mark line as Excluded, do not propose any match
 *     create_pending  – create a Pending proposal targeted at the suspense
 *                       account (JE-type), leave for approver review
 *     auto_approve    – create a proposal targeted at the suspense account
 *                       AND immediately mark it Approved so the User Event
 *                       script posts the JE without human intervention
 *
 * For auto_approve / create_pending, the proposal targets the suspense GL
 * account from settings (customrecord_bm_settings → suspense_account).
 * Admins set that up once and re-classify the JE later if needed.
 *
 * Public API:
 *   load(settings)                     → evaluator object
 *   evaluator.evaluate(line)           → { rule, action } | null
 *   evaluator.count                    → number of active rules loaded
 */
define([
    'N/search',
    'N/log',
    './BM_Constants'
], function (search, log, C) {
    'use strict';

    var RF = C.RULE_FIELDS;

    // Numeric operator forms accepted on the `amount` field.
    var NUMERIC_OPS = { equals: true, gte: true, lte: true };

    function _toLower(s) {
        return (s == null ? '' : String(s)).toLowerCase();
    }

    /**
     * Evaluate a single rule against a bank line.
     * @returns {boolean} true if the rule's condition matches this line
     */
    function _matchesCondition(rule, line) {
        var fieldId = (rule.condField || '').toLowerCase();
        var op      = (rule.condOp    || '').toLowerCase();
        var value   = rule.condValue == null ? '' : rule.condValue;

        // Resolve the bank-line field referenced by the rule
        var lhs;
        switch (fieldId) {
            case 'amount':       lhs = parseFloat(line.amount) || 0;            break;
            case 'reference':    lhs = line.reference   || '';                  break;
            case 'payee':        lhs = line.payee       || '';                  break;
            case 'description':  /* fall through */
            default:             lhs = line.description || '';                  break;
        }

        // Numeric path: `amount` field with numeric operator
        if (fieldId === 'amount' && NUMERIC_OPS[op]) {
            var rhs = parseFloat(value);
            if (isNaN(rhs)) return false;
            var lhsAbs = Math.abs(lhs);
            var rhsAbs = Math.abs(rhs);
            if (op === 'equals') return Math.abs(lhsAbs - rhsAbs) <= 0.005;
            if (op === 'gte')    return lhsAbs >= rhsAbs;
            if (op === 'lte')    return lhsAbs <= rhsAbs;
            return false;
        }

        // String path (case-insensitive)
        var s   = _toLower(lhs);
        var pat = _toLower(value);
        if (!pat) return false;

        switch (op) {
            case 'equals':     return s === pat;
            case 'startswith': return s.indexOf(pat) === 0;
            case 'endswith':   return s.length >= pat.length &&
                                      s.lastIndexOf(pat) === s.length - pat.length;
            case 'regex':
                try {
                    // Allow case-insensitive regex; pattern is treated as raw JS regex.
                    var re = new RegExp(value, 'i');
                    return re.test(String(lhs));
                } catch (e) {
                    log.error('BM_RulesEngine',
                        'Invalid regex "' + value + '" on rule "' + rule.name + '": ' + e.message);
                    return false;
                }
            case 'contains':
            default:
                return s.indexOf(pat) >= 0;
        }
    }

    /**
     * Load all active rules ordered by priority (ascending).
     */
    function _loadRules() {
        var rules = [];
        try {
            search.create({
                type:    C.RECORDS.RULE,
                filters: [
                    ['isinactive', 'is', 'F'], 'AND',
                    [RF.IS_ACTIVE, 'is', 'T']
                ],
                columns: [
                    'internalid',
                    RF.NAME, RF.PRIORITY,
                    RF.COND_FIELD, RF.COND_OP, RF.COND_VALUE,
                    RF.ACTION,
                    search.createColumn({ name: RF.PRIORITY, sort: search.Sort.ASC })
                ]
            }).run().each(function (row) {
                rules.push({
                    id:        row.id,
                    name:      row.getValue(RF.NAME)       || '(unnamed)',
                    priority:  parseInt(row.getValue(RF.PRIORITY), 10) || 100,
                    condField: row.getValue(RF.COND_FIELD) || '',
                    condOp:    row.getValue(RF.COND_OP)    || '',
                    condValue: row.getValue(RF.COND_VALUE) || '',
                    action:    row.getValue(RF.ACTION)     || ''
                });
                return rules.length < 500;
            });
        } catch (e) {
            log.error('BM_RulesEngine._loadRules', e.message);
        }
        // Search already sorts; resort defensively in case the sort hint is ignored.
        rules.sort(function (a, b) { return a.priority - b.priority; });
        return rules;
    }

    /**
     * Build an evaluator over the currently active rule set.
     * The caller invokes evaluator.evaluate(line) for each bank line.
     *
     * @param {Object} [settings]   { suspenseAccount } — used by callers to
     *                              build proposals when a rule fires.
     * @returns {{
     *   count: number,
     *   rules: Array,
     *   evaluate: function(line): ({rule:Object,action:string}|null)
     * }}
     */
    function load(settings) {
        var rules = _loadRules();
        log.audit('BM_RulesEngine',
            'Loaded ' + rules.length + ' active reconciliation rule(s)');

        return {
            count: rules.length,
            rules: rules,
            settings: settings || {},
            evaluate: function (line) {
                for (var i = 0; i < rules.length; i++) {
                    var r = rules[i];
                    if (_matchesCondition(r, line)) {
                        return { rule: r, action: r.action };
                    }
                }
                return null;
            }
        };
    }

    return {
        load:               load,
        // Exported for unit testing / re-use
        _matchesCondition:  _matchesCondition
    };
});
