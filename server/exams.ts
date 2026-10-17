import { randomInt } from "./crypto.ts";
import { isUniqueViolation, type Db } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { lagosDate } from "./time.ts";
import { ENGLISH_ID } from "./validation.ts";

export interface ECtx {
  db: Db;
  now: Date;
  ipHash: string;
  adminId: number;
  rng?: (maxExclusive: number) => number; // injectable for deterministic tests
}

export const MAX_GRACE_SECONDS = 120; // the largest late-submit grace an admin can set
export const ENGLISH_COUNT = 60;
export const OTHER_COUNT = 40;
export const questionCountFor = (subjectId: string) => (subjectId === ENGLISH_ID ? ENGLISH_COUNT : OTHER_COUNT);
const LETTERS = ["A", "B", "C", "D"] as const;
type Letter = (typeof LETTERS)[number];

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function parseTs(v: unknown): string | null {
  if (typeof v !== "string" || !TS_RE.test(v)) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : iso(t);
}

function validDate(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v) ? v : null;
}

export interface ExamInput {
  exam_date: string;
  title: string;
  registration_opens_at: string | null;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  correction_release_at: string;
  share_gate_enabled: boolean;
  shuffle_questions: boolean;
  shuffle_options: boolean;
}

export function validateExamInput(raw: Record<string, unknown>): { ok: true; value: ExamInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const exam_date = validDate(raw.exam_date);
  if (!exam_date) errors.exam_date = "Use a valid date (YYYY-MM-DD).";
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (title.length < 3 || title.length > 120) errors.title = "Title must be 3 to 120 characters.";
  const starts = parseTs(raw.starts_at);
  const ends = parseTs(raw.ends_at);
  if (!starts) errors.starts_at = "Invalid start time.";
  if (!ends) errors.ends_at = "Invalid end time.";
  const duration = Number(raw.duration_minutes ?? 120);
  if (!Number.isInteger(duration) || duration < 1 || duration > 300) errors.duration_minutes = "Duration must be 1 to 300 minutes.";
  let reg: string | null = null;
  if (raw.registration_opens_at) {
    reg = parseTs(raw.registration_opens_at);
    if (!reg) errors.registration_opens_at = "Invalid registration time.";
  }
  const corr = parseTs(raw.correction_release_at);
  if (!corr) errors.correction_release_at = "Invalid correction release time.";
  if (starts && ends && ends <= starts) errors.ends_at = "The window must end after it starts.";
  if (reg && starts && reg > starts) errors.registration_opens_at = "Registration must open before the exam starts.";
  // Answers must stay hidden until the LAST possible participant (who starts at ends_at) has finished.
  if (ends && corr && !errors.duration_minutes && Date.parse(corr) < Date.parse(ends) + duration * 60_000 + MAX_GRACE_SECONDS * 1000) {
    errors.correction_release_at = "Corrections must be released after the last start time plus the full exam duration (and a short grace period), so nobody sees answers mid-exam.";
  }
  // The exam is looked up by its Lagos calendar day, so the whole start window must fall on that day.
  if (exam_date && starts && lagosDate(new Date(starts)) !== exam_date) errors.starts_at = "The start time must be on the exam date (Lagos time).";
  if (exam_date && ends && lagosDate(new Date(ends)) !== exam_date) errors.ends_at = errors.ends_at ?? "The last start time must be on the exam date (Lagos time).";
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      exam_date: exam_date!, title, registration_opens_at: reg, starts_at: starts!, ends_at: ends!, duration_minutes: duration,
      correction_release_at: corr!, share_gate_enabled: raw.share_gate_enabled !== false && raw.share_gate_enabled !== 0,
      shuffle_questions: raw.shuffle_questions !== false && raw.shuffle_questions !== 0,
      shuffle_options: raw.shuffle_options !== false && raw.shuffle_options !== 0,
    },
  };
}

async function getExamRow(db: Db, id: number) {
  return db.prepare("SELECT * FROM exams WHERE id = ?").bind(id).first<Record<string, any>>();
}
const attemptsCount = async (db: Db, id: number) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE exam_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;

