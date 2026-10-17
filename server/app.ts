import { Hono, type Context } from "hono";
import { csrfValid, getSession, hasPermission, loginAdmin, logoutAdmin, setupStatus, bootstrapAdmin, type AdminCtx, type AdminSession } from "./admin.ts";
import { sha256Hex } from "./crypto.ts";
import { getCorrections, getMyResult, getPaper, saveAnswers, startAttempt, submitAttempt, sweepExpired } from "./attempts.ts";
import { adjustResult, changeOwnPassword, createAdmin, getParticipantAdmin, listAdmins, listAudit, overview, resetRecoveryCode, searchParticipants, setAdminStatus, setParticipantStatus, setResultEligibility, type OpCtx } from "./adminOps.ts";
import { approveExam, cancelExam, createExam, generateSubject, listExams, previewExam, publishExam, unapproveExam, updateExam, type ECtx } from "./exams.ts";
import { availableDates, dailyLeaderboard, exportDailyCsv, exportParticipantsCsv, exportResultsCsv, exportWeeklyCsv, isDate, weeklyLeaderboard } from "./leaderboard.ts";
import { addImportRows, commitImport, createQuestion, deleteQuestions, discardImport, editImportRow, exportQuestionsCsv, IMPORT_TEMPLATE_CSV, importPreview, listQuestions, questionStats, setImportRowStatus, setVerification, startImport, updateQuestion, type QCtx } from "./questions.ts";
import { deleteAnnouncement, getLogo, getSettings, listAnnouncements, saveAnnouncement, saveLogo, updateSettings, MAX_LOGO_BYTES, type SCtx } from "./settings.ts";
import type { Db } from "./db.ts";
import { lookupParticipant, registerParticipant, updateSubjects, verifyRecovery, type Ctx, type Result } from "./participants.ts";
import { computePhase, currentExam } from "./status.ts";
import { lagosDate, nowIso } from "./time.ts";

export interface Env {
  DB: D1Database;
  APP_TIMEZONE: string;
  ADMIN_BOOTSTRAP_SECRET?: string;
  SESSION_PEPPER?: string;
  PBKDF2_ITERATIONS?: string; // optional override (max 100000 on Workers)
}

type AppContext = Context<{ Bindings: Env }>;

// ---- small helpers -------------------------------------------------------------------------
class ConfigError extends Error {}

function pepper(c: AppContext): string {
  const p = c.env.SESSION_PEPPER;
  if (!p || p.length < 16) throw new ConfigError("SESSION_PEPPER is not configured.");
  return p;
}

async function baseCtx(c: AppContext): Promise<Ctx> {
  const ip = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "unknown";
  const p = pepper(c);
  return {
    db: c.env.DB as unknown as Db,
    pepper: p,
    now: new Date(),
    ipHash: (await sha256Hex(`${p}:ip:${ip}`)).slice(0, 32),
  };
}

async function adminCtx(c: AppContext): Promise<AdminCtx> {
  const base = await baseCtx(c);
  const iter = Number(c.env.PBKDF2_ITERATIONS);
  return {
    ...base,
    bootstrapSecret: c.env.ADMIN_BOOTSTRAP_SECRET,
    iterations: Number.isInteger(iter) && iter > 0 && iter <= 100_000 ? iter : undefined,
  };
}

function isHttps(c: AppContext) {
  return new URL(c.req.url).protocol === "https:";
}

