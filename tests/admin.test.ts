import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bootstrapAdmin, csrfValid, getSession, hasPermission, loginAdmin, logoutAdmin, setupStatus, type AdminCtx,
} from "../server/admin.ts";
import { hashPassword, verifyPassword } from "../server/crypto.ts";
import { createTestDb, FAST_PBKDF2, NOW, PEPPER } from "./helpers/d1.ts";

const SECRET = "bootstrap-secret-for-tests-only";
const PASSWORD = "correct horse battery staple";

function actx(db: ReturnType<typeof createTestDb>, over: Partial<AdminCtx> = {}): AdminCtx {
  return { db, pepper: PEPPER, now: NOW, ipHash: "ip-1", bootstrapSecret: SECRET, iterations: FAST_PBKDF2, ...over };
}
const setup = (db: ReturnType<typeof createTestDb>, over: Record<string, unknown> = {}) =>
  bootstrapAdmin(actx(db), { secret: SECRET, username: "owner", display_name: "Owner", password: PASSWORD, ...over });

// ---- password hashing ----------------------------------------------------------------------
test("password hashing: salted, verifiable, rejects wrong passwords and malformed hashes", async () => {
  const h1 = await hashPassword("a-long-password-123", FAST_PBKDF2);
  const h2 = await hashPassword("a-long-password-123", FAST_PBKDF2);
  assert.notEqual(h1, h2); // random salt
  assert.match(h1, /^pbkdf2-sha256\$1000\$/);
  assert.ok(!h1.includes("a-long-password-123"));
  assert.equal(await verifyPassword("a-long-password-123", h1), true);
  assert.equal(await verifyPassword("wrong", h1), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
  assert.equal(await verifyPassword("x", "pbkdf2-sha256$99999999$AAAA$AAAA"), false);
});

// ---- bootstrap -----------------------------------------------------------------------------
test("bootstrap: needs the secret, creates a super_admin once, then is disabled", async () => {
  const db = createTestDb();
  assert.equal((await setupStatus(db)).needs_setup, true);

  assert.equal((await bootstrapAdmin(actx(db), { secret: "wrong", username: "owner", display_name: "O", password: PASSWORD })).status, 403);
  assert.equal((await bootstrapAdmin(actx(db, { bootstrapSecret: undefined }), { secret: SECRET, username: "owner", display_name: "O", password: PASSWORD })).status, 503);
  assert.equal((await setup(db, { password: "short" })).status, 400);
  assert.equal((await setup(db, { username: "a b" })).status, 400);
  assert.equal((await setupStatus(db)).needs_setup, true);

  assert.equal((await setup(db)).status, 201);
  assert.equal((await setupStatus(db)).needs_setup, false);
  const row: any = db.raw.prepare("SELECT username, role_id, password_hash FROM admins").get();
  assert.equal(row.role_id, "super_admin");
  assert.ok(!row.password_hash.includes(PASSWORD));

  // even with the correct secret, a second admin cannot be created this way
  assert.equal((await setup(db, { username: "intruder" })).status, 403);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM admins").get() as any).n, 1);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='admin.bootstrap'").get() as any).n, 1);
});

test("bootstrap guessing is rate limited", async () => {
  const db = createTestDb();
  let s = 0;
  for (let i = 0; i < 7; i++) s = (await bootstrapAdmin(actx(db), { secret: `guess${i}`, username: "owner", display_name: "O", password: PASSWORD })).status;
  assert.equal(s, 429);
  assert.equal((await setupStatus(db)).needs_setup, true);
});

test("no admin exists by default: there are no hardcoded credentials", async () => {
  const db = createTestDb();
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM admins").get() as any).n, 0);
  assert.equal((await loginAdmin(actx(db), { username: "admin", password: "admin" })).status, 401);
});

// ---- login / sessions ----------------------------------------------------------------------
test("login: success creates a server-side session; the cookie value is never stored", async () => {
  const db = createTestDb();
  await setup(db);
  const r = await loginAdmin(actx(db), { username: "OWNER", password: PASSWORD }); // case-insensitive username
  assert.equal(r.status, 200);
  assert.ok(r.sessionToken && r.sessionToken.length >= 40);
  const stored = db.raw.prepare("SELECT id_hash FROM admin_sessions").all() as any[];
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].id_hash, r.sessionToken);
  assert.ok(!JSON.stringify(r.body).includes("password"));
  const s = await getSession(actx(db), r.sessionToken);
  assert.equal(s?.admin.username, "owner");
  assert.equal(s?.admin.role, "super_admin");
  assert.ok(s?.permissions.includes("admins.manage"));
});

test("login failures: generic message, no account enumeration", async () => {
  const db = createTestDb();
  await setup(db);
  const wrongPw = await loginAdmin(actx(db), { username: "owner", password: "wrong-password-123" });
  const noUser = await loginAdmin(actx(db), { username: "nobody", password: "wrong-password-123" });
  assert.equal(wrongPw.status, 401);
  assert.equal(noUser.status, 401);
  assert.deepEqual(wrongPw.body, noUser.body);
  assert.equal(wrongPw.sessionToken, undefined);
});

