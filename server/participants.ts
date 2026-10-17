import { hmacHex, randomInt, randomToken, safeEqual, sha256Hex } from "./crypto.ts";
import { isUniqueViolation, type Db } from "./db.ts";
import { hit, peek } from "./ratelimit.ts";
import { computePhase, currentExam, type Phase } from "./status.ts";
import {
  ENGLISH_ID,
  normalizeId,
  normalizeRecoveryCode,
  validateRegistration,
  validateSubjects,
} from "./validation.ts";

export interface Ctx {
  db: Db;
  pepper: string; // SESSION_PEPPER secret
  now: Date;
  ipHash: string;
  genId?: () => string; // injectable for tests
}

export interface Result {
  status: number;
  body: Record<string, unknown>;
  deviceToken?: string; // caller sets this as the participant device cookie
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

/** JAMB + 4 digits + 2 uppercase letters, e.g. JAMB4827QX */
export function generateParticipantId(): string {
  const digits = String(randomInt(10000)).padStart(4, "0");
  return `JAMB${digits}${LETTERS[randomInt(26)]}${LETTERS[randomInt(26)]}`;
}

export function generateRecoveryCode(): string {
  let c = "";
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

const tooMany = (retryAfterSeconds: number): Result => ({
  status: 429,
  body: { error: "Too many attempts. Please wait a few minutes and try again.", retry_after_seconds: retryAfterSeconds },
});

async function activeSubjectIds(db: Db): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT id FROM subjects WHERE is_active = 1 AND id != ?")
    .bind(ENGLISH_ID)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

const normName = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------
export async function registerParticipant(ctx: Ctx, raw: unknown): Promise<Result> {
  const { db, pepper, now } = ctx;

  const rl = await hit(db, `register:${ctx.ipHash}`, now, 3600, 20);
  if (!rl.allowed) return tooMany(rl.retryAfterSeconds);

  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // Honeypot: real users never see or fill this field.
  if (typeof obj.website === "string" && obj.website.trim() !== "") {
    return { status: 400, body: { error: "Invalid request." } };
  }

  const v = validateRegistration(raw, await activeSubjectIds(db));
  if (!v.ok) return { status: 400, body: { error: "Please correct the highlighted fields.", fields: v.errors } };
  const p = v.value;

  // Duplicate-registration guard (same name + course + institution). Reduces accidental and
  // casual duplicate IDs; a determined person can still vary spelling.
  const dedupe = await hmacHex(
    pepper,
    `dedupe:${[p.first_name, p.last_name, p.intended_course, p.preferred_institution].map(normName).join("|")}`,
  );
  const dup = await db.prepare("SELECT id FROM participants WHERE dedupe_hash = ?").bind(dedupe).first();
  if (dup) {
    return {
      status: 409,
      body: {
        error:
          "A participant with these details is already registered. Use your existing Participant ID. If you lost it, contact AlphaPrep NG support.",
      },
    };
  }

  const deviceToken = randomToken();
  const deviceHash = await sha256Hex(deviceToken);
  const recoveryCode = generateRecoveryCode();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  const gen = ctx.genId ?? generateParticipantId;
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = gen();
    const recoveryHash = await hmacHex(pepper, `rc:${id}:${recoveryCode.replace("-", "")}`);
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO participants (id, first_name, last_name, target_score, intended_course, preferred_institution,
               gender, dedupe_hash, created_ip_hash, recovery_code_hash, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .bind(
            id, p.first_name, p.last_name, p.target_score, p.intended_course, p.preferred_institution,
            p.gender, dedupe, ctx.ipHash, recoveryHash, nowIso, nowIso,
          ),
        ...p.subjects.map((s) =>
          db.prepare("INSERT INTO participant_subjects (participant_id, subject_id) VALUES (?,?)").bind(id, s),
        ),
        db
          .prepare("INSERT INTO participant_devices (participant_id, token_hash, created_at) VALUES (?,?,?)")
          .bind(id, deviceHash, nowIso),
      ]);
      return { status: 201, body: { participant_id: id, recovery_code: recoveryCode }, deviceToken };
    } catch (err) {
      // The database enforces uniqueness; on a collision just generate another ID.
      if (isUniqueViolation(err, "participants.id")) continue;
      throw err;
    }
  }
  return { status: 503, body: { error: "Could not generate a unique ID right now. Please try again." } };
}

// ---------------------------------------------------------------------------------------------
// Lookup / confirmation
// ---------------------------------------------------------------------------------------------
interface ParticipantRow {
  id: string;
  first_name: string;
  last_name: string;
  status: "active" | "suspended";
  recovery_code_hash: string | null;
}

async function loadParticipant(db: Db, id: string): Promise<ParticipantRow | null> {
  return db
    .prepare("SELECT id, first_name, last_name, status, recovery_code_hash FROM participants WHERE id = ?")
    .bind(id)
    .first<ParticipantRow>();
}

