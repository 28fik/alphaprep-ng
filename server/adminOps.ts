import { hashPassword, hmacHex, safeEqual, verifyPassword, DEFAULT_PBKDF2_ITERATIONS, sha256Hex } from "./crypto.ts";
import type { Db } from "./db.ts";
import { isUniqueViolation } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { generateRecoveryCode } from "./participants.ts";
import { normalizeId, validateAdminPassword } from "./validation.ts";

export interface OpCtx {
  db: Db;
  now: Date;
  ipHash: string;
  adminId: number;
  pepper: string;
  iterations?: number;
}
type Out = { status: number; body: Record<string, unknown> };
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

// ---- participants --------------------------------------------------------------------------
export async function searchParticipants(db: Db, q: string, page = 1, pageSize = 25) {
  const size = Math.min(100, Math.max(1, pageSize));
  const like = `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`;
  const where = q.trim() ? "WHERE id LIKE ? ESCAPE '\\' OR first_name LIKE ? ESCAPE '\\' OR last_name LIKE ? ESCAPE '\\'" : "";
  const params = q.trim() ? [like, like, like] : [];
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM participants ${where}`).bind(...params).first<{ n: number }>();
  const { results } = await db
    .prepare(
      `SELECT id, first_name, last_name, status, created_at, (SELECT COUNT(*) FROM results r WHERE r.participant_id = participants.id) AS exams_taken
         FROM participants ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...params, size, (Math.max(1, page) - 1) * size)
    .all();
  return { rows: results, total: total?.n ?? 0, page, page_size: size };
}

export async function getParticipantAdmin(db: Db, rawId: string): Promise<Out> {
  const id = normalizeId(rawId);
  if (!id) return { status: 400, body: { error: "Invalid Participant ID." } };
  const p = await db
    .prepare("SELECT id, first_name, last_name, target_score, intended_course, preferred_institution, gender, status, suspended_reason, created_at FROM participants WHERE id = ?")
    .bind(id)
    .first();
  if (!p) return { status: 404, body: { error: "Participant not found." } };
  const subjects = (await db.prepare("SELECT subject_id FROM participant_subjects WHERE participant_id = ?").bind(id).all<{ subject_id: string }>()).results.map((s) => s.subject_id);
  const { results: results } = await db
    .prepare(
      `SELECT r.attempt_id, r.exam_date, r.total_score, r.duration_seconds, r.is_eligible, a.status, a.submit_reason,
              (SELECT COUNT(*) FROM result_adjustments x WHERE x.attempt_id = r.attempt_id) AS adjustments
         FROM results r JOIN attempts a ON a.id = r.attempt_id WHERE r.participant_id = ? ORDER BY r.exam_date DESC LIMIT 60`,
    )
    .bind(id)
    .all();
  const devices = await db.prepare("SELECT COUNT(*) AS n FROM participant_devices WHERE participant_id = ?").bind(id).first<{ n: number }>();
  return { status: 200, body: { participant: p, subjects, results, linked_devices: devices?.n ?? 0 } };
}

export async function setParticipantStatus(ctx: OpCtx, rawId: string, suspend: boolean, reason: unknown): Promise<Out> {
  const id = normalizeId(rawId);
  if (!id) return { status: 400, body: { error: "Invalid Participant ID." } };
  const why = typeof reason === "string" ? reason.trim().slice(0, 300) : "";
  if (suspend && why.length < 5) return { status: 400, body: { error: "Give a reason (at least 5 characters)." } };
  const r = await ctx.db
    .prepare("UPDATE participants SET status = ?, suspended_reason = ?, updated_at = ? WHERE id = ?")
    .bind(suspend ? "suspended" : "active", suspend ? why : null, iso(ctx.now), id)
    .run();
  if (!r.meta.changes) return { status: 404, body: { error: "Participant not found." } };
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: suspend ? "participant.suspend" : "participant.reinstate", targetType: "participant", targetId: id, details: { reason: why }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}

/** For a participant who lost their recovery code. Issues a new one (shown once) and unlinks every device. */
export async function resetRecoveryCode(ctx: OpCtx, rawId: string): Promise<Out> {
  const id = normalizeId(rawId);
  if (!id) return { status: 400, body: { error: "Invalid Participant ID." } };
  const code = generateRecoveryCode();
  const hash = await hmacHex(ctx.pepper, `rc:${id}:${code.replace("-", "")}`);
  const [r] = (await ctx.db.batch([
    ctx.db.prepare("UPDATE participants SET recovery_code_hash = ?, updated_at = ? WHERE id = ?").bind(hash, iso(ctx.now), id),
    ctx.db.prepare("DELETE FROM participant_devices WHERE participant_id = ?").bind(id),
  ])) as { meta: { changes: number } }[];
  if (!r.meta.changes) return { status: 404, body: { error: "Participant not found." } };
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "participant.reset_recovery", targetType: "participant", targetId: id, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { recovery_code: code, note: "Show this once to the participant. All their linked devices were signed out." } };
}

