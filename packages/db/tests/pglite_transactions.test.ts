import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';

/**
 * The in-memory database is one PGlite session shared by every connection, so its driver
 * takes turns: a transaction holds the session until it ends (dialects/postgres.ts).
 */
describe('In-memory database transactions', () => {
  let db: Kysely<any>;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const rows = async (on: Kysely<any> = db) => (await sql<{ n: number }>`select n from t order by n`.execute(on)).rows.map((r) => r.n);

  beforeEach(async () => {
    db = createDbClient();
    await sql`create table t (n int primary key)`.execute(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  it("runs overlapping transactions one after the other, so one's rollback doesn't undo the other", async () => {
    const events: string[] = [];
    const first = db.transaction().execute(async (trx) => {
      events.push('first begins');
      await sql`insert into t values (1)`.execute(trx);
      await pause(30); // the second is called meanwhile
      events.push('first ends');
    });
    const second = db.transaction().execute(async (trx) => {
      events.push('second begins');
      await sql`insert into t values (2)`.execute(trx);
      throw new Error('rolled back');
    });
    await first;
    await expect(second).rejects.toThrow('rolled back');
    // Sharing one session, the second's BEGIN and ROLLBACK used to take the first's row with it.
    expect(events).toEqual(['first begins', 'first ends', 'second begins']);
    expect(await rows()).toEqual([1]);
  });

  it("makes a query outside a transaction wait for it, so it never sees the transaction's uncommitted rows", async () => {
    let inserted!: () => void;
    const insertedPromise = new Promise<void>((resolve) => (inserted = resolve));
    const rolledBack = db.transaction().execute(async (trx) => {
      await sql`insert into t values (1)`.execute(trx);
      inserted();
      await pause(30);
      throw new Error('rolled back');
    });
    await insertedPromise;
    // Asked while the row exists only inside the transaction; answered after its rollback.
    expect(await rows()).toEqual([]);
    await expect(rolledBack).rejects.toThrow('rolled back');
  });

  it('runs a query made with `db` inside the callback at once, inside the transaction, rather than waiting for itself', async () => {
    const seen = await db.transaction().execute(async (trx) => {
      await sql`insert into t values (1)`.execute(trx);
      return rows(db);
    });
    expect(seen).toEqual([1]);
  });

  it('refuses a transaction started with `db` inside another one, which would wait for itself', async () => {
    await expect(
      db.transaction().execute(async () => {
        await db.transaction().execute(async () => {});
      })
    ).rejects.toThrow(/use that transaction/);
    // The outer one rolled back and let go of the session.
    expect(await rows()).toEqual([]);
  });
});
