import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import type { Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';
import type { Database } from '../src/types.js';
import { migrateToLatest } from '../src/migrations/index.js';
import { seedRbacRegistry } from '../src/seeds/seed_rbac_registry.js';
import { UserRepository, hashPassword, verifyPassword, passwordNeedsRehash, PASSWORD_HASH_ITERATIONS } from '../src/repositories/user.repository.js';

/** A hash in the format used before 2026-10-22: `<salt>:<key>`, PBKDF2-SHA512 at 100,000 iterations. */
function legacyHash(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex')}`;
}

describe('Password hashing', () => {
  it('stores PBKDF2-SHA512 at 210,000 iterations with a random salt, and verifies it', async () => {
    expect(PASSWORD_HASH_ITERATIONS).toBe(210_000);
    const a = await hashPassword('Correct Horse 1!');
    const b = await hashPassword('Correct Horse 1!');
    expect(a).toMatch(/^pbkdf2_sha512\$210000\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(a).not.toBe(b); // different salts
    expect(await verifyPassword('Correct Horse 1!', a)).toBe(true);
    expect(await verifyPassword('correct horse 1!', a)).toBe(false);
    expect(passwordNeedsRehash(a)).toBe(false);
  });

  it('still verifies the old format, and marks it for re-hashing', async () => {
    const old = legacyHash('password');
    expect(await verifyPassword('password', old)).toBe(true);
    expect(await verifyPassword('wrong', old)).toBe(false);
    expect(passwordNeedsRehash(old)).toBe(true);
    expect(passwordNeedsRehash('pbkdf2_sha512$100000$00$00')).toBe(true);
  });

  it('refuses malformed stored values instead of throwing', async () => {
    for (const stored of ['', 'nonsense', 'pbkdf2_sha512$0$00$00', 'pbkdf2_sha512$210000$00$', 'abc:']) {
      expect(await verifyPassword('password', stored)).toBe(false);
    }
  });
});

describe('Signing in with stored hashes', () => {
  let db: Kysely<Database>;
  let users: UserRepository;

  beforeEach(async () => {
    db = createDbClient();
    await migrateToLatest(db);
    await seedRbacRegistry(db);
    users = new UserRepository(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  const storedHash = async (id: string) => (await db.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow()).password_hash;

  it('upgrades an old-format hash the first time its user signs in', async () => {
    const user = await users.create({ username: 'alice', email: 'alice@example.com', password: 'Correct Horse 1!' });
    const old = legacyHash('Correct Horse 1!');
    await db.updateTable('users').set({ password_hash: old }).where('id', '=', user.id).execute();

    // A wrong password leaves it alone.
    expect(await users.verifyCredentials('alice', 'wrong')).toBeNull();
    expect(await storedHash(user.id)).toBe(old);

    const signedIn = await users.verifyCredentials('alice', 'Correct Horse 1!');
    expect(signedIn?.id).toBe(user.id);
    const upgraded = await storedHash(user.id);
    expect(upgraded).toMatch(/^pbkdf2_sha512\$210000\$/);
    expect(signedIn?.password_hash).toBe(upgraded);

    // The upgraded hash keeps working, and isn't replaced again.
    expect((await users.verifyCredentials('alice@example.com', 'Correct Horse 1!'))?.id).toBe(user.id);
    expect(await storedHash(user.id)).toBe(upgraded);
    expect(await users.isCurrentPassword(user.id, 'Correct Horse 1!')).toBe(true);
  });

  it('refuses an unknown or disabled account after checking a password all the same', async () => {
    const user = await users.create({ username: 'bob', email: 'bob@example.com', password: 'Correct Horse 1!' });
    await users.updateStatus(user.id, 'DISABLED');
    expect(await users.verifyCredentials('bob', 'Correct Horse 1!')).toBeNull();
    expect(await users.verifyCredentials('nobody', 'Correct Horse 1!')).toBeNull();
  });
});
