import type { Db } from "./db.ts";
import { toCsv } from "./csv.ts";

/** Monday of the week containing `date` (YYYY-MM-DD). Weeks run Monday to Sunday (Lagos dates). */
export function weekStartOf(date: string): string {
  const d = new Date(date + "T00:00:00Z");
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(+d - back * 86400_000).toISOString().slice(0, 10);
}
export const WEEK_MAX = 2800;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v));

const clampLimit = (n: unknown, def: number) => Math.min(200, Math.max(1, Math.floor(Number(n)) || def));

/**
 * Public leaderboard rows. Participant IDs are deliberately NOT included: an ID is the key to a profile,
 * so publishing it would make impersonation easier. Ties share a rank (RANK semantics); within a tie the
 * shorter duration, then earlier submission, is listed first.
 */
export async function dailyLeaderboard(db: Db, date: string, limit?: unknown, offset = 0) {
  const { results } = await db
    .prepare(
      `SELECT rank, display_name, total_score, duration_seconds FROM v_daily_leaderboard WHERE exam_date = ?
        ORDER BY rank, duration_seconds, submitted_at, participant_id LIMIT ? OFFSET ?`,
    )
    .bind(date, clampLimit(limit, 10), Math.max(0, offset))
    .all();
  const n = await db.prepare("SELECT COUNT(*) AS n FROM v_daily_leaderboard WHERE exam_date = ?").bind(date).first<{ n: number }>();
  return { date, max_score: 400, total: n?.n ?? 0, rows: results };
}

const WEEKLY = `SELECT RANK() OVER (ORDER BY w.weekly_total DESC) AS rank, p.first_name || ' ' || substr(p.last_name,1,1) || '.' AS display_name,
       w.weekly_total, w.exams_taken, w.weekly_percentage, w.total_duration, w.participant_id
  FROM v_weekly_totals w JOIN participants p ON p.id = w.participant_id WHERE w.week_start = ?`;

export async function weeklyLeaderboard(db: Db, anyDateInWeek: string, limit?: unknown, offset = 0) {
  const week = weekStartOf(anyDateInWeek);
  const { results } = await db
    .prepare(`SELECT rank, display_name, weekly_total, exams_taken, weekly_percentage FROM (${WEEKLY}) ORDER BY rank, total_duration, participant_id LIMIT ? OFFSET ?`)
    .bind(week, clampLimit(limit, 10), Math.max(0, offset))
    .all();
  const n = await db.prepare("SELECT COUNT(*) AS n FROM v_weekly_totals WHERE week_start = ?").bind(week).first<{ n: number }>();
  return { week_start: week, week_end: new Date(+new Date(week + "T00:00:00Z") + 6 * 86400_000).toISOString().slice(0, 10), max_score: WEEK_MAX, total: n?.n ?? 0, rows: results };
}

export async function availableDates(db: Db, limit = 60) {
  const { results } = await db.prepare("SELECT DISTINCT exam_date FROM results ORDER BY exam_date DESC LIMIT ?").bind(limit).all<{ exam_date: string }>();
  return results.map((r) => r.exam_date);
}

// ---- admin exports (include IDs and names: protected by reports.read) --------------------------
export async function exportDailyCsv(db: Db, date: string) {
  const { results } = await db
    .prepare(
      `SELECT v.rank, v.participant_id, p.first_name, p.last_name, v.total_score, v.duration_seconds, v.submitted_at
         FROM v_daily_leaderboard v JOIN participants p ON p.id = v.participant_id WHERE v.exam_date = ?
        ORDER BY v.rank, v.duration_seconds, v.submitted_at, v.participant_id`,
    )
    .bind(date)
    .all<Record<string, unknown>>();
  return toCsv(["rank", "participant_id", "first_name", "last_name", "total_score", "duration_seconds", "submitted_at"], results);
}

export async function exportWeeklyCsv(db: Db, anyDateInWeek: string) {
  const week = weekStartOf(anyDateInWeek);
  const { results } = await db
    .prepare(
      `SELECT rank, participant_id, first_name, last_name, weekly_total, exams_taken, weekly_percentage FROM (
         SELECT RANK() OVER (ORDER BY w.weekly_total DESC) AS rank, w.participant_id, p.first_name, p.last_name, w.weekly_total, w.exams_taken, w.weekly_percentage, w.total_duration
           FROM v_weekly_totals w JOIN participants p ON p.id = w.participant_id WHERE w.week_start = ?) ORDER BY rank, total_duration, participant_id`,
    )
    .bind(week)
    .all<Record<string, unknown>>();
  return toCsv(["rank", "participant_id", "first_name", "last_name", "weekly_total", "exams_taken", "weekly_percentage"], results);
}

/** Backup-style exports. Never includes hashes, recovery codes or session data. */
export async function exportParticipantsCsv(db: Db) {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.first_name, p.last_name, p.target_score, p.intended_course, p.preferred_institution, p.gender, p.status, p.created_at,
              (SELECT group_concat(subject_id, ' ') FROM participant_subjects s WHERE s.participant_id = p.id) AS subjects
         FROM participants p ORDER BY p.created_at LIMIT 20000`,
    )
    .all<Record<string, unknown>>();
  return toCsv(["id", "first_name", "last_name", "target_score", "intended_course", "preferred_institution", "gender", "status", "subjects", "created_at"], results);
}

export async function exportResultsCsv(db: Db) {
  const { results } = await db
    .prepare(
      `SELECT r.exam_date, r.participant_id, r.total_score, r.duration_seconds, r.submitted_at, r.is_eligible, a.status, a.submit_reason,
              (SELECT group_concat(subject_id || ':' || score, ' ') FROM result_subject_scores s WHERE s.attempt_id = r.attempt_id) AS subject_scores
         FROM results r JOIN attempts a ON a.id = r.attempt_id ORDER BY r.exam_date DESC, r.total_score DESC LIMIT 50000`,
    )
    .all<Record<string, unknown>>();
  return toCsv(["exam_date", "participant_id", "total_score", "duration_seconds", "submitted_at", "is_eligible", "status", "submit_reason", "subject_scores"], results);
}
