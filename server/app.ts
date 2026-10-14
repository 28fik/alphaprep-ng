import { Hono, type Context } from "hono";
import { csrfValid, getSession, hasPermission, loginAdmin, logoutAdmin, setupStatus, bootstrapAdmin, type AdminCtx, type AdminSession } from "./admin.ts";
import { sha256Hex } from "./crypto.ts";
import type { Db } from "./db.ts";
import { lookupParticipant, registerParticipant, updateSubjects, verifyRecovery, type Ctx, type Result } from "./participants.ts";
import { computePhase, currentExam } from "./status.ts";
import { nowIso } from "./time.ts";

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

async function readJson(c: AppContext): Promise<unknown | null> {
  const len = Number(c.req.header("Content-Length") ?? "0");
  if (len > 20_000) return null;
  try {
    return await c.req.json();
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
  c.header("Cache-Control", "no-store");
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

app.notFound((c) => c.json({ error: "Not found." }, 404));
app.onError((err, c) => {
  if (err instanceof ConfigError) {
    console.error(err.message);
    return c.json({ error: "The server is not fully configured yet. Please contact the administrator." }, 500);
  }
  console.error(err);
  return c.json({ error: "Something went wrong on the server. Please try again." }, 500);
});
