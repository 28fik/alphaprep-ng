import { randomToken, sha256Hex } from "./crypto.ts";
import { isUniqueViolation, type Db } from "./db.ts";
import { isTrustedDevice, type Ctx } from "./participants.ts";
import { hit } from "./ratelimit.ts";
import { computePhase, currentExam } from "./status.ts";
import { ENGLISH_ID, normalizeId } from "./validation.ts";

// All timing, scoring and eligibility decisions happen here, on the server clock.
// The browser only ever sends answers. It never sends a score, a time or a correct option.

export interface Out {
  status: number;
  body: Record<string, unknown>;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const LETTER = /^[ABCD]$/;
export const MAX_ANSWER_KEYS_PER_SAVE = 200;
export const MIN_SAVE_GAP_MS = 1500;

async function settingNum(db: Db, key: string, fallback: number): Promise<number> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  const n = Number(r?.value);
  return Number.isFinite(n) ? n : fallback;
}

interface AttemptRow {
  id: number;
  exam_id: number;
  participant_id: string;
  exam_date: string;
  started_at: string;
  deadline_at: string;
  status: string;
  answers_json: string;
  answers_saved_at: string | null;
}

/** True when every id is a question on THIS attempt's paper. Chunked: D1 allows only 100 bound parameters per query. */
async function allOnPaper(db: Db, examId: number, attemptId: number, ids: string[]): Promise<boolean> {
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    const { results } = await db
      .prepare(
        `SELECT id FROM exam_questions WHERE exam_id = ? AND id IN (${part.map(() => "?").join(",")})
           AND (subject_id = ? OR subject_id IN (SELECT subject_id FROM attempt_subjects WHERE attempt_id = ?))`,
      )
      .bind(examId, ...part, ENGLISH_ID, attemptId)
      .all<{ id: number }>();
    if (results.length !== part.length) return false;
  }
  return true;
}

async function loadAttempt(db: Db, id: number, token: string | undefined): Promise<AttemptRow | null> {
  if (!Number.isInteger(id) || !token) return null;
  return db
    .prepare(
      `SELECT id, exam_id, participant_id, exam_date, started_at, deadline_at, status, answers_json, answers_saved_at
         FROM attempts WHERE id = ? AND attempt_token_hash = ?`,
    )
    .bind(id, await sha256Hex(token))
    .first<AttemptRow>();
}

