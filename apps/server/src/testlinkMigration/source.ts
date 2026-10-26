import { sql, type Kysely } from 'kysely';
import { createDbClient } from '@testify/db';

/**
 * Where the migration reads TestLink from: a function that runs one SELECT. TestLink keeps its
 * data in MySQL or PostgreSQL; the migration's queries are plain SQL that both accept (no
 * quoting, no dialect functions), so one reader serves both.
 */
export interface TestLinkSource {
  query(text: string): Promise<Record<string, any>[]>;
  close(): Promise<void>;
}

/** A source over a Kysely connection (a PostgreSQL TestLink, or an in-memory one in tests). */
export function kyselySource(db: Kysely<any>, opts: { closeWith?: () => Promise<void> } = {}): TestLinkSource {
  return {
    query: async (text) => (await sql.raw(text).execute(db)).rows as Record<string, any>[],
    close: async () => {
      await opts.closeWith?.();
    },
  };
}

/**
 * Connects to a TestLink database by URL: `postgres://…` (read with Testify's own driver) or
 * `mysql://…` (needs the mysql2 package, which Testify doesn't install by default).
 */
export async function connectTestLink(url: string): Promise<TestLinkSource> {
  if (/^postgres(ql)?:\/\//i.test(url)) {
    const db = createDbClient({ connectionString: url });
    return kyselySource(db, { closeWith: () => db.destroy() });
  }
  if (/^mysql:\/\//i.test(url)) {
    let mysql: any;
    try {
      // A variable, so neither TypeScript nor the bundler needs the package to exist.
      const moduleName = 'mysql2/promise';
      mysql = await import(moduleName);
    } catch {
      throw new Error('Reading a MySQL TestLink needs the mysql2 package: npm install mysql2 --workspace=apps/server');
    }
    const connection = await (mysql.default ?? mysql).createConnection({ uri: url, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true });
    return {
      query: async (text) => (await connection.query(text))[0],
      close: async () => {
        await connection.end();
      },
    };
  }
  throw new Error('The TestLink database URL must start with postgres:// or mysql://');
}
