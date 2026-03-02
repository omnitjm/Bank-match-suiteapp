# Bank Match SuiteApp

A focused NetSuite SuiteApp that automates bank reconciliation by bridging
the native Match Bank Data module with an approval-gated matching engine.

## What it does

- **Auto Match** — scores bank lines against open invoices and vendor payments,
  creates proposals with a single button click
- **Approval gate** — every match requires approver sign-off before NS is touched
- **custbody_bank_transaction_id** — stamped on matched NS transactions on approval;
  native Reconciliation Rules use this field to auto-reconcile (no manual re-matching)
- **Idempotent** — repeated button clicks never create duplicate proposals
- **Batched** — processes 100 lines per page; client loops until all lines are done
- **Bill Payment date adjustment** — optionally aligns Vendor Payment date to bank date
- **canRun gating** — button is disabled if settings are not configured

## User Flow

```
1. Open Banking → Match Bank Data
2. Click [Auto Match]              ← Bank Match proposes matches (batched)
3. Open [Pending Approvals]        ← review each proposal
4. Change Status → Approved        ← Bank Match executes:
                                       • creates/updates NS transaction
                                       • sets custbody_bank_transaction_id
5. Back on Match Bank Data page:
   Click [Run Reconciliation Rules] ← native rules match on bank_transaction_id
   Click [Submit]                   ← reconciliation complete
```

No manual item-by-item matching required. The user only needs to approve
proposals and then run the native Reconciliation Rules once.

## Reconciliation Rule Setup (one-time admin task)

After deploying, configure a NetSuite native Reconciliation Rule:

1. Banking → Reconciliation Rules → New
2. Add condition: **Amount** equals Bank Line Amount
3. Add condition: **Bank Transaction ID** (`custbody_bank_transaction_id`) equals Bank Line Transaction ID
4. Save and activate the rule

This rule runs when the user clicks **Run Reconciliation Rules** on the Match
Bank Data page and will auto-match every transaction that Bank Match has approved.

> **Note:** `tranid` (document number) is never written by Bank Match.
> `custbody_bank_transaction_id` is the sole matching key.

## Deployment

You have three options. Pick one.

---

### Option A — SuiteCloud CLI (recommended)

The project is fully wired for one-command deployment via the
[SuiteCloud CLI](https://www.npmjs.com/package/@oracle/suitecloud-cli).

**Prerequisites:** Node.js ≥ 18, a NetSuite account with SDF enabled,
a Token-Based Authentication (TBA) integration set up in NetSuite.

**One-time setup:**

```bash
npm install                                        # install CLI
npm run setup                                      # interactive auth wizard
# ↑ prompts for Account ID, Token ID, Token Secret, Consumer Key/Secret
# saves credentials under the alias "bank-match-auth"
```

**Deploy:**

```bash
npm run deploy       # validate + deploy (prompts for confirmation)
npm run validate     # dry-run only, no changes pushed
```

The CLI deploys everything in `manifest.xml` automatically:
custom body field, custom lists, custom records, all scripts and deployments.

---

### Option B — GitHub Actions (CI/CD, deploy on push)

Push to `main` → auto-deploy. Also supports manual runs targeting sandbox or production.

**Setup:**

1. In GitHub → your repo → **Settings → Secrets and variables → Actions**
2. Add these 5 secrets:

| Secret name | Where to find it in NetSuite |
|---|---|
| `NS_ACCOUNT_ID` | Setup → Company Information |
| `NS_TOKEN_ID` | Setup → Users/Roles → Access Tokens |
| `NS_TOKEN_SECRET` | Shown once when token is created |
| `NS_CONSUMER_KEY` | Setup → Integration → your integration record |
| `NS_CONSUMER_SECRET` | Shown once when integration is created |

3. Push to `main` — the workflow in `.github/workflows/deploy.yml` runs automatically.

For a manual deploy to sandbox: GitHub → Actions → **Deploy to NetSuite** → **Run workflow** → choose `sandbox`.

---

### Option C — Manual UI

Follow the step-by-step NetSuite UI instructions in:
- `MANUAL_DEPLOYMENT_GUIDE.md` — initial install
- `PHASE2_DEPLOYMENT_GUIDE.md` — Phase 2 additions (custom body field, new proposal fields)

No tools or CLI required.

---

**After any deployment method**, configure the Reconciliation Rule (one-time):

1. Banking → Reconciliation Rules → New
2. Add condition: **Amount** equals Bank Line Amount
3. Add condition: **Bank Transaction ID** (`custbody_bank_transaction_id`) equals Bank Line Transaction ID
4. Save and activate

## CSV Format (for manual bank line import)

```
Date, Description, Amount, Reference
2026-01-15, ACME Payment, 5000.00, INV-1042
2026-01-16, Rent, -3500.00, BP-2031
```

Positive amount = credit (Customer Payment). Negative = debit (Bill Payment).

## File structure

```
FileCabinet/SuiteScripts/BankMatch/
  BM_Constants.js       ← field IDs, status codes, normalizeTxnId helper
  BM_MatchEngine.js     ← scoring, matching, and reconciliation logic
  BM_BankLineReader.js  ← reads unmatched bank lines (SuiteQL / search fallback)
  BM_NativeBridge.js    ← OFX generator + native module URL helpers
  BM_NativePage_CS.js   ← global client script: injects Auto Match bar (MutationObserver)
  BM_Reconcile_RL.js    ← RESTlet: paginated propose_all + status endpoint
  BM_Setup_SL.js        ← settings/configuration suitelet
  BM_Setup_CS.js        ← settings page client script
  BM_Main_SL.js         ← approval dashboard (pending + history)
  BM_Dashboard_CS.js    ← dashboard client script
  BM_Proposal_UE.js     ← user event: locking + custbody stamping on approval

Objects/
  customtransactionbodycustomfield_bank_txn_id.xml  ← custbody_bank_transaction_id
  customlist_bm_prop_status.xml
  customlist_bm_txn_status.xml
  customlist_bm_txn_type.xml
  customrecord_bm_settings.xml
  customrecord_bm_bank_txn.xml
  customrecord_bm_proposal.xml     ← includes idempotency + apply-lock fields
  customscript_bm_native_cs.xml
  customscript_bm_reconcile_rl.xml
  customscript_bm_setup_sl.xml
  customscript_bm_setup_cs.xml
  customscript_bm_main_sl.xml
  customscript_bm_dashboard_cs.xml
  customscript_bm_proposal_ue.xml
```

## Proposal Record — New Fields

| Field | Script ID | Purpose |
|---|---|---|
| Idempotency Key | `custrecord_bm_idempotency_key` | Prevents duplicate proposals |
| Apply Status | `custrecord_bm_apply_status` | Pending / Processing / Applied / Failed |
| Apply Attempts | `custrecord_bm_apply_attempts` | Retry counter |
| Apply Error | `custrecord_bm_apply_error` | Last error detail |
| Applied NS Transaction ID | `custrecord_bm_applied_txn_id` | NS internal ID on success |
