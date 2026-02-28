# Bank Match SuiteApp — Manual Deployment Guide

Follow these steps **in order**. Each phase depends on the one before it.

---

## PHASE 1 — Upload Script Files to File Cabinet

**Navigation:** Documents → Files → SuiteScripts

1. Inside SuiteScripts, create a new folder named **`BankMatch`**
2. Open the `BankMatch` folder and upload all 11 JS files one by one:

| File to Upload |
|---|
| `BM_Constants.js` |
| `BM_MatchEngine.js` |
| `BM_BankLineReader.js` |
| `BM_NativeBridge.js` |
| `BM_NativePage_CS.js` |
| `BM_Reconcile_RL.js` |
| `BM_Setup_SL.js` |
| `BM_Setup_CS.js` |
| `BM_Main_SL.js` |
| `BM_Dashboard_CS.js` |
| `BM_Proposal_UE.js` |

> After upload, the files must live at path: `/SuiteScripts/BankMatch/<filename>.js`

---

## PHASE 2 — Create Custom Lists (3 lists)

**Navigation:** Customization → Lists, Records & Fields → Other Lists → **New**

---

### List 1 — BM Proposal Status

| Field | Value |
|---|---|
| Name | `BM Proposal Status` |
| ID | `customlist_bm_prop_status` |
| Ordered | No |

**Values to add** (click "Add" for each):

| # | Value |
|---|---|
| 1 | `Pending Approval` |
| 2 | `Approved` |
| 3 | `Rejected` |
| 4 | `Applied` |
| 5 | `Failed` |

Click **Save**.

---

### List 2 — BM Bank Transaction Status

| Field | Value |
|---|---|
| Name | `BM Bank Transaction Status` |
| ID | `customlist_bm_txn_status` |
| Ordered | No |

**Values to add:**

| # | Value |
|---|---|
| 1 | `Unmatched` |
| 2 | `Proposed` |
| 3 | `Reconciled` |
| 4 | `Excluded` |

Click **Save**.

---

### List 3 — BM Transaction Type

| Field | Value |
|---|---|
| Name | `BM Transaction Type` |
| ID | `customlist_bm_txn_type` |
| Ordered | No |

**Values to add:**

| # | Value |
|---|---|
| 1 | `Customer Payment` |
| 2 | `Bill Payment` |

Click **Save**.

---

## PHASE 3 — Create Custom Record Types (3 records)

**Navigation:** Customization → Lists, Records & Fields → Record Types → **New**

---

### Record 1 — BM App Settings

**Header tab:**

| Field | Value |
|---|---|
| Name | `BM App Settings` |
| ID | `customrecord_bm_settings` |
| Record Name Field Label | `Settings` |
| Allow Inline Editing | Yes |
| Allow UI Access | Yes |
| Show Last Modified | Yes |

**Fields tab — add these 6 fields:**

#### Field 1
| Field | Value |
|---|---|
| Label | `Bank Account` |
| ID | `custrecord_bm_bank_account` |
| Type | `List/Record` |
| List/Record | `Account` (record type -10) |
| Mandatory | Yes |
| Show in List | Yes |
| Help Text | `The GL bank account used for reconciliation.` |

#### Field 2
| Field | Value |
|---|---|
| Label | `Subsidiary` |
| ID | `custrecord_bm_subsidiary` |
| Type | `List/Record` |
| List/Record | `Subsidiary` (record type -117) |
| Mandatory | No |
| Show in List | Yes |
| Help Text | `Limit matching to this subsidiary. Leave blank for all subsidiaries.` |

#### Field 3
| Field | Value |
|---|---|
| Label | `Amount Tolerance` |
| ID | `custrecord_bm_tolerance_amt` |
| Type | `Currency` |
| Mandatory | No |
| Default Value | `0.01` |
| Show in List | Yes |
| Help Text | `Maximum allowed amount difference when auto-matching.` |