// ---- start / resume ------------------------------------------------------------------------
export async function startAttempt(ctx: Ctx, rawId: unknown, deviceToken: string | undefined, body: { share_confirmed?: unknown }): Promise<Out> {
  const { db, now } = ctx;
  const id = normalizeId(rawId);
  if (!id) return { status: 400, body: { error: "Enter a valid Participant ID." } };
  // Keyed on the caller's IP, not the ID: otherwise anyone could lock a victim out by spamming their ID.
  const rl = await hit(db, `start:${ctx.ipHash}`, now, 900, 30);
  if (!rl.allowed) return { status: 429, body: { error: "Too many attempts. Please wait a few minutes.", retry_after_seconds: rl.retryAfterSeconds } };

  const p = await db.prepare("SELECT id, status FROM participants WHERE id = ?").bind(id).first<{ id: string; status: string }>();
  if (!p || !(await isTrustedDevice(db, id, deviceToken))) {
    return { status: 403, body: { error: "This device is not linked to that Participant ID. Use your recovery code on the Continue page first." } };
  }
  if (p.status !== "active") return { status: 403, body: { error: "This participant account is suspended. Please contact the administrator." } };

  const exam = await currentExam(db, now);
  const phase = computePhase(exam, iso(now));
  const full = exam ? await db.prepare("SELECT id, exam_date, duration_minutes, share_gate_enabled FROM exams WHERE id = ?").bind(exam.id).first<{ id: number; exam_date: string; duration_minutes: number; share_gate_enabled: number }>() : null;

  // An unfinished attempt can always be resumed (until its own deadline), even after the start window closed
  // or after midnight. An overdue one is closed with the answers saved so far.
  const open = await db
    .prepare("SELECT id, deadline_at FROM attempts WHERE participant_id = ? AND status = 'in_progress' ORDER BY id DESC LIMIT 1")
    .bind(id)
    .first<{ id: number; deadline_at: string }>();
  if (open) {
    if (open.deadline_at > iso(now)) {
      const token = randomToken();
      await db.prepare("UPDATE attempts SET attempt_token_hash = ? WHERE id = ? AND status = 'in_progress'").bind(await sha256Hex(token), open.id).run();
      return { status: 200, body: { attempt_id: open.id, attempt_token: token, deadline_at: open.deadline_at, server_now: iso(now), resumed: true } };
    }
    await finalizeAttempt(db, open.id, "timeout", now);
  }
  if (full) {
    const taken = await db.prepare("SELECT 1 AS t FROM attempts WHERE participant_id = ? AND exam_id = ?").bind(id, full.id).first();
    if (taken) return { status: 409, body: { error: "You have already taken this examination." } };
  }

  if (!full || phase !== "ongoing") {
    const msg = phase === "closed" ? "Today's examination has closed." : phase === "registration_open" ? "The examination has not started yet." : "No examination is open right now.";
    return { status: 409, body: { error: msg } };
  }
  const miss = await db
    .prepare(
      `SELECT 1 AS m FROM (SELECT subject_id FROM participant_subjects WHERE participant_id = ? UNION SELECT 'english')
        WHERE subject_id NOT IN (SELECT subject_id FROM exam_subjects WHERE exam_id = ?) LIMIT 1`,
    )
    .bind(id, full.id)
    .first();
  if (miss) return { status: 409, body: { error: "Today's examination does not include all of your subjects." } };

  const gateOn = full.share_gate_enabled === 1 && (await db.prepare("SELECT value FROM settings WHERE key = 'whatsapp_gate_enabled'").first<{ value: string }>())?.value === "1";
  if (gateOn && body.share_confirmed !== true) {
    // We cannot verify that anything was sent; the participant only confirms they did it.
    return { status: 400, body: { error: "Please share the exam on WhatsApp, then tick the confirmation box.", needs_share: true } };
  }

  const token = randomToken();
  const deadline = iso(new Date(now.getTime() + full.duration_minutes * 60_000));
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO attempts (exam_id, participant_id, exam_date, share_confirmed_at, started_at, deadline_at, attempt_token_hash, created_at)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .bind(full.id, id, full.exam_date, gateOn ? iso(now) : null, iso(now), deadline, await sha256Hex(token), iso(now)),
      db
        .prepare(
          `INSERT INTO attempt_subjects (attempt_id, subject_id)
           SELECT (SELECT id FROM attempts WHERE participant_id = ? AND exam_id = ?), subject_id FROM participant_subjects WHERE participant_id = ?`,
        )
        .bind(id, full.id, id),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) return { status: 409, body: { error: "You have already taken this examination." } };
    throw e;
  }
  const row = await db.prepare("SELECT id FROM attempts WHERE participant_id = ? AND exam_id = ?").bind(id, full.id).first<{ id: number }>();
  return { status: 201, body: { attempt_id: row!.id, attempt_token: token, deadline_at: deadline, server_now: iso(now), resumed: false } };
}

