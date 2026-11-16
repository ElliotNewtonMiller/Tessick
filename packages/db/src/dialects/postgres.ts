import { AsyncLocalStorage } from 'node:async_hooks';
import {
  Kysely,
  PostgresDialect,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
  type TransactionBuilder,
} from 'kysely';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { Database as DatabaseSchema } from '../types.js';

export function createPostgresClient(connectionString?: string): Kysely<DatabaseSchema> {
  if (!connectionString) {
    const pglite = new PGlite();
    return new PGliteKysely({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new PGliteDriver(pglite),
        createIntrospector: (db: any) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
  }

  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
      }),
    }),
  });
}

/**
 * Which `db.transaction().execute(...)` the current code runs in: one object per call, set by
 * PGliteKysely around the whole call (its BEGIN, callback and COMMIT), naming the call it was
 * made inside, if any.
 */
interface TransactionCall {
  within: TransactionCall | undefined;
}
const transactionCall = new AsyncLocalStorage<TransactionCall>();

/** Whether the current code runs inside `call` (its callback, or work the callback started). */
function runsInside(call: TransactionCall | undefined): boolean {
  if (!call) return false;
  for (let c = transactionCall.getStore(); c; c = c.within) if (c === call) return true;
  return false;
}

/** Marks every transaction's callback (and the work it starts) as belonging to that transaction. */
class PGliteKysely extends Kysely<DatabaseSchema> {
  override transaction(): TransactionBuilder<DatabaseSchema> {
    return markCallbacks(super.transaction());
  }
}

function markCallbacks(builder: TransactionBuilder<DatabaseSchema>): TransactionBuilder<DatabaseSchema> {
  return new Proxy(builder, {
    get(target, property) {
      if (property === 'execute') {
        return (callback: Parameters<typeof target.execute>[0]) => transactionCall.run({ within: transactionCall.getStore() }, () => target.execute(callback));
      }
      // setIsolationLevel / setAccessMode return a new builder, which is marked too.
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        return result && typeof result === 'object' && 'execute' in result ? markCallbacks(result) : result;
      };
    },
  });
}

/** A FIFO lock: each holder waits for every earlier one to release. */
class SessionLock {
  #tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const acquired = this.#tail.then(() => release);
    this.#tail = this.#tail.then(() => released);
    return acquired;
  }
}

/**
 * The in-memory database is one PGlite instance: one Postgres session, which every connection
 * Kysely asks for shares. Left alone, two requests' transactions would run inside each other
 * (one BEGIN, two callers' queries, the first COMMIT ending both), so a transaction-level
 * advisory lock such as TestCaseRepository.lockExternalIds wouldn't keep them apart. So:
 *
 * - A transaction holds the session from BEGIN to COMMIT/ROLLBACK; others wait their turn.
 * - A query outside any transaction waits for the open one to finish, so it neither sees its
 *   uncommitted rows nor ends up in (and rolled back with) someone else's transaction.
 * - Except a query made with `db` from inside the open transaction's own callback: that runs
 *   at once, inside the transaction, rather than waiting forever for its own caller. (On real
 *   PostgreSQL such a query runs on another connection, outside the transaction; use `trx`.)
 */
class PGliteDriver implements Driver {
  readonly #pglite: PGlite;
  readonly #lock = new SessionLock();
  #open: { connection: DatabaseConnection; call: TransactionCall | undefined; release: () => void } | null = null;

  constructor(pglite: PGlite) {
    this.#pglite = pglite;
  }

  async init() {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const driver = this;
    const connection: DatabaseConnection = {
      async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
        const open = driver.#open;
        if (open && (open.connection === connection || runsInside(open.call))) {
          return driver.#run(compiledQuery);
        }
        const release = await driver.#lock.acquire();
        try {
          return await driver.#run(compiledQuery);
        } finally {
          release();
        }
      },
      async *streamQuery() {
        throw new Error('Streaming not supported in PGlite driver');
      },
    };
    return connection;
  }

  async releaseConnection() {}

  async beginTransaction(connection: DatabaseConnection) {
    if (this.#open && runsInside(this.#open.call)) {
      // It would wait for the transaction whose callback is waiting for it.
      throw new Error('A transaction was started with `db` inside another transaction; use that transaction (`trx`) instead.');
    }
    const release = await this.#lock.acquire();
    this.#open = { connection, call: transactionCall.getStore(), release };
    try {
      await this.#run({ sql: 'BEGIN', parameters: [] });
    } catch (error) {
      this.#close();
      throw error;
    }
  }

  async commitTransaction() {
    await this.#run({ sql: 'COMMIT', parameters: [] });
    // A failed COMMIT keeps the session: Kysely follows it with rollbackTransaction.
    this.#close();
  }

  async rollbackTransaction() {
    try {
      await this.#run({ sql: 'ROLLBACK', parameters: [] });
    } finally {
      this.#close();
    }
  }

  async destroy() {
    await this.#pglite.close();
  }

  #close() {
    const open = this.#open;
    this.#open = null;
    open?.release();
  }

  async #run<R>(compiledQuery: Pick<CompiledQuery, 'sql' | 'parameters'>): Promise<QueryResult<R>> {
    const res = await this.#pglite.query(compiledQuery.sql, compiledQuery.parameters as any[]);
    return {
      rows: (res.rows || []) as R[],
      numAffectedRows: res.affectedRows !== undefined ? BigInt(res.affectedRows) : undefined,
    };
  }
}
