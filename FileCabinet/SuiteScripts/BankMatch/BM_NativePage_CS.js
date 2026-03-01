/**
 * BM_NativePage_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Bank Match – Native Page Enhancement
 *
 * Deployed globally (all roles, all employees). Detects when the user is on
 * the NetSuite "Match Bank Data" page and injects our button bar.
 *
 * ─── DOM injection strategy ───────────────────────────────────────────────────
 * Uses MutationObserver to wait for the native page content to appear, then
 * injects exactly once (guarded by element ID). Observer disconnects after
 * injection or after a 10-second safety timeout.
 *
 * ─── Auto Match batching ─────────────────────────────────────────────────────
 * Calls propose_all with limit=100 repeatedly until done=true. Status message
 * updates after each batch. canRun=false from status endpoint disables the button.
 *
 * ─── User flow ───────────────────────────────────────────────────────────────
 *   1. Click [Auto Match]         → creates proposals for all unmatched lines
 *   2. Approve proposals          → Bank Match stamps custbody_bank_transaction_id
 *   3. Click [Run Recon Rules]    → native rules match on that field automatically
 *   4. Click [Submit]             → reconciliation complete
 */
define(['N/url', 'N/https'], function (url, https) {
    'use strict';

    var MATCH_BANK_DATA_PATH = 'matchbankdata.nl';
    var BAR_ID               = 'bm-native-bar';

    var RESTLET_SCRIPT  = 'customscript_bm_reconcile_rl';
    var RESTLET_DEPLOY  = 'customdeploy_bm_reconcile_rl';
    var MAIN_SL_SCRIPT  = 'customscript_bm_main_sl';
    var MAIN_SL_DEPLOY  = 'customdeploy_bm_main_sl';
    var SETUP_SL_SCRIPT = 'customscript_bm_setup_sl';
    var SETUP_SL_DEPLOY = 'customdeploy_bm_setup_sl';

    // ── Styles ────────────────────────────────────────────────────────────
    var BAR_STYLE = [
        'display:flex;align-items:center;gap:8px;',
        'padding:8px 16px;',
        'background:#f0f4ff;',
        'border-bottom:1px solid #c5cee0;',
        'font-family:system-ui,sans-serif;',
        'font-size:13px;',
        'z-index:1000;',
        'box-sizing:border-box;',
        'flex-wrap:wrap;'
    ].join('');

    var BTN_BASE = [
        'display:inline-flex;align-items:center;gap:5px;',
        'padding:5px 12px;border-radius:4px;',
        'font-size:12px;font-weight:600;',
        'border:none;cursor:pointer;',
        'text-decoration:none;'
    ].join('');

    var BTN_PRIMARY   = BTN_BASE + 'background:#1565c0;color:#fff;';
    var BTN_SECONDARY = BTN_BASE + 'background:#fff;color:#333;border:1px solid #ccc;';
    var BTN_DISABLED  = BTN_BASE + 'background:#bbb;color:#fff;cursor:not-allowed;';

    var BTN_BADGE = [
        'background:#e53935;color:#fff;',
        'border-radius:10px;padding:0 5px;',
        'font-size:10px;font-weight:700;',
        'margin-left:3px;'
    ].join('');

    var LOGO_STYLE = 'font-size:11px;color:#1565c0;font-weight:700;' +
                     'padding-right:8px;border-right:1px solid #c5cee0;margin-right:4px;';

    // ── URL helpers ───────────────────────────────────────────────────────
    function _restletUrl(action, extra) {
        var base = url.resolveScript({
            scriptId:          RESTLET_SCRIPT,
            deploymentId:      RESTLET_DEPLOY,
            returnExternalUrl: false
        });
        var qs = '&action=' + encodeURIComponent(action);
        if (extra) {
            Object.keys(extra).forEach(function (k) {
                qs += '&' + k + '=' + encodeURIComponent(extra[k]);
            });
        }
        return base + qs;
    }

    function _slUrl(scriptId, deployId, params) {
        var u = url.resolveScript({
            scriptId:          scriptId,
            deploymentId:      deployId,
            returnExternalUrl: false
        });
        if (params) {
            Object.keys(params).forEach(function (k) {
                u += '&' + k + '=' + encodeURIComponent(params[k]);
            });
        }
        return u;
    }

    function _getAccountFromUrl() {
        var m = window.location.href.match(/[?&]account=(\d+)/);
        return m ? m[1] : null;
    }

    // ── Build button bar ──────────────────────────────────────────────────
    function _buildBar(pendingCount, canRun, gateMessage) {
        var bar = document.createElement('div');
        bar.id            = BAR_ID;
        bar.style.cssText = BAR_STYLE;

        var logo = document.createElement('span');
        logo.style.cssText = LOGO_STYLE;
        logo.textContent   = 'AUTO MATCH';
        bar.appendChild(logo);

        // Primary action: Auto Match
        var btnAuto = document.createElement('button');
        btnAuto.id            = 'bm-btn-auto';
        btnAuto.style.cssText = canRun ? BTN_PRIMARY : BTN_DISABLED;
        btnAuto.textContent   = 'Auto Match';
        btnAuto.disabled      = !canRun;
        btnAuto.title = canRun
            ? 'Propose matches for all unmatched bank lines and send for approval'
            : (gateMessage || 'Bank Match is not ready');
        if (canRun) {
            btnAuto.addEventListener('click', function (e) {
                e.preventDefault();
                _runAutoMatch(btnAuto);
            });
        }
        bar.appendChild(btnAuto);

        // Pending approvals
        var btnPending = document.createElement('a');
        btnPending.id          = 'bm-btn-pending';
        btnPending.href        = _slUrl(MAIN_SL_SCRIPT, MAIN_SL_DEPLOY, { tab: 'pending' });
        btnPending.target      = '_blank';
        btnPending.style.cssText = BTN_SECONDARY;
        btnPending.innerHTML   = 'Pending Approvals' +
            (pendingCount > 0
                ? '<span style="' + BTN_BADGE + '">' + pendingCount + '</span>'
                : '');
        bar.appendChild(btnPending);

        // Settings
        var btnSetup = document.createElement('a');
        btnSetup.href        = _slUrl(SETUP_SL_SCRIPT, SETUP_SL_DEPLOY, {});
        btnSetup.target      = '_blank';
        btnSetup.style.cssText = BTN_SECONDARY;
        btnSetup.textContent = 'BM Settings';
        bar.appendChild(btnSetup);

        // Status message (right-aligned)
        var msg = document.createElement('span');
        msg.id            = 'bm-status-msg';
        msg.style.cssText = 'margin-left:auto;font-size:12px;color:#555;';
        if (!canRun && gateMessage) msg.textContent = gateMessage;
        bar.appendChild(msg);

        return bar;
    }

    // ── Auto Match: paginated batching loop ───────────────────────────────
    function _runAutoMatch(btnEl) {
        var accountId = _getAccountFromUrl();
        var msgEl     = document.getElementById('bm-status-msg');

        btnEl.disabled      = true;
        btnEl.style.cssText = BTN_DISABLED;
        btnEl.textContent   = 'Matching…';
        if (msgEl) { msgEl.textContent = ''; msgEl.style.color = '#555'; }

        var totalCreated  = 0;
        var totalSkipped  = 0;
        var totalReasons  = {};

        function _mergeReasons(src) {
            if (!src) return;
            Object.keys(src).forEach(function (k) {
                totalReasons[k] = (totalReasons[k] || 0) + src[k];
            });
        }

        function _formatReasons(reasons) {
            var labels = {
                existing_proposal:           'already proposed',
                no_candidate_over_threshold: 'no match found',
                settings_missing:            'settings missing',
                creation_error:              'error'
            };
            return Object.keys(reasons)
                .filter(function (k) { return reasons[k] > 0; })
                .map(function (k) { return reasons[k] + ' ' + (labels[k] || k); })
                .join(', ');
        }

        function _nextBatch(offset) {
            var batchNum = Math.floor(offset / 100) + 1;
            if (msgEl) msgEl.textContent = 'Batch ' + batchNum + ' – matching…';

            var extra = { limit: 100, offset: offset };
            if (accountId) extra.account = accountId;

            https.get.promise({ url: _restletUrl('propose_all', extra) })
                .then(function (resp) {
                    var data;
                    try { data = JSON.parse(resp.body); }
                    catch (e) { return _handleError('Response parse error: ' + e.message); }

                    if (!data.ok) return _handleError(data.error || 'Unknown error');

                    totalCreated += (data.created || 0);
                    totalSkipped += (data.skipped || 0);
                    _mergeReasons(data.skippedReasons);

                    if (data.done) {
                        _handleDone();
                    } else {
                        _nextBatch(data.nextOffset || (offset + 100));
                    }
                })
                .catch(function (err) {
                    _handleError(err.message || String(err));
                });
        }

        function _handleDone() {
            var summary = 'Created ' + totalCreated;
            if (totalSkipped > 0) {
                summary += ', skipped ' + totalSkipped;
                var breakdown = _formatReasons(totalReasons);
                if (breakdown) summary += ' (' + breakdown + ')';
            }

            btnEl.style.cssText = BTN_BASE + 'background:#2e7d32;color:#fff;';
            btnEl.textContent   = 'Done';
            btnEl.disabled      = false;
            if (msgEl) { msgEl.textContent = summary; msgEl.style.color = '#333'; }

            _refreshPendingBadge();

            setTimeout(function () {
                btnEl.style.cssText = BTN_PRIMARY;
                btnEl.textContent   = 'Auto Match';
            }, 5000);
        }

        function _handleError(errorText) {
            btnEl.disabled      = false;
            btnEl.style.cssText = BTN_PRIMARY;
            btnEl.textContent   = 'Auto Match';
            if (msgEl) { msgEl.textContent = errorText; msgEl.style.color = '#c62828'; }
        }

        _nextBatch(0);
    }

    // ── Refresh pending badge from status endpoint ─────────────────────────
    function _refreshPendingBadge() {
        https.get.promise({ url: _restletUrl('status') })
            .then(function (resp) {
                try {
                    var data  = JSON.parse(resp.body);
                    var btn   = document.getElementById('bm-btn-pending');
                    if (!btn) return;
                    var count = data.pendingCount || 0;
                    btn.innerHTML = 'Pending Approvals' +
                        (count > 0
                            ? '<span style="' + BTN_BADGE + '">' + count + '</span>'
                            : '');
                } catch (e) { /* ignore */ }
            })
            .catch(function () { /* ignore */ });
    }

    // ── Find the best DOM anchor to prepend bar into ───────────────────────
    function _findAnchor() {
        var selectors = [
            '#main_form',
            '.ns-page-header',
            '#div__bodytag',
            'body > div:not([style*="display:none"])'
        ];
        for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el) return el;
        }
        return null;
    }

    // ── Inject bar (called once status is fetched) ─────────────────────────
    function _injectBar(pendingCount, canRun, gateMessage) {
        if (document.getElementById(BAR_ID)) return;
        var bar    = _buildBar(pendingCount || 0, canRun !== false, gateMessage || '');
        var anchor = _findAnchor() || document.body;
        anchor.insertBefore(bar, anchor.firstChild);
    }

    // ── Fetch status then inject ───────────────────────────────────────────
    function _initOnBankingPage() {
        https.get.promise({ url: _restletUrl('status') })
            .then(function (resp) {
                var pendingCount = 0;
                var canRun       = true;
                var gateMessage  = '';
                try {
                    var data    = JSON.parse(resp.body);
                    pendingCount = data.pendingCount || 0;
                    canRun      = data.canRun !== false;
                    gateMessage = data.message || '';
                } catch (e) { /* use defaults */ }
                _injectBar(pendingCount, canRun, gateMessage);
            })
            .catch(function () {
                _injectBar(0, true, '');
            });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Client Script entry point — MutationObserver injection
    // ══════════════════════════════════════════════════════════════════════
    function pageInit() {
        // Fast exit: not the Match Bank Data page
        if (window.location.href.indexOf(MATCH_BANK_DATA_PATH) < 0) return;
        if (document.getElementById(BAR_ID)) return;

        var injected = false;

        function _tryInject() {
            if (injected || document.getElementById(BAR_ID)) {
                injected = true;
                return true;
            }
            // Only inject once a suitable anchor exists
            if (!_findAnchor()) return false;
            injected = true;
            _initOnBankingPage();
            return true;
        }

        // Attempt immediately — the anchor may already be present
        if (_tryInject()) return;

        // Watch for DOM mutations (native page loads content asynchronously)
        var observer  = null;
        var stopTimer = null;

        observer = new MutationObserver(function () {
            if (_tryInject()) {
                observer.disconnect();
                clearTimeout(stopTimer);
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Safety net: inject unconditionally after 10 seconds
        stopTimer = setTimeout(function () {
            observer.disconnect();
            if (!injected) {
                injected = true;
                _initOnBankingPage();
            }
        }, 10000);
    }

    return { pageInit: pageInit };
});