// ---- reading the paper (never includes answer keys) -----------------------------------------
export async function getPaper(ctx: Pick<Ctx, "db" | "now">, attemptId: number, token: string | undefined): Promise<Out> {
  const { db, now } = ctx;
  const a = await loadAttempt(db, attemptId, token);
  if (!a) return { status: 403, body: { error: "This exam session is not valid. Open the Continue page to resume." } };
  const grace = await settingNum(db, "late_submit_grace_seconds", 30);
  if (a.status === "in_progress" && Date.parse(a.deadline_at) + grace * 1000 <= +now) await finalizeAttempt(db, a.id, "timeout", now);
  const cur = a.status === "in_progress" ? await db.prepare("SELECT status FROM attempts WHERE id = ?").bind(a.id).first<{ status: string }>() : { status: a.status };
  if (cur?.status !== "in_progress") return { status: 200, body: { finished: true } };

  const { results } = await db
    .prepare(
      `SELECT q.id, q.subject_id, q.position, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, s.name AS subject_name
         FROM exam_questions q JOIN subjects s ON s.id = q.subject_id
        WHERE q.exam_id = ? AND (q.subject_id = ? OR q.subject_id IN (SELECT subject_id FROM attempt_subjects WHERE attempt_id = ?))
        ORDER BY CASE WHEN q.subject_id = ? THEN -1 ELSE s.sort_order END, q.position`,
    )
    .bind(a.exam_id, ENGLISH_ID, a.id, ENGLISH_ID)
    .all<{ id: number; subject_id: string; position: number; question_text: string; option_a: string; option_b: string; option_c: string; option_d: string; subject_name: string }>();
  const policy = (await db.prepare("SELECT value FROM settings WHERE key = 'tab_hidden_policy'").first<{ value: string }>())?.value ?? "auto_submit";
  return {
    status: 200,
    body: {
      finished: false,
      deadline_at: a.deadline_at,
      server_now: iso(now),
      tab_hidden_policy: policy,
      answers: JSON.parse(a.answers_json || "{}"),
      questions: results.map((q) => ({
        id: q.id, subject_id: q.subject_id, subject_name: q.subject_name, position: q.position, text: q.question_text,
        options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
      })),
    },
  };
}

// ---- autosave (one row write per call) -------------------------------------------------------
/** `answers` is a delta: {"<exam_question_id>": "A" | null}. null clears an answer. */
export async function saveAnswers(ctx: Pick<Ctx, "db" | "now">, attemptId: number, token: string | undefined, answers: unknown): Promise<Out> {
  const { db, now } = ctx;
  const a = await loadAttempt(db, attemptId, token);
  if (!a) return { status: 403, body: { error: "This exam session is not valid." } };
  if (a.status !== "in_progress") return { status: 409, body: { finished: true, error: "This exam has already been submitted." } };
  const grace = await settingNum(db, "late_submit_grace_seconds", 30);
  if (Date.parse(a.deadline_at) + grace * 1000 <= +now) {
    await finalizeAttempt(db, a.id, "timeout", now);
    return { status: 409, body: { finished: true, error: "Time is up. Your exam was submitted." } };
  }
  const delta = parseDelta(answers);
  if (!delta) return { status: 400, body: { error: "Invalid answers." } };
  if (a.answers_saved_at && +now - Date.parse(a.answers_saved_at) < MIN_SAVE_GAP_MS) return { status: 429, body: { error: "Saving too quickly.", retry_after_seconds: 2 } };
  const ids = Object.keys(delta);
  if (ids.length === 0) return { status: 200, body: { saved: 0, server_now: iso(now), deadline_at: a.deadline_at } };

  // Only questions that belong to THIS attempt's paper may be answered.
  if (!(await allOnPaper(db, a.exam_id, a.id, ids))) return { status: 400, body: { error: "Some answers do not belong to your paper." } };

  const merged: Record<string, string> = JSON.parse(a.answers_json || "{}");
  for (const [k, v] of Object.entries(delta)) {
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  // Compare-and-set on the previous value so two tabs cannot silently overwrite each other's blob.
  const r = await db
    .prepare("UPDATE attempts SET answers_json = ?, answers_saved_at = ? WHERE id = ? AND status = 'in_progress' AND answers_json = ?")
    .bind(JSON.stringify(merged), now.toISOString(), a.id, a.answers_json)
    .run();
  if (!r.meta.changes) return { status: 409, body: { error: "Your answers changed in another tab. Reload to continue.", conflict: true } };
  return { status: 200, body: { saved: ids.length, answered: Object.keys(merged).length, server_now: iso(now), deadline_at: a.deadline_at } };
}

function parseDelta(raw: unknown): Record<string, string | null> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ANSWER_KEYS_PER_SAVE) return null;
  const out: Record<string, string | null> = {};
  for (const [k, v] of entries) {
    if (!/^\d{1,9}$/.test(k)) return null;
    if (v === null) out[k] = null;
    else if (typeof v === "string" && LETTER.test(v)) out[k] = v;
    else return null;
  }
  return out;
}

