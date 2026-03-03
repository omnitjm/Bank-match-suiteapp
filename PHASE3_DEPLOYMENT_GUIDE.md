# Bank Match SuiteApp — Phase 3 Upgrade Deployment Guide

This guide covers all new objects and changes introduced in the third build.
Apply this **after** completing both `MANUAL_DEPLOYMENT_GUIDE.md` (initial) and
`PHASE2_DEPLOYMENT_GUIDE.md` (idempotency/locking upgrade).

---

## What Changed

| Area | What was added / changed |
|---|---|
| **Settings record** | 5 new fields: Fee Account, Suspense Account, Default Department, Default Class, Default Location |
| **Match Proposal record** | 3 new fields: Has Variance, Variance Amount, Bank Account |
| **BM_Constants.js** | New field IDs for all 8 new fields |
| **BM_MatchEngine.js** | Waterfall matching (Tier 1/2a/2b/3), variance JE creation, multi-apply, segment application to JE lines |
| **BM_Main_SL.js** | Master/Detail view, Global Overview, failed proposals banner, multi-apply invoice/bill pages |
| **BM_Dashboard_CS.js** | goOverview(), cascading subsidiary filter, running Remaining Amount counter |
| **BM_Setup_SL.js** | New Advanced GL & Segment settings sections |
| **BM_Proposal_UE.js** | Passes settings (including segments) to engine on approval |

---

## STEP 1 — Upload Updated Script Files

**Navigation:** Documents → Files → SuiteScripts → BankMatch

Re-upload (overwrite) all 6 files:

| File |
|---|
| `BM_Constants.js` |
| `BM_MatchEngine.js` |
| `BM_Main_SL.js` |
| `BM_Dashboard_CS.js` |
| `BM_Setup_SL.js` |
| `BM_Proposal_UE.js` |

> All files must live at: `/SuiteScripts/BankMatch/<filename>.js`

---

## STEP 2 — Add 5 New Fields to BM App Settings Record

**Navigation:** Customization → Lists, Records & Fields → Record Types

Find **BM App Settings** (`customrecord_bm_settings`) → click **Edit** → go to the **Fields** tab.

Add each field below by clicking **New Field**, filling in the values, and clicking **Save Field**.

---

### Field 1 — Default Bank Fee Account

| Setting | Value |
|---|---|
| Label | `Default Bank Fee Account` |
| ID | `custrecord_bm_fee_account` |
| Type | `List/Record` |
| List/Record | `Account` (record type -10) |
| Mandatory | No |
| Show in List | Yes |
| Help Text | `GL expense account used to post the variance difference when a payment is created with an amount tolerance gap (Match with Variance).` |

---

### Field 2 — Default Suspense Account

| Setting | Value |
|---|---|
| Label | `Default Suspense Account` |
| ID | `custrecord_bm_suspense_account` |
| Type | `List/Record` |
| List/Record | `Account` (record type -10) |
| Mandatory | No |
| Show in List | Yes |
| Help Text | `GL suspense account used as a quick-select default in the Manual Matching UI for unknown or unidentified transactions.` |

---

### Field 3 — Default Department

| Setting | Value |
|---|---|
| Label | `Default Department` |
| ID | `custrecord_bm_default_department` |
| Type | `List/Record` |
| List/Record | `Department` (record type -123) |
| Mandatory | No |
| Show in List | No |
| Help Text | `Default department applied to all Journal Entry lines created by Bank Match. Required when Department is a mandatory segment in your NetSuite account.` |

---

### Field 4 — Default Class

| Setting | Value |
|---|---|
| Label | `Default Class` |
| ID | `custrecord_bm_default_class` |
| Type | `List/Record` |
| List/Record | `Classification` (record type -101) |
| Mandatory | No |
| Show in List | No |
| Help Text | `Default class applied to all Journal Entry lines created by Bank Match. Required when Class is a mandatory segment in your NetSuite account.` |

---

### Field 5 — Default Location

