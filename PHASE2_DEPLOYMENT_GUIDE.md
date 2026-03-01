# Bank Match SuiteApp — Phase 2 Upgrade Deployment Guide

This guide covers the new objects and changes introduced in the second build.
Apply this **after** completing `MANUAL_DEPLOYMENT_GUIDE.md` (initial deployment).

If you are deploying from scratch, complete the initial guide first, then return here.

---

## What Changed

| Area | What was added / changed |
|---|---|
| New custom body field | `custbody_bank_transaction_id` on transactions |
| BM Match Proposal record | 5 new fields (idempotency, apply locking) |
| `BM_NativePage_CS.js` | MutationObserver injection, batching loop, canRun gating |
| `BM_Reconcile_RL.js` | Idempotency, limit/offset batching, structured skip reasons, status gating |
| `BM_Proposal_UE.js` | Concurrency locking, stamps `custbody_bank_transaction_id` on approval |
| `BM_Constants.js` | `normalizeTxnId`, `BODY_FIELD`, `APPLY_STATUS`, `SKIP_REASON` |
| Reconciliation Rule | One-time native NetSuite rule setup (admin task — no code) |

---

## STEP 1 — Upload Updated Script Files

**Navigation:** Documents → Files → SuiteScripts → BankMatch

Re-upload (overwrite) these 4 files:

| File |
|---|
| `BM_Constants.js` |
| `BM_NativePage_CS.js` |
| `BM_Reconcile_RL.js` |
| `BM_Proposal_UE.js` |

> All 4 files live in the same folder: `/SuiteScripts/BankMatch/`

---

## STEP 2 — Create the Custom Transaction Body Field

**Navigation:** Customization → Lists, Records & Fields → Transaction Body Fields → **New**

| Field | Value |
|---|---|
| Label | `Bank Transaction ID` |
| ID | `custbody_bank_transaction_id` |
| Type | `Free Form Text` |
| Store Value | Yes |
| Show in List | No |
| Mandatory | No |
| Help Text | `Bank statement transaction identifier set by Bank Match. Used by Reconciliation Rules to match bank lines to NetSuite transactions. Do not edit manually.` |

**Applies To tab** — check these transaction types:

| Transaction Type | Apply? |
|---|---|
| Customer Payment | **Yes** |
| Vendor Payment | **Yes** |
| Deposit | **Yes** |
| Check | **Yes** |
| Journal Entry | **Yes** |
| Credit Memo | No |
| Customer Refund | No |
| Vendor Refund | No |
| Cash Sale | No |
| Expense Report | No |

Click **Save**.

> This field is the only identifier Bank Match writes to. `tranid` is never touched.

---

## STEP 3 — Add 5 New Fields to BM Match Proposal Record

**Navigation:** Customization → Lists, Records & Fields → Record Types

Find **BM Match Proposal** (`customrecord_bm_proposal`) → click **Edit** → go to the **Fields** tab.

Add each field below by clicking **New Field**, filling in the values, and clicking **Save Field** before adding the next.

---

### Field 1 — Idempotency Key

| Setting | Value |
|---|---|
| Label | `Idempotency Key` |
| ID | `custrecord_bm_idempotency_key` |
| Type | `Free Form Text` |
| Mandatory | No |
| Show in List | No |
| Help Text | `Deduplication key: bankLineId or date\|amount\|ref composite. Prevents duplicate proposals for the same bank line.` |

---

### Field 2 — Apply Status

| Setting | Value |
|---|---|
| Label | `Apply Status` |
| ID | `custrecord_bm_apply_status` |
| Type | `Free Form Text` |
| Mandatory | No |
| Default Value | `Pending` |
| Show in List | Yes |
| Help Text | `Internal apply-execution status: Pending \| Processing \| Applied \| Failed. Do not edit manually.` |

---

### Field 3 — Apply Attempts

| Setting | Value |
|---|---|
| Label | `Apply Attempts` |
| ID | `custrecord_bm_apply_attempts` |
| Type | `Integer` |
| Mandatory | No |
| Default Value | `0` |
| Show in List | No |
| Help Text | `Number of times the apply logic has been executed for this proposal.` |

---

### Field 4 — Apply Error

| Setting | Value |
|---|---|
| Label | `Apply Error` |
| ID | `custrecord_bm_apply_error` |
| Type | `Text Area` |
| Mandatory | No |
| Show in List | No |
| Help Text | `Last error message from the apply execution. Populated when Apply Status is Failed.` |

---

### Field 5 — Applied NS Transaction ID

