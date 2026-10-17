export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;
  data?: Record<string, any>; // the full error body (e.g. release_at, needs_share)
  constructor(message: string, status: number, fields?: Record<string, string>, data?: Record<string, any>) {
    super(message);
    this.status = status;
    this.fields = fields;
    this.data = data;
  }
}

// Admin CSRF token lives in memory only (re-fetched from /admin/me after a reload).
let csrfToken = "";
export function setCsrf(token: string) {
  csrfToken = token;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (csrfToken && path.startsWith("/admin")) headers["X-CSRF-Token"] = csrfToken;
  try {
    res = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...init,
      headers: { ...headers, ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
  } catch {
    throw new ApiError("Cannot reach the server. Check your internet connection and try again.", 0);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    throw new ApiError(body?.error ?? `Request failed (${res.status}).`, res.status, body?.fields, body ?? undefined);
  }
  return body as T;
}

/** Same as api() but sends raw bytes (used for the logo upload). */
export async function apiUpload<T>(path: string, body: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: "PUT", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken, "Content-Type": body.type || "application/octet-stream" }, body });
  } catch {
    throw new ApiError("Cannot reach the server. Check your internet connection and try again.", 0);
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(json?.error ?? `Request failed (${res.status}).`, res.status);
  return json as T;
}

export type ExamPhase = "none" | "registration_open" | "ongoing" | "closed";

export interface PublicStatus {
  phase: ExamPhase;
  exam: { exam_date: string; title: string; starts_at: string; ends_at: string } | null;
  countdown: { target: string; label: string } | null;
  announcements: { id: number; title: string; body: string }[];
  settings?: Record<string, string>;
}

export interface LeaderboardRow {
  rank: number;
  display_name: string;
  total_score?: number;
  duration_seconds?: number;
  weekly_total?: number;
  exams_taken?: number;
  weekly_percentage?: number;
}

export interface SubjectScore { subject_id: string; name: string; correct_count: number; question_count: number; score: number }
export interface ExamResult {
  exam_date: string; total_score: number; max_score: number; duration_seconds: number; submitted_at: string;
  subjects: SubjectScore[]; daily_rank: number | null; participants_ranked: number; corrections_release_at: string | null;
}

export const ATTEMPT_KEY = "ap_attempt";
export interface StoredAttempt { id: number; token: string; pid: string }
export function loadAttempt(): StoredAttempt | null {
  try {
    const v = JSON.parse(localStorage.getItem(ATTEMPT_KEY) ?? "null");
    return v && typeof v.id === "number" && typeof v.token === "string" ? v : null;
  } catch { return null; }
}
export function saveAttempt(a: StoredAttempt | null) {
  try { if (a) localStorage.setItem(ATTEMPT_KEY, JSON.stringify(a)); else localStorage.removeItem(ATTEMPT_KEY); } catch { /* storage blocked */ }
}

export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export interface ParticipantProfile {
  found: true;
  trusted: boolean;
  participant?: { id: string; first_name: string; last_initial: string };
  subjects?: { id: string; name: string }[];
  subject_change?: { allowed: boolean; reason?: string; deadline?: string };
  eligibility?: {
    phase: ExamPhase;
    exam: { exam_date: string; title: string; starts_at: string; ends_at: string } | null;
    already_attempted: boolean;
    in_progress?: boolean;
    can_start: boolean;
    reason?: string;
  };
}

export interface AdminSessionInfo {
  admin: { id: number; username: string; display_name: string; role: string };
  permissions: string[];
  csrf: string;
}
