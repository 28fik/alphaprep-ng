import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adjustResult, changeOwnPassword, createAdmin, getParticipantAdmin, listAudit, overview, resetRecoveryCode, searchParticipants,
  setAdminStatus, setParticipantStatus, setResultEligibility, type OpCtx,
} from "../server/adminOps.ts";
import { hashPassword, hmacHex, verifyPassword } from "../server/crypto.ts";
import { deleteAnnouncement, getLogo, getSettings, listAnnouncements, saveAnnouncement, saveLogo, updateSettings, type SCtx } from "../server/settings.ts";
import { lookupParticipant, verifyRecovery } from "../server/participants.ts";
import { createTestDb, FAST_PBKDF2, NOW, PEPPER } from "./helpers/d1.ts";
import { seedAdmin } from "./helpers/seed.ts";

function setup() {
  const db = createTestDb();
  const adminId = seedAdmin(db, "boss", "super_admin");
  const ctx: OpCtx = { db, now: NOW, ipHash: "ip", adminId, pepper: PEPPER, iterations: FAST_PBKDF2 };
  const sctx: SCtx = { db, now: NOW, ipHash: "ip", adminId };
  return { db, ctx, sctx, adminId };
}
function mkP(db: ReturnType<typeof createTestDb>, id = "JAMB1111AA") {
  db.raw.prepare("INSERT INTO participants (id, first_name, last_name, target_score, intended_course, preferred_institution, gender) VALUES (?,?,?,?,?,?,?)").run(id, "Ada", "Obi", 250, "Law", "UNILAG", "female");
  db.raw.prepare("INSERT INTO participant_subjects (participant_id, subject_id) VALUES (?, 'physics'),(?, 'chemistry'),(?, 'biology')").run(id, id, id);
  return id;
}
function mkResult(db: ReturnType<typeof createTestDb>, pid: string, score = 200) {
  db.raw.prepare("INSERT INTO exams (exam_date, title, status, starts_at, ends_at, correction_release_at) VALUES ('2026-10-14','m','published','2026-10-14T07:00:00Z','2026-10-14T19:00:00Z','2026-10-14T23:00:00Z')").run();
  db.raw.prepare("INSERT INTO attempts (exam_id, participant_id, exam_date, started_at, deadline_at, attempt_token_hash, status) VALUES (1,?,?,?,?,?,'submitted')").run(pid, "2026-10-14", "a", "b", "h");
  db.raw.prepare("INSERT INTO results (attempt_id, exam_id, participant_id, exam_date, total_score, duration_seconds, submitted_at) VALUES (1,1,?, '2026-10-14', ?, 100, 'x')").run(pid, score);
}

test("participants: search by id/name with wildcard escaping; detail view; suspend needs a reason and is audited", async () => {
  const { db, ctx } = setup();
  mkP(db); mkP(db, "JAMB2222BB");
  assert.equal((await searchParticipants(db, "JAMB1111")).total, 1);
  assert.equal((await searchParticipants(db, "ada")).total, 2);
  assert.equal((await searchParticipants(db, "%")).total, 0);
  assert.equal((await searchParticipants(db, "")).total, 2);
  const d: any = (await getParticipantAdmin(db, "jamb1111aa")).body;
  assert.equal(d.participant.intended_course, "Law");
  assert.deepEqual(d.subjects.sort(), ["biology", "chemistry", "physics"]);
  assert.equal((await getParticipantAdmin(db, "bad")).status, 400);
  assert.equal((await getParticipantAdmin(db, "JAMB9999ZZ")).status, 404);

  assert.equal((await setParticipantStatus(ctx, "JAMB1111AA", true, "x")).status, 400);
  assert.equal((await setParticipantStatus(ctx, "JAMB1111AA", true, "cheating with two devices")).status, 200);
  assert.equal((db.raw.prepare("SELECT status s FROM participants WHERE id='JAMB1111AA'").get() as any).s, "suspended");
  assert.equal((await setParticipantStatus(ctx, "JAMB1111AA", false, "")).status, 200);
  assert.equal((await setParticipantStatus(ctx, "JAMB0000ZZ", false, "")).status, 404);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action LIKE 'participant.%'").get() as any).n, 2);
});