| Setting | Value |
|---|---|
| Label | `Default Location` |
| ID | `custrecord_bm_default_location` |
| Type | `List/Record` |
| List/Record | `Location` (record type -104) |
| Mandatory | No |
| Show in List | No |
| Help Text | `Default location applied to all Journal Entry lines created by Bank Match. Required when Location is a mandatory segment in your NetSuite account.` |

---

Click **Save** on the record type after all 5 fields are added.

---

## STEP 3 — Add 3 New Fields to BM Match Proposal Record

**Navigation:** Customization → Lists, Records & Fields → Record Types

Find **BM Match Proposal** (`customrecord_bm_proposal`) → click **Edit** → go to the **Fields** tab.

---

### Field 1 — Has Variance

| Setting | Value |
|---|---|
| Label | `Has Variance` |
| ID | `custrecord_bm_prop_has_variance` |
| Type | `Check Box` |
| Mandatory | No |
| Default Value | Unchecked |
| Show in List | Yes |
| Help Text | `Checked when the waterfall matcher found a Tier 2b match — the bank amount and NS balance differ by less than the configured tolerance. A variance write-off JE is created on approval.` |

---

### Field 2 — Variance Amount

| Setting | Value |
|---|---|
| Label | `Variance Amount` |
| ID | `custrecord_bm_prop_variance_amt` |
| Type | `Currency` |
| Mandatory | No |
| Show in List | Yes |
| Help Text | `Absolute difference between the bank line amount and the NS open balance. Populated when Has Variance is checked.` |

---

### Field 3 — Bank Account

| Setting | Value |
|---|---|
| Label | `Bank Account` |
| ID | `custrecord_bm_prop_bank_acct` |
| Type | `List/Record` |
| List/Record | `Account` (record type -10) |
| Mandatory | No |
| Show in List | Yes |
| Help Text | `The GL bank account this proposal belongs to. Used by the Global Overview to count proposals per account.` |

---

Click **Save** on the record type after all 3 fields are added.

---

## STEP 4 — Configure New Settings via the Setup Suitelet

After uploading the updated scripts and creating the new fields:

1. Navigate to the **BM Setup Suitelet** (Customization → Scripting → Scripts → BM Setup Suitelet → deployment URL)
2. Two new sections appear:

### Advanced — GL Account Defaults

| Field | What to enter |
|---|---|
| **Default Bank Fee Account** | An expense/bank charges GL account (e.g. "Bank Service Charges"). Variance write-off JEs will debit/credit this account. |
| **Default Suspense Account** | A clearing/suspense account pre-selected in Manual Match Option C for unknown transactions. |

### Mandatory Segment Defaults (Journal Entry Lines)

Only fill these in if your NetSuite account has Department, Class, or Location set as **mandatory segments**. If they are optional, leave blank.

| Field | What to enter |
|---|---|
| **Default Department** | The department to stamp on all JE lines created by Bank Match. |
| **Default Class** | The class (classification) to stamp on all JE lines. |
| **Default Location** | The location to stamp on all JE lines. |

3. Click **Save**

---

## STEP 5 — Clear Script Cache

After uploading updated JS files, force NetSuite to reload them:

1. Go to **Setup → Company → Enable Features**
2. Click **Save** (no changes needed — this alone clears the SuiteScript cache)

Alternatively: open each affected script deployment record and click **Save**.

---

## STEP 6 — Verify the Deployment

### Global Overview (Master View)
1. Navigate to the Bank Match main Suitelet (BM Main Dashboard deployment URL)
2. Without any `bank_account` URL param, you should see the **Global Overview** — a table of all GL bank accounts with Subsidiary, Unmatched Line count, Pending Proposals count, and a "Go to Matching" link
3. Click "Go to Matching" for any account — the workspace should open filtered to that account

### Multi-Subsidiary Filter
1. In the workspace, the **Subsidiary** and **Bank Account** dropdowns appear at the top
2. Changing the Subsidiary dropdown should reload the page with the Bank Account dropdown repopulated with only accounts for that subsidiary

