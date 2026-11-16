import type { Kysely } from 'kysely';

/**
 * Where an API token works (`API_TOKEN_INTERFACES` in @tessick/core): BOTH (the REST API and MCP,
 * what every existing token keeps), MCP only (an AI agent's token) or REST only.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable('api_tokens')
    .addColumn('interfaces', 'varchar(10)', (col) => col.notNull().defaultTo('BOTH'))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('api_tokens').dropColumn('interfaces').execute();
}
