/**
 * BM_NativePage_CS.js
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @NScriptType ClientScript
 *
 * Bank Match – Native Page Enhancement
 *
 * This client script is deployed globally (all roles, all employees).
 * It detects when the user is on the NetSuite "Match Bank Data" page and
 * injects our Bank Match button bar directly into that native page.
 *
 * ─── What the injected buttons do ────────────────────────────────────────────
 *   [⚡ Auto-Reconcile]   Calls our RESTlet which reads all unmatched bank lines
 *                         for the current account, runs the scoring engine, and
 *                         creates proposals for the approver.
 *
 *   [📋 Pending Approvals (N)]   Opens our Suitelet dashboard filtered to
 *                                pending proposals — the approver can act there.
 *
 *   [⚙ BM Settings]      Opens the Bank Match setup page.
 *
 * ─── How injection works ─────────────────────────────────────────────────────
 * The native Match Bank Data page is at:
 *   /app/accounting/transactions/bank/reconciliation/matchbankdata.nl
 *
 * pageInit fires on every page load. If we're NOT on that URL we return
 * immediately (no performance impact on other pages).
 *
 * If we ARE on the page, we wait for the DOM to be ready, then find the
 * native button/header area and prepend our button bar.
 */
define(['N/url', 'N/https'], function (url, https) {
    'use strict';

    // ── Target page detection ─────────────────────────────────────────────
    var MATCH_BANK_DATA_PATH = 'matchbankdata.nl';

    // ── Script / deployment IDs ───────────────────────────────────────────
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

    var BTN_PRIMARY = BTN_BASE +
        'background:#1565c0;color:#fff;';
    var BTN_SECONDARY = BTN_BASE +
        'background:#fff;color:#333;border:1px solid #ccc;';
    var BTN_BADGE = [
        'background:#e53935;color:#fff;',
        'border-radius:10px;padding:0 5px;',
        'font-size:10px;font-weight:700;',
        'margin-left:3px;'
    ].join('');

    var LOGO_STYLE = 'font-size:11px;color:#1565c0;font-weight:700;' +
                     'padding-right:8px;border-right:1px solid #c5cee0;margin-right:4px;';

    // ── Build RESTlet URL ─────────────────────────────────────────────────
    function _restletUrl(action, extra) {
        var base = url.resolveScript({
            scriptId:     RESTLET_SCRIPT,
            deploymentId: RESTLET_DEPLOY,
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

    // ── Build Suitelet URL ────────────────────────────────────────────────
    function _slUrl(scriptId, deployId, params) {
        var u = url.resolveScript({
            scriptId:     scriptId,
            deploymentId: deployId,
            returnExternalUrl: false
        });
        if (params) {
            Object.keys(params).forEach(function (k) {
                u += '&' + k + '=' + encodeURIComponent(params[k]);
            });
        }
        return u;
    }

    // ── Extract account ID from native page URL ───────────────────────────
    function _getAccountFromUrl() {
        var match = window.location.href.match(/[?&]account=(\d+)/);
        return match ? match[1] : null;
    }

    // ── Create the button bar element ─────────────────────────────────────
    function _buildBar(pendingCount) {
        var bar = document.createElement('div');
        bar.id    = 'bm-native-bar';
        bar.style.cssText = BAR_STYLE;

        // Logo label
        var logo  = document.createElement('span');
        logo.style.cssText = LOGO_STYLE;
        logo.textContent   = '⚡ BANK MATCH';
        bar.appendChild(logo);

        // Auto-Reconcile button
        var btnAuto = document.createElement('button');
        btnAuto.id  = 'bm-btn-auto';
        btnAuto.style.cssText = BTN_PRIMARY;
        btnAuto.textContent   = '⚡ Auto-Reconcile';
        btnAuto.title = 'Run the Bank Match engine on all unmatched bank lines and send proposals for approval';
        btnAuto.addEventListener('click', function (e) {
            e.preventDefault();
            _runAutoReconcile(btnAuto);
        });
        bar.appendChild(btnAuto);

        // Pending approvals button (with badge)
        var btnPending = document.createElement('a');
        btnPending.href  = _slUrl(MAIN_SL_SCRIPT, MAIN_SL_DEPLOY, { tab: 'pending' });
        btnPending.target = '_blank';
        btnPending.style.cssText = BTN_SECONDARY;
        btnPending.innerHTML = '📋 Pending Approvals' +
            (pendingCount > 0
                ? '<span style="' + BTN_BADGE + '">' + pendingCount + '</span>'
                : '');
        btnPending.id = 'bm-btn-pending';
        bar.appendChild(btnPending);

        // Settings button
        var btnSetup = document.createElement('a');
        btnSetup.href   = _slUrl(SETUP_SL_SCRIPT, SETUP_SL_DEPLOY, {});
        btnSetup.target = '_blank';
        btnSetup.style.cssText = BTN_SECONDARY;
        btnSetup.textContent   = '⚙ BM Settings';
        bar.appendChild(btnSetup);

        // Status message area
        var msg = document.createElement('span');
        msg.id  = 'bm-status-msg';
        msg.style.cssText = 'margin-left:auto;font-size:12px;color:#555;';
        bar.appendChild(msg);

        return bar;
    }

    // ── Run auto-reconcile via RESTlet ────────────────────────────────────
    function _runAutoReconcile(btnEl) {
        var accountId = _getAccountFromUrl();
        var msgEl = document.getElementById('bm-status-msg');

        btnEl.disabled = true;
        btnEl.textContent = '⏳ Matching…';
        if (msgEl) msgEl.textContent = '';

        var rlUrl = _restletUrl('propose_all', accountId ? { account: accountId } : {});

        https.get.promise({ url: rlUrl })
            .then(function (resp) {
                try {
                    var data = JSON.parse(resp.body);
                    if (data.ok) {
                        btnEl.textContent = '✓ Done';
                        btnEl.style.background = '#2e7d32';

                        if (msgEl) msgEl.textContent = data.message || (data.proposed + ' proposal(s) created');

                        // Update pending badge
                        _refreshPendingBadge(data.pendingCount);

                        // Reset button after 4s
                        setTimeout(function () {
                            btnEl.disabled = false;
                            btnEl.textContent = '⚡ Auto-Reconcile';
                            btnEl.style.background = '#1565c0';
                        }, 4000);
                    } else {
                        throw new Error(data.error || 'Unknown error');
                    }
                } catch (parseErr) {
                    _showError(btnEl, msgEl, 'Response error: ' + parseErr.message);
                }
            })
            .catch(function (err) {
                _showError(btnEl, msgEl, err.message || String(err));
            });
    }

    function _showError(btnEl, msgEl, errorText) {
        btnEl.disabled    = false;
        btnEl.textContent = '⚡ Auto-Reconcile';
        btnEl.style.background = '#1565c0';
        if (msgEl) {
            msgEl.textContent  = '⚠ ' + errorText;
            msgEl.style.color  = '#c62828';
        }
    }

    function _refreshPendingBadge(count) {
        var btn = document.getElementById('bm-btn-pending');
        if (!btn) return;
        btn.innerHTML = '📋 Pending Approvals' +
            (count > 0
                ? '<span style="' + BTN_BADGE + '">' + count + '</span>'
                : '');
    }

    // ── Inject bar into the native page ───────────────────────────────────
    function _injectBar(pendingCount) {
        if (document.getElementById('bm-native-bar')) return; // already injected

        var bar = _buildBar(pendingCount || 0);

        // Try to insert before the native page's main content area.
        // NetSuite's banking pages typically have a header div we can anchor to.
        var targets = [
            document.querySelector('#main_form'),
            document.querySelector('.ns-page-header'),
            document.querySelector('#div__bodytag'),
            document.querySelector('body > div:not([style*="display:none"]):first-child'),
            document.body
        ];

        var inserted = false;
        for (var i = 0; i < targets.length; i++) {
            if (targets[i]) {
                targets[i].insertBefore(bar, targets[i].firstChild);
                inserted = true;
                break;
            }
        }

        if (!inserted) document.body.insertBefore(bar, document.body.firstChild);
    }

    // ── Fetch status and inject ───────────────────────────────────────────
    function _initOnBankingPage() {
        // Get pending count from RESTlet to show badge immediately
        var statusUrl = _restletUrl('status');
        https.get.promise({ url: statusUrl })
            .then(function (resp) {
                try {
                    var data = JSON.parse(resp.body);
                    _injectBar(data.pendingCount || 0);
                } catch (e) {
                    _injectBar(0);
                }
            })
            .catch(function () {
                _injectBar(0);
            });
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Client Script entry point
    // ═══════════════════════════════════════════════════════════════════════
    function pageInit() {
        // Fast exit: only act on the native Match Bank Data page
        if (window.location.href.indexOf(MATCH_BANK_DATA_PATH) < 0) return;

        // Wait briefly for the native page's DOM to settle before injecting
        setTimeout(_initOnBankingPage, 600);
    }

    return { pageInit: pageInit };
});