export async function isTrustedDevice(db: Db, participantId: string, deviceToken: string | undefined): Promise<boolean> {
  if (!deviceToken) return false;
  const row = await db
    .prepare("SELECT 1 AS ok FROM participant_devices WHERE participant_id = ? AND token_hash = ?")
    .bind(participantId, await sha256Hex(deviceToken))
    .first();
  return !!row;
}

export async function subjectChangePolicy(ctx: Ctx): Promise<{ allowed: boolean; reason?: string; deadline?: string }> {
  const { db, now } = ctx;
  const setting = await db
    .prepare("SELECT value FROM settings WHERE key = 'subject_change_cutoff_hours_before_exam'")
    .first<{ value: string }>();
  const cutoffHours = Math.max(0, Number(setting?.value ?? "2") || 0);
  const nowIso = now.toISOString();
  const horizon = new Date(now.getTime() + cutoffHours * 3600_000).toISOString();

  // Locked while any published exam is within its cutoff window or still open.
  const open = await db
    .prepare(
      `SELECT exam_date FROM exams WHERE status IN ('published','locked') AND ends_at > ? AND starts_at <= ? LIMIT 1`,
    )
    .bind(nowIso, horizon)
    .first<{ exam_date: string }>();
  if (open) {
    return {
      allowed: false,
      reason: `Subjects are locked for the ${open.exam_date} examination. You can change them after it closes.`,
    };
  }
  const next = await db
    .prepare(`SELECT starts_at FROM exams WHERE status IN ('published','locked') AND starts_at > ? ORDER BY starts_at LIMIT 1`)
    .bind(horizon)
    .first<{ starts_at: string }>();
  const deadline = next ? new Date(Date.parse(next.starts_at) - cutoffHours * 3600_000).toISOString() : undefined;
  return { allowed: true, deadline };
}

async function eligibility(ctx: Ctx, participantId: string) {
  const exam = await currentExam(ctx.db, ctx.now);
  const phase: Phase = computePhase(exam, ctx.now.toISOString());
  let alreadyAttempted = false;
  let inProgress = false;
  let covered = true;
  if (exam) {
    const a = await ctx.db
      .prepare("SELECT status, deadline_at FROM attempts WHERE participant_id = ? AND exam_id = ?")
      .bind(participantId, exam.id)
      .first<{ status: string; deadline_at: string }>();
    alreadyAttempted = !!a;
    inProgress = !!a && a.status === "in_progress" && a.deadline_at > ctx.now.toISOString();
    const miss = await ctx.db
      .prepare(
        `SELECT 1 AS m FROM (SELECT subject_id FROM participant_subjects WHERE participant_id = ? UNION SELECT 'english')
          WHERE subject_id NOT IN (SELECT subject_id FROM exam_subjects WHERE exam_id = ?) LIMIT 1`,
      )
      .bind(participantId, exam.id)
      .first();
    covered = !miss;
  }
  let reason: string | undefined;
  if (phase === "none") reason = "No examination is open right now.";
  else if (phase === "registration_open") reason = "The examination has not started yet.";
  else if (inProgress) reason = undefined;
  else if (phase === "closed" && !alreadyAttempted) reason = "Today's examination has closed.";
  else if (alreadyAttempted) reason = "You have already taken this examination.";
  else if (!covered) reason = "Today's examination does not include all of your subjects.";
  return {
    phase,
    exam: exam ? { exam_date: exam.exam_date, title: exam.title, starts_at: exam.starts_at, ends_at: exam.ends_at } : null,
    already_attempted: alreadyAttempted,
    in_progress: inProgress,
    can_start: (phase === "ongoing" && !alreadyAttempted && covered) || inProgress,
    reason,
  };
}

async function trustedProfile(ctx: Ctx, p: ParticipantRow): Promise<Record<string, unknown>> {
  const { results } = await ctx.db
    .prepare(
      `SELECT s.id, s.name FROM participant_subjects ps JOIN subjects s ON s.id = ps.subject_id
       WHERE ps.participant_id = ? ORDER BY s.sort_order`,
    )
    .bind(p.id)
    .all<{ id: string; name: string }>();
  const policy = await subjectChangePolicy(ctx);
  return {
    trusted: true,
    // Only what is needed to confirm identity: no target score, course, institution or gender.
    participant: { id: p.id, first_name: p.first_name, last_initial: p.last_name.charAt(0).toUpperCase() },
    subjects: [{ id: ENGLISH_ID, name: "Use of English" }, ...results],
    subject_change: policy,
    eligibility: await eligibility(ctx, p.id),
  };
}

