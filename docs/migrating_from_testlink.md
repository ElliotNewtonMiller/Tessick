# Moving from TestLink to Tessick

This guide takes your test cases out of TestLink and into Tessick. The quick way uses TestLink's own XML export and Tessick's Import wizard, with no scripts and no database access, and takes about fifteen minutes. If you also want your plans, builds, results history and users, there's a full database migration (below).

## Choose your way out

| | XML export and import | Database migration |
| :--- | :--- | :--- |
| **You need** | TestLink's web UI | A copy of TestLink's database, Node.js 22 and a copy of Tessick's source |
| **Suites, cases, steps** | Yes | Yes, with every version |
| **Custom fields and keywords** | Yes | Yes |
| **Test plans, builds, results history** | No | Yes |
| **Users, roles, TestLink API keys** | No | Yes (passwords are set again) |
| **Requirements, attachments** | No | No |

Most teams start with XML: it's quick, and you can try it on one project. Use the migration when the history matters, or when scripts use TestLink's API and must keep working on day one.

## Before you start

1. **Run Tessick.**
   - To try it out: the one-command demo in the [README](../README.md#try-it-in-a-minute).
   - To keep your data: [Running it for real](../README.md#running-it-for-real) and [deployment.md](deployment.md).
2. **Sign in as `admin`.**
3. **Create a project with the same prefix as in TestLink** (the **⋯** next to Project in the header → New project). For example, if TestLink's cases are `SHOP-331`, use the prefix `SHOP`. TestLink's export holds only the number (`331`), and Tessick puts the project's prefix in front of it, so your cases keep their ids.

## 1. Export from TestLink

In TestLink 1.9:

1. Open **Test Specification**.
2. In the tree, click the project's name at the top.
3. Click **Export All Test Suites**.
4. Choose **XML**, and tick the options for keywords and custom fields.
5. Save the file.

To move one part at a time, select a suite instead and export it the same way. An export of single test cases, rather than a suite, works too: its cases go into a top-level suite called **Imported cases**.

## 2. Import into Tessick

Click **📥 Import** in the header. The wizard has five steps:

1. **Upload.**
   - Choose the file. Leave the format on Auto-detect: Tessick recognises TestLink XML.
   - Pick the project you created.
   - **Preview Import** reads the file and writes nothing. Nothing is written until you click **Run Import** at the end.
2. **Field Mapping.** Each TestLink custom field that the project doesn't have yet is listed, with its values. Click each one and choose:
   - **Create New:** a new Tessick field, with a type suggested from its values. A list type can be chosen instead.
   - **Map to Existing:** put the values in a field you already have.
   - **Drop:** leave it out.

   A field with the same name as one the project already has is filled in without asking.
3. **Duplicates.** The counts of suites and cases to create, and any warnings (for example, cases with no steps). If a case with the same id is already in the project, the default is to give it a new version, keeping its results. Cases are matched by their id only, so two TestLink cases with the same title stay two cases. So you can import the same file again, for example after the last edits in TestLink, without making copies.
4. **Confirm.** A summary; **Run Import** writes it all, in one go.
5. **Results.** What was imported, and any custom-field values that didn't fit their field.

**Files over 50 MB** are refused. Export the project one top-level suite at a time instead, and import each file into the same project.

## What comes across

| TestLink | Tessick |
| :--- | :--- |
| Test suites, nested | Suites, in the same tree and order (up to 27 levels deep) |
| Test case, with its external id (`331`) | A case with the id `PREFIX-331`. If that id is already taken, the case gets the project's next free number |
| Summary, preconditions, steps, expected results | The same, as plain text: paragraphs and line breaks stay, lists become `- item` or `1. item` lines, and a table row becomes one line with its cells separated by ` \| `. Other formatting (bold, links, colours) is removed |
| Importance 1, 2, 3 | Priority LOW, MEDIUM, HIGH |
| Execution type manual or automated | MANUAL or AUTOMATED |
| Status final | Approved |
| Status draft, review, rework or future | Draft |
| Status obsolete, or an inactive case | Deprecated: hidden in the tree unless **Show deprecated** is on |
| Keywords | The project's `keywords` field |
| Custom fields | The fields you chose in Field Mapping |
| TestLink's internal ids | Kept, for the [TestLink-compatible API](testlink_compat_api.md) |

**Drafts stay drafts.** Tessick only puts approved cases in a test plan, so approve the drafts you want to run:
- one at a time with **✓ Approve** on the case;
- or many at once over the API, up to 500 per call, with a project API token that has `SPEC_APPROVE`:
  ```bash
  curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d '{"action":"approve","case_ids":["SHOP-12","SHOP-13"]}' \
    "$TESSICK/api/v1/projects/$PROJECT/cases/bulk"
  ```

An export without statuses (older TestLink versions) is imported as approved. A re-import's new versions take TestLink's status at the time, so a case you approved in Tessick but that's still a draft in TestLink gets a new draft version. Approve in one place.

**Not in TestLink's XML**, and so not imported this way: test plans, builds, results, users, requirements and attachments. To bring plans, builds, results and users, use the database migration.

## Importing from a script

The same import works over the API, which is useful for many projects. You need an API token for the project: in Tessick, go to **Admin Panel → API Tokens**, and give it `IMPORT_DATA`.

```bash
TESSICK=http://localhost:3001
PROJECT=<the project's id, from GET $TESSICK/api/v1/projects>

# A preview: counts, warnings and the custom fields that need a mapping. Nothing is written.
curl -fsS -H "Authorization: Bearer $TOKEN" -F file=@testsuites.xml \
  "$TESSICK/api/v1/projects/$PROJECT/imports/dry-run"

# The import. Custom fields not named in field_mappings are left out.
curl -fsS -H "Authorization: Bearer $TOKEN" -F file=@testsuites.xml \
  -F 'configuration={"field_mappings":[{"incoming_key":"Component","action":"AUTO_CREATE","field_type":"SINGLE_SELECT"}]}' \
  "$TESSICK/api/v1/projects/$PROJECT/imports/execute"
```

The field mappings and duplicate options are described in [RFC 03 §6.4](rfc_03_api_and_xml_contracts.md#64-field-mapping--duplicates).

## The full database migration

`apps/server/scripts/migrate-testlink.ts` reads TestLink 1.9's database and moves everything in it into Tessick in one transaction. That includes users, roles, projects, suites, every case version, custom fields, keywords, plans, builds, results with their testers and times, and API keys. TestLink's ids are kept.

It runs from a copy of Tessick's source, with Node.js 22:

```bash
git clone https://github.com/ElliotNewtonMiller/Tessick.git && cd Tessick
npm install
npm install mysql2 --workspace=apps/server   # only for a MySQL or MariaDB TestLink (most are)
```

**Start Tessick on its PostgreSQL database once before migrating.** That creates its tables and its admin.

**If Tessick runs with `docker-compose.yml`,** its database isn't reachable from outside Docker. Open it to your machine while you migrate:
1. Add a `docker-compose.override.yml` next to `docker-compose.yml`:
   ```yaml
   services:
     db:
       ports: ["127.0.0.1:5432:5432"]
   ```
2. Run `docker compose up -d`.
3. Delete the file when you're done, and run `docker compose up -d` again.

Then try it with `--dry-run`. It does everything, prints exactly what it would bring, and writes nothing:

```bash
DATABASE_URL=postgres://tessick:<password>@127.0.0.1:5432/tessick \
  npx tsx apps/server/scripts/migrate-testlink.ts \
  --from mysql://<user>:<password>@<testlink-host>:3306/testlink \
  --time-zone Europe/Berlin --dry-run
```

**The options:**
- `--time-zone` is the zone TestLink's server keeps its times in. TestLink doesn't store one, and the default is UTC.
- `--table-prefix` is for a TestLink installed with a table prefix.

When the report looks right, run the same command without `--dry-run`.

**Good to know:**
- **Run it early, then again at the switch.** A second run brings only what TestLink gained since. Changes made in TestLink to things already migrated aren't brought, so keep editing in one place.
- **Passwords aren't brought:** TestLink stores them as unsalted MD5. An admin sets each user's password (Admin Panel → User Roster → Reset Password). Users' TestLink API keys work straight away.
- **What isn't brought:** requirements, attachments, milestones, tester assignments, and custom fields on plans or builds. The report counts the requirements and attachments it left.
- **Platforms** aren't a Tessick feature: each build and platform becomes its own test run.
- The full mapping is in [testlink_compat_api.md](testlink_compat_api.md#migration-phase-5).

## Keep your TestLink scripts

Tessick also answers TestLink's REST API (v1, v2 and the custom one) under `/lib/api/rest/`. A script or CI job written for TestLink keeps working with only the host changed, using the user's TestLink API key. Each user makes theirs by clicking their name in the header, or it comes across with the migration. See [testlink_compat_api.md](testlink_compat_api.md).

## After the move: what's different

- **Builds are test runs**, and a test plan has as many runs as you like.
- **Recording results is keyboard-driven:** in Execute mode, `j`/`k` move through the queue and `p`/`f`/`b`/`s` record pass, fail, blocked or skipped.
- **CI sends its JUnit XML report straight to a run**, created by build name on first use. See [api_getting_started.md](api_getting_started.md).
- **A test case's content is versioned:** edit an approved case to make a new draft, then approve it. Approving updates the case in every active plan.
- **Reports** (trends, flaky and slow tests, run comparisons) are built in, and can be emailed on a schedule.

---

*Tested with a real TestLink 1.9 export of a whole project (724 cases in 178 suites, with lists, tables and ten custom fields), and the migration against TestLink 1.9.20's PostgreSQL schema. If something from your TestLink doesn't come across as described here, please [open an issue](https://github.com/ElliotNewtonMiller/Tessick/issues) with what it was.*
