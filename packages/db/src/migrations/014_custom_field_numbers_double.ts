import { sql, type Kysely } from 'kysely';

/**
 * NUMBER custom field values were `real`: about 7 significant digits (123456789 came back as
 * 123456790) and nothing past about 3.4e38 (a larger number failed with a 500). `double
 * precision` holds every number JavaScript can, exactly as sent. Values saved before keep the
 * rounding they got.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE custom_field_values ALTER COLUMN number_value TYPE double precision`.execute(db);
}

/** Back to `real` (fails if a value is beyond its range). */
export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE custom_field_values ALTER COLUMN number_value TYPE real`.execute(db);
}
