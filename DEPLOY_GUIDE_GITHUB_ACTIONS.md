# Deployment Guide B — GitHub Actions (CI/CD)

Use this when onboarding customers. Each customer gets their own GitHub
environment with their own NetSuite credentials. Deploying is as simple
as pushing a commit — no CLI needed on any machine.

---

## How It Works

```
You push code to main
        ↓
GitHub Actions runs automatically
        ↓
SuiteCloud CLI deploys to the customer's NetSuite account
        ↓
Done
```

For manual deploys (e.g. to a sandbox before going live):
GitHub → Actions → Deploy to NetSuite → Run workflow → choose environment.

---

## What You Need Per Customer

- Their NetSuite **Account ID**
- A **TBA Integration** created in their NetSuite account (you create this)
- An **Access Token** in their NetSuite account (you create this)

---

## Step 1 — Add the Customer's Repo (or environment)

You have two options depending on how you structure this:

**Option 1: One repo, multiple GitHub Environments**
Use this if all customers run the same code version.

**Option 2: One repo fork per customer**
Use this if customers may have different configurations.

Either way, the secrets setup below is the same — just done per Environment or per repo.

---

## Step 2 — Enable SDF in Customer's NetSuite

Log into the customer's NetSuite account:

1. Setup → Company → Enable Features
2. Click the **SuiteCloud** tab
3. Check **SuiteCloud Development Framework**
4. Click **Save**

---

## Step 3 — Create a TBA Integration in Customer's NetSuite

1. Setup → Integration → Manage Integrations → **New**
2. Fill in:
   - **Name:** `Bank Match Deploy`
   - **State:** Enabled
3. Under **Authentication**, check **Token-Based Authentication**
4. Uncheck **Authorization Code Grant**
5. Click **Save**
6. **Copy immediately — shown only once:**
   - **Consumer Key**
   - **Consumer Secret**

---

## Step 4 — Create an Access Token in Customer's NetSuite

1. Setup → Users/Roles → Access Tokens → **New**
2. Fill in:
   - **Application Name:** `Bank Match Deploy`
   - **User:** an admin user
   - **Role:** `Administrator`
3. Click **Save**
4. **Copy immediately — shown only once:**
   - **Token ID**
   - **Token Secret**

---

## Step 5 — Find the Customer's Account ID

Setup → Company → Company Information → **Account ID** at the top.

Examples: `1234567` (production), `1234567_SB1` (sandbox).

---

## Step 6 — Add Secrets to GitHub

Go to the GitHub repository → **Settings** → **Secrets and variables** → **Actions**.

If using GitHub Environments (recommended for multiple customers):

1. Click **Manage environments**
2. Click **New environment** → name it after the customer (e.g. `acme-production`)
3. Click **Add secret** for each of the 5 values below

If using a single environment or repo secrets, click **New repository secret** for each.

| Secret Name | Value |
|---|---|
| `NS_ACCOUNT_ID` | Account ID from Step 5 |
| `NS_TOKEN_ID` | Token ID from Step 4 |
| `NS_TOKEN_SECRET` | Token Secret from Step 4 |
| `NS_CONSUMER_KEY` | Consumer Key from Step 3 |
| `NS_CONSUMER_SECRET` | Consumer Secret from Step 3 |

---

## Step 7 — Verify the Workflow File

The file `.github/workflows/deploy.yml` is already in the repo.
Open it and confirm the `environment:` line matches the environment name you created:

```yaml
environment: ${{ github.event_name == 'workflow_dispatch' && inputs.environment || 'production' }}
```

If your environment is named something other than `production` or `sandbox`,
update the workflow or use `workflow_dispatch` with a custom input.

---

## Step 8 — Deploy

**Automatic (push to main):**
```bash
git push origin main
```
GitHub Actions starts automatically. Watch the progress:
GitHub → Actions → **Deploy to NetSuite** → click the running workflow.

**Manual (e.g. deploy to sandbox first):**
1. GitHub → Actions → **Deploy to NetSuite**
2. Click **Run workflow**
3. Choose `sandbox` or `production`
4. Click **Run workflow**

A successful run looks like:
```
✓ Set up Node.js
✓ Install dependencies
✓ Write SuiteCloud credentials
✓ Validate project
✓ Deploy to NetSuite
```

---

## Step 9 — Configure the Reconciliation Rule (in the Customer's NetSuite)

The CI/CD pipeline cannot create Reconciliation Rules. Do this once per customer:

1. Banking → Reconciliation Rules → **New**
2. **Name:** `Bank Match – Auto Reconcile`
3. **Bank Account:** customer's GL bank account
4. Add matching condition 1: **Amount** equals Bank Line Amount
5. Add matching condition 2: **Bank Transaction ID** equals Bank Line Transaction ID
6. Status: **Active**
7. Click **Save**

---

## Step 10 — Configure Bank Match Settings (in the Customer's NetSuite)

1. Customization → Scripting → Scripts → find **BM Setup Suitelet** → open deployment URL
2. Fill in:
   - **Bank Account** — customer's GL bank account
   - **Approver** — the employee who approves matches
   - **Amount Tolerance** — default `0.01`
   - **Date Tolerance (days)** — default `5`
3. Click **Save**

---

## Managing Multiple Customers

| Customer | How to handle |
|---|---|
| All on same version | One repo, one environment per customer, each with their own 5 secrets |
| On different versions | Fork the repo per customer, push updates to each fork as needed |
| Needs sandbox testing | Add a `<customer>-sandbox` environment with sandbox Account ID (`_SB1`) |

**Recommended structure for multiple customers:**

```
Environments in one repo:
  acme-production    → NS_ACCOUNT_ID = 111111
  acme-sandbox       → NS_ACCOUNT_ID = 111111_SB1
  globex-production  → NS_ACCOUNT_ID = 222222
  globex-sandbox     → NS_ACCOUNT_ID = 222222_SB1
```

Each environment has its own 5 secrets. Deploy to a specific customer:
GitHub → Actions → Run workflow → choose environment.

---

## Troubleshooting

**Workflow doesn't start on push**
Check that the branch in the push matches `main` in the workflow trigger:
```yaml
on:
  push:
    branches: [main]
```

**`AUTH_FAILED` in the deploy step**
One or more of the 5 secrets is wrong. Double-check by re-running the setup.
Most common issue: secrets copied with a leading or trailing space.

**`SDF is not enabled` error**
Go back to Step 2 in the customer's NetSuite account.

**Deploy succeeds but nothing changed in NetSuite**
Go to Setup → Company → Enable Features → Save to flush the script cache.

**Secrets are visible in logs**
They won't be — GitHub masks all secret values in workflow logs automatically.
