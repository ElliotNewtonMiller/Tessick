import type { Kysely } from 'kysely';

/**
 * A webhook that keeps failing is paused (apps/server/src/services/webhooks.ts): its run of failed
 * attempts since the last success (`failing_since`, `consecutive_failures`), and when and why it
 * was paused (`paused_at`, `pause_reason`). Turning it back on clears them.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('webhooks')
    .addColumn('failing_since', 'varchar(30)')
    .addColumn('consecutive_failures', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('paused_at', 'varchar(30)')
    .addColumn('pause_reason', 'text')
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('webhooks').dropColumn('failing_since').dropColumn('consecutive_failures').dropColumn('paused_at').dropColumn('pause_reason').execute();
}