test("account locks after repeated failures, even for the right password, then unlocks", async () => {
  const db = createTestDb();
  await setup(db);
  for (let i = 0; i < 5; i++) await loginAdmin(actx(db, { ipHash: `ip-${i}` }), { username: "owner", password: "bad-password-xx" });
  const locked = await loginAdmin(actx(db, { ipHash: "ip-x" }), { username: "owner", password: PASSWORD });
  assert.equal(locked.status, 401);
  assert.equal(locked.sessionToken, undefined);
  const later = new Date(NOW.getTime() + 16 * 60_000);
  const ok = await loginAdmin(actx(db, { now: later, ipHash: "ip-y" }), { username: "owner", password: PASSWORD });
  assert.equal(ok.status, 200);
});

test("login attempts are rate limited per source", async () => {
  const db = createTestDb();
  await setup(db);
  let s = 0;
  for (let i = 0; i < 12; i++) s = (await loginAdmin(actx(db), { username: `user${i}`, password: "bad-password-xx" })).status;
  assert.equal(s, 429);
});

test("sessions expire, and logout destroys them", async () => {
  const db = createTestDb();
  await setup(db);
  const r = await loginAdmin(actx(db), { username: "owner", password: PASSWORD });
  assert.ok(await getSession(actx(db), r.sessionToken));
  assert.equal(await getSession(actx(db, { now: new Date(NOW.getTime() + 13 * 3600_000) }), r.sessionToken), null);
  assert.equal(await getSession(actx(db), "forged-token"), null);
  assert.equal(await getSession(actx(db), undefined), null);
  await logoutAdmin(actx(db), r.sessionToken);
  assert.equal(await getSession(actx(db), r.sessionToken), null);
});

test("disabled administrators lose access immediately", async () => {
  const db = createTestDb();
  await setup(db);
  const r = await loginAdmin(actx(db), { username: "owner", password: PASSWORD });
  db.raw.prepare("UPDATE admins SET status = 'disabled'").run();
  assert.equal(await getSession(actx(db), r.sessionToken), null);
  assert.equal((await loginAdmin(actx(db, { ipHash: "other" }), { username: "owner", password: PASSWORD })).status, 401);
});

// ---- CSRF and permissions ------------------------------------------------------------------
test("CSRF: only the token derived from the session is accepted", async () => {
  const db = createTestDb();
  await setup(db);
  const a = await loginAdmin(actx(db), { username: "owner", password: PASSWORD });
  const b = await loginAdmin(actx(db, { ipHash: "ip-b" }), { username: "owner", password: PASSWORD });
  const sa = (await getSession(actx(db), a.sessionToken))!;
  const sb = (await getSession(actx(db), b.sessionToken))!;
  assert.equal(await csrfValid(sa, sa.csrf), true);
  assert.equal(await csrfValid(sa, sb.csrf), false); // token from another session
  assert.equal(await csrfValid(sa, "guess"), false);
  assert.equal(await csrfValid(sa, null), false);
  assert.equal(await csrfValid(sa, ""), false);
});

test("role-based permissions are enforced from the database, not the client", async () => {
  const db = createTestDb();
  await setup(db);
  const hash = await hashPassword("viewer-password-123", FAST_PBKDF2);
  db.raw.prepare("INSERT INTO admins (username, display_name, password_hash, role_id) VALUES ('viewer1','V',?, 'viewer')").run(hash);
  db.raw.prepare("INSERT INTO admins (username, display_name, password_hash, role_id) VALUES ('editor1','E',?, 'content_editor')").run(hash);

  const v = await loginAdmin(actx(db, { ipHash: "v" }), { username: "viewer1", password: "viewer-password-123" });
  const e = await loginAdmin(actx(db, { ipHash: "e" }), { username: "editor1", password: "viewer-password-123" });
  const o = await loginAdmin(actx(db, { ipHash: "o" }), { username: "owner", password: PASSWORD });
  const sv = (await getSession(actx(db), v.sessionToken))!;
  const se = (await getSession(actx(db), e.sessionToken))!;
  const so = (await getSession(actx(db), o.sessionToken))!;

  assert.equal(hasPermission(sv, "reports.read"), true);
  assert.equal(hasPermission(sv, "questions.write"), false);
  assert.equal(hasPermission(sv, "admins.manage"), false);
  assert.equal(hasPermission(se, "questions.write"), true);
  assert.equal(hasPermission(se, "exams.write"), false);
  assert.equal(hasPermission(so, "admins.manage"), true);

  // privilege changes take effect on the next request
  db.raw.prepare("UPDATE admins SET role_id = 'viewer' WHERE username = 'owner'").run();
  assert.equal(hasPermission((await getSession(actx(db), o.sessionToken))!, "admins.manage"), false);
});
