# Manual test backlog

Checks Elliot plans to do himself in the web app, kept here so they can be caught up on later (decided with Elliot, 2026-11-09: for the sake of progress, the agent verifies each change itself and records Elliot's checklist here rather than waiting for it).

Each entry says what the agent already checked, and how, so it's clear what a person's run adds: a real clipboard, file picker and drag from the desktop, other browsers, and how it looks and feels. Tick an item off (or delete it) once done; note anything that misbehaved in `docs/changelog.md` and fix it.

API and MCP changes aren't listed: the agent tests those itself.

Tasks for Elliot that aren't tests (decisions, paperwork) are in **Elliot's other tasks** at the end.

## Evidence in the web app (2026-11-09)

Commits `cc48c79` (the Execute pane's Evidence section, the viewer, the Reports chip) and the audit log grouping after it. Sign in as `admin` / `password`, with a plan that has a run.

- [ ] **Before a result:** in Execute, the Evidence section says to record a result first, and **+ Add files** is disabled. Press **Fail**: it becomes enabled.
- [ ] **Paste a real screenshot:** take one with the OS screenshot tool and press Ctrl+V (with the notes box focused, and without). It appears as `screenshot-<time>.png`. A text paste into the notes still pastes text.
- [ ] **The file picker:** **+ Add files**, choose several files at once.
- [ ] **Drag from the file manager:** drop a video (MP4 or WebM) and a `.log` on the pane. The pane is outlined while dragging, and each upload shows its progress (a large video shows it best).
- [ ] **The viewer:** open the video and seek in it; → to the next file, ← back; Esc closes it, and so does a click outside. Press `p` while it's open: no verdict is recorded.
- [ ] **A long log:** it shows the first 1 MB, scrolling inside the viewer with the header still visible, and a note to download the rest. **Download** saves the whole file with its name.
- [ ] **Deleting:** × on a file shows the amber warning, then **Delete Anyway** removes it.
- [ ] **After Close Run:** you can still add files to a case you recorded (for 24 hours). A case with no result says the run is closed. Sign in as `tester` (`DevTest123!`): on a case the admin recorded, adding is disabled with the reason, and the × doesn't show.
- [ ] **Reports → Run:** a failed case with files shows 📎 and a count; click it to open the viewer.
- [ ] **Refused files:** try a PDF, and an `.exe` renamed to `.png`. Each is refused with a message naming the file.
- [ ] **Other browsers:** Firefox and Safari (or a phone): thumbnails, video playback and seeking, paste.
- [ ] **Admin Panel → Security Audit Log:** after a CI-style upload of several files (or several of your own within the hour), the additions show as one `EVIDENCE_ADDED ×n` line with their time span, kinds, size and first names. **×n ▸** lists each one; a single addition shows as its own line; deletions show one by one.

**Already checked by the agent** (live at `127.0.0.1:3000`, a separate tab, and in the smoke test):
- every item above with page events, not the real desktop: a paste event carrying a canvas PNG; one drop carrying a 4-second WebM recorded with MediaRecorder and a 1.7 MB log; a drop carrying a PDF and a disguised executable;
- video playback and seeking, the log viewer's layout (a bug found and fixed), Esc and ← →, `p` ignored while open, the two-step delete, the closed run's answers, the Reports chip, and the audit log's grouped line and its expansion.

**Not checked by the agent:** the real clipboard, file picker and desktop drag; browsers other than Chromium; how it looks at other window sizes.

## Longer toasts; the Security Audit Log's width (2026-11-15)

- [ ] **Toasts:** any message at the bottom right (e.g. drop a PDF on the Execute pane) stays about 6 seconds, long enough to read.
- [ ] **The Security Audit Log** has no horizontal scroll bar. Dates sit above times, long action names wrap after an underscore, and ids wrap onto two lines; a click on an id still selects all of it.

**Already checked by the agent** (live at `127.0.0.1:3000`, measured in the page): the table's scroll width equalled its width, with and without an expanded group of evidence additions; a toast was showing at 4.5 seconds and gone at 7.

**Not checked by the agent:** how the wrapped columns look to the eye (the browser pane was hidden, so no screenshot); a window narrower than about 890 px, where the whole Admin Panel is wider than the window.

## Duplicate a test case (2026-11-15)

- [ ] In Spec mode, select an approved case with steps and a custom field, and press **⧉ Duplicate**. The copy is selected, marked **v1 DRAFT**, titled "… (copy)", and its title is ready to type over.
- [ ] Type a new name and press Enter; edit a step; **✓ Approve**. The original case is unchanged.
- [ ] The copy has the original's priority, execution type, summary, preconditions, steps and custom fields, and isn't in any plan until you add it.
- [ ] Duplicate a case whose latest version is a draft: the copy has the draft's content.
- [ ] As `viewer` (`DevTest123!`), there's no Duplicate button.

**Already checked by the agent** (live at `127.0.0.1:3000`, a separate tab, with real clicks and typing): Duplicate on an approved case selected a DRAFT copy with its title focused and selected; typing a name and Enter saved it; Approve approved it; the copy kept its step and custom field. Through the API and MCP: plain copies, copies with changes, and the refusals.

**Not checked by the agent:** editing a copy's steps in the UI, and how the new button looks beside Edit and Delete (no screenshot; the browser pane was hidden).

## JUnit import: file-path classnames become folders (2026-11-16)

Import a Playwright (or Vitest) JUnit report, e.g. the `results.xml` from 2026-10-22, through **Import** in Spec mode.

- [ ] The dry run's tree shows the spec files' folders as nested suites, with one suite per spec file named without `.spec.ts`, and no `spec` › `ts` levels.
- [ ] Importing creates the same tree. A Java-style report (dotted classnames like `com.acme.LoginTest`) still nests by its dots.

**Already checked by the agent** (2026-10-22, in-process through the API, with the real 47-test report): 62 suites instead of 188 for both the dry run and the import, and uploading the same file as results recorded all 47 onto 47 distinct cases. The parser and server tests cover the same cases.

**Not checked by the agent:** the Import dialog itself with this file (its preview tree comes from the same dry run).

## The one-command demo (2026-11-16)

Once CI has published the image and the package is public (see Elliot's other tasks), on a machine without the repo (CI checks the arm64 image for Apple Silicon Macs; see below):

- [ ] In an empty folder, run the two commands from the README's "Try it in a minute". Note how long it takes until the sign-in page loads.
- [ ] The sign-in page shows the amber "Demo instance" note, with `admin` and `tessick-demo-admin` already filled in; Log In works.
- [ ] Report Demo is selected, with Release Regression and Run 1.0.8. Reports shows the trends and Test Health its flaky and failing cases.
- [ ] `docker compose -f docker-compose.demo.yml logs tessick` shows the demo block with the `claude mcp add` command; running it connects Claude Code, and it can list the project's runs.
- [ ] `docker compose -f docker-compose.demo.yml down -v`, then `up` again: a fresh demo, with a new token.
- [ ] From another machine on the network, http://<this machine>:3001 doesn't answer.

**Already checked by the agent** (on the dev server in demo mode, at `127.0.0.1:3000` in a separate tab): the note and the filled-in fields, signing in with them, the Overview report (88 results, the activity chart), and recording a Pass with `p` on DEMO-12 in Execute. The startup log's demo block, and `scripts/report-demo.ts` against the same server. CI starts the demo compose file from the image it builds and checks its sign-in and project.

**Also checked by the agent (2026-11-17), with the published image on Linux (amd64):**
- In an empty folder with no GHCR sign-in, I downloaded the compose file with the README's `curl` and ran `up -d`. The image pulled was the one CI published (`sha256:609f4a3e…`), and the server answered after 17 seconds, including that download (`postgres:17-alpine` was already on the machine).
- `/instance` gave the demo sign-in, the API login worked, and the log showed the demo block with Report Demo (12 cases, 8 runs).
- In a separate browser tab at `127.0.0.1:3001`, the sign-in page showed the note with the fields filled in, and Log In opened Report Demo with Release Regression and Run 1.0.8.
- `down -v` removed the containers, volumes and network.

**Not checked by the agent:** a first start with no images already on the machine, and the `claude mcp add` command from the log.

**The arm64 image (2026-11-18):** no Mac is needed. Docker on an Apple Silicon Mac runs the image's linux/arm64 build, and CI now starts that published build's demo on GitHub's arm64 runner after every publish ("The published image runs on arm64"), with the same checks as the amd64 demo.

## Moving from TestLink: the guide, and two TestLink export shapes (2026-11-17)

Read `docs/migrating_from_testlink.md` as a TestLink admin would. If you have a TestLink (or can start one), follow it with a real export:

- [ ] TestLink's buttons are as the guide names them (Test Specification → the project → **Export All Test Suites**, XML, keywords and custom fields).
- [ ] Importing that file with **📥 Import** gives the same suite tree as TestLink, with no extra top-level suite, and ids `PREFIX-n` matching TestLink's.
- [ ] Exporting a single test case from TestLink and importing it puts the case in **Imported cases**.
- [ ] Optional: the database migration's `--dry-run` against a copy of a real TestLink database (MySQL needs `mysql2`).

**Already checked by the agent:**
- **In the browser:** a hand-made export of a whole project (a nameless outer `<testsuite>`, nested suites, HTML steps, `&nbsp;`/`&mdash;`, a custom field, two keywords), on the dev server at `127.0.0.1:3000` in a separate tab. I followed the guide: created the project Shop with prefix TL, then Import, Preview Import, Create New for Component, Duplicates, and Run Import.
  - 3 suites at the top (Checkout › Cards, Search) and no "Unnamed Suite".
  - TL-331: HIGH, MANUAL, approved, plain-text steps, the Component value, and both keywords.
- **With the guide's `curl` commands and a project API token:**
  - the same file again gave 3 new versions and no copies;
  - a `<testcases>` file of two cases went into "Imported cases", with a warning each, and the tree showed it.
- **The migration section's `docker-compose.override.yml`:** `docker compose config` shows the database port published on `127.0.0.1:5432`.

**Not checked by the agent:** a real TestLink's export (the files were written by hand from TestLink 1.9's format), and the database migration against a real TestLink.

**Then checked by the agent with a real export (2026-11-18):** Elliot's export of a whole project (724 cases, 178 suites), through the API on the dev server, then looked at in a separate tab at `127.0.0.1:3000`. That found and fixed three problems, below.
- **What the import gave:**
  - the 5 real top-level suites;
  - all 724 TestLink ids as `CT-n`, none missing and none extra;
  - 6 custom fields created, with no values skipped;
  - a second import added a version to each case and created none.
- **CT-1851 (a table) and CT-1818 (a list),** in Spec and in Execute (a plan and a run made for it): the table read as rows of cells and the list as `- ` lines, with the line breaks shown, and the Jira Key, Sprint, Type and Automation Status values were there.

**For Elliot, after that:**
- [ ] Open a few approved cases with lists, tables or numbered steps: the read-only Spec pane and the Execute pane show their line breaks.
- [ ] A draft case's text boxes look as before.

**TestLink's status is kept (2026-11-18):** import a TestLink export with drafts and final cases.
- [ ] TestLink's drafts show as DRAFT, with ✓ Approve, and can't be added to a plan until approved. Final cases are APPROVED.
- [ ] Obsolete or inactive TestLink cases are hidden until **Show deprecated** is on.

**Already checked by the agent:** with your real export, 619 drafts and 105 approved, each matching its `<status>` in the file. In the browser, CT-1413 shows v1 DRAFT with Approve and its "+ Add" greyed out. Bulk approve over the API approved two of them.

## MCP can approve; the token form warns (2026-11-18)

In Admin Panel → API Tokens → New Token:
- [ ] Turn SPEC_APPROVE on: the amber warning appears under the capabilities. With "REST API only" it goes away; with "MCP only" or "REST API and MCP" it's there. Turning SPEC_APPROVE off removes it.
- [ ] Create an MCP-only token with SPEC_VIEW, SPEC_CREATE and SPEC_APPROVE, connect Claude Code with it, and ask it to write a case and then approve it. Without being asked, it shouldn't approve.

**Already checked by the agent:** the warning in each of those states. A token made from the form: over `/mcp` it was offered `approve_cases`, made TL-351 as a draft and approved it, and got 403 on the REST API. The audit rows mark the approval as made through MCP. Not checked: a real agent deciding when to approve.

## The logo in the app (2026-11-18)

- [ ] The sign-in page: the mark above the wordmark, both sharp (on a high-DPI screen too).
- [ ] Signed in, the top bar starts with the mark and the wordmark, before Spec / Execute / Reports, and nothing wraps that didn't before.
- [ ] The browser tab shows the mark as its icon (Chrome, Firefox; a hard reload may be needed). Small, it's the T and the check: say if it needs a simpler favicon.
- [ ] The loading screen ("Initializing Tessick...", for a moment after a reload) shows the mark.

**Already checked by the agent** (dev server, `127.0.0.1:3000` in a separate tab): the sign-in page and the top bar (the logo takes 119 px against about 105 px for the old "⚡ TESSICK", so both parts stay), the favicon address answering `image/svg+xml`, and the production build hashing both files and rewriting the favicon link.

## The filming project; case order; checkbox imports (2026-11-20)

- [ ] The Storefront's cases are listed SHOP-1, SHOP-2 ... SHOP-10 (number order), in Spec and Execute.
- [ ] In the Import wizard, the sample `testlink-export.xml` into a new project with the prefix BANK: Field Mapping suggests a checkbox for "Regulatory requirement"; after Run Import, BANK-101 shows it ticked and Component "Onboarding".

**Already checked by the agent:** the load, and Storefront in Spec, Execute and Reports (`127.0.0.1:3000`, a separate tab); both fixes by tests and over the API (the spec tree's order, the TestLink file's 26 field values).

## The SVG wordmarks; the full logo in the README (2026-11-20)

- [ ] On GitHub (once pushed), the README's heading shows the full logo: black letters on the light theme, white on the dark theme (switch it in GitHub's appearance settings).
- [ ] The header and sign-in page's wordmark is sharp at any zoom.

**Already checked by the agent:** the header and sign-in page at `127.0.0.1:3000` (a separate tab); both full logos drawn by Chrome, on dark and light, and by Inkscape; the cleaned wordmarks drawn the same as your files; the production build.

## Demo clips: new runs on focus, imports end in Spec (2026-11-23)

- [ ] With the app open, upload a JUnit file with a new `run_name` from a terminal, then click back into the browser: the run is in the Run picker without a reload, and the run you had chosen stays chosen.
- [ ] Import a file into a new project while in Execute mode: after Run Import, the app is in Spec mode on that project.
- [ ] Import into one project, close the wizard, switch projects and open it again: it shows the current project.

**Already checked by the agent:** all three live in its own tab at `127.0.0.1:3000` (focus events dispatched in the page), plus every clip in `apps/server/scripts/showcase/README.md`; the first by a new smoke test.

## A deleted project no longer haunts the pickers (2026-11-23)

- [ ] Delete a project while the Admin Panel's API Tokens tab has it chosen, then reopen the tab: it shows another project, and Create Token works.
- [ ] Sign out and in as another user: the project picker never shows the first user's projects, even briefly.

**Already checked by the agent:** the first, live in its own tab (with a sign-out and sign-in in the same page); the server's 404s by `missing_project.test.ts`.

## The README's GIF and screenshots; the social preview (2026-11-23)

- [ ] After the next push, open the repo on GitHub: the GIF plays under the first line, and the two screenshots sit side by side under the feature list, in light and dark themes.
- [ ] Upload `branding/tessick-social-preview-logo.png` in the repo's **Settings → General → Social preview**, then check a shared link shows it.

**Already checked by the agent:** the GIF (from `clip1_processed.mp4`: 960 × 545, 15 fps, 3.8 MB, under GitHub's 10 MB limit) by looking at frames from it; that every image path in the README exists; that `git` ignores the `.xcf`. Not checked: how GitHub draws the README, until it's pushed.

## A user guide to the web app (2026-11-23)

- [ ] Read `docs/user_guide.md` on GitHub after the next push: its three images show, and its section links and links to the other docs work.
- [ ] Skim it for anything that reads differently from how you use the app, or that you'd rather not promise (the role table in section 9, the evidence limits).

**Already checked by the agent:** each statement against the source and the server's rules, and live in its own tab (Spec panes, Fail with notes and Ctrl+Enter, a run auto-closing, a pasted screenshot and the viewer, the Admin Panel tabs, My Account, three reports). Not checked: how GitHub draws it, until it's pushed.

## The `[` and `]` hotkeys (2026-11-23)

- [ ] In Spec and in Execute mode, press `[`: every suite folds up to the top level, and the button under the search box says **Expand all**. Press `]`: they all open again. Typing `[` in the search box or notes types it, and doesn't fold the tree.

**Already checked by the agent:** the folding and the button's label in both modes, live in its own tab; the helper by a unit test.

## Importing TestLink test plans (2026-11-24)

- [ ] Import your project's test cases (TestLink XML) into a project with TestLink's prefix, then a plan's `linkedItems_<plan>.xml` with **📥 Import** on Auto-detect: the wizard says it's a TestLink test plan and lists its cases in TestLink's order, with what happens to each.
- [ ] **Create Test Plan** without approving: only the approved cases are in the new plan, and Tessick selects it. Import the file again, choose **Add to the existing plan** and tick **Approve the N draft cases**: they're approved and added after the others.
- [ ] Confirm where TestLink 1.9 exports a plan: the docs say **Test Plan Management → the plan's export icon**. Tell the agent if it's somewhere else.
- [ ] As a user without Approve permission, the tick box isn't offered; the drafts are listed as skipped.

**Already checked by the agent:** with your real exports, in its own tab: Auto-detect switched to the plan; 79 cases, 20 ready, 59 drafts and 12 renamed since the spec export, each shown with both titles; the first import added 20, the second approved and added the 59 with the 20 left alone; Spec mode showed 79 in the plan. The rules (states, order, platforms, permissions, locked plans, refusing a spec file, the case import refusing a plan file) by server tests. Not checked: a TestLink plan with platforms from a real TestLink (only a written one).

## The plan's total above the suite tree (2026-11-25)

- [ ] In Spec mode, choose a plan: next to **SUITE TREE** it says how many of the project's cases are in the plan (`79/725 in plan`), the sum of the top-level suites' counts. Add or remove a case: the total follows. In Execute mode, or with no plan chosen, it isn't shown.

**Already checked by the agent:** in its own tab, with your Training project: "Regression - Admin" showed 20/725, "Regression - Admin back to 79" 79/725 (76 in Portal/Console/LMS Admin, 2 in Flutter, 1 in Bugs/Misc); not shown in Execute mode.

## Suite counts: own cases, then the whole suite (2026-11-25)

- [ ] In Spec mode with a plan, a suite holding cases itself and in its sub-suites shows both (`1/1 · 7/33`); a suite with none of its own shows `— · 2/30`; a suite without sub-suites with cases shows one count. Hovering a count says it in words. Click a suite: the case list's "x/y in plan" matches the first count, and the details pane says "N cases here, M with sub-suites".
- [ ] In a project with no plans, the rows count cases only (`2 · 6`).
- [ ] In Execute mode, parent suites show progress (`— · 3/9 P`). Pass a case in a sub-suite: the count moves in its suite and every suite above it, and a suite turns green once everything in it has passed.
- [ ] With the tree pane at its default width, the longer counts on parent suites hide more of their names. Say if that's too much.

**Already checked by the agent:** in its own tab, with your Training project's "Regression - Admin back to 79": Portal/Console/LMS Admin `— · 76/196`, End-to-End `1/1 · 7/33` (its own case matched the case list's "1/1 in plan" and the details pane), Reports `1/1 · 12/24`. In a scratch project (deleted afterwards): case counts only without a plan, then Execute mode with passes moving up the tree and a finished suite turning green. The rules by unit tests (`suiteTree.test.ts`).

## A result recorded during a queue refresh stays on screen (2026-11-25)

- [ ] In Execute mode, click away from the window and back, and press `p` at once: the case shows P and keeps it. Before, it could go back to U until the next refresh, although the result was saved.

**Already checked by the agent:** in its own tab, with the queue's refresh slowed down in the page: before the fix the pass went back to U when the refresh answered; after it, the P stayed, and a result CI recorded meanwhile for another case still showed. The rules by unit tests (`unsettledVerdicts.test.ts`).

## Elliot's other tasks

### Launch (2026-11-18)

In this order, so the GIFs, videos and website all show the final logo:
- [x] **Replace the logo.** Done: your mark and wordmark are in `branding/` and in the app (header, sign-in page, loading screen, browser-tab icon). Check them in the app (below). Your white and black SVG wordmarks replaced the WebP (2026-11-20), and `branding/tessick-logo-white.svg` / `-black.svg` are the full logo for the website and social preview.
- [x] **README images:** done (2026-11-23): the keyboard GIF under the first line, and the Reports and case-editor screenshots.
- [x] **Demo videos:** done (2026-11-23), eight clips in `~/Videos/Tessick`; the website has them.
- [ ] **The website** (2026-11-23), at **tessick.com**. It's built and committed in its own local repo, `~/Documents/Code/tessick-site` (its `README.md` has the details); nothing is on GitHub yet. Your steps:
  - [x] **The commercial-license email:** TessickTesting@gmail.com (2026-11-24), on the home page, `/testlink/` and Tessick's README.
  - [x] **The domain:** tessick.com (2026-11-24); the site's addresses, sitemap and 404 page use it.
  - [ ] **Verify the domain in GitHub:** github.com → your picture → **Settings → Pages → Add a domain**, type `tessick.com`, and add the `TXT` record it shows at your registrar; then click **Verify**. This stops anyone else's repository from claiming tessick.com.
  - [ ] **Say "publish"**: the agent creates the public repo `ElliotNewtonMiller/tessick-site`, pushes it, turns on GitHub Pages with the domain, and pushes Tessick's README link to the site.
  - [ ] **Set the domain's DNS records** at your registrar (they're in the site's `README.md` under Publishing): four `A` and four `AAAA` records for `tessick.com`, and a `CNAME` for `www`. Remove any parking or forwarding records the registrar put there. Then wait for GitHub to issue the certificate (minutes to a day), and tick **Enforce HTTPS** in the site repo's **Settings → Pages** (or ask the agent).
  - [ ] **Look over the copy** on all three pages: it's checked against the docs, but the voice should be yours.
- [ ] **With the website, on the GitHub repository** (its ⚙ next to About):
  - [ ] the website link (the agent can set it with `gh` once the site is live);
  - [ ] topics, e.g. `testlink`, `test-management`, `test-case-management`, `qa`, `self-hosted`, `mcp` (none set yet);
  - [ ] the social preview image: upload `branding/tessick-social-preview-logo.png` in **Settings → General → Social preview**;
  - [x] the description: done ("Self-hosted, open-source test case management: a modern replacement for TestLink").
- [ ] **Getting it in front of TestLink users**, once the site is live (the checklist is in the site's `README.md`): list Tessick on AlternativeTo as an alternative to TestLink and TestRail; post on Show HN, r/QualityAssurance, r/softwaretesting, r/selfhosted and Ministry of Testing's forum, each saying it's yours; awesome-selfhosted once Tessick meets its rule on release age; an article such as "Moving off TestLink" linking to the site's `/testlink/` page; and submit the sitemap to Google Search Console and Bing Webmaster Tools.
- [ ] **Optional:** the README's first line calls Tessick "faster" than TestLink. Keep it if you can show it (in the GIF, say), or drop the word.

**Already done by the agent:** the README now has the TestLink pitch under its first line and its sections in the order a visitor needs them (demo, real install, API, development), and says contributions aren't accepted. Releases are versioned: `v1.0.0` is a git tag and GitHub release, and a version tag publishes the image as `1.0.0`, `1.0` and `1`.

### Before selling a commercial license (2026-11-16)

Tessick is dual-licensed since `4e94dc3`: AGPL-3.0-only, or a commercial license from Elliot. Selling the commercial one needs these first; a lawyer should look at each.

- [ ] **Commercial license terms:** what a buyer may do (use, change, host, resell), for how long, on how many installations, and at what price. Nothing like this exists yet; the README only says to ask.
- **Contributions:** not accepted for now (decided 2026-11-18); the README says so, and asks for bug reports and ideas as issues. A contributor license agreement is needed only if that changes, before merging anyone else's code.
- [ ] **Rights to AI-generated code:** most of Tessick was written with Claude's help, and whether such code can be owned and licensed (by country) is unsettled. Ask how that affects a commercial license and what a buyer should be told.

**Already done by the agent:** checked that every commit is yours and that no one else has contributed; checked that every production dependency has a permissive license; switched `LICENSE`, the `package.json` files and the README; and added the rule that new dependencies must be permissive (CLAUDE.md, "Decisions to keep").

### Make the Docker image public (2026-11-16)

- [ ] After the first push to `main` with the publish job, CI publishes `ghcr.io/elliotnewtonmiller/tessick`. GitHub makes a new package private, so the demo can't download it until you change that: on GitHub, your profile → **Packages** → **tessick** → **Package settings** → **Change visibility** → **Public**. While you're there, check that it's linked to the Tessick repository.

**Already checked by the agent (2026-11-17):** the first publish (CI run 44021341974, commit `465b387`) pushed `latest` and `sha-465b387` for amd64 and arm64. Without signing in, the registry already serves the image's manifest, so it looks public already: it probably took the visibility of the public repository it's linked to. Confirm it on the package's settings page, and tick this box.

