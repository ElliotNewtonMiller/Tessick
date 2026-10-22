import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Database, UsersTable } from '../types.js';
import { validatePasswordPolicy } from '@testify/core';
import type { RoleName } from './role.repository.js';

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export interface CreateUserInput {
  id?: string;
  username: string;
  email: string;
  password: string;
  global_role?: RoleName;
  status?: 'ACTIVE' | 'DISABLED';
}

export interface UpdateCredentialsInput {
  userId: string;
  newUsername?: string;
  newEmail?: string;
  newPassword?: string;
}

/**
 * Passwords are stored as `pbkdf2_sha512$<iterations>$<salt>$<key>` (hex): PBKDF2-HMAC-SHA512 with
 * a 16-byte random salt and a 64-byte key, at OWASP's recommended 210,000 iterations. Hashes made
 * before 2026-10-22 are `<salt>:<key>` at 100,000 iterations; they still verify, and
 * verifyCredentials re-hashes them at today's setting when their user next signs in.
 * Hashing runs on Node's thread pool, so a sign-in doesn't hold up other requests.
 */
export const PASSWORD_HASH_ITERATIONS = 210_000;
const LEGACY_HASH_ITERATIONS = 100_000;
const pbkdf2 = promisify(crypto.pbkdf2);

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await pbkdf2(password, salt, PASSWORD_HASH_ITERATIONS, 64, 'sha512');
  return `pbkdf2_sha512$${PASSWORD_HASH_ITERATIONS}$${salt}$${key.toString('hex')}`;
}

function parsePasswordHash(stored: string): { iterations: number; salt: string; key: Buffer } | null {
  const current = /^pbkdf2_sha512\$(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(stored);
  if (current) return { iterations: Number(current[1]), salt: current[2], key: Buffer.from(current[3], 'hex') };
  const legacy = /^([0-9a-f]+):([0-9a-f]+)$/.exec(stored);
  if (legacy) return { iterations: LEGACY_HASH_ITERATIONS, salt: legacy[1], key: Buffer.from(legacy[2], 'hex') };
  return null;
}

/** Whether `password` matches a stored hash (either format). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed || parsed.key.length === 0 || parsed.iterations < 1) return false;
  const key = await pbkdf2(password, parsed.salt, parsed.iterations, parsed.key.length, 'sha512');
  return crypto.timingSafeEqual(key, parsed.key);
}

/** True when a stored hash was made with weaker settings than today's. */
export function passwordNeedsRehash(stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  return !parsed || !stored.startsWith('pbkdf2_sha512$') || parsed.iterations < PASSWORD_HASH_ITERATIONS;
}

/** A hash of no one's password, checked when a sign-in names no account, so that answer takes as
 * long as a wrong password would (the time doesn't tell which usernames exist). */
let decoyHash: Promise<string> | null = null;
const getDecoyHash = () => (decoyHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));

export class UserRepository {
  constructor(private db: Kysely<Database>) {}