/** Step 1 of returning: validate the ID. Unknown or untrusted devices learn almost nothing. */
export async function lookupParticipant(ctx: Ctx, rawId: unknown, deviceToken?: string): Promise<Result> {
  const { db, now } = ctx;
  const id = normalizeId(rawId);
  if (!id) return { status: 400, body: { error: "Enter your ID exactly as given, for example JAMB4827QX." } };

  // Stop ID-guessing: block after repeated misses, and cap total lookups.
  if ((await peek(db, `lookupfail:${ctx.ipHash}`, now, 900)) >= 10) return tooMany(900);
  const rl = await hit(db, `lookup:${ctx.ipHash}`, now, 600, 40);
  if (!rl.allowed) return tooMany(rl.retryAfterSeconds);

  const p = await loadParticipant(db, id);
  if (!p) {
    await hit(db, `lookupfail:${ctx.ipHash}`, now, 900, 10);
    return { status: 404, body: { error: "We couldn't find that Participant ID. Check it and try again." } };
  }

  if (!(await isTrustedDevice(db, id, deviceToken))) {
    // Do not reveal the name, profile, status or subjects to an unverified visitor.
    return { status: 200, body: { found: true, trusted: false } };
  }
  if (p.status === "suspended") {
    return { status: 403, body: { error: "This Participant ID is suspended. Contact AlphaPrep NG support." } };
  }
  return { status: 200, body: { found: true, ...(await trustedProfile(ctx, p)) } };
}

/** Step 2 on a new device: prove ownership with the recovery code shown at registration. */
export async function verifyRecovery(ctx: Ctx, rawId: unknown, rawCode: unknown): Promise<Result> {
  const { db, now, pepper } = ctx;
  const id = normalizeId(rawId);
  const code = normalizeRecoveryCode(rawCode);
  const bad: Result = { status: 401, body: { error: "That ID and recovery code do not match." } };
  if (!id || !code) return bad;

  const a = await hit(db, `recovery-ip:${ctx.ipHash}`, now, 900, 10);
  if (!a.allowed) return tooMany(a.retryAfterSeconds);
  const b = await hit(db, `recovery-id:${id}`, now, 900, 5);
  if (!b.allowed) return tooMany(b.retryAfterSeconds);

  const p = await loadParticipant(db, id);
  if (!p || !p.recovery_code_hash) return bad;
  const expected = await hmacHex(pepper, `rc:${id}:${code}`);
  if (!(await safeEqual(expected, p.recovery_code_hash))) return bad;
  if (p.status === "suspended") {
    return { status: 403, body: { error: "This Participant ID is suspended. Contact AlphaPrep NG support." } };
  }

  const deviceToken = randomToken();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  await db.batch([
    db.prepare("INSERT INTO participant_devices (participant_id, token_hash, created_at) VALUES (?,?,?)")
      .bind(id, await sha256Hex(deviceToken), nowIso),
    // keep at most 5 trusted devices per participant (drop the oldest)
    db.prepare(
      `DELETE FROM participant_devices WHERE participant_id = ? AND id NOT IN
         (SELECT id FROM participant_devices WHERE participant_id = ? ORDER BY id DESC LIMIT 5)`,
    ).bind(id, id),
  ]);
  return { status: 200, body: { found: true, ...(await trustedProfile(ctx, p)) }, deviceToken };
}

// ---------------------------------------------------------------------------------------------
// Subject combination changes (trusted device only, before the exam cutoff)
// ---------------------------------------------------------------------------------------------
export async function updateSubjects(ctx: Ctx, rawId: unknown, rawSubjects: unknown, deviceToken?: string): Promise<Result> {
  const { db, now } = ctx;
  const id = normalizeId(rawId);
  if (!id) return { status: 400, body: { error: "Invalid Participant ID." } };

  const rl = await hit(db, `subjects:${ctx.ipHash}`, now, 600, 20);
  if (!rl.allowed) return tooMany(rl.retryAfterSeconds);

  const p = await loadParticipant(db, id);
  if (!p || !(await isTrustedDevice(db, id, deviceToken))) {
    return { status: 403, body: { error: "Please confirm your Participant ID on this device first." } };
  }
  if (p.status === "suspended") return { status: 403, body: { error: "This Participant ID is suspended." } };

  const v = validateSubjects(rawSubjects, await activeSubjectIds(db));
  if (!v.ok) return { status: 400, body: { error: v.errors.subjects, fields: v.errors } };

  const policy = await subjectChangePolicy(ctx);
  if (!policy.allowed) return { status: 409, body: { error: policy.reason } };

  const inProgress = await db
    .prepare("SELECT 1 AS ok FROM attempts WHERE participant_id = ? AND status = 'in_progress'")
    .bind(id)
    .first();
  if (inProgress) return { status: 409, body: { error: "You cannot change subjects while an examination is in progress." } };

  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  await db.batch([
    db.prepare("DELETE FROM participant_subjects WHERE participant_id = ?").bind(id),
    ...v.value.map((s) => db.prepare("INSERT INTO participant_subjects (participant_id, subject_id) VALUES (?,?)").bind(id, s)),
    db.prepare("UPDATE participants SET updated_at = ? WHERE id = ?").bind(nowIso, id),
  ]);
  return { status: 200, body: { ok: true, ...(await trustedProfile(ctx, p)) } };
}