export async function createExam(ctx: ECtx, raw: Record<string, unknown>) {
  const v = validateExamInput(raw);
  if (!v.ok) return { status: 400, body: { error: "Please fix the highlighted fields.", errors: v.errors } };
  const e = v.value;
  const { results: subjects } = await ctx.db.prepare("SELECT id FROM subjects WHERE is_active = 1").all<{ id: string }>();
  const active = new Set(subjects.map((s) => s.id));
  let chosen: string[] = subjects.map((s) => s.id);
  if (Array.isArray(raw.subjects)) chosen = [...new Set(raw.subjects.filter((s): s is string => typeof s === "string" && active.has(s)))];
  if (!chosen.includes(ENGLISH_ID)) chosen.unshift(ENGLISH_ID);
  if (chosen.length < 4) return { status: 400, body: { error: "An exam needs English plus at least three other subjects." } };
  try {
    await ctx.db
      .prepare(
        `INSERT INTO exams (exam_date, title, status, registration_opens_at, starts_at, ends_at, duration_minutes, correction_release_at,
           share_gate_enabled, shuffle_questions, shuffle_options, created_by, created_at, updated_at) VALUES (?,?,'draft',?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(e.exam_date, e.title, e.registration_opens_at, e.starts_at, e.ends_at, e.duration_minutes, e.correction_release_at,
        +e.share_gate_enabled, +e.shuffle_questions, +e.shuffle_options, ctx.adminId, iso(+ctx.now), iso(+ctx.now))
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 409, body: { error: `An exam for ${e.exam_date} already exists.` } };
    throw err;
  }
  const row = await ctx.db.prepare("SELECT id FROM exams WHERE exam_date = ?").bind(e.exam_date).first<{ id: number }>();
  await ctx.db.batch(
    chosen.map((s) => ctx.db.prepare("INSERT INTO exam_subjects (exam_id, subject_id, question_count) VALUES (?,?,?)").bind(row!.id, s, questionCountFor(s))),
  );
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "exam.create", targetType: "exam", targetId: row!.id, details: { exam_date: e.exam_date }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 201, body: { id: row!.id } };
}

export async function updateExam(ctx: ECtx, id: number, raw: Record<string, unknown>) {
  const ex = await getExamRow(ctx.db, id);
  if (!ex) return { status: 404, body: { error: "Exam not found." } };
  if (ex.status === "cancelled") return { status: 409, body: { error: "A cancelled exam cannot be edited." } };
  const merged = { ...ex, ...raw };
  const v = validateExamInput(merged);
  if (!v.ok) return { status: 400, body: { error: "Please fix the highlighted fields.", errors: v.errors } };
  const e = v.value;
  const hasAttempts = (await attemptsCount(ctx.db, id)) > 0;
  if (hasAttempts) {
    // Participants already started: only the correction release time may move.
    const same = e.starts_at === ex.starts_at && e.ends_at === ex.ends_at && e.duration_minutes === ex.duration_minutes && e.exam_date === ex.exam_date;
    if (!same) return { status: 409, body: { error: "Participants have already started this exam. Only the correction release time can change now." } };
  }
  if (e.exam_date !== ex.exam_date && ex.status !== "draft") return { status: 409, body: { error: "The date can only change while the exam is a draft." } };
  try {
    await ctx.db
      .prepare(
        `UPDATE exams SET exam_date=?, title=?, registration_opens_at=?, starts_at=?, ends_at=?, duration_minutes=?, correction_release_at=?,
           share_gate_enabled=?, shuffle_questions=?, shuffle_options=?, updated_at=? WHERE id=?`,
      )
      .bind(e.exam_date, e.title, e.registration_opens_at, e.starts_at, e.ends_at, e.duration_minutes, e.correction_release_at,
        +e.share_gate_enabled, +e.shuffle_questions, +e.shuffle_options, iso(+ctx.now), id)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 409, body: { error: `An exam for ${e.exam_date} already exists.` } };
    throw err;
  }
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "exam.update", targetType: "exam", targetId: id, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}

export async function cancelExam(ctx: ECtx, id: number) {
  const ex = await getExamRow(ctx.db, id);
  if (!ex) return { status: 404, body: { error: "Exam not found." } };
  if (ex.status === "cancelled") return { status: 200, body: { ok: true } };
  if ((await attemptsCount(ctx.db, id)) > 0) return { status: 409, body: { error: "Participants have already started this exam, so it cannot be cancelled." } };
  await ctx.db.prepare("UPDATE exams SET status = 'cancelled', updated_at = ? WHERE id = ?").bind(iso(+ctx.now), id).run();
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "exam.cancel", targetType: "exam", targetId: id, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}

export async function listExams(db: Db) {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.exam_date, e.title, e.status, e.starts_at, e.ends_at, e.duration_minutes, e.correction_release_at, e.frozen_at,
              (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = e.id) AS questions_ready,
              (SELECT COALESCE(SUM(question_count),0) FROM exam_subjects s WHERE s.exam_id = e.id) AS questions_needed,
              (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id) AS attempts
         FROM exams e ORDER BY e.exam_date DESC LIMIT 200`,
    )
    .all();
  return results;
}

// ---- generation ----------------------------------------------------------------------------
type Rng = (n: number) => number;

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface PoolQ {
  id: number;
  topic: string | null;
  uses: number;
}

/** Round-robin across topics so no single topic dominates; inside a topic prefer least-used, then random. */
export function pickBalanced(pool: PoolQ[], count: number, rng: Rng): PoolQ[] {
  const byTopic = new Map<string, PoolQ[]>();
  for (const q of shuffle(pool, rng)) {
    const t = (q.topic ?? "General").toLowerCase();
    (byTopic.get(t) ?? byTopic.set(t, []).get(t)!).push(q);
  }
  for (const list of byTopic.values()) list.sort((a, b) => a.uses - b.uses); // stable: random order kept among ties
  const topics = shuffle([...byTopic.keys()], rng);
  const out: PoolQ[] = [];
  while (out.length < count) {
    let progressed = false;
    for (const t of topics) {
      const next = byTopic.get(t)!.shift();
      if (next) {
        out.push(next);
        progressed = true;
        if (out.length === count) break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

/** Shuffle the four options and return them with the correct letter remapped. */
export function shuffleOptions(opts: [string, string, string, string], correct: Letter, rng: Rng, doShuffle: boolean) {
  const order = doShuffle ? shuffle([0, 1, 2, 3], rng) : [0, 1, 2, 3];
  const newOpts = order.map((i) => opts[i]) as [string, string, string, string];
  const newCorrect = LETTERS[order.indexOf(LETTERS.indexOf(correct))];
  return { opts: newOpts, correct: newCorrect };
}

export async function generateSubject(ctx: ECtx, examId: number, subjectId: string) {
  const ex = await getExamRow(ctx.db, examId);
  if (!ex) return { status: 404, body: { error: "Exam not found." } };
  if (ex.frozen_at || !["draft", "approved"].includes(ex.status)) return { status: 409, body: { error: "This exam is published and frozen; its questions cannot change." } };
  const sub = await ctx.db.prepare("SELECT question_count FROM exam_subjects WHERE exam_id = ? AND subject_id = ?").bind(examId, subjectId).first<{ question_count: number }>();
  if (!sub) return { status: 404, body: { error: "That subject is not part of this exam." } };
  const need = sub.question_count;
  const rng = ctx.rng ?? randomInt;

  const { results } = await ctx.db
    .prepare(
      `SELECT q.id, q.topic, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.explanation, k.correct_option,
              (SELECT COUNT(*) FROM exam_questions eq WHERE eq.question_id = q.id) AS uses
         FROM questions q JOIN question_answer_keys k ON k.question_id = q.id
        WHERE q.subject_id = ? AND q.is_active = 1 AND q.verification_status IN ('verified','unverified')`,
    )
    .bind(subjectId)
    .all<{ id: number; topic: string | null; question_text: string; option_a: string; option_b: string; option_c: string; option_d: string; explanation: string | null; correct_option: Letter; uses: number }>();
  if (results.length < need) {
    return { status: 422, body: { error: `Not enough usable questions for ${subjectId}: need ${need}, have ${results.length}. Only questions with an answer key that are not 'needs review' can be used.`, available: results.length, needed: need } };
  }
  const byId = new Map(results.map((r) => [r.id, r]));
  let picked = pickBalanced(results.map((r) => ({ id: r.id, topic: r.topic, uses: r.uses })), need, rng);
  if (ex.shuffle_questions) picked = shuffle(picked, rng);

  const stmts = [ctx.db.prepare("DELETE FROM exam_questions WHERE exam_id = ? AND subject_id = ?").bind(examId, subjectId)];
  picked.forEach((p, i) => {
    const q = byId.get(p.id)!;
    const s = shuffleOptions([q.option_a, q.option_b, q.option_c, q.option_d], q.correct_option, rng, !!ex.shuffle_options);
    stmts.push(
      ctx.db
        .prepare(`INSERT INTO exam_questions (exam_id, subject_id, position, question_id, question_text, option_a, option_b, option_c, option_d, explanation) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .bind(examId, subjectId, i + 1, q.id, q.question_text, s.opts[0], s.opts[1], s.opts[2], s.opts[3], q.explanation),
      ctx.db
        .prepare(`INSERT INTO exam_answer_keys (exam_question_id, correct_option) SELECT id, ? FROM exam_questions WHERE exam_id = ? AND subject_id = ? AND position = ?`)
        .bind(s.correct, examId, subjectId, i + 1),
    );
  });
  // A draft that was approved goes back to draft because its content changed.
  stmts.push(ctx.db.prepare("UPDATE exams SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'approved'").bind(iso(+ctx.now), examId));
  await ctx.db.batch(stmts);
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "exam.generate", targetType: "exam", targetId: examId, details: { subject: subjectId, count: picked.length }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { subject: subjectId, generated: picked.length } };
}

/** Admin-only preview. Includes correct answers, so route it behind questions.read. */
export async function previewExam(db: Db, examId: number, opts: { now: Date; liveKeysAllowed: boolean }) {
  const exam = await getExamRow(db, examId);
  if (!exam) return { status: 404, body: { error: "Exam not found." } };
  // While a published exam can still be taken, only admins who manage exams may see its answer key.
  if (exam.frozen_at && exam.correction_release_at > iso(+opts.now) && !opts.liveKeysAllowed) {
    return { status: 403, body: { error: "The answer key of a live exam is only visible to exam managers until corrections are released." } };
  }
  const { results: subjects } = await db
    .prepare(
      `SELECT es.subject_id, es.question_count, (SELECT COUNT(*) FROM exam_questions q WHERE q.exam_id = es.exam_id AND q.subject_id = es.subject_id) AS generated
         FROM exam_subjects es JOIN subjects s ON s.id = es.subject_id WHERE es.exam_id = ? ORDER BY s.sort_order`,
    )
    .bind(examId)
    .all();
  const { results: questions } = await db
    .prepare(
      `SELECT q.id, q.subject_id, q.position, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.explanation, k.correct_option, b.topic
         FROM exam_questions q JOIN exam_answer_keys k ON k.exam_question_id = q.id LEFT JOIN questions b ON b.id = q.question_id
        WHERE q.exam_id = ? ORDER BY q.subject_id, q.position`,
    )
    .bind(examId)
    .all();
  return { status: 200, body: { exam, subjects, questions } };
}

async function completeness(db: Db, examId: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT es.subject_id, es.question_count AS need,
              (SELECT COUNT(*) FROM exam_questions q JOIN exam_answer_keys k ON k.exam_question_id = q.id WHERE q.exam_id = es.exam_id AND q.subject_id = es.subject_id) AS have
         FROM exam_subjects es WHERE es.exam_id = ?`,
    )
    .bind(examId)
    .all<{ subject_id: string; need: number; have: number }>();
  return results.filter((r) => r.have !== r.need).map((r) => `${r.subject_id}: ${r.have}/${r.need}`);
}

export async function approveExam(ctx: ECtx, id: number) {
  const ex = await getExamRow(ctx.db, id);
  if (!ex) return { status: 404, body: { error: "Exam not found." } };
  if (ex.status !== "draft") return { status: 409, body: { error: "Only a draft can be approved." } };
  const missing = await completeness(ctx.db, id);
  if (missing.length) return { status: 422, body: { error: "Some subjects are incomplete.", incomplete: missing } };
  await ctx.db.prepare("UPDATE exams SET status = 'approved', updated_at = ? WHERE id = ?").bind(iso(+ctx.now), id).run();
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "exam.approve", targetType: "exam", targetId: id, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}

export async function unapproveExam(ctx: ECtx, id: number) {
  const r = await ctx.db.prepare("UPDATE exams SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'approved' AND frozen_at IS NULL").bind(iso(+ctx.now), id).run();
  if (!r.meta.changes) return { status: 409, body: { error: "Only an approved, unpublished exam can go back to draft." } };
  return { status: 200, body: { ok: true } };
}

/** Publishing freezes the questions and keys permanently (also enforced by database triggers). */
export async function publishExam(ctx: ECtx, id: number) {
  const ex = await getExamRow(ctx.db, id);
  if (!ex) return { status: 404, body: { error: "Exam not found." } };
  if (ex.status !== "approved") return { status: 409, body: { error: "Approve the exam before publishing it." } };
  if (ex.ends_at <= iso(+ctx.now)) return { status: 422, body: { error: "The exam window has already ended. Reschedule it first." } };
  const missing = await completeness(ctx.db, id);
  if (missing.length) return { status: 422, body: { error: "Some subjects are incomplete.", incomplete: missing } };
  const t = iso(+ctx.now);
  const r = await ctx.db.prepare("UPDATE exams SET status = 'published', frozen_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'").bind(t, t, id).run();
  if (!r.meta.changes) return { status: 409, body: { error: "The exam changed while publishing. Reload and try again." } };
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "exam.publish", targetType: "exam", targetId: id, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}
