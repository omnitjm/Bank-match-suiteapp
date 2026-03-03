# Bank Match SuiteApp — Deployment Guide

Deploy and configure the full Bank Match SuiteApp using the SuiteCloud CLI.
Running `npm run deploy` pushes everything: custom records, all fields, all scripts.
No manual field creation in the NetSuite UI is ever needed.

---

## Prerequisites

- Node.js 18 or higher — https://nodejs.org
- Git
- A NetSuite account with **SuiteCloud Development Framework (SDF)** enabled

---

## Step 1 — Enable SDF in NetSuite

1. Setup → Company → Enable Features
2. Click the **SuiteCloud** tab
3. Check **SuiteCloud Development Framework**
4. Click **Save**

---

## Step 2 — Create a TBA Integration Record

Token-Based Authentication (TBA) is how the CLI talks to your account.

1. Setup → Integration → Manage Integrations → **New**
2. Fill in:
   - **Name:** `Bank Match CLI`
   - **State:** Enabled
3. Under **Authentication**, check **Token-Based Authentication**
4. Uncheck **Authorization Code Grant**
5. Click **Save**
6. On the confirmation page, copy and save — shown only once:
   - **Consumer Key**
   - **Consumer Secret**

---

## Step 3 — Create an Access Token

> **Before you start:** The Role dropdown only lists roles already assigned to the selected user.
> If Administrator is not in the list, you must add it to your user first:
> Setup → Users/Roles → Manage Users → find your user → Edit → Roles subtab → Add → **Administrator** → Save.
> Then come back here.

1. Setup → Users/Roles → Access Tokens → **New**
2. Fill in:
   - **Application Name:** `Bank Match CLI`
   - **User:** your user account
   - **Role:** `Administrator`
3. Click **Save**
4. Copy and save — shown only once:
   - **Token ID**
   - **Token Secret**

You now have 4 credentials. Keep them safe:

| Value | Where you got it |
|---|---|
| Consumer Key | Integration record |
| Consumer Secret | Integration record |
| Token ID | Access Token record |
| Token Secret | Access Token record |

---

## Step 4 — Find Your Account ID

Setup → Company → Company Information → **Account ID** at the top.

Format: `1234567` (production) or `1234567_SB1` (sandbox).

---

## Step 5 — Install Dependencies

```bash
npm install
```

---

## Step 6 — Authenticate the CLI

```bash
npm run setup
```

Answer each prompt:

| Prompt | What to enter |
|---|---|
| Authentication type | `Token-based authentication (TBA)` |
| Account ID | From Step 4 |
| Token ID | From Step 3 |
| Token Secret | From Step 3 |
| Consumer Key | From Step 2 |
| Consumer Secret | From Step 2 |

Credentials are saved locally under the alias `bank-match-auth`.
Run this once per machine.

---

## Step 7 — Validate (optional dry-run)

```bash
npm run validate
```

Fix any errors before deploying.

---

## Step 8 — Deploy

```bash
npm run deploy
```

Type `YES` when prompted.

The CLI deploys everything in one shot:

- Custom transaction body field
- Custom lists
- Custom records with all fields (Settings, Proposals, Bank Lines)
- All script files to File Cabinet (`/SuiteScripts/BankMatch/`)
- All script records and deployments

> This replaces all previous manual steps for creating fields via Customization → Lists, Records & Fields.

---

## Step 9 — Configure Settings (one-time, in NetSuite UI)

After the first deploy, open the Setup Suitelet to configure the app:

**Navigation:** Customization → Scripting → Scripts → **BM Setup Suitelet** → click the deployment URL

### Required

| Field | What to enter |
|---|---|
| **Bank Account** | Your GL bank clearing account |
| **Approver** | Employee who approves auto-matched proposals |
| **Amount Tolerance** | Maximum variance allowed for auto-matching (e.g. `0.01`) |
| **Date Tolerance (days)** | Maximum day gap for date-fuzzy matching (e.g. `5`) |

### Advanced GL Account Defaults

| Field | What to enter |
|---|---|
| **Default Bank Fee Account** | Expense account for variance write-off JEs (e.g. "Bank Service Charges") |
| **Default Suspense Account** | Clearing account pre-selected in Manual Match → Option C |

### Mandatory Segment Defaults

Only fill these in if Department, Class, or Location are **mandatory segments** in your account. Leave blank if optional.

| Field | What to enter |
|---|---|
| **Default Department** | Department stamped on all JE lines created by Bank Match |
| **Default Class** | Class (classification) stamped on all JE lines |
| **Default Location** | Location stamped on all JE lines |

Click **Save**.

---

## Step 10 — Verify the Deployment

### Global Overview
- Open the BM Main Suitelet (Customization → Scripting → Scripts → BM Main Dashboard → deployment URL)
- Without a `bank_account` URL param, the **Global Overview** loads — a table of all GL bank accounts with Subsidiary, Unmatched Lines, Pending Proposals, and a "Go to Matching" link
- Click "Go to Matching" for any account to open the workspace

### Multi-Subsidiary Filter
- In the workspace, **Subsidiary** and **Bank Account** dropdowns appear at the top
- Changing Subsidiary should repopulate the Bank Account list for that subsidiary only

### Waterfall Auto-Match
- Open a workspace, click **Run Auto-Match**
- Proposals are created with Notes showing: `Tier1`, `Tier2a`, `Tier2b (variance: X.XX)`, or `Tier3`
- Tier 2b proposals show a "⚠ X.XX" variance label in the Pending Approvals tab
- Approving a Tier 2b proposal creates both the payment and a variance write-off JE

### Failed Proposals Banner
- If any proposals have Apply Status = Failed, a red banner appears above the tabs
- Lists bank ref, date, amount, and error detail per failed proposal
- History tab shows `⚠ FAILED` in the Result column with full error detail

### Multi-Apply (Invoice / Bill Selection)
- Click **Manual Match** for an unmatched bank line → **Find Open Invoices →**
- Each row has an **Apply?** checkbox
- A **Selected / Remaining** counter updates in real-time as you check/uncheck rows
- Check multiple invoices → click **Create Customer Payment for Selected Invoice(s)**
- One Customer Payment applied to all checked invoices is created

### Mandatory Segment Defaults
- Configure Default Department/Class/Location in Settings (if your account uses mandatory segments)
- Create a Manual GL match (Option C — Journal Entry)
- Open the created JE and verify each line has the configured segment values

---

## Future Deployments

Every time you update the code, just run:

```bash
npm run deploy
```

---

## Troubleshooting

**`suitecloud: command not found`**
Run `npm install` first. Or use `npx suitecloud` directly.

**`Invalid login attempt` / `AUTH_FAILED`**
Re-run `npm run setup` with the correct credentials. Confirm the integration and token are both Active in NetSuite.

**`SDF is not enabled`**
Go back to Step 1 and enable SuiteCloud Development Framework.

**Scripts don't appear after deploy**
Go to Setup → Company → Enable Features → click Save. This clears the SuiteScript cache.

**Variance JE not created after approving a Tier 2b proposal**
- Confirm **Default Bank Fee Account** is set in Settings
- Check Script Execution Log for `customscript_bm_proposal_ue`
- Confirm the proposal's Has Variance checkbox is checked and Variance Amount is > 0

**JE fails with "Department is required" (or Class / Location)**
Set Default Department / Class / Location in Bank Match Settings.

**Multi-apply: "No records selected" error**
Check at least one **Apply?** checkbox before submitting.

**Bank Account dropdown doesn't change when Subsidiary is selected**
Clear the script cache (Setup → Company → Enable Features → Save) and check browser console for JS errors.
