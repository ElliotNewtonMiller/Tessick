# Filming demo clips

The **Storefront** (SHOP) project, loaded into a running dev server, for the README's GIF and the website's clips. Each step below was run through in the app (2026-11-23).

## Setting up

1. Start the dev servers (`api-server` and `web`). Their database is in memory: a restart empties it.
2. Load the project:
   ```bash
   npx tsx apps/server/scripts/showcase/load-showcase.ts
   ```
   Its last lines are the commands for clip 3, with this load's plan id and CI token.
3. Open http://localhost:3000, sign in as `admin` / `password`, and choose **Storefront (SHOP)**.
4. Use a browser window of about 1440 × 900, with the bookmarks bar hidden and the developer tools closed.

**A fresh start for retakes:** restart the API server and run the loader again (about a minute).

## The clips, in recording order

### 1. Keyboard execution (the README's hero GIF, 10-15 s)

**Set up before recording:**
1. Click **Execute** and choose the run **2.4.0-rc.8**.
2. Click **+ Filter**, choose **Verdict**, and tick **UNTESTED**.

The queue now lists only the 12 manual cases nobody has run yet.

**Record:**
1. Press `j` to select the first one.
2. Press `p` a few times. Each pass records the case, which drops off the list, and opens the next one.
3. Press `f`. The cursor goes to Notes: type a short reason (e.g. "Delete button does nothing on Android") and press Ctrl+Enter.

The status bar confirms each verdict ("Recorded SHOP-8 → PASSED").

**Without the filter:**
- Clicking a suite in Execute mode shows only that suite's *own* cases, and `j`/`k` stay within them.
- A parent such as Accounts or Catalog has no cases of its own, so its queue is empty. Click a sub-suite (Sign-in, Profile, …) instead.

### 2. Reports (30-40 s)

**Reports** (top bar):
- **Overview:** the plan's pass rate and the activity chart. After clip 1, today has a purple "by people" bar.
- **Run:** rc.8 compared with rc.7:
  - "Cart is kept after signing out and in" is a new failure;
  - "Apply a discount code" is still failing;
  - "Filter by brand and size together" is fixed.
- **Test Health:**
  - "Pay with a saved card" is flaky;
  - "Search by product name" is getting slower.

  Click a case for its history.

### 3. CI results arriving (20-30 s)

Put a terminal beside the browser. Before recording, paste the `export` lines the loader printed, then `clear`.

**Record:** run this from the repo folder (`jq` keeps the output to two lines):
```bash
curl -s -X POST "$TESSICK/api/v1/plans/$PLAN_ID/results/junit?run_name=2.4.0-rc.9&ci_name=GitHub%20Actions" -H "Authorization: Bearer $TESSICK_TOKEN" --data-binary @apps/server/scripts/showcase/junit-rc9.xml | jq -c '.summary, .run'
```
It answers with 22 results recorded and a run "2.4.0-rc.9", created.

Click back into the browser. The run list refreshes when the window gets focus. Then:
- open the **Run** picker and choose **2.4.0-rc.9**;
- or open **Reports → Run**. Against rc.8:
  - the discount code is fixed;
  - the cart still fails;
  - "Sign in with Google" was skipped.

### 4. Importing from TestLink (30-45 s)

**Record:**
1. Click the **⋯** next to Project → **New project**: name **Mobile Banking**, prefix **BANK** → **Create Project**.
2. Click **📥 Import** and choose `apps/server/scripts/showcase/testlink-export.xml` (Format: Auto-detect) → **Preview Import**.
3. **Field Mapping:**
   - **Component** → **Create New**, Field Type **SINGLE_SELECT**;
   - **Regulatory requirement** → **Create New** (CHECKBOX is suggested).

   Then **Next**.
4. **Duplicates:** shows 7 suites and 13 cases to create → **Next** → **Run Import**.
5. **Results:** 13 cases imported, 2 fields created, 0 values skipped → **Close**.

Tessick switches to Spec mode on Mobile Banking:
- the tree, and BANK-101 to BANK-112;
- the two drafts are hollow;
- the obsolete case is hidden until "Show deprecated".

Open BANK-101 for its steps, its list of preconditions and its fields.

### 5. Writing a case (20-30 s)

As admin, a new case starts out approved; steps go in a draft from **Edit**.

1. In **Spec**, click the suite **Cart & Checkout / Discounts** → **+ Case**.
2. Type a title ("Two discount codes can't be combined") → **Create Case**.
3. **Edit**, which makes a v2 draft → **+ Add Step**. Type the action and the expected result.
4. Click **✓ Approve**, then **+ Add** in the list to put it in the plan.

**Quicker:** **⧉ Duplicate** an existing case. The copy is a draft with its steps; change them, then Approve.

### 6. Evidence (10-15 s)

Copy a screenshot to the clipboard first.

1. In **Execute**, on run **2.4.0-rc.8**, click the failed **SHOP-23** ("Cart is kept after signing out and in").
2. Press Ctrl+V: the screenshot appears under **Evidence (1)**.
3. Click it to open the viewer.

### 7. An AI agent writing test cases (30-45 s)

**Set up off camera:**
1. **Admin Panel → API Tokens:** project Storefront, interfaces **MCP only**, capabilities **SPEC_VIEW** and **SPEC_CREATE**. Copy the token.
2. In the folder where you'll run Claude Code, run:
   ```bash
   claude mcp add --transport http tessick http://localhost:3001/mcp --header "Authorization: Bearer <token>"
   ```

**Record:**
1. Ask Claude to "write test cases for paying with a gift card in Storefront's Payment suite".
2. Switch to the browser. The tree refreshes on focus.
3. Click **Payment**: the new cases are hollow (drafts).
4. Open one, then **✓ Approve**.

Turning **SPEC_APPROVE** on in the token form shows its amber warning, if you want that moment on camera.

### 8. The one-command install (optional, 15 s, sped up)

In an empty folder, run the two commands from the README's "Try it in a minute", then show the sign-in page.