// ---- submit + scoring ------------------------------------------------------------------------
export async function submitAttempt(
  ctx: Pick<Ctx, "db" | "now">,
  attemptId: number,
  token: string | undefined,
  opts: { answers?: unknown; reason?: unknown },
): Promise<Out> {
  const { db, now } = ctx;
  const a = await loadAttempt(db, attemptId, token);
  if (!a) return { status: 403, body: { error: "This exam session is not valid." } };
  const a_ = a;
  if (a.status !== "in_progress") return { status: 200, body: { already_submitted: true, ...(await resultForAttempt(db, a.id)) } };

  const grace = await settingNum(db, "late_submit_grace_seconds", 30);
  const late = Date.parse(a.deadline_at) <= +now;
  let reason: "manual" | "tab_hidden" | "timeout" = opts.reason === "tab_hidden" ? "tab_hidden" : "manual";
  if (late) reason = "timeout";
  // Final answers sent with the submit are accepted only inside the deadline plus the small grace period.
  let answers: Record<string, string> = JSON.parse(a.answers_json || "{}");
  if (Date.parse(a.deadline_at) + grace * 1000 > +now && opts.answers !== undefined) {
    const delta = parseDelta(opts.answers);
    if (!delta) return { status: 400, body: { error: "Invalid answers." } };
    const ids = Object.keys(delta);
    if (ids.length) {
      if (!(await allOnPaper(db, a_.exam_id, a_.id, ids))) return { status: 400, body: { error: "Some answers do not belong to your paper." } };
      for (const [k, v] of Object.entries(delta)) {
        if (v === null) delete answers[k];
        else answers[k] = v;
      }
    }
  }
  await finalizeAttempt(db, a.id, reason, now, answers);
  return { status: 200, body: { submitted: true, ...(await resultForAttempt(db, a.id)) } };
}

/**
 * Score and close an attempt. Idempotent and race-safe: the status flip and the result rows are one atomic
 * batch, results use INSERT OR IGNORE, so concurrent or repeated submissions can never create a second result.
 */
