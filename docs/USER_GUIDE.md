# Bank Match SuiteApp – User Guide

> **Version 1.0** · NetSuite SuiteCloud · SuiteScript 2.1

---

## Overview

Bank Match is a lightweight NetSuite SuiteApp that bridges your bank statement with your NetSuite books. It handles two core workflows:

| Bank line | NetSuite side | What the app does |
|-----------|---------------|-------------------|
| **Credit** (money received) | Open Sales Invoice | Creates a Customer Payment and applies it to the invoice |
| **Debit** (money paid out) | Vendor Payment | Marks as reconciled; optionally adjusts the payment date to the bank date |

Every match goes through a mandatory **approval step** before any changes are made to NetSuite transactions.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Bank Match SuiteApp                │
│                                                     │
│  BM_Setup_SL ──► Settings record                   │
│  (Setup page)     (1 per account)                   │
│                                                     │
│  BM_Main_SL ──► BM_MatchEngine ──► Candidates      │
│  (Dashboard)      findInvoiceMatches()              │
│       │           findBillPaymentMatches()           │
│       │                                             │
│       └──► BM Bank Transaction records (imported)   │
│       └──► BM Match Proposal records (pending)      │
│                         │                           │
│              Approver edits proposal                │
│              Status → Approved                      │
│                         │                           │
│              BM_Proposal_UE (afterSubmit)           │
│              ├─ applyCustomerPayment()  (invoice)   │
│              └─ applyBillPayment()     (vendor pymt)│
└─────────────────────────────────────────────────────┘
```

### Files

| File | Type | Purpose |
|------|------|---------|
| `BM_Constants.js` | Library | All field IDs, status codes, record type IDs |
| `BM_MatchEngine.js` | Library | Matching logic + reconciliation execution |
| `BM_Setup_SL.js` | Suitelet | Settings / configuration page |
| `BM_Setup_CS.js` | Client Script | Navigation on the setup page |
| `BM_Main_SL.js` | Suitelet | Main dashboard: import, match, view proposals |
| `BM_Dashboard_CS.js` | Client Script | Navigation on the dashboard |
| `BM_Proposal_UE.js` | User Event | Fires on proposal approval → runs reconciliation |

---

## Initial Setup

### Step 1 – Deploy the SuiteApp

1. In NetSuite, go to **Customization → SuiteCloud → SuiteCloud Development Framework → Projects**.
2. Upload or sync this project using the SuiteCloud CLI:
   ```bash
   suitecloud project:deploy
   ```
3. NetSuite will create all custom records, lists, and scripts automatically.

### Step 2 – Open the Setup Page

Navigate to:

```
Customization → Scripted UI → Suitelet Scripts
```

Find **"BM Setup Suitelet"** and click **View Deployment** → **URL** to open the setup page.

Alternatively, use the direct URL pattern:
```
/app/site/hosting/scriptlet.nl?script=customscript_bm_setup_sl&deploy=customdeploy_bm_setup_sl
```

### Step 3 – Configure Settings

Fill in all fields on the setup form:

| Field | Description | Example |
|-------|-------------|---------|
| **Bank Account** | The GL account linked to your bank | `1000 – Checking Account` |
| **Subsidiary** | Limit matching to one subsidiary (optional) | Leave blank for all |
| **Amount Tolerance** | Max $ difference still considered a match | `0.50` |
| **Date Tolerance (days)** | Max days difference for date-based scoring | `5` |
| **Approver** | Employee who approves all proposals | `Jane Smith` |
| **Notification Email** | Override email (defaults to approver's email) | `finance@example.com` |
| **Auto-suggest on Import** | Auto-propose best match when importing CSV | ✓ checked |

Click **Save Settings**.

---

## Daily Workflow

### 1. Import Your Bank Statement

1. Open the **Bank Match – Reconciliation** dashboard.
2. Click **⬆ Import Bank Statement**.
3. Upload a CSV file in this format:

   ```csv
   Date,Description,Amount,Reference
   2026-02-01,ACME Corp Payment,5000.00,INV-1042
   2026-02-02,Office Supplies,-234.56,BP-2031
   ```

   - **Amount positive** → credit (money received) → matched as Customer Payment
   - **Amount negative** → debit (money paid out) → matched as Bill Payment
   - **Reference** is optional but greatly improves match scoring

4. Click **Import & Auto-suggest Matches**.

If **Auto-suggest** is enabled, the best match for each line will be automatically proposed (status: *Pending Approval*). The approver receives an email notification for each proposal.

---

### 2. Propose a Match Manually

1. On the dashboard **Bank Transactions** tab, find an *Unmatched* line.
2. Click **Propose Match** in the Action column.
3. The system shows scored candidates:
   - **Credits**: Open Sales Invoices matching the amount (within tolerance)
   - **Debits**: Posted Vendor Payments matching the amount (within tolerance)
4. Click **Select** next to the best candidate.
   - For **Bill Payments**: check **"Adjust Payment Date in NetSuite"** if the Vendor Payment date should be updated to match the bank date.
5. Optionally add **Notes** and click **Submit Manual Proposal for Approval**.

The proposal is created with status **Pending Approval** and the approver is notified.

---

### 3. Approve (or Reject) a Proposal

The approver opens the **BM Match Proposal** record (link in the notification email or via the **Pending Approvals** tab).

| Proposal fields shown | Description |
|-----------------------|-------------|
| **Transaction Type** | Customer Payment or Bill Payment |
| **Bank Date / Amount / Reference** | From the imported bank line |
| **NS Transaction #** | The matching invoice or vendor payment number |
| **NS Match Amount** | Amount on the NetSuite record |
| **Adjust Payment Date** | Whether the vendor payment date will be updated |
| **Notes** | Any notes added during proposal creation |

To **approve**: change **Status** → *Approved* and save.
To **reject**: change **Status** → *Rejected* and save.

> **What happens on approval?**
>
> - **Customer Payment**: A new `Customer Payment` record is created in NetSuite and applied to the matched invoice. The bank transaction is marked *Reconciled*.
> - **Bill Payment**: The `Vendor Payment` is marked reconciled. If "Adjust Date" was checked, its `trandate` is updated to the bank date. The bank transaction is marked *Reconciled*.

---

### 4. View History

The **History** tab on the dashboard shows all applied and rejected proposals with dates, amounts, and any error messages.

---

## Matching Score

Each candidate is scored 0–100:

| Criterion | Max points | Detail |
|-----------|-----------|--------|
| **Amount match** | 40 | Exact match = 40 pts; within tolerance = 15–35 pts |
| **Date proximity** | 30 | Same day = 30 pts; ≤3 days = 22 pts; ≤7 days = 14 pts |
| **Reference match** | 30 | Exact = 30 pts; partial = 18 pts |

Candidates are shown best-first. A score above 70 is a strong match; below 40 is weak.

---

## Custom Records Reference

### BM App Settings (`customrecord_bm_settings`)
One record per account. Managed via the Setup page.

### BM Bank Transaction (`customrecord_bm_bank_txn`)
Created automatically from CSV imports. Statuses:
- **Unmatched** – no proposal yet
- **Proposed** – a pending proposal exists
- **Reconciled** – reconciliation applied
- **Excluded** – manually excluded from matching

### BM Match Proposal (`customrecord_bm_proposal`)
Created by the dashboard when a match is proposed. Statuses:
- **Pending Approval** – waiting for approver action
- **Approved** → triggers reconciliation automatically
- **Rejected** – approver declined
- **Applied** – reconciliation completed successfully
- **Failed** – reconciliation attempted but errored (check Error Message field)

---

## CSV Format Reference

```csv
Date,Description,Amount,Reference
2026-01-15,SMITH CORP,1250.00,INV-0099
2026-01-16,RENT PAYMENT,-3500.00,BP-4422
2026-01-17,BANK INTEREST,12.50,
```

- **Date**: `YYYY-MM-DD` or `MM/DD/YYYY`
- **Description**: bank narrative (free text)
- **Amount**: use `.` as decimal separator; negative = payment out
- **Reference**: bank reference or check number (optional)

Column headers are **case-insensitive**.

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Redirected to Setup on open | No settings record exists | Complete the Setup page first |
| No candidates shown | Amount outside tolerance | Lower Amount Tolerance in Settings, or use manual proposal |
| Proposal stuck at Pending | Approver hasn't acted | Remind approver; check notification email setting |
| Proposal status = Failed | Reconciliation error | Open the proposal record and read the Error Message field |
| Customer Payment not applied | Invoice already paid | Verify the invoice status in NetSuite |
| Bill Payment date not changed | "Adjust Date" unchecked | Open proposal, check the field, re-approve (create new proposal) |

---

## Permissions

- **Admin / Controller**: Full access to all records and scripts
- **Accounting Staff**: Create proposals via the dashboard
- **Approver**: Edit `BM Match Proposal` records (change Status field)

Ensure the Approver employee has at minimum **Edit** permission on the `BM Match Proposal` custom record.

---

*Bank Match SuiteApp v1.0 — Built with SuiteScript 2.1*
