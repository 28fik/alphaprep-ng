import { DEFAULT_PBKDF2_ITERATIONS, hashPassword, hmacHex, randomToken, safeEqual, sha256Hex, verifyPassword } from "./crypto.ts";
import type { Db } from "./db.ts";
import { hit, purgeOld } from "./ratelimit.ts";
import type { Result } from "./participants.ts";
import { validateAdminPassword } from "./validation.ts";

export interface AdminCtx {
  db: Db;
  pepper: string; // SESSION_PEPPER
  now: Date;
  ipHash: string;
  bootstrapSecret?: string; // ADMIN_BOOTSTRAP_SECRET
  iterations?: number; // PBKDF2 iterations (tests use a low value)
}

export const SESSION_HOURS = 12;
const GENERIC_LOGIN_ERROR = "Invalid username or password, or the account is temporarily locked.";

const isoSec = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function audit(ctx: AdminCtx, adminId: number | null, action: string, details?: Record<string, unknown>) {
  await ctx.db
    .prepare("INSERT INTO audit_logs (admin_id, action, details_json, ip_hash, created_at) VALUES (?,?,?,?,?)")
    .bind(adminId, action, details ? JSON.stringify(details) : null, ctx.ipHash, isoSec(ctx.now))
    .run();
}

async function setting(db: Db, key: string, fallback: number): Promise<number> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const dummyHashes = new Map<number, Promise<string>>();
function dummyHash(iterations: number) {
  let p = dummyHashes.get(iterations);
  if (!p) {
    p = hashPassword("not-a-real-password-for-timing", iterations);
    dummyHashes.set(iterations, p);
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// First-administrator bootstrap
// ---------------------------------------------------------------------------------------------
export async function setupStatus(db: Db): Promise<{ needs_setup: boolean }> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM admins").first<{ n: number }>();
  return { needs_setup: (row?.n ?? 0) === 0 };
}

export async function bootstrapAdmin(ctx: AdminCtx, raw: unknown): Promise<Result> {
  const { db, now } = ctx;
  if (!ctx.bootstrapSecret) {
    return { status: 503, body: { error: "First-time setup is not configured on the server." } };
  }
  const rl = await hit(db, `bootstrap:${ctx.ipHash}`, now, 900, 5);
  if (!rl.allowed) {
    return { status: 429, body: { error: "Too many attempts. Please wait and try again.", retry_after_seconds: rl.retryAfterSeconds } };
  }
  if (!(await setupStatus(db)).needs_setup) {
    return { status: 403, body: { error: "Setup has already been completed." } };
  }

  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const secret = typeof r.secret === "string" ? r.secret : "";
  if (!(await safeEqual(secret, ctx.bootstrapSecret))) {
    return { status: 403, body: { error: "The setup secret is incorrect." } };
  }

  const username = typeof r.username === "string" ? r.username.trim() : "";
  const display = typeof r.display_name === "string" ? r.display_name.trim().slice(0, 60) : "";
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
    return { status: 400, body: { error: "Username must be 3-40 characters: letters, numbers, dot, dash or underscore." } };
  }
  if (!display) return { status: 400, body: { error: "Enter a display name." } };
  const pwError = validateAdminPassword(r.password, username);
  if (pwError) return { status: 400, body: { error: pwError } };

  const hash = await hashPassword(r.password as string, ctx.iterations ?? DEFAULT_PBKDF2_ITERATIONS);
  // Atomic: inserts only if there is still no administrator (guards against concurrent requests).
  const res = await db
    .prepare(
      `INSERT INTO admins (username, display_name, password_hash, role_id, created_at)
       SELECT ?, ?, ?, 'super_admin', ? WHERE NOT EXISTS (SELECT 1 FROM admins)`,
    )
    .bind(username, display, hash, isoSec(now))
    .run();
  if (res.meta.changes !== 1) return { status: 403, body: { error: "Setup has already been completed." } };

  await audit(ctx, null, "admin.bootstrap", { username });
  return { status: 201, body: { ok: true } };
}

// ---------------------------------------------------------------------------------------------
// Login / sessions
// ---------------------------------------------------------------------------------------------
export interface AdminSession {
  admin: { id: number; username: string; display_name: string; role: string };
  permissions: string[];
  csrf: string;
}

async function csrfFor(pepper: string, sessionToken: string) {
  return hmacHex(pepper, `csrf:${sessionToken}`);
}

export interface LoginResult extends Result {
  sessionToken?: string;
}

