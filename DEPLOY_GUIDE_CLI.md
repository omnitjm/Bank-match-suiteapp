# Deployment Guide A — SuiteCloud CLI

Use this for your own development environment.
After this setup, deploying is a single command: `npm run deploy`.

---

## Prerequisites

- Node.js 18 or higher — download at https://nodejs.org
- Git
- A NetSuite account with **SuiteCloud Development Framework (SDF)** enabled

---

## Step 1 — Enable SDF in NetSuite

1. Setup → Company → Enable Features
2. Click the **SuiteCloud** tab
3. Check **SuiteCloud Development Framework**
4. Click **Save**

---

## Step 2 — Create a TBA Integration Record in NetSuite

Token-Based Authentication (TBA) is how the CLI authenticates to your account.

1. Setup → Integration → Manage Integrations → **New**
2. Fill in:
   - **Name:** `Bank Match CLI`
   - **State:** Enabled
3. Under **Authentication**, check **Token-Based Authentication**
4. Uncheck **Authorization Code Grant** (not needed)
5. Click **Save**
6. On the confirmation page, copy and **save these two values** — they are only shown once:
   - **Consumer Key**
   - **Consumer Secret**

---

## Step 3 — Create an Access Token in NetSuite

1. Setup → Users/Roles → Access Tokens → **New**
2. Fill in:
   - **Application Name:** `Bank Match CLI` (the integration you just created)
   - **User:** your own user account
   - **Role:** `Administrator`
3. Click **Save**
4. Copy and **save these two values** — shown once only:
   - **Token ID**
   - **Token Secret**

You now have 4 values total. Keep them somewhere safe:

| Value | Where you got it |
|---|---|
| Consumer Key | Integration record |
| Consumer Secret | Integration record |
| Token ID | Access Token record |
| Token Secret | Access Token record |

---

## Step 4 — Find Your Account ID

Setup → Company → Company Information → look for **Account ID** at the top of the page.

It looks like: `1234567` or `1234567_SB1` (sandbox).

---

## Step 5 — Install Dependencies

In your terminal, navigate to the project folder and run:

```bash
npm install
```

---

## Step 6 — Authenticate the CLI

```bash
npm run setup
```

This runs the interactive wizard. Answer each prompt:

| Prompt | What to enter |
|---|---|
| Authentication type | `Token-based authentication (TBA)` |
| Account ID | Your Account ID from Step 4 |
| Token ID | From Step 3 |
| Token Secret | From Step 3 |
| Consumer Key | From Step 2 |
| Consumer Secret | From Step 2 |

The credentials are saved locally under the alias `bank-match-auth`.
You only need to run this once per machine.

---

## Step 7 — Validate (optional dry-run)

Before deploying, you can validate the project without making any changes:

```bash
npm run validate
```

If this returns errors, fix them before deploying.

---

## Step 8 — Deploy

```bash
npm run deploy
```

The CLI will show a preview of what will be deployed and ask for confirmation.
Type `YES` and press Enter.

The CLI deploys in order:
1. Custom transaction body field (`custbody_bank_transaction_id`)
2. Custom lists (3)
3. Custom records (3, with all fields)
4. All script files to File Cabinet
5. All scripts and deployments (7 scripts)

---

## Step 9 — Configure the Reconciliation Rule (one-time, in NetSuite UI)

The CLI cannot create Reconciliation Rules — do this manually:

1. Banking → Reconciliation Rules → **New**
2. **Name:** `Bank Match – Auto Reconcile`
3. **Bank Account:** select your GL bank account
4. Add matching condition 1: **Amount** equals Bank Line Amount
5. Add matching condition 2: **Bank Transaction ID** equals Bank Line Transaction ID
6. Status: **Active**
7. Click **Save**

---

## Step 10 — Configure Bank Match Settings

1. Customization → Scripting → Scripts → find **BM Setup Suitelet** → open deployment URL
2. Fill in:
   - **Bank Account** — your GL bank account
   - **Approver** — the employee who approves matches
   - **Amount Tolerance** — default `0.01`
   - **Date Tolerance (days)** — default `5`
3. Click **Save**

---

## Future Deployments

Every time you make changes to the code:

```bash
npm run deploy
```

That's it.

---

## Troubleshooting

**`suitecloud: command not found`**
Run `npm install` first. Then use `npx suitecloud` instead, or ensure `./node_modules/.bin` is in your PATH.

**`Invalid login attempt` / `AUTH_FAILED`**
Re-run `npm run setup` with the correct credentials. Verify the integration and token are both active in NetSuite.

**`SDF is not enabled`**
Go back to Step 1 and make sure SuiteCloud Development Framework is checked.

**Deployment succeeds but scripts don't appear in NetSuite**
Go to Setup → Company → Enable Features → save again to clear the script cache.