### Waterfall Auto-Match
1. Open a workspace for a bank account with unmatched lines
2. Click **Run Auto-Match**
3. Proposals are created with a Notes field showing the tier: `Tier1`, `Tier2a`, `Tier2b (variance: X.XX)`, or `Tier3`
4. Tier 2b proposals show a "⚠ X.XX" variance label in the Pending Approvals tab
5. Approving a Tier 2b proposal should create both the Customer/Vendor Payment AND a variance write-off Journal Entry (check Script Execution Log for confirmation)

### Failed Proposals Banner (Feature 7)
1. If any proposals have `Apply Status = Failed`, a red warning banner appears above the tabs in the workspace
2. The banner lists the bank ref, date, amount, and error detail for up to 5 failed proposals
3. In the **History** tab, failed rows show `⚠ FAILED` in the Result column and the full error in "Error Detail"

### Multi-Apply — Manual Invoice/Bill Selection (Feature 8)
1. Click **Manual Match** for an unmatched bank line
2. Click **Find Open Invoices →** (or **Find Open Bills →**)
3. The invoice/bill page now shows an **Apply?** checkbox per row instead of a single "Select" link
4. A **Selected / Remaining** counter above the sublist updates in real-time as you check/uncheck boxes
5. Check multiple invoices and click **Create Customer Payment for Selected Invoice(s)**
6. A single Customer Payment applied to all checked invoices is created

### Mandatory Segment Defaults (Feature 9)
1. Configure Default Department/Class/Location in Settings (if your account uses mandatory segments)
2. Create a manual GL match (Option C — Journal Entry)
3. Open the created Journal Entry and verify each line has the configured department/class/location set

---

## STEP 7 — Troubleshooting

### Variance JE not created after approving a Tier 2b proposal
- Verify **Default Bank Fee Account** is set in Settings
- Check Script Execution Log for `customscript_bm_proposal_ue` for any error
- Confirm the proposal's **Has Variance** checkbox is checked and **Variance Amount** is > 0

### Journal Entry fails with "Department is required" (or Class/Location)
- Set the appropriate Default Department / Default Class / Default Location in Bank Match Settings
- These are applied to all JE lines created by the engine

### Multi-apply: "No records selected" error
- Ensure at least one **Apply?** checkbox is checked before clicking the submit button

### Global Overview shows '?' for Unmatched Lines count
- This means the `bankstatementimportline` search is not available in your NS account version
- Falls back to BankLineReader; if both fail, the count shows `?` — not a blocking issue

### Bank Account dropdown doesn't change when Subsidiary is selected
- Ensure `BM_Dashboard_CS.js` was uploaded (Step 1) and the script cache was cleared (Step 5)
- Check browser console for JavaScript errors

---

## Upgrade Checklist

- [ ] Step 1: 6 JS files re-uploaded to `/SuiteScripts/BankMatch/`
- [ ] Step 2: 5 new fields added to `customrecord_bm_settings`
- [ ] Step 3: 3 new fields added to `customrecord_bm_proposal`
- [ ] Step 4: Fee Account, Suspense Account, and optional segment defaults configured in Settings
- [ ] Step 5: Script cache cleared
- [ ] Step 6: End-to-end flow verified (Overview, waterfall, failed banner, multi-apply, segments)

---

## Guide Index — Which Guide to Use

| Situation | Guide to use |
|---|---|
| **First-ever installation** | `MANUAL_DEPLOYMENT_GUIDE.md` → then `PHASE2_DEPLOYMENT_GUIDE.md` → then this guide |
| **Already on Phase 2, upgrading now** | This guide (`PHASE3_DEPLOYMENT_GUIDE.md`) only |
| **Automated deploy via SuiteCloud CLI** | `DEPLOY_GUIDE_CLI.md` (the XML metadata deploys all custom record fields automatically) |
| **Automated deploy via GitHub Actions** | `DEPLOY_GUIDE_GITHUB_ACTIONS.md` |

> **Prefer the CLI or GitHub Actions guides** if you have SDF access — they deploy all custom record field changes from the XML files automatically, replacing Steps 2 and 3 of this guide.