// ---- results -------------------------------------------------------------------------------
export async function adjustResult(ctx: OpCtx, attemptId: number, newTotal: unknown, reason: unknown): Promise<Out> {
  const t = Number(newTotal);
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!Number.isFinite(t) || t < 0 || t > 400) return { status: 400, body: { error: "Score must be between 0 and 400." } };
  if (why.length < 5 || why.length > 300) return { status: 400, body: { error: "Give a reason (5 to 300 characters)." } };
  const cur = await ctx.db.prepare("SELECT total_score FROM results WHERE attempt_id = ?").bind(attemptId).first<{ total_score: number }>();
  if (!cur) return { status: 404, body: { error: "Result not found." } };
  const rounded = Math.round(t * 100) / 100;
  await ctx.db.batch([
    ctx.db.prepare("INSERT INTO result_adjustments (attempt_id, admin_id, old_total, new_total, reason, created_at) VALUES (?,?,?,?,?,?)").bind(attemptId, ctx.adminId, cur.total_score, rounded, why, iso(ctx.now)),
    ctx.db.prepare("UPDATE results SET total_score = ? WHERE attempt_id = ?").bind(rounded, attemptId),
  ]);
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "result.adjust", targetType: "attempt", targetId: attemptId, details: { old: cur.total_score, new: rounded, reason: why }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true, old_total: cur.total_score, new_total: rounded } };
}

export async function setResultEligibility(ctx: OpCtx, attemptId: number, eligible: boolean, reason: unknown): Promise<Out> {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 5) return { status: 400, body: { error: "Give a reason (at least 5 characters)." } };
  const r = await ctx.db.prepare("UPDATE results SET is_eligible = ? WHERE attempt_id = ?").bind(eligible ? 1 : 0, attemptId).run();
  if (!r.meta.changes) return { status: 404, body: { error: "Result not found." } };
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: eligible ? "result.restore" : "result.hide", targetType: "attempt", targetId: attemptId, details: { reason: why }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}

// ---- overview / audit ----------------------------------------------------------------------
export async function overview(db: Db, today: string) {
  const one = async (sql: string, ...p: unknown[]) => (await db.prepare(sql).bind(...p).first<{ n: number }>())?.n ?? 0;
  return {
    participants: await one("SELECT COUNT(*) AS n FROM participants"),
    participants_suspended: await one("SELECT COUNT(*) AS n FROM participants WHERE status = 'suspended'"),
    attempts_today: await one("SELECT COUNT(*) AS n FROM attempts WHERE exam_date = ?", today),
    in_progress_now: await one("SELECT COUNT(*) AS n FROM attempts WHERE status = 'in_progress'"),
    results_today: await one("SELECT COUNT(*) AS n FROM results WHERE exam_date = ?", today),
    questions_total: await one("SELECT COUNT(*) AS n FROM questions"),
    questions_usable: await one("SELECT COUNT(*) AS n FROM questions q JOIN question_answer_keys k ON k.question_id = q.id WHERE q.is_active = 1 AND q.verification_status <> 'needs_review'"),
    questions_missing_key: await one("SELECT COUNT(*) AS n FROM questions WHERE id NOT IN (SELECT question_id FROM question_answer_keys)"),
    upcoming_exams: (await db.prepare("SELECT id, exam_date, title, status FROM exams WHERE exam_date >= ? AND status <> 'cancelled' ORDER BY exam_date LIMIT 5").bind(today).all()).results,
  };
}

export async function listAudit(db: Db, page = 1, action?: string, pageSize = 50) {
  const size = Math.min(100, Math.max(1, pageSize));
  const w = action ? "WHERE a.action LIKE ? ESCAPE '\\'" : "";
  const p = action ? [`${action.replace(/[\\%_]/g, "\\$&")}%`] : [];
  const total = await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs a ${w}`).bind(...p).first<{ n: number }>();
  const { results } = await db
    .prepare(
      `SELECT a.id, a.created_at, a.action, a.target_type, a.target_id, a.details_json, ad.username AS admin
         FROM audit_logs a LEFT JOIN admins ad ON ad.id = a.admin_id ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...p, size, (Math.max(1, page) - 1) * size)
    .all();
  return { rows: results, total: total?.n ?? 0, page, page_size: size };
}