#### Field 4
| Field | Value |
|---|---|
| Label | `Date Tolerance (days)` |
| ID | `custrecord_bm_tolerance_days` |
| Type | `Integer` |
| Mandatory | No |
| Default Value | `5` |
| Show in List | Yes |
| Help Text | `Maximum number of days between bank date and NetSuite date for auto-matching.` |

#### Field 5
| Field | Value |
|---|---|
| Label | `Approver` |
| ID | `custrecord_bm_approver` |
| Type | `List/Record` |
| List/Record | `Employee` (record type -4) |
| Mandatory | Yes |
| Show in List | Yes |
| Help Text | `Employee who must approve all reconciliation proposals before they are applied.` |

#### Field 6
| Field | Value |
|---|---|
| Label | `Auto-suggest Matches on Import` |
| ID | `custrecord_bm_auto_suggest` |
| Type | `Check Box` |
| Mandatory | No |
| Default Value | Checked |
| Show in List | Yes |
| Help Text | `When enabled, the best match candidate is automatically proposed when bank lines are imported (still requires approval).` |

Click **Save**.

---

### Record 2 — BM Bank Transaction

**Header tab:**

| Field | Value |
|---|---|
| Name | `BM Bank Transaction` |
| ID | `customrecord_bm_bank_txn` |
| Record Name Field Label | `Bank Transaction` |
| Allow Inline Editing | Yes |
| Allow UI Access | Yes |
| Enable Keyword Search | Yes |
| Show Creation Date | Yes |
| Show Last Modified | Yes |

**Fields tab — add these 7 fields:**

#### Field 1
| Field | Value |
|---|---|
| Label | `Transaction Date` |
| ID | `custrecord_bm_txn_date` |
| Type | `Date` |
| Mandatory | Yes |
| Show in List | Yes |

#### Field 2
| Field | Value |
|---|---|
| Label | `Description` |
| ID | `custrecord_bm_txn_desc` |
| Type | `Free-Form Text` |
| Mandatory | No |
| Show in List | Yes |

#### Field 3
| Field | Value |
|---|---|
| Label | `Amount` |
| ID | `custrecord_bm_txn_amount` |
| Type | `Currency` |
| Mandatory | Yes |
| Show in List | Yes |
| Help Text | `Positive = credit (money received), Negative = debit (money paid out).` |

#### Field 4
| Field | Value |
|---|---|
| Label | `Bank Reference` |
| ID | `custrecord_bm_txn_ref` |
| Type | `Free-Form Text` |
| Mandatory | No |
| Show in List | Yes |

#### Field 5
| Field | Value |
|---|---|
| Label | `Currency` |
| ID | `custrecord_bm_txn_currency` |
| Type | `Free-Form Text` |
| Mandatory | No |
| Default Value | `USD` |
| Show in List | Yes |

#### Field 6
| Field | Value |
|---|---|
| Label | `Status` |
| ID | `custrecord_bm_txn_status` |
| Type | `List/Record` |
| List/Record | `BM Bank Transaction Status` (the list you created above) |
| Mandatory | Yes |
| Default Value | `1` (= Unmatched) |
| Show in List | Yes |

#### Field 7
| Field | Value |
|---|---|
| Label | `Bank Account` |
| ID | `custrecord_bm_txn_bank_acct` |
| Type | `List/Record` |
| List/Record | `Account` (record type -10) |
| Mandatory | No |
| Show in List | Yes |

Click **Save**.

---

### Record 3 — BM Match Proposal

**Header tab:**

| Field | Value |
|---|---|
| Name | `BM Match Proposal` |
| ID | `customrecord_bm_proposal` |
| Record Name Field Label | `Match Proposal` |
| Allow UI Access | Yes |
| Enable Keyword Search | Yes |
| Enable Notes | Yes |
| Show Creation Date | Yes |
| Show Last Modified | Yes |
| Show Owner | Yes |

**Fields tab — add these 14 fields:**

#### Field 1
| Field | Value |
|---|---|
| Label | `Bank Transaction` |
| ID | `custrecord_bm_prop_bank_txn` |
| Type | `List/Record` |
| List/Record | `BM Bank Transaction` (the record you created above) |
| Mandatory | Yes |
| Show in List | Yes |

