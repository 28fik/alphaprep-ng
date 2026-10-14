export class ApiError extends Error {
  status: number;
  fields?: Record<string, string>;
  constructor(message: string, status: number, fields?: Record<string, string>) {
    super(message);
    this.status = status;
    this.fields = fields;
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
    throw new ApiError(body?.error ?? `Request failed (${res.status}).`, res.status, body?.fields);
  }
  return body as T;
}

export type ExamPhase = "none" | "registration_open" | "ongoing" | "closed";

export interface PublicStatus {
  phase: ExamPhase;
  exam: { exam_date: string; title: string; starts_at: string; ends_at: string } | null;
  countdown: { target: string; label: string } | null;
  announcements: { id: number; title: string; body: string }[];
}

export interface LeaderboardRow {
  rank: number;
  display_name: string;
  total_score: number;
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
    can_start: boolean;
    reason?: string;
  };
}

export interface AdminSessionInfo {
  admin: { id: number; username: string; display_name: string; role: string };
  permissions: string[];
  csrf: string;
}