  /** Runs `fn` in a transaction, or directly inside the caller's one when this repository was
   * built on a transaction already (Kysely can't nest them). */
  private async runInTransaction<T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    if ((this.db as any).isTransaction) return fn(this.db);
    return this.db.transaction().execute(fn);
  }

  /**
   * Seeds initial omnipotent superuser (admin / password) on startup if no users exist.
   */
  async hasAnyUser(): Promise<boolean> {
    return !!(await this.db.selectFrom('users').select('id').executeTakeFirst());
  }

  /**
   * Creates the first admin user (username `admin`) when there are no users at all; otherwise
   * does nothing and returns the first user. The caller chooses the password: there is no
   * built-in default (see apps/server/src/config.ts for how the server picks one).
   */
  async seedInitialAdmin(options: { password: string; mustChangePassword?: boolean }): Promise<User> {
    const existing = await this.db.selectFrom('users').selectAll().executeTakeFirst();
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const adminId = '0191c4d0-0000-7000-8000-000000000001';
    const passwordHash = await hashPassword(options.password);

    const adminUser: NewUser = {
      id: adminId,
      username: 'admin',
      email: 'admin@testify.local',
      password_hash: passwordHash,
      status: 'ACTIVE',
      must_change_password: options.mustChangePassword ?? false,
      created_at: now,
      updated_at: now,
    };

    await this.runInTransaction(async (trx) => {
      await trx.insertInto('users').values(adminUser).execute();
      await trx
        .insertInto('user_roles')
        .values({
          id: uuidv7(),
          user_id: adminId,
          role: 'Admin',
          created_at: now,
        })
        .execute();
    });

    return (await this.findById(adminId))!;
  }

  async create(input: CreateUserInput): Promise<User> {
    // Validate password complexity
    const validation = validatePasswordPolicy(input.password);
    if (!validation.valid) {
      throw new Error(`PASSWORD_POLICY_VIOLATION: ${validation.reason}`);
    }

    const now = new Date().toISOString();
    const id = input.id || uuidv7();
    const passwordHash = await hashPassword(input.password);

    const newUser: NewUser = {
      id,
      username: input.username,
      email: input.email,
      password_hash: passwordHash,
      status: input.status ?? 'ACTIVE',
      created_at: now,
      updated_at: now,
    };

    const globalRole = input.global_role ?? 'Tester';

    await this.runInTransaction(async (trx) => {
      await trx.insertInto('users').values(newUser).execute();
      await trx
        .insertInto('user_roles')
        .values({
          id: uuidv7(),
          user_id: id,
          role: globalRole,
          created_at: now,
        })
        .execute();
    });

    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<User | undefined> {
    return await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByUsernameOrEmail(identifier: string): Promise<User | undefined> {
    return await this.db
      .selectFrom('users')
      .selectAll()
      .where((eb) => eb.or([eb('username', '=', identifier), eb('email', '=', identifier)]))
      .executeTakeFirst();
  }

  async findAll(): Promise<User[]> {
    return await this.db.selectFrom('users').selectAll().orderBy('created_at', 'asc').execute();
  }

  async updateCredentials(input: UpdateCredentialsInput): Promise<User> {
    const user = await this.findById(input.userId);
    if (!user) {
      throw new Error(`User with ID '${input.userId}' not found`);
    }

    const now = new Date().toISOString();
    const updateData: UserUpdate = { updated_at: now };

    if (input.newUsername) updateData.username = input.newUsername;
    if (input.newEmail) updateData.email = input.newEmail;

    if (input.newPassword) {
      const validation = validatePasswordPolicy(input.newPassword);
      if (!validation.valid) {
        throw new Error(`PASSWORD_POLICY_VIOLATION: ${validation.reason}`);
      }
      updateData.password_hash = await hashPassword(input.newPassword);
      updateData.must_change_password = false;
    }

    await this.db.updateTable('users').set(updateData).where('id', '=', input.userId).execute();
    return (await this.findById(input.userId))!;
  }

  /**
   * An administrator resets someone's password: sets `newPassword` (checked against the
   * policy), makes them choose their own at next sign-in, and clears any sign-in lock.
   * Ending their sessions is up to the caller.
   */
  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const validation = validatePasswordPolicy(newPassword);
    if (!validation.valid) {
      throw new Error(`PASSWORD_POLICY_VIOLATION: ${validation.reason}`);
    }
    const passwordHash = await hashPassword(newPassword);
    await this.db
      .updateTable('users')
      .set({
        password_hash: passwordHash,
        must_change_password: true,
        failed_login_count: 0,
        locked_until: null,
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', userId)
      .execute();
  }

  async updateStatus(userId: string, status: 'ACTIVE' | 'DISABLED'): Promise<User> {
    const now = new Date().toISOString();
    await this.db.updateTable('users').set({ status, updated_at: now }).where('id', '=', userId).execute();
    return (await this.findById(userId))!;
  }

  /**
   * Records a failed sign-in (or a wrong current password). Once `threshold` failures are in a
   * row the account is locked for `lockSeconds`; while the count stays at or above the
   * threshold, each further failure locks it again. Returns the lock time, or null if not locked.
   */
  async recordFailedLogin(userId: string, threshold: number, lockSeconds: number): Promise<string | null> {
    const row = await this.db
      .updateTable('users')
      .set((eb) => ({ failed_login_count: eb('failed_login_count', '+', 1) }))
      .where('id', '=', userId)
      .returning('failed_login_count')
      .executeTakeFirst();
    if (!row || row.failed_login_count < threshold) return null;
    const lockedUntil = new Date(Date.now() + lockSeconds * 1000).toISOString();
    await this.db.updateTable('users').set({ locked_until: lockedUntil }).where('id', '=', userId).execute();
    return lockedUntil;
  }

  /** Clears the failure count and any lock (after a successful sign-in, or an admin unlock). */
  async resetLoginFailures(userId: string): Promise<void> {
    await this.db.updateTable('users').set({ failed_login_count: 0, locked_until: null }).where('id', '=', userId).execute();
  }

  /** True when `password` is this user's current password. */
  async isCurrentPassword(userId: string, password: string): Promise<boolean> {
    const user = await this.findById(userId);
    return !!user && (await verifyPassword(password, user.password_hash));
  }

  /**
   * The user these credentials sign in, or null. The password is checked even for an unknown or
   * disabled account, so every refusal takes about as long. A hash made with older settings is
   * replaced by one at today's (see hashPassword).
   */
  async verifyCredentials(identifier: string, password: string): Promise<User | null> {
    const user = await this.findByUsernameOrEmail(identifier);
    if (!user) {
      await verifyPassword(password, await getDecoyHash());
      return null;
    }

    const isValid = await verifyPassword(password, user.password_hash);
    if (!isValid || user.status === 'DISABLED') return null;

    if (passwordNeedsRehash(user.password_hash)) {
      const upgraded = await hashPassword(password);
      // Only if it hasn't changed meanwhile (a concurrent password change wins).
      await this.db.updateTable('users').set({ password_hash: upgraded }).where('id', '=', user.id).where('password_hash', '=', user.password_hash).execute();
      return { ...user, password_hash: upgraded };
    }
    return user;
  }
}