#### Field 2
| Field | Value |
|---|---|
| Label | `Transaction Type` |
| ID | `custrecord_bm_prop_txn_type` |
| Type | `List/Record` |
| List/Record | `BM Transaction Type` (the list you created above) |
| Mandatory | Yes |
| Show in List | Yes |

#### Field 3
| Field | Value |
|---|---|
| Label | `NS Record Type` |
| ID | `custrecord_bm_prop_ns_type` |
| Type | `Free-Form Text` |
| Mandatory | No |
| Show in List | No |
| Help Text | `Internal NetSuite record type string (e.g. invoice, vendorpayment).` |

#### Field 4
| Field | Value |
|---|---|
| Label | `NS Record ID` |
| ID | `custrecord_bm_prop_ns_id` |
| Type | `Integer` |
| Mandatory | Yes |
| Show in List | Yes |

#### Field 5
| Field | Value |
|---|---|
| Label | `NS Transaction #` |
| ID | `custrecord_bm_prop_ns_ref` |
| Type | `Free-Form Text` |
| Mandatory | No |
| Show in List | Yes |

#### Field 6
| Field | Value |
|---|---|
| Label | `NS Match Amount` |
| ID | `custrecord_bm_prop_match_amt` |
| Type | `Currency` |
| Mandatory | No |
| Show in List | Yes |

#### Field 7
| Field | Value |
|---|---|
| Label | `NS Match Date` |
| ID | `custrecord_bm_prop_match_date` |
| Type | `Date` |
| Mandatory | No |
| Show in List | Yes |

#### Field 8
| Field | Value |
|---|---|
| Label | `Bank Amount` |
| ID | `custrecord_bm_prop_bank_amt` |
| Type | `Currency` |
| Mandatory | No |
| Show in List | Yes |

#### Field 9
| Field | Value |
|---|---|
| Label | `Bank Date` |
| ID | `custrecord_bm_prop_bank_date` |
| Type | `Date` |
| Mandatory | No |
| Show in List | Yes |

#### Field 10
| Field | Value |
|---|---|
| Label | `Bank Reference` |
| ID | `custrecord_bm_prop_bank_ref` |
| Type | `Free-Form Text` |
| Mandatory | No |
| Show in List | Yes |

#### Field 11
| Field | Value |
|---|---|
| Label | `Status` |
| ID | `custrecord_bm_prop_status` |
| Type | `List/Record` |
| List/Record | `BM Proposal Status` (the list you created above) |
| Mandatory | Yes |
| Default Value | `1` (= Pending Approval) |
| Show in List | Yes |
| Help Text | `Change to Approved to execute the reconciliation. Change to Rejected to decline.` |

#### Field 12
| Field | Value |
|---|---|
| Label | `Approver` |
| ID | `custrecord_bm_prop_approver` |
| Type | `List/Record` |
| List/Record | `Employee` (record type -4) |
| Mandatory | No |
| Show in List | Yes |

#### Field 13
| Field | Value |
|---|---|
| Label | `Adjust Payment Date in NetSuite` |
| ID | `custrecord_bm_prop_adj_date` |
| Type | `Check Box` |
| Mandatory | No |
| Default Value | Unchecked |
| Show in List | Yes |
| Help Text | `When checked (Bill Payment only), the Vendor Payment trandate will be updated to match the Bank Date on approval.` |

#### Field 14
| Field | Value |
|---|---|
| Label | `Notes` |
| ID | `custrecord_bm_prop_notes` |
| Type | `Text Area` |
| Mandatory | No |
| Show in List | No |

#### Field 15
| Field | Value |
|---|---|
| Label | `Applied Date` |
| ID | `custrecord_bm_prop_applied_dt` |
| Type | `Date` |
| Mandatory | No |
| Show in List | Yes |

#### Field 16
| Field | Value |
|---|---|
| Label | `Error Message` |
| ID | `custrecord_bm_prop_error_msg` |
| Type | `Text Area` |
| Mandatory | No |
| Show in List | No |