export async function finalizeAttempt(
  db: Db,
  attemptId: number,
  reason: "manual" | "tab_hidden" | "timeout" | "server_sweep",
  now: Date,
  answersOverride?: Record<string, string>,
): Promise<void> {
  const a = await db
    .prepare("SELECT id, exam_id, participant_id, exam_date, started_at, deadline_at, status, answers_json FROM attempts WHERE id = ?")
    .bind(attemptId)
    .first<AttemptRow>();
  if (!a || a.status !== "in_progress") return;
  const answers: Record<string, string> = answersOverride ?? JSON.parse(a.answers_json || "{}");

  const { results: keys } = await db
    .prepare(
      `SELECT q.id, q.subject_id, k.correct_option
         FROM exam_questions q JOIN exam_answer_keys k ON k.exam_question_id = q.id
        WHERE q.exam_id = ? AND (q.subject_id = ? OR q.subject_id IN (SELECT subject_id FROM attempt_subjects WHERE attempt_id = ?))`,
    )
    .bind(a.exam_id, ENGLISH_ID, a.id)
    .all<{ id: number; subject_id: string; correct_option: string }>();
  const per = new Map<string, { correct: number; count: number }>();
  for (const k of keys) {
    const s = per.get(k.subject_id) ?? { correct: 0, count: 0 };
    s.count += 1;
    if (answers[String(k.id)] === k.correct_option) s.correct += 1;
    per.set(k.subject_id, s);
  }
  const rows = [...per.entries()].map(([subject, s]) => ({ subject, ...s, score: Math.round((s.correct / s.count) * 10000) / 100 }));
  const total = Math.min(400, Math.round(rows.reduce((t, r) => t + r.score, 0) * 100) / 100);

  const deadlineMs = Date.parse(a.deadline_at);
  const endedMs = reason === "manual" || reason === "tab_hidden" ? Math.min(+now, deadlineMs) : deadlineMs;
  const duration = Math.max(0, Math.round((endedMs - Date.parse(a.started_at)) / 1000));
  const submittedAt = iso(new Date(endedMs));
  const status = reason === "manual" ? "submitted" : "auto_submitted";
  const dbReason = reason;

  await db.batch([
    db
      .prepare("UPDATE attempts SET status = ?, submit_reason = ?, submitted_at = ?, answers_json = ? WHERE id = ? AND status = 'in_progress'")
      .bind(status, dbReason, submittedAt, JSON.stringify(answers), a.id),
    db
      .prepare(
        `INSERT OR IGNORE INTO results (attempt_id, exam_id, participant_id, exam_date, total_score, max_score, duration_seconds, submitted_at, is_eligible, created_at)
         VALUES (?,?,?,?,?,400,?,?,1,?)`,
      )
      .bind(a.id, a.exam_id, a.participant_id, a.exam_date, total, duration, submittedAt, iso(now)),
    ...rows.map((r) =>
      db
        .prepare("INSERT OR IGNORE INTO result_subject_scores (attempt_id, subject_id, correct_count, question_count, score) VALUES (?,?,?,?,?)")
        .bind(a.id, r.subject, r.correct, r.count, r.score),
    ),
  ]);
}

/** Finalize attempts nobody came back to. Cheap (indexed) and bounded; call from read endpoints. */
export async function sweepExpired(db: Db, now: Date, limit = 5): Promise<number> {
  const grace = await settingNum(db, "late_submit_grace_seconds", 30);
  const cutoff = iso(new Date(+now - grace * 1000));
  const { results } = await db.prepare("SELECT id FROM attempts WHERE status = 'in_progress' AND deadline_at <= ? LIMIT ?").bind(cutoff, limit).all<{ id: number }>();
  for (const r of results) await finalizeAttempt(db, r.id, "server_sweep", now);
  return results.length;
}

// ---- results and corrections -----------------------------------------------------------------
async function resultForAttempt(db: Db, attemptId: number) {
  const r = await db
    .prepare("SELECT attempt_id, exam_id, exam_date, total_score, max_score, duration_seconds, submitted_at, participant_id FROM results WHERE attempt_id = ?")
    .bind(attemptId)
    .first<{ exam_id: number; exam_date: string; total_score: number; max_score: number; duration_seconds: number; submitted_at: string; participant_id: string }>();
  if (!r) return { result: null };
  const { results: subjects } = await db
    .prepare(
      `SELECT s.subject_id, sub.name, s.correct_count, s.question_count, s.score
         FROM result_subject_scores s JOIN subjects sub ON sub.id = s.subject_id WHERE s.attempt_id = ? ORDER BY CASE WHEN s.subject_id = 'english' THEN -1 ELSE sub.sort_order END`,
    )
    .bind(attemptId)
    .all();
  const rank = await db.prepare("SELECT rank FROM v_daily_leaderboard WHERE exam_date = ? AND participant_id = ?").bind(r.exam_date, r.participant_id).first<{ rank: number }>();
  const total = await db.prepare("SELECT COUNT(*) AS n FROM v_daily_leaderboard WHERE exam_date = ?").bind(r.exam_date).first<{ n: number }>();
  const exam = await db.prepare("SELECT correction_release_at FROM exams WHERE id = ?").bind(r.exam_id).first<{ correction_release_at: string }>();
  return {
    result: {
      exam_date: r.exam_date, total_score: r.total_score, max_score: r.max_score, duration_seconds: r.duration_seconds, submitted_at: r.submitted_at,
      subjects, daily_rank: rank?.rank ?? null, participants_ranked: total?.n ?? 0, corrections_release_at: exam?.correction_release_at ?? null,
    },
  };
}