// ---- administrators (admins.manage) ----------------------------------------------------------
export async function listAdmins(db: Db) {
  return (await db.prepare("SELECT id, username, display_name, role_id AS role, status, last_login_at, created_at FROM admins ORDER BY id").all()).results;
}

export async function createAdmin(ctx: OpCtx, raw: Record<string, unknown>): Promise<Out> {
  const username = typeof raw.username === "string" ? raw.username.trim() : "";
  const display = typeof raw.display_name === "string" ? raw.display_name.trim().slice(0, 60) : "";
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) return { status: 400, body: { error: "Username must be 3-40 characters: letters, numbers, dot, dash or underscore." } };
  if (!display) return { status: 400, body: { error: "Enter a display name." } };
  const pw = validateAdminPassword(raw.password, username);
  if (pw) return { status: 400, body: { error: pw } };
  const role = await ctx.db.prepare("SELECT id FROM roles WHERE id = ?").bind(raw.role).first();
  if (!role) return { status: 400, body: { error: "Unknown role." } };
  const hash = await hashPassword(raw.password as string, ctx.iterations ?? DEFAULT_PBKDF2_ITERATIONS);
  try {
    await ctx.db.prepare("INSERT INTO admins (username, display_name, password_hash, role_id, created_at) VALUES (?,?,?,?,?)").bind(username, display, hash, raw.role, iso(ctx.now)).run();
  } catch (e) {
    if (isUniqueViolation(e)) return { status: 409, body: { error: "That username is taken." } };
    throw e;
  }
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "admin.create", targetType: "admin", targetId: username, details: { role: raw.role }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 201, body: { ok: true } };
}

export async function setAdminStatus(ctx: OpCtx, targetId: number, status: "active" | "disabled", role?: unknown): Promise<Out> {
  const t = await ctx.db.prepare("SELECT id, role_id, status FROM admins WHERE id = ?").bind(targetId).first<{ id: number; role_id: string; status: string }>();
  if (!t) return { status: 404, body: { error: "Administrator not found." } };
  if (t.id === ctx.adminId && (status === "disabled" || (role !== undefined && role !== t.role_id))) {
    return { status: 409, body: { error: "You cannot disable or demote your own account." } };
  }
  const newRole = typeof role === "string" ? role : t.role_id;
  if (typeof role === "string" && !(await ctx.db.prepare("SELECT id FROM roles WHERE id = ?").bind(role).first())) return { status: 400, body: { error: "Unknown role." } };
  const losesSuper = t.role_id === "super_admin" && t.status === "active" && (status === "disabled" || newRole !== "super_admin");
  if (losesSuper) {
    const others = await ctx.db.prepare("SELECT COUNT(*) AS n FROM admins WHERE role_id = 'super_admin' AND status = 'active' AND id <> ?").bind(targetId).first<{ n: number }>();
    if (!others?.n) return { status: 409, body: { error: "There must always be at least one active super administrator." } };
  }
  await ctx.db.batch([
    ctx.db.prepare("UPDATE admins SET status = ?, role_id = ? WHERE id = ?").bind(status, newRole, targetId),
    ...(status === "disabled" || newRole !== t.role_id ? [ctx.db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").bind(targetId)] : []),
  ]);
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "admin.update", targetType: "admin", targetId, details: { status, role: newRole }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}

export async function changeOwnPassword(ctx: OpCtx, current: unknown, next: unknown): Promise<Out> {
  const me = await ctx.db.prepare("SELECT username, password_hash FROM admins WHERE id = ?").bind(ctx.adminId).first<{ username: string; password_hash: string }>();
  if (!me) return { status: 404, body: { error: "Not found." } };
  if (typeof current !== "string" || !(await verifyPassword(current, me.password_hash))) return { status: 403, body: { error: "Current password is incorrect." } };
  const pw = validateAdminPassword(next, me.username);
  if (pw) return { status: 400, body: { error: pw } };
  const hash = await hashPassword(next as string, ctx.iterations ?? DEFAULT_PBKDF2_ITERATIONS);
  await ctx.db.batch([
    ctx.db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?").bind(hash, ctx.adminId),
    // keep nothing but... all sessions are ended; the user signs in again
    ctx.db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?").bind(ctx.adminId),
  ]);
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "admin.change_password", targetType: "admin", targetId: ctx.adminId, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}
void safeEqual; void sha256Hex;
