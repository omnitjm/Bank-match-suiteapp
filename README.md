# Bank Match SuiteApp

A simple, focused NetSuite SuiteApp for bank reconciliation.

## What it does

- **Import** bank statement lines from a CSV file
- **Auto-match** credits to open Sales Invoices (Customer Payments) and debits to Vendor Payments
- **Approval gate** — every match requires approval before NetSuite is touched
- **Bill Payment date adjustment** — optionally update a Vendor Payment's date to the bank date
- **Simple setup page** — one form for all configuration

## Quick Start

1. Deploy via SuiteCloud CLI: `suitecloud project:deploy`
2. Open the **BM Setup** suitelet and configure your bank account, tolerances, and approver
3. Open the **BM Reconciliation** dashboard and import a bank statement CSV
4. Review and approve proposals — reconciliation runs automatically on approval

## CSV Format

```
Date, Description, Amount, Reference
2026-01-15, ACME Payment, 5000.00, INV-1042
2026-01-16, Rent, -3500.00, BP-2031
```

Positive amount = credit (Customer Payment). Negative = debit (Bill Payment).

## See also

- [Full User Guide](docs/USER_GUIDE.md)

## File structure

```
FileCabinet/SuiteScripts/BankMatch/
  BM_Constants.js       ← shared field IDs and status codes
  BM_MatchEngine.js     ← scoring, matching, and reconciliation logic
  BM_Setup_SL.js        ← settings/configuration suitelet
  BM_Setup_CS.js        ← settings page client script
  BM_Main_SL.js         ← main dashboard (import, match, proposals)
  BM_Dashboard_CS.js    ← dashboard client script
  BM_Proposal_UE.js     ← user event: executes reconciliation on approval

Objects/
  customlist_bm_prop_status.xml
  customlist_bm_txn_status.xml
  customlist_bm_txn_type.xml
  customrecord_bm_settings.xml
  customrecord_bm_bank_txn.xml
  customrecord_bm_proposal.xml
  customscript_bm_setup_sl.xml
  customscript_bm_setup_cs.xml
  customscript_bm_main_sl.xml
  customscript_bm_dashboard_cs.xml
  customscript_bm_proposal_ue.xml
```
