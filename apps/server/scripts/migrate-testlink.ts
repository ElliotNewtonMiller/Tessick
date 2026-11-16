/**
 * Moves a TestLink 1.9 database into Tessick, keeping TestLink's ids, API keys and history, so
 * clients of the TestLink-compatible API keep working after the switch
 * (docs/testlink_compat_api.md, "Migration").
 *
 *   DATABASE_URL=postgres://…tessick… npx tsx apps/server/scripts/migrate-testlink.ts --from postgres://…testlink… --dry-run
 *
 * Options:
 *   --from <url>          TestLink's database: postgres://… or mysql://… (mysql needs `npm install mysql2 --workspace=apps/server`).
 *                         Or TESTLINK_DATABASE_URL.
 *   --dry-run             Do it all, report, and write nothing (the migration rolled back).
 *   --time-zone <zone>    The zone TestLink's server keeps its times in (IANA, e.g. America/Chicago). Default UTC.
 *   --table-prefix <p>    TestLink's table prefix (its DB_TABLE_PREFIX), if any.
 *   --actor <username>    The Tessick user the migration is recorded as. Default admin.
 *   --json                Print the report as JSON.
 *
 * DATABASE_URL is Tessick's own database (PostgreSQL). Start Tessick on it once first, so it
 * has its tables and its admin. Running again brings only what TestLink gained since.
 */
import { createDbClient, migrateToLatest } from '@tessick/db';
import { connectTestLink } from '../src/testlinkMigration/source.js';
import { migrateTestLink, MigrationError, type MigrationReport } from '../src/testlinkMigration/migrate.js';

function args(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument '${a}'`);
    const key = a.slice(2);
    if (key === 'dry-run' || key === 'json') out[key] = true;
    else {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
      out[key] = value;
    }
  }
  return out;
}

function print(report: MigrationReport) {
  const rows = Object.entries(report.counts).filter(([, t]) => t.testlink || t.created || t.existing || t.skipped);
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  console.log(report.dryRun ? '\nDry run: nothing was written.\n' : '\nMigrated.\n');
  console.log(`${'what'.padEnd(15)}${pad('in TestLink', 13)}${pad('new', 9)}${pad('already', 9)}${pad('skipped', 9)}`);
  for (const [kind, t] of rows) console.log(`${kind.padEnd(15)}${pad(t.testlink, 13)}${pad(t.created, 9)}${pad(t.existing, 9)}${pad(t.skipped, 9)}`);
  if (report.warnings.length) {
    console.log(`\n${report.warnings.length} note(s):`);
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
}

async function main() {
  const opts = args(process.argv.slice(2));
  const from = (opts.from as string) || process.env.TESTLINK_DATABASE_URL;
  const target = process.env.DATABASE_URL;
  if (!from) throw new Error('Name TestLink\'s database with --from <url> (or TESTLINK_DATABASE_URL)');
  if (!target || target === 'memory') throw new Error("Set DATABASE_URL to Tessick's PostgreSQL database");

  const db = createDbClient({ connectionString: target });
  const source = await connectTestLink(from);
  try {
    await migrateToLatest(db);
    const report = await migrateTestLink(db, source, {
      actor: (opts.actor as string) || 'admin',
      dryRun: Boolean(opts['dry-run']),
      timeZone: opts['time-zone'] as string | undefined,
      tablePrefix: opts['table-prefix'] as string | undefined,
      log: opts.json ? undefined : (line) => console.log(line),
    });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else print(report);
  } finally {
    await source.close();
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof MigrationError ? `Not migrated: ${err.message}` : err);
  process.exit(1);
});