export async function loginAdmin(ctx: AdminCtx, raw: unknown): Promise<LoginResult> {
  const { db, now } = ctx;
  const iterations = ctx.iterations ?? DEFAULT_PBKDF2_ITERATIONS;

  const rl = await hit(db, `login:${ctx.ipHash}`, now, 900, 10);
  if (!rl.allowed) {
    return { status: 429, body: { error: "Too many sign-in attempts. Please wait a few minutes.", retry_after_seconds: rl.retryAfterSeconds } };
  }

  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const username = typeof r.username === "string" ? r.username.trim() : "";
  const password = typeof r.password === "string" ? r.password : "";
  const fail: LoginResult = { status: 401, body: { error: GENERIC_LOGIN_ERROR } };
  if (!username || !password || password.length > 200) return fail;

  const admin = await db
    .prepare("SELECT id, username, display_name, password_hash, role_id, status, failed_logins, locked_until FROM admins WHERE username = ?")
    .bind(username)
    .first<{
      id: number; username: string; display_name: string; password_hash: string;
      role_id: string; status: string; failed_logins: number; locked_until: string | null;
    }>();

  if (!admin) {
    await verifyPassword(password, await dummyHash(iterations)); // equalise timing
    return fail;
  }
  if (admin.locked_until && admin.locked_until > isoSec(now)) return fail;

  const ok = await verifyPassword(password, admin.password_hash);
  if (!ok || admin.status !== "active") {
    if (!ok) {
      const maxFailures = await setting(db, "login_max_failures", 5);
      const lockMinutes = await setting(db, "login_lockout_minutes", 15);
      const failures = admin.failed_logins + 1;
      if (failures >= maxFailures) {
        const until = new Date(now.getTime() + lockMinutes * 60_000);
        await db.prepare("UPDATE admins SET failed_logins = 0, locked_until = ? WHERE id = ?").bind(isoSec(until), admin.id).run();
        await audit(ctx, admin.id, "admin.locked", { minutes: lockMinutes });
      } else {
        await db.prepare("UPDATE admins SET failed_logins = ? WHERE id = ?").bind(failures, admin.id).run();
        await audit(ctx, admin.id, "admin.login_failed");
      }
    }
    return fail;
  }

  const sessionToken = randomToken();
  const expires = new Date(now.getTime() + SESSION_HOURS * 3600_000);
  await db.batch([
    db.prepare("DELETE FROM admin_sessions WHERE expires_at < ?").bind(isoSec(now)),
    db.prepare("UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?").bind(isoSec(now), admin.id),
    db
      .prepare("INSERT INTO admin_sessions (id_hash, admin_id, csrf_token_hash, ip_hash, created_at, expires_at) VALUES (?,?,?,?,?,?)")
      .bind(await sha256Hex(sessionToken), admin.id, await sha256Hex(await csrfFor(ctx.pepper, sessionToken)), ctx.ipHash, isoSec(now), isoSec(expires)),
  ]);
  await purgeOld(db, now);
  await audit(ctx, admin.id, "admin.login");

  const session = await getSession(ctx, sessionToken);
  return { status: 200, body: { ...session }, sessionToken };
}

export async function getSession(ctx: Pick<AdminCtx, "db" | "pepper" | "now">, sessionToken: string | undefined): Promise<AdminSession | null> {
  if (!sessionToken) return null;
  const row = await ctx.db
    .prepare(
      `SELECT a.id, a.username, a.display_name, a.role_id
         FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
        WHERE s.id_hash = ? AND s.expires_at > ? AND a.status = 'active'`,
    )
    .bind(await sha256Hex(sessionToken), isoSec(ctx.now))
    .first<{ id: number; username: string; display_name: string; role_id: string }>();
  if (!row) return null;
  const { results } = await ctx.db
    .prepare("SELECT permission_id FROM role_permissions WHERE role_id = ? ORDER BY permission_id")
    .bind(row.role_id)
    .all<{ permission_id: string }>();
  return {
    admin: { id: row.id, username: row.username, display_name: row.display_name, role: row.role_id },
    permissions: results.map((p) => p.permission_id),
    csrf: await csrfFor(ctx.pepper, sessionToken),
  };
}

export async function logoutAdmin(ctx: AdminCtx, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken) return;
  await ctx.db.prepare("DELETE FROM admin_sessions WHERE id_hash = ?").bind(await sha256Hex(sessionToken)).run();
}

/** CSRF check for state-changing requests: header must equal the token derived from the session. */
export async function csrfValid(session: AdminSession, headerValue: string | null | undefined): Promise<boolean> {
  return !!headerValue && (await safeEqual(headerValue, session.csrf));
}

export function hasPermission(session: AdminSession, permission: string): boolean {
  return session.permissions.includes(permission);
}