test("lost recovery code: admin issues a new one, old code dies, devices are unlinked, new code works once linked", async () => {
  const { db, ctx } = setup();
  const id = mkP(db);
  const oldCode = "AAAA-BBBB";
  db.raw.prepare("UPDATE participants SET recovery_code_hash = ? WHERE id = ?").run(await hmacHex(PEPPER, `rc:${id}:AAAABBBB`), id);
  db.raw.prepare("INSERT INTO participant_devices (participant_id, token_hash, created_at) VALUES (?,?,?)").run(id, "h1", "t");
  const r: any = (await resetRecoveryCode(ctx, id)).body;
  assert.match(r.recovery_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM participant_devices").get() as any).n, 0);
  const pctx = { db, pepper: PEPPER, now: NOW, ipHash: "ip2" };
  assert.equal((await verifyRecovery(pctx, id, oldCode)).status, 401);
  const ok = await verifyRecovery(pctx, id, r.recovery_code);
  assert.equal(ok.status, 200);
  assert.ok(ok.deviceToken);
  assert.equal(((await lookupParticipant(pctx, id, ok.deviceToken)).body as any).trusted, true);
  // the audit log must not contain the code
  assert.equal(JSON.stringify(db.raw.prepare("SELECT * FROM audit_logs").all()).includes(r.recovery_code), false);
  assert.equal((await resetRecoveryCode(ctx, "JAMB0000ZZ")).status, 404);
});

test("result adjustment: validated, keeps an audit trail of old/new/reason, never silent", async () => {
  const { db, ctx } = setup();
  const id = mkP(db);
  mkResult(db, id, 200);
  assert.equal((await adjustResult(ctx, 1, 401, "too high")).status, 400);
  assert.equal((await adjustResult(ctx, 1, -1, "too low ok")).status, 400);
  assert.equal((await adjustResult(ctx, 1, 250, "no")).status, 400);
  assert.equal((await adjustResult(ctx, 99, 250, "good reason")).status, 404);
  const r: any = (await adjustResult(ctx, 1, 250.456, "re-marked after answer-key fix")).body;
  assert.equal(r.old_total, 200);
  assert.equal((db.raw.prepare("SELECT total_score s FROM results WHERE attempt_id=1").get() as any).s, 250.46);
  const adj: any = db.raw.prepare("SELECT old_total, new_total, reason, admin_id FROM result_adjustments").get();
  assert.deepEqual({ ...adj }, { old_total: 200, new_total: 250.46, reason: "re-marked after answer-key fix", admin_id: ctx.adminId });
  assert.equal((await setResultEligibility(ctx, 1, false, "x")).status, 400);
  assert.equal((await setResultEligibility(ctx, 1, false, "suspected cheating")).status, 200);
  assert.equal((db.raw.prepare("SELECT is_eligible e FROM results WHERE attempt_id=1").get() as any).e, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM v_daily_leaderboard").get() as any).n, 0);
});

test("administrators: create with validation, last super admin protected, no self-lockout, sessions revoked", async () => {
  const { db, ctx, adminId } = setup();
  assert.equal((await createAdmin(ctx, { username: "ed", display_name: "Ed", password: "long enough password", role: "viewer" })).status, 400);
  assert.equal((await createAdmin(ctx, { username: "editor1", display_name: "Ed", password: "short", role: "viewer" })).status, 400);
  assert.equal((await createAdmin(ctx, { username: "editor1", display_name: "Ed", password: "long enough password", role: "root" })).status, 400);
  assert.equal((await createAdmin(ctx, { username: "editor1", display_name: "Ed", password: "long enough password", role: "content_editor" })).status, 201);
  assert.equal((await createAdmin(ctx, { username: "EDITOR1", display_name: "Ed", password: "long enough password", role: "viewer" })).status, 409); // case-insensitive
  const ed: any = db.raw.prepare("SELECT id, password_hash FROM admins WHERE username='editor1'").get();
  assert.ok(!ed.password_hash.includes("long enough"));

  assert.equal((await setAdminStatus(ctx, adminId, "disabled")).status, 409); // not yourself
  assert.equal((await setAdminStatus(ctx, adminId, "active", "viewer")).status, 409);
  const second = seedAdmin(db, "second", "super_admin");
  db.raw.prepare("INSERT INTO admin_sessions (id_hash, admin_id, csrf_token_hash, ip_hash, created_at, expires_at) VALUES ('s',?,'c','i','a','z')").run(second);
  assert.equal((await setAdminStatus({ ...ctx, adminId: second }, adminId, "disabled")).status, 200);
  assert.equal((await setAdminStatus({ ...ctx, adminId: ed.id }, second, "disabled")).status, 409); // would leave nobody? (second is last active super)
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM admin_sessions WHERE admin_id = ?").get(second) as any).n, 1);
  assert.equal((await setAdminStatus(ctx, 9999, "disabled")).status, 404);
});

test("own password change: needs the current password, enforces rules, ends sessions", async () => {
  const { db, ctx, adminId } = setup();
  db.raw.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(await hashPassword("old password 12345", FAST_PBKDF2), adminId);
  db.raw.prepare("INSERT INTO admin_sessions (id_hash, admin_id, csrf_token_hash, ip_hash, created_at, expires_at) VALUES ('s',?,'c','i','a','z')").run(adminId);
  assert.equal((await changeOwnPassword(ctx, "wrong", "new password 12345")).status, 403);
  assert.equal((await changeOwnPassword(ctx, "old password 12345", "short")).status, 400);
  assert.equal((await changeOwnPassword(ctx, "old password 12345", "new password 12345")).status, 200);
  const row: any = db.raw.prepare("SELECT password_hash h FROM admins WHERE id = ?").get(adminId);
  assert.equal(await verifyPassword("new password 12345", row.h), true);
  assert.equal(await verifyPassword("old password 12345", row.h), false);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM admin_sessions").get() as any).n, 0);
});

test("settings: only known keys, strict validation, social links stay on official domains, public subset hides internals", async () => {
  const { db, sctx } = setup();
  assert.equal((await updateSettings(sctx, { evil_key: "1" })).status, 400);
  const bad: any = (await updateSettings(sctx, { social_x: "https://evil.example/alphaprepng", social_tiktok: "http://tiktok.com/@a", utme_countdown_date: "soon", late_submit_grace_seconds: "999", tab_hidden_policy: "nuke" })).body;
  assert.deepEqual(Object.keys(bad.errors).sort(), ["late_submit_grace_seconds", "social_tiktok", "social_x", "tab_hidden_policy", "utme_countdown_date"]);
  assert.equal((await updateSettings(sctx, { social_x: "https://x.com/alphaprepng", whatsapp_gate_enabled: "0" })).status, 200); // unchanged values also fine
  assert.equal((await updateSettings(sctx, { social_x: "https://x.com.evil.com/a" })).status, 400);
  assert.equal((await updateSettings(sctx, { site_url: "javascript:alert(1)" })).status, 400);
  assert.equal((await updateSettings(sctx, { utme_countdown_date: "2027-05-01T08:00:00+01:00", utme_countdown_label: "UTME 2027" })).status, 200);
  assert.equal((await updateSettings(sctx, null)).status, 400);
  assert.equal((await updateSettings(sctx, {})).status, 400);
  const pub = await getSettings(db, true);
  assert.equal(pub.utme_countdown_label, "UTME 2027");
  assert.equal(pub.late_submit_grace_seconds, undefined);
  assert.equal((await getSettings(db)).late_submit_grace_seconds, "30");
});

test("announcements: create, edit, delete, validated; logo: images only, size capped, SVG refused", async () => {
  const { db, sctx } = setup();
  assert.equal((await saveAnnouncement(sctx, null, { title: "", body: "x" })).status, 400);
  assert.equal((await saveAnnouncement(sctx, null, { title: "Hello", body: "x".repeat(1001) })).status, 400);
  assert.equal((await saveAnnouncement(sctx, null, { title: "<b>Hi</b>", body: "Exam on Monday", is_published: true })).status, 201);
  const id = ((await listAnnouncements(db))[0] as any).id;
  assert.equal((await saveAnnouncement(sctx, id, { title: "Hi", body: "Moved", is_published: false })).status, 200);
  assert.equal((await saveAnnouncement(sctx, 999, { title: "Hi", body: "Moved" })).status, 404);
  assert.equal((await deleteAnnouncement(sctx, id)).status, 200);
  assert.equal((await deleteAnnouncement(sctx, id)).status, 404);

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
  assert.equal((await saveLogo(sctx, new TextEncoder().encode("<svg onload=alert(1)></svg>"))).status, 400);
  assert.equal((await saveLogo(sctx, new Uint8Array(0))).status, 400);
  assert.equal((await saveLogo(sctx, new Uint8Array(300_001))).status, 400);
  assert.equal((await saveLogo(sctx, png)).status, 200);
  const logo = await getLogo(db);
  assert.equal(logo?.type, "image/png");
  assert.deepEqual([...logo!.data].slice(0, 4), [0x89, 0x50, 0x4e, 0x47]);
});

test("overview and audit viewer: counts, pagination, action filter, no secrets", async () => {
  const { db, ctx, sctx } = setup();
  mkP(db);
  const o: any = await overview(db, "2026-10-14");
  assert.equal(o.participants, 1);
  assert.equal(o.questions_total, 0);
  for (let i = 0; i < 60; i++) await updateSettings(sctx, { utme_countdown_label: `Label ${i}` });
  await setParticipantStatus(ctx, "JAMB1111AA", true, "a proper reason");
  const p1: any = await listAudit(db, 1);
  assert.equal(p1.rows.length, 50);
  assert.equal(p1.total, 61);
  assert.equal((await listAudit(db, 2)).rows.length, 11);
  assert.equal(((await listAudit(db, 1, "participant.")) as any).total, 1);
  assert.equal(((await listAudit(db, 1, "%")) as any).total, 0); // wildcard escaped
});