function readCookie(c: AppContext, names: string[]): string | undefined {
  const header = c.req.header("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (names.includes(k)) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

// `__Host-` prefix (HTTPS only) stops subdomain cookie injection; plain names work on http://localhost.
const adminCookieName = (https: boolean) => (https ? "__Host-ap_admin" : "ap_admin");
const deviceCookieName = (https: boolean) => (https ? "__Host-ap_device" : "ap_device");

function setCookie(c: AppContext, name: string, value: string, maxAgeSeconds: number, sameSite: "Strict" | "Lax") {
  const secure = isHttps(c) ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=${sameSite}${secure}`,
    { append: true },
  );
}
const clearCookie = (c: AppContext, name: string) => setCookie(c, name, "", 0, "Strict");

async function readJson(c: AppContext, maxChars = 20_000): Promise<unknown | null> {
  try {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > maxChars * 4) return null; // refuse before reading the body
    const text = await c.req.text();
    if (text.length > maxChars) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function respond(c: AppContext, r: Result) {
  if (r.status === 429 && typeof r.body.retry_after_seconds === "number") {
    c.header("Retry-After", String(r.body.retry_after_seconds));
  }
  return c.json(r.body, r.status as 200);
}

const badBody = (c: AppContext) => c.json({ error: "Invalid request." }, 400);

// ---- app -----------------------------------------------------------------------------------
export const app = new Hono<{ Bindings: Env }>().basePath("/api");

app.use("*", async (c, next) => {
  // Reject cross-site state-changing requests (defence in depth on top of SameSite cookies).
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (origin) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === new URL(c.req.url).host;
      } catch {
        /* Origin: null or malformed -> treat as cross-site */
      }
      if (!sameHost) return c.json({ error: "Cross-site request blocked." }, 403);
    }
  }
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
});

app.get("/health", (c) => c.json({ ok: true, time: nowIso() }));

// Public status for the homepage. Exposes no participant data and no answer keys.
app.get("/status", async (c) => {
  const db = c.env.DB as unknown as Db;
  const now = new Date();
  const exam = await currentExam(db, now);
  const settings = await db
    .prepare("SELECT key, value FROM settings WHERE key IN ('utme_countdown_date','utme_countdown_label')")
    .all<{ key: string; value: string }>();
  const s = Object.fromEntries(settings.results.map((r) => [r.key, r.value]));
  const ann = await db
    .prepare("SELECT id, title, body FROM announcements WHERE is_published = 1 ORDER BY pinned DESC, id DESC LIMIT 5")
    .all<{ id: number; title: string; body: string }>();
  return c.json({
    phase: computePhase(exam, now.toISOString()),
    exam: exam ? { exam_date: exam.exam_date, title: exam.title, starts_at: exam.starts_at, ends_at: exam.ends_at } : null,
    countdown: s.utme_countdown_date ? { target: s.utme_countdown_date, label: s.utme_countdown_label ?? "UTME countdown" } : null,
    announcements: ann.results,
    settings: await getSettings(db, true),
  });
});

// ---- participants --------------------------------------------------------------------------
function withDevice(c: AppContext, r: Result) {
  if (r.deviceToken) setCookie(c, deviceCookieName(isHttps(c)), r.deviceToken, 365 * 86400, "Lax");
  return respond(c, r);
}
const deviceToken = (c: AppContext) => readCookie(c, ["__Host-ap_device", "ap_device"]);

app.post("/participants", async (c) => {
  const body = await readJson(c);
  if (body === null) return badBody(c);
  return withDevice(c, await registerParticipant(await baseCtx(c), body));
});

app.post("/participants/lookup", async (c) => {
  const body = (await readJson(c)) as { id?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await lookupParticipant(await baseCtx(c), body.id, deviceToken(c)));
});

app.post("/participants/verify", async (c) => {
  const body = (await readJson(c)) as { id?: unknown; recovery_code?: unknown } | null;
  if (!body) return badBody(c);
  return withDevice(c, await verifyRecovery(await baseCtx(c), body.id, body.recovery_code));
});

app.put("/participants/subjects", async (c) => {
  const body = (await readJson(c)) as { id?: unknown; subjects?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await updateSubjects(await baseCtx(c), body.id, body.subjects, deviceToken(c)));
});

// ---- admin ---------------------------------------------------------------------------------
const adminToken = (c: AppContext) => readCookie(c, ["__Host-ap_admin", "ap_admin"]);

/** Server-side admin check used by every protected admin route. */
export async function requireAdmin(c: AppContext, permission?: string): Promise<{ session: AdminSession } | Response> {
  const ctx = await adminCtx(c);
  const session = await getSession(ctx, adminToken(c));
  if (!session) return c.json({ error: "Please sign in." }, 401);
  if (!["GET", "HEAD"].includes(c.req.method) && !(await csrfValid(session, c.req.header("X-CSRF-Token")))) {
    return c.json({ error: "Security check failed. Reload the page and try again." }, 403);
  }
  if (permission && !hasPermission(session, permission)) {
    return c.json({ error: "You do not have permission to do that." }, 403);
  }
  return { session };
}

app.get("/admin/status", async (c) => c.json(await setupStatus(c.env.DB as unknown as Db)));

app.post("/admin/bootstrap", async (c) => {
  const body = await readJson(c);
  if (body === null) return badBody(c);
  return respond(c, await bootstrapAdmin(await adminCtx(c), body));
});

app.post("/admin/login", async (c) => {
  const body = await readJson(c);
  if (body === null) return badBody(c);
  const r = await loginAdmin(await adminCtx(c), body);
  if (r.sessionToken) setCookie(c, adminCookieName(isHttps(c)), r.sessionToken, 12 * 3600, "Strict");
  return respond(c, r);
});

app.get("/admin/me", async (c) => {
  const a = await requireAdmin(c);
  if (a instanceof Response) return a;
  return c.json(a.session);
});

app.post("/admin/logout", async (c) => {
  const a = await requireAdmin(c);
  if (a instanceof Response) return a;
  await logoutAdmin(await adminCtx(c), adminToken(c));
  clearCookie(c, adminCookieName(isHttps(c)));
  return c.json({ ok: true });
});


// ---- public: leaderboards, logo -------------------------------------------------------------
const cachePublic = (c: AppContext, seconds: number) => c.header("Cache-Control", `public, max-age=${seconds}`);

app.get("/leaderboard/daily", async (c) => {
  const db = c.env.DB as unknown as Db;
  const now = new Date();
  await sweepExpired(db, now, 2);
  const q = c.req.query("date");
  const date = q === undefined ? lagosDate(now) : isDate(q) ? q : null;
  if (!date) return c.json({ error: "Invalid date." }, 400);
  cachePublic(c, 30);
  return c.json(await dailyLeaderboard(db, date, c.req.query("limit"), Math.max(0, Number(c.req.query("offset")) || 0)));
});

app.get("/leaderboard/weekly", async (c) => {
  const db = c.env.DB as unknown as Db;
  const now = new Date();
  await sweepExpired(db, now, 2);
  const q = c.req.query("date");
  const date = q === undefined ? lagosDate(now) : isDate(q) ? q : null;
  if (!date) return c.json({ error: "Invalid date." }, 400);
  cachePublic(c, 30);
  return c.json(await weeklyLeaderboard(db, date, c.req.query("limit"), Math.max(0, Number(c.req.query("offset")) || 0)));
});

app.get("/leaderboard/dates", async (c) => {
  cachePublic(c, 60);
  return c.json({ dates: await availableDates(c.env.DB as unknown as Db) });
});

app.get("/logo", async (c) => {
  const logo = await getLogo(c.env.DB as unknown as Db);
  if (!logo) return c.json({ error: "Not found." }, 404);
  return c.body(logo.data as unknown as ArrayBuffer, 200, { "Content-Type": logo.type, "Cache-Control": "public, max-age=3600", "Content-Security-Policy": "default-src 'none'" });
});

// ---- participants: taking the exam -----------------------------------------------------------
const attemptToken = (c: AppContext) => c.req.header("X-Attempt-Token") ?? undefined;
const attemptId = (c: AppContext) => Number(c.req.param("attemptId"));

app.post("/exam/start", async (c) => {
  const body = (await readJson(c)) as { id?: unknown; share_confirmed?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await startAttempt(await baseCtx(c), body.id, deviceToken(c), body));
});
app.get("/exam/:attemptId/paper", async (c) => respond(c, await getPaper({ db: c.env.DB as unknown as Db, now: new Date() }, attemptId(c), attemptToken(c))));
app.put("/exam/:attemptId/answers", async (c) => {
  const body = (await readJson(c)) as { answers?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await saveAnswers({ db: c.env.DB as unknown as Db, now: new Date() }, attemptId(c), attemptToken(c), body.answers));
});
app.post("/exam/:attemptId/submit", async (c) => {
  const body = (await readJson(c)) as { answers?: unknown; reason?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await submitAttempt({ db: c.env.DB as unknown as Db, now: new Date() }, attemptId(c), attemptToken(c), body));
});
app.post("/me/result", async (c) => {
  const body = (await readJson(c)) as { id?: unknown; date?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await getMyResult(await baseCtx(c), body.id, deviceToken(c), typeof body.date === "string" ? body.date : undefined));
});
app.post("/me/corrections", async (c) => {
  const body = (await readJson(c)) as { id?: unknown; date?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await getCorrections(await baseCtx(c), body.id, deviceToken(c), body.date));
});

// ---- admin helpers ---------------------------------------------------------------------------
type AdminHandler = (c: AppContext, s: AdminSession, ids: { db: Db; now: Date; ipHash: string }) => Promise<Response>;
function guarded(permission: string | undefined, fn: AdminHandler) {
  return async (c: AppContext) => {
    const a = await requireAdmin(c, permission);
    if (a instanceof Response) return a;
    const base = await baseCtx(c);
    return fn(c, a.session, { db: base.db, now: base.now, ipHash: base.ipHash });
  };
}
const qctx = (s: AdminSession, i: { db: Db; now: Date; ipHash: string }): QCtx => ({ ...i, adminId: s.admin.id });
const ectx = (s: AdminSession, i: { db: Db; now: Date; ipHash: string }): ECtx => ({ ...i, adminId: s.admin.id });
const sctx = (s: AdminSession, i: { db: Db; now: Date; ipHash: string }): SCtx => ({ ...i, adminId: s.admin.id });
async function opctx(c: AppContext, s: AdminSession, i: { db: Db; now: Date; ipHash: string }): Promise<OpCtx> {
  const a = await adminCtx(c);
  return { ...i, adminId: s.admin.id, pepper: a.pepper, iterations: a.iterations };
}
const numParam = (c: AppContext, name: string) => Number(c.req.param(name));
const csvResponse = (c: AppContext, csv: string, name: string) =>
  c.body(csv, 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" });
const BIG = 600_000;

app.get("/admin/overview", guarded("exams.read", async (c, _s, i) => c.json(await overview(i.db, lagosDate(i.now)))));

// ---- admin: question bank ---------------------------------------------------------------------
const filtersOf = (c: AppContext) => ({
  subject: c.req.query("subject") || undefined, topic: c.req.query("topic") || undefined, status: c.req.query("status") || undefined,
  has_key: c.req.query("has_key") || undefined, q: c.req.query("q") || undefined,
  page: Number(c.req.query("page")) || 1, page_size: Number(c.req.query("page_size")) || 25,
});
app.get("/admin/questions", guarded("questions.read", async (c, _s, i) => c.json(await listQuestions(i.db, filtersOf(c)))));
app.get("/admin/questions/stats", guarded("questions.read", async (c, _s, i) => c.json({ subjects: await questionStats(i.db) })));
app.get("/admin/questions/export", guarded("questions.read", async (c, _s, i) => csvResponse(c, await exportQuestionsCsv(i.db, filtersOf(c)), "alphaprep-questions.csv")));
app.get("/admin/questions/template", guarded("questions.write", async (c) => csvResponse(c, IMPORT_TEMPLATE_CSV, "alphaprep-import-template.csv")));
app.post("/admin/questions", guarded("questions.write", async (c, s, i) => {
  const body = await readJson(c, 40_000);
  if (!body || typeof body !== "object") return badBody(c);
  return respond(c, await createQuestion(qctx(s, i), body as Record<string, unknown>));
}));
app.put("/admin/questions/:id", guarded("questions.write", async (c, s, i) => {
  const body = await readJson(c, 40_000);
  if (!body || typeof body !== "object") return badBody(c);
  return respond(c, await updateQuestion(qctx(s, i), numParam(c, "id"), body as Record<string, unknown>));
}));
app.post("/admin/questions/delete", guarded("questions.write", async (c, s, i) => {
  const body = (await readJson(c)) as { ids?: unknown } | null;
  if (!body || !Array.isArray(body.ids)) return badBody(c);
  return respond(c, await deleteQuestions(qctx(s, i), body.ids.map(Number)));
}));
app.post("/admin/questions/status", guarded("questions.write", async (c, s, i) => {
  const body = (await readJson(c)) as { ids?: unknown; status?: unknown } | null;
  if (!body || !Array.isArray(body.ids) || typeof body.status !== "string") return badBody(c);
  return respond(c, await setVerification(qctx(s, i), body.ids.map(Number), body.status));
}));

// ---- admin: bulk import (the browser parses files; the server validates and saves in small chunks) ----
app.post("/admin/imports", guarded("questions.write", async (c, s, i) => {
  const body = (await readJson(c)) as { file_name?: unknown; file_type?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await startImport(qctx(s, i), String(body.file_name ?? ""), String(body.file_type ?? "")));
}));
app.post("/admin/imports/:id/rows", guarded("questions.write", async (c, s, i) => {
  const body = (await readJson(c, BIG)) as { rows?: unknown } | null;
  if (!body || !Array.isArray(body.rows)) return badBody(c);
  return respond(c, await addImportRows(qctx(s, i), numParam(c, "id"), body.rows));
}));
app.get("/admin/imports/:id", guarded("questions.write", async (c, s, i) => respond(c, await importPreview(i.db, s.admin.id, numParam(c, "id"), Number(c.req.query("page")) || 1))));
app.put("/admin/imports/:id/rows/:row", guarded("questions.write", async (c, s, i) => {
  const body = await readJson(c, 40_000);
  if (!body || typeof body !== "object") return badBody(c);
  return respond(c, await editImportRow(qctx(s, i), numParam(c, "id"), numParam(c, "row"), body as Record<string, unknown>));
}));
app.post("/admin/imports/:id/rows-status", guarded("questions.write", async (c, s, i) => {
  const body = (await readJson(c)) as { rows?: unknown; status?: unknown } | null;
  if (!body || !Array.isArray(body.rows) || (body.status !== "approved" && body.status !== "rejected")) return badBody(c);
  return respond(c, await setImportRowStatus(qctx(s, i), numParam(c, "id"), body.rows.map(Number), body.status));
}));
app.post("/admin/imports/:id/commit", guarded("questions.write", async (c, s, i) => respond(c, await commitImport(qctx(s, i), numParam(c, "id")))));
app.post("/admin/imports/:id/discard", guarded("questions.write", async (c, s, i) => respond(c, await discardImport(qctx(s, i), numParam(c, "id")))));

// ---- admin: exams ------------------------------------------------------------------------------
app.get("/admin/exams", guarded("exams.read", async (c, _s, i) => c.json({ exams: await listExams(i.db) })));
app.post("/admin/exams", guarded("exams.write", async (c, s, i) => {
  const body = await readJson(c);
  if (!body || typeof body !== "object") return badBody(c);
  return respond(c, await createExam(ectx(s, i), body as Record<string, unknown>));
}));
app.put("/admin/exams/:id", guarded("exams.write", async (c, s, i) => {
  const body = await readJson(c);
  if (!body || typeof body !== "object") return badBody(c);
  return respond(c, await updateExam(ectx(s, i), numParam(c, "id"), body as Record<string, unknown>));
}));
app.post("/admin/exams/:id/generate", guarded("exams.write", async (c, s, i) => {
  const body = (await readJson(c)) as { subject?: unknown } | null;
  if (!body || typeof body.subject !== "string") return badBody(c);
  return respond(c, await generateSubject(ectx(s, i), numParam(c, "id"), body.subject));
}));
app.get("/admin/exams/:id/preview", guarded("questions.read", async (c, s, i) => respond(c, await previewExam(i.db, numParam(c, "id"), { now: i.now, liveKeysAllowed: hasPermission(s, "exams.write") }))));
app.post("/admin/exams/:id/approve", guarded("exams.write", async (c, s, i) => respond(c, await approveExam(ectx(s, i), numParam(c, "id")))));
app.post("/admin/exams/:id/unapprove", guarded("exams.write", async (c, s, i) => respond(c, await unapproveExam(ectx(s, i), numParam(c, "id")))));
app.post("/admin/exams/:id/publish", guarded("exams.write", async (c, s, i) => respond(c, await publishExam(ectx(s, i), numParam(c, "id")))));
app.post("/admin/exams/:id/cancel", guarded("exams.write", async (c, s, i) => respond(c, await cancelExam(ectx(s, i), numParam(c, "id")))));

// ---- admin: participants, results, exports ----------------------------------------------------
app.get("/admin/participants", guarded("participants.read", async (c, _s, i) => c.json(await searchParticipants(i.db, c.req.query("q") ?? "", Number(c.req.query("page")) || 1))));
app.get("/admin/participants/:id", guarded("participants.read", async (c, _s, i) => respond(c, await getParticipantAdmin(i.db, c.req.param("id")))));
app.post("/admin/participants/:id/status", guarded("participants.write", async (c, s, i) => {
  const body = (await readJson(c)) as { suspend?: unknown; reason?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await setParticipantStatus(await opctx(c, s, i), c.req.param("id"), body.suspend === true, body.reason));
}));
app.post("/admin/participants/:id/reset-recovery", guarded("participants.write", async (c, s, i) => respond(c, await resetRecoveryCode(await opctx(c, s, i), c.req.param("id")))));
app.post("/admin/results/:attemptId/adjust", guarded("participants.write", async (c, s, i) => {
  const body = (await readJson(c)) as { new_total?: unknown; reason?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await adjustResult(await opctx(c, s, i), attemptId(c), body.new_total, body.reason));
}));
app.post("/admin/results/:attemptId/eligibility", guarded("participants.write", async (c, s, i) => {
  const body = (await readJson(c)) as { eligible?: unknown; reason?: unknown } | null;
  if (!body) return badBody(c);
  return respond(c, await setResultEligibility(await opctx(c, s, i), attemptId(c), body.eligible === true, body.reason));
}));
app.get("/admin/export/daily", guarded("reports.read", async (c, _s, i) => {
  const d = c.req.query("date");
  if (!isDate(d)) return c.json({ error: "Invalid date." }, 400);
  return csvResponse(c, await exportDailyCsv(i.db, d), `alphaprep-daily-${d}.csv`);
}));
app.get("/admin/export/weekly", guarded("reports.read", async (c, _s, i) => {
  const d = c.req.query("date");
  if (!isDate(d)) return c.json({ error: "Invalid date." }, 400);
  return csvResponse(c, await exportWeeklyCsv(i.db, d), `alphaprep-weekly-${d}.csv`);
}));
app.get("/admin/export/participants", guarded("participants.read", async (c, _s, i) => csvResponse(c, await exportParticipantsCsv(i.db), "alphaprep-participants.csv")));
app.get("/admin/export/results", guarded("reports.read", async (c, _s, i) => csvResponse(c, await exportResultsCsv(i.db), "alphaprep-results.csv")));

// ---- admin: settings, announcements, logo, audit, administrators ----------------------------------
app.get("/admin/settings", guarded("settings.write", async (c, _s, i) => c.json({ settings: await getSettings(i.db) })));
app.put("/admin/settings", guarded("settings.write", async (c, s, i) => respond(c, await updateSettings(sctx(s, i), await readJson(c)))));
app.get("/admin/announcements", guarded("settings.write", async (c, _s, i) => c.json({ announcements: await listAnnouncements(i.db) })));
app.post("/admin/announcements", guarded("settings.write", async (c, s, i) => {
  const body = await readJson(c);
  if (!body || typeof body !== "object") return badBody(c);
  return respond(c, await saveAnnouncement(sctx(s, i), null, body as Record<string, unknown>));
}));
app.put("/admin/announcements/:id", guarded("settings.write", async (c, s, i) => {
  const body = await readJson(c);
  if (!body || typeof body !== "object") return badBody(c);
  return respond(c, await saveAnnouncement(sctx(s, i), numParam(c, "id"), body as Record<string, unknown>));
}));
app.delete("/admin/announcements/:id", guarded("settings.write", async (c, s, i) => respond(c, await deleteAnnouncement(sctx(s, i), numParam(c, "id")))));
app.put("/admin/logo", guarded("settings.write", async (c, s, i) => {
  const buf = new Uint8Array(await c.req.arrayBuffer());
  if (buf.length > MAX_LOGO_BYTES) return c.json({ error: "Logo must be under 300 KB." }, 400);
  return respond(c, await saveLogo(sctx(s, i), buf));
}));
app.get("/admin/audit", guarded("audit.read", async (c, _s, i) => c.json(await listAudit(i.db, Number(c.req.query("page")) || 1, c.req.query("action") || undefined))));
app.get("/admin/admins", guarded("admins.manage", async (c, _s, i) => c.json({ admins: await listAdmins(i.db) })));
app.post("/admin/admins", guarded("admins.manage", async (c, s, i) => {
  const body = await readJson(c);
  if (!body || typeof body !== "object") return badBody(c);
  return respond(c, await createAdmin(await opctx(c, s, i), body as Record<string, unknown>));
}));
app.put("/admin/admins/:id", guarded("admins.manage", async (c, s, i) => {
  const body = (await readJson(c)) as { status?: unknown; role?: unknown } | null;
  if (!body || (body.status !== "active" && body.status !== "disabled")) return badBody(c);
  return respond(c, await setAdminStatus(await opctx(c, s, i), numParam(c, "id"), body.status, body.role));
}));
app.post("/admin/password", guarded(undefined, async (c, s, i) => {
  const body = (await readJson(c)) as { current?: unknown; next?: unknown } | null;
  if (!body) return badBody(c);
  const r = await changeOwnPassword(await opctx(c, s, i), body.current, body.next);
  if (r.status === 200) clearCookie(c, adminCookieName(isHttps(c)));
  return respond(c, r);
}));

app.notFound((c) => c.json({ error: "Not found." }, 404));
app.onError((err, c) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
    return c.json({ error: "The server is not fully configured yet. Please contact the administrator." }, 500);
  }
  console.error(err);
  return c.json({ error: "Something went wrong on the server. Please try again." }, 500);
});