#### Field 17
| Field | Value |
|---|---|
| Label | `Native Bank Line ID` |
| ID | `custrecord_bm_prop_bank_line` |
| Type | `Free-Form Text` |
| Mandatory | No |
| Show in List | No |
| Help Text | `Internal ID of the bank statement line from NetSuite's native Match Bank Data module.` |

Click **Save**.

---

## PHASE 4 — Create Scripts & Deployments (7 scripts)

**Navigation:** Customization → Scripting → Scripts → **New**

For each script: upload/select the file, fill in the fields, then go to the **Deployments** tab and add the deployment settings shown.

---

### Script 1 — BM Native Page Enhancement (Client Script)

**Script tab:**

| Field | Value |
|---|---|
| Name | `BM Native Page Enhancement` |
| ID | `customscript_bm_native_cs` |
| Script Type | `Client Script` |
| Script File | `/SuiteScripts/BankMatch/BM_NativePage_CS.js` |
| Description | `Bank Match – Injects Auto-Reconcile button into the native Match Bank Data page` |
| Notify Owner on Error | Yes |

**Deployments tab → click Add Deployment:**

| Field | Value |
|---|---|
| Title | `BM Native Page Enhancement` |
| Deployment ID | `customdeploy_bm_native_cs` |
| Status | `Released` |
| Deployed | Yes |
| Log Level | `Error` |
| Execute as Role | *(leave blank)* |
| All Roles | Yes |
| All Employees | Yes |
| All Partners | No |

Click **Save**.

---

### Script 2 — BM Reconcile RESTlet

**Script tab:**

| Field | Value |
|---|---|
| Name | `BM Reconcile RESTlet` |
| ID | `customscript_bm_reconcile_rl` |
| Script Type | `RESTlet` |
| Script File | `/SuiteScripts/BankMatch/BM_Reconcile_RL.js` |
| Description | `Bank Match – RESTlet called by the native Match Bank Data button to auto-propose matches` |
| Notify Owner on Error | Yes |

**Deployments tab → click Add Deployment:**

| Field | Value |
|---|---|
| Title | `BM Reconcile RESTlet` |
| Deployment ID | `customdeploy_bm_reconcile_rl` |
| Status | `Released` |
| Deployed | Yes |
| Log Level | `Debug` |
| Execute as Role | `Administrator` |
| All Roles | Yes |
| All Employees | No |
| All Partners | No |

Click **Save**.

---

### Script 3 — BM Setup Suitelet

**Script tab:**

| Field | Value |
|---|---|
| Name | `BM Setup Suitelet` |
| ID | `customscript_bm_setup_sl` |
| Script Type | `Suitelet` |
| Script File | `/SuiteScripts/BankMatch/BM_Setup_SL.js` |
| Description | `Bank Match – Setup / Configuration Page` |
| Notify Owner on Error | Yes |

**Deployments tab → click Add Deployment:**

| Field | Value |
|---|---|
| Title | `Bank Match – Setup` |
| Deployment ID | `customdeploy_bm_setup_sl` |
| Status | `Released` |
| Deployed | Yes |
| Log Level | `Debug` |
| Execute as Role | `Administrator` |
| All Roles | Yes |
| All Employees | No |
| All Partners | No |

Click **Save**.

---

### Script 4 — BM Setup Client Script

**Script tab:**

| Field | Value |
|---|---|
| Name | `BM Setup Client Script` |
| ID | `customscript_bm_setup_cs` |
| Script Type | `Client Script` |
| Script File | `/SuiteScripts/BankMatch/BM_Setup_CS.js` |
| Description | `Bank Match – Setup page client script` |
| Notify Owner on Error | Yes |

**Deployments tab → click Add Deployment:**

| Field | Value |
|---|---|
| Title | `BM Setup CS` |
| Deployment ID | `customdeploy_bm_setup_cs` |
| Status | `Released` |
| Deployed | Yes |
| Log Level | `Debug` |
| Execute as Role | *(leave blank)* |
| All Roles | Yes |
| All Employees | No |
| All Partners | No |