| Setting | Value |
|---|---|
| Label | `Applied NS Transaction ID` |
| ID | `custrecord_bm_applied_txn_id` |
| Type | `Free Form Text` |
| Mandatory | No |
| Show in List | Yes |
| Help Text | `Internal ID of the NetSuite transaction created or updated when this proposal was applied.` |

---

Click **Save** on the record type after all 5 fields are added.

---

## STEP 4 — Configure the Native Reconciliation Rule (one-time admin task)

This rule is what allows the user to click **Run Reconciliation Rules** instead
of matching items manually. It reads `custbody_bank_transaction_id` that Bank
Match stamped on each approved transaction.

**Navigation:** Banking → Reconciliation Rules → **New**

| Setting | Value |
|---|---|
| Name | `Bank Match – Auto Reconcile` |
| Bank Account | *(select your GL bank account)* |
| Status | Active |

**Matching Conditions** — add both:

| # | Field | Operator | Match Against |
|---|---|---|---|
| 1 | Amount | equals | Bank Line Amount |
| 2 | Bank Transaction ID (`custbody_bank_transaction_id`) | equals | Bank Line Transaction ID |

Click **Save**.

> If **Bank Transaction ID** does not appear in the field picker, verify that
> `custbody_bank_transaction_id` was saved with **Store Value = Yes** in Step 2
> and that it applies to the relevant transaction type (Customer Payment / Vendor Payment).

---

## STEP 5 — Clear Script Cache

After uploading updated JS files, clear the server script cache so NetSuite picks up the changes:

1. Go to **Setup → Company → Enable Features**
2. Click **Save** (no changes needed — this alone clears the cache)

Alternatively: go to each script record, open its deployment, and click **Save** to force a reload.

---

## STEP 6 — Verify the Deployment

Open **Banking → Match Bank Data**.

**Button bar checks:**
- [ ] The bar appears near the top of the page (via MutationObserver, no fixed delay)
- [ ] The **Auto Match** button is enabled (if disabled, check that BM Settings are configured — see STEP 7)
- [ ] **Pending Approvals** badge shows the correct count

**Auto Match run:**
1. Click **Auto Match**
2. Status message shows batch progress: `Batch 1 – matching…`
3. On completion: `Created N, skipped M (X already proposed, Y no match found)`
4. Badge updates automatically

**Proposal approval:**
1. Open a pending proposal
2. Change **Status** → `Approved` → Save
3. Verify:
   - Proposal **Apply Status** changes to `Applied`
   - Proposal **Applied NS Transaction ID** is populated
   - The matched NS transaction (Customer Payment or Vendor Payment) now has
     **Bank Transaction ID** field populated with the normalized bank reference

**Reconciliation:**
1. Go back to **Match Bank Data**
2. Click **Run Reconciliation Rules**
3. Approved transactions should auto-match to their bank lines
4. Click **Submit**

---

## STEP 7 — Troubleshooting

### Auto Match button is disabled / greyed out
The status endpoint returned `canRun=false`. This means settings are not configured.
Go to the **BM Settings** suitelet and ensure **Bank Account** and **Approver** are set.

### custbody_bank_transaction_id is empty after approval
- Confirm the field was created in Step 2 with **Store Value = Yes**
- Confirm the field applies to Customer Payment and/or Vendor Payment
- Check the Proposal record's **Apply Error** field for any error message
- Check Script Execution Log: Customization → Scripting → Script Execution Log → filter by `customscript_bm_proposal_ue`

### Reconciliation Rule doesn't match transactions
- Confirm the transaction has `custbody_bank_transaction_id` populated (check the transaction record)
- Confirm the bank line's Transaction ID exactly matches after normalization (trimmed, uppercased)
- Confirm the rule condition uses the correct field: **Bank Transaction ID** = `custbody_bank_transaction_id`

### Proposal stuck in "Processing" Apply Status
A concurrent apply attempt was interrupted. To retry:
- Set the proposal **Status** back to `Pending Approval`
- Manually clear **Apply Status** to blank or `Pending`
- Re-approve the proposal

### Duplicate proposals not being blocked
Confirm `custrecord_bm_idempotency_key` field was created in Step 3 and is being
populated (check an existing proposal — the field value should be `lid:<id>` or
`fallback:<date>|<amount>|<ref>`).

---

## Upgrade Checklist

- [ ] Step 1: 4 JS files re-uploaded to `/SuiteScripts/BankMatch/`
- [ ] Step 2: `custbody_bank_transaction_id` custom body field created
- [ ] Step 3: 5 new fields added to BM Match Proposal record
- [ ] Step 4: Reconciliation Rule configured in NetSuite Banking
- [ ] Step 5: Script cache cleared
- [ ] Step 6: End-to-end flow verified
