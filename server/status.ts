import type { Db } from "./db.ts";
import { lagosDate } from "./time.ts";

export type Phase = "none" | "registration_open" | "ongoing" | "closed";

export interface ExamRow {
  exam_date: string;
  title: string;
  status: string;
  registration_opens_at: string | null;
  starts_at: string;
  ends_at: string;
}

export function computePhase(exam: ExamRow | null, nowIso: string): Phase {
  if (!exam || exam.status === "cancelled" || exam.status === "draft" || exam.status === "approved") return "none";
  if (nowIso >= exam.ends_at) return "closed";
  if (nowIso >= exam.starts_at) return "ongoing";
  if (!exam.registration_opens_at || nowIso >= exam.registration_opens_at) return "registration_open";
  return "none";
}

const COLS = "id, exam_date, title, status, registration_opens_at, starts_at, ends_at";

/** Today's published exam (Lagos date), otherwise the next upcoming published exam. */
export async function currentExam(db: Db, now: Date): Promise<(ExamRow & { id: number }) | null> {
  const today = lagosDate(now);
  const todays = await db
    .prepare(`SELECT ${COLS} FROM exams WHERE exam_date = ? AND status IN ('published','locked')`)
    .bind(today)
    .first<ExamRow & { id: number }>();
  if (todays) return todays;
  return db
    .prepare(`SELECT ${COLS} FROM exams WHERE exam_date > ? AND status IN ('published','locked') ORDER BY exam_date LIMIT 1`)
    .bind(today)
    .first<ExamRow & { id: number }>();
}
