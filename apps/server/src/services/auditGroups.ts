import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, AuditLogsTable } from '@tessick/db';

/** An audit entry standing for several evidence additions: one uploader, one run, one hour. */
export type AuditEntry = Selectable<AuditLogsTable> & { grouped_count?: number; first_created_at?: string };

/** How many file names a grouped entry lists (the rest are counted). */
const NAMES_SHOWN = 5;

/**
 * Evidence additions for the Security Audit Log, organised by time (decided with Elliot): one
 * entry per uploader, run and clock hour, which a CI build adding hundreds of files makes one line
 * of. Every row stays in `audit_logs`; `?action=EVIDENCE_ADDED` still lists each one.
 *
 * A group with one addition is answered as that row. A larger one is answered as its latest row
 * (so it pages by that row's time and id, like any other entry), with the run as its resource, a
 * summary as its diff, `grouped_count` and `first_created_at`. Newest first, after `cursor`.
 */
export async function groupedEvidenceAdditions(
  db: Kysely<Database>,
  opts: { actorId?: string; since?: string; cursor?: { ts: string; id: string } | null; limit: number }
): Promise<AuditEntry[]> {
  const filters = [
    sql`action = 'EVIDENCE_ADDED'`,
    ...(opts.actorId ? [sql`actor_id = ${opts.actorId}`] : []),
    ...(opts.since ? [sql`created_at >= ${opts.since}`] : []),
  ];
  const after = opts.cursor ? sql`AND (l.created_at < ${opts.cursor.ts} OR (l.created_at = ${opts.cursor.ts} AND l.id < ${opts.cursor.id}))` : sql``;
  const { rows } = await sql<
    Selectable<AuditLogsTable> & { run_id: string; n: string; first_at: string; total_bytes: string | null; kinds: Record<string, number>; late: string; names: string[] }
  >`
    WITH e AS (
      SELECT *, (diff::jsonb ->> 'test_run_id') AS run_id, substr(created_at, 1, 13) AS bucket
      FROM audit_logs WHERE ${sql.join(filters, sql` AND `)}
    ),
    g AS (
      SELECT actor_id, run_id, bucket,
        count(*) AS n,
        min(created_at) AS first_at,
        sum((diff::jsonb ->> 'size_bytes')::bigint) AS total_bytes,
        count(*) FILTER (WHERE (diff::jsonb ->> 'after_close') = 'true') AS late,
        (array_agg(diff::jsonb ->> 'filename' ORDER BY created_at, id))[1:${sql.lit(NAMES_SHOWN)}] AS names
      FROM e GROUP BY actor_id, run_id, bucket
    ),
    k AS (
      SELECT actor_id, run_id, bucket, jsonb_object_agg(kind, c) AS kinds
      FROM (SELECT actor_id, run_id, bucket, diff::jsonb ->> 'kind' AS kind, count(*) AS c FROM e GROUP BY actor_id, run_id, bucket, diff::jsonb ->> 'kind') per_kind
      GROUP BY actor_id, run_id, bucket
    ),
    l AS (
      SELECT DISTINCT ON (actor_id, run_id, bucket) * FROM e ORDER BY actor_id, run_id, bucket, created_at DESC, id DESC
    )
    SELECT l.id, l.actor_id, l.actor_type, l.action, l.resource_type, l.resource_id, l.project_id, l.diff, l.ip_address, l.user_agent, l.created_at,
      l.run_id, g.n, g.first_at, g.total_bytes, g.late, g.names, k.kinds
    FROM l
    JOIN g ON g.actor_id = l.actor_id AND g.run_id IS NOT DISTINCT FROM l.run_id AND g.bucket = l.bucket
    JOIN k ON k.actor_id = l.actor_id AND k.run_id IS NOT DISTINCT FROM l.run_id AND k.bucket = l.bucket
    WHERE true ${after}
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${opts.limit}
  `.execute(db);

  return rows.map(({ run_id, n, first_at, total_bytes, kinds, late, names, ...row }) => {
    const count = Number(n);
    if (count === 1) return row;
    let via: unknown;
    try {
      via = JSON.parse(row.diff).via;
    } catch {
      via = undefined;
    }
    return {
      ...row,
      resource_type: 'test_run',
      resource_id: run_id,
      diff: JSON.stringify({
        files: count,
        total_bytes: Number(total_bytes ?? 0),
        kinds,
        after_close: Number(late),
        via,
        first_files: names,
      }),
      grouped_count: count,
      first_created_at: first_at,
    };
  });
}
