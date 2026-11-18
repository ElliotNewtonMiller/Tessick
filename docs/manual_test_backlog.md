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

Once CI has published the image and the package is public (see Elliot's other tasks), on a machine without the repo (a Mac with Apple Silicon if you can, to check the arm64 image):

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

**Not checked by the agent:** the arm64 image on a real Apple Silicon Mac, a first start with no images already on the machine, and the `claude mcp add` command from the log.

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

## Elliot's other tasks

### Before selling a commercial license (2026-11-16)

Tessick is dual-licensed since `4e94dc3`: AGPL-3.0-only, or a commercial license from Elliot. Selling the commercial one needs these first; a lawyer should look at each.

- [ ] **Commercial license terms:** what a buyer may do (use, change, host, resell), for how long, on how many installations, and at what price. Nothing like this exists yet; the README only says to ask.
- [ ] **A contributor license agreement (CLA):** needed before merging anyone else's code, so you keep the right to sell it commercially. Also decide how contributors sign it (for example a CLA bot on pull requests). Until then, the README asks contributors to open an issue first.
- [ ] **Rights to AI-generated code:** most of Tessick was written with Claude's help, and whether such code can be owned and licensed (by country) is unsettled. Ask how that affects a commercial license and what a buyer should be told.

**Already done by the agent:** checked that every commit is yours and that no one else has contributed; checked that every production dependency has a permissive license; switched `LICENSE`, the `package.json` files and the README; and added the rule that new dependencies must be permissive (CLAUDE.md, "Decisions to keep").

### Make the Docker image public (2026-11-16)

- [ ] After the first push to `main` with the publish job, CI publishes `ghcr.io/elliotnewtonmiller/tessick`. GitHub makes a new package private, so the demo can't download it until you change that: on GitHub, your profile → **Packages** → **tessick** → **Package settings** → **Change visibility** → **Public**. While you're there, check that it's linked to the Tessick repository.

**Already checked by the agent (2026-11-17):** the first publish (CI run 44021341974, commit `465b387`) pushed `latest` and `sha-465b387` for amd64 and arm64. Without signing in, the registry already serves the image's manifest, so it looks public already: it probably took the visibility of the public repository it's linked to. Confirm it on the package's settings page, and tick this box.