Click **Save**.

---

### Script 5 — BM Main Dashboard (Suitelet)

**Script tab:**

| Field | Value |
|---|---|
| Name | `BM Main Dashboard` |
| ID | `customscript_bm_main_sl` |
| Script Type | `Suitelet` |
| Script File | `/SuiteScripts/BankMatch/BM_Main_SL.js` |
| Description | `Bank Match – Main Reconciliation Dashboard` |
| Notify Owner on Error | Yes |

**Deployments tab → click Add Deployment:**

| Field | Value |
|---|---|
| Title | `Bank Match – Reconciliation` |
| Deployment ID | `customdeploy_bm_main_sl` |
| Status | `Released` |
| Deployed | Yes |
| Log Level | `Debug` |
| Execute as Role | `Administrator` |
| All Roles | Yes |
| All Employees | No |
| All Partners | No |

Click **Save**.

---

### Script 6 — BM Dashboard Client Script

**Script tab:**

| Field | Value |
|---|---|
| Name | `BM Dashboard Client Script` |
| ID | `customscript_bm_dashboard_cs` |
| Script Type | `Client Script` |
| Script File | `/SuiteScripts/BankMatch/BM_Dashboard_CS.js` |
| Description | `Bank Match – Dashboard client script` |
| Notify Owner on Error | Yes |

**Deployments tab → click Add Deployment:**

| Field | Value |
|---|---|
| Title | `BM Dashboard CS` |
| Deployment ID | `customdeploy_bm_dashboard_cs` |
| Status | `Released` |
| Deployed | Yes |
| Log Level | `Debug` |
| Execute as Role | *(leave blank)* |
| All Roles | Yes |
| All Employees | No |
| All Partners | No |

Click **Save**.

---

### Script 7 — BM Proposal User Event

**Script tab:**

| Field | Value |
|---|---|
| Name | `BM Proposal User Event` |
| ID | `customscript_bm_proposal_ue` |
| Script Type | `User Event Script` |
| Script File | `/SuiteScripts/BankMatch/BM_Proposal_UE.js` |
| Description | `Bank Match – Executes reconciliation when a proposal is approved` |
| Notify Owner on Error | Yes |

**Deployments tab → click Add Deployment:**

| Field | Value |
|---|---|
| Title | `BM Proposal – Execute on Approval` |
| Deployment ID | `customdeploy_bm_proposal_ue` |
| Status | `Released` |
| Deployed | Yes |
| Log Level | `Debug` |
| Execute as Role | `Administrator` |
| Applies To (Record Type) | `BM Match Proposal` (the custom record you created) |
| Event Type | `After Submit (Edit only)` |
| All Roles | Yes |
| All Employees | No |
| All Partners | No |

Click **Save**.

---

## PHASE 5 — Initial Configuration

After all scripts are deployed:

1. Go to **Customization → Scripting → Scripts**
2. Find **BM Setup Suitelet** → click its deployment link to get the Suitelet URL
3. Open the URL — you will see the Bank Match settings page
4. Fill in:
   - **Bank Account** — your GL bank account
   - **Approver** — the employee who will approve matches
   - **Amount Tolerance** — default `0.01`
   - **Date Tolerance (days)** — default `5`
   - **Subsidiary** — optional, leave blank for all
5. Click **Save**

---

## Deployment Checklist

- [ ] Phase 1: All 11 JS files uploaded to `/SuiteScripts/BankMatch/`
- [ ] Phase 2: 3 Custom Lists created with correct values
- [ ] Phase 3: 3 Custom Record types created with all fields
- [ ] Phase 4: 7 Scripts created and deployed
- [ ] Phase 5: Settings configured via Setup Suitelet

---

## Verify It Works

1. Go to **Banking → Match Bank Data** — you should see an **Auto-Reconcile** button bar injected at the top of the page
2. Go to **Customization → Scripting → Scripts → BM Main Dashboard deployment URL** — the reconciliation approval dashboard should load
3. Check **Customization → Lists, Records & Fields → Record Types** — confirm all 3 custom records exist