/** A participant's own result, from a trusted device. `date` defaults to the latest. */
export async function getMyResult(ctx: Ctx, rawId: unknown, deviceToken: string | undefined, date?: string): Promise<Out> {
  const id = normalizeId(rawId);
  if (!id || !(await isTrustedDevice(ctx.db, id, deviceToken))) return { status: 403, body: { error: "This device is not linked to that Participant ID." } };
  await sweepExpired(ctx.db, ctx.now);
  const a = date
    ? await ctx.db.prepare("SELECT id FROM attempts WHERE participant_id = ? AND exam_date = ? AND status <> 'in_progress'").bind(id, date).first<{ id: number }>()
    : await ctx.db.prepare("SELECT id FROM attempts WHERE participant_id = ? AND status <> 'in_progress' ORDER BY exam_date DESC LIMIT 1").bind(id).first<{ id: number }>();
  if (!a) return { status: 404, body: { error: "No completed exam found." } };
  return { status: 200, body: await resultForAttempt(ctx.db, a.id) };
}

/** Answers and explanations appear only after the admin-set release time. Before that nothing about the key leaves the server. */
export async function getCorrections(ctx: Ctx, rawId: unknown, deviceToken: string | undefined, date: unknown): Promise<Out> {
  const { db, now } = ctx;
  const id = normalizeId(rawId);
  if (!id || !(await isTrustedDevice(db, id, deviceToken))) return { status: 403, body: { error: "This device is not linked to that Participant ID." } };
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { status: 400, body: { error: "Invalid date." } };
  const a = await db
    .prepare("SELECT id, exam_id, answers_json FROM attempts WHERE participant_id = ? AND exam_date = ? AND status <> 'in_progress'")
    .bind(id, date)
    .first<{ id: number; exam_id: number; answers_json: string }>();
  if (!a) return { status: 404, body: { error: "You have no completed exam for that date." } };
  const exam = await db.prepare("SELECT correction_release_at FROM exams WHERE id = ?").bind(a.exam_id).first<{ correction_release_at: string }>();
  if (!exam || exam.correction_release_at > iso(now)) {
    return { status: 403, body: { error: "Corrections are not released yet.", release_at: exam?.correction_release_at ?? null } };
  }
  const answers: Record<string, string> = JSON.parse(a.answers_json || "{}");
  const { results } = await db
    .prepare(
      `SELECT q.id, q.subject_id, q.position, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d, q.explanation, k.correct_option
         FROM exam_questions q JOIN exam_answer_keys k ON k.exam_question_id = q.id
         JOIN subjects s ON s.id = q.subject_id
        WHERE q.exam_id = ? AND (q.subject_id = ? OR q.subject_id IN (SELECT subject_id FROM attempt_subjects WHERE attempt_id = ?))
        ORDER BY CASE WHEN q.subject_id = ? THEN -1 ELSE s.sort_order END, q.position`,
    )
    .bind(a.exam_id, ENGLISH_ID, a.id, ENGLISH_ID)
    .all<{ id: number; subject_id: string; position: number; question_text: string; option_a: string; option_b: string; option_c: string; option_d: string; explanation: string | null; correct_option: string }>();
  return {
    status: 200,
    body: {
      exam_date: date,
      questions: results.map((q) => ({
        id: q.id, subject_id: q.subject_id, position: q.position, text: q.question_text,
        options: { A: q.option_a, B: q.option_b, C: q.option_c, D: q.option_d },
        your_answer: answers[String(q.id)] ?? null, correct_option: q.correct_option, explanation: q.explanation,
        is_correct: answers[String(q.id)] === q.correct_option,
      })),
    },
  };
}
