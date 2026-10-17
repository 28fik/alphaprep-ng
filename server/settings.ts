import type { Db } from "./db.ts";
import { writeAudit } from "./audit.ts";

type Out = { status: number; body: Record<string, unknown> };
export interface SCtx { db: Db; now: Date; ipHash: string; adminId: number }
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const httpsHost = (hosts: string[]) => (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && hosts.some((h) => u.hostname === h || u.hostname.endsWith("." + h)) && !u.username && !u.password;
  } catch {
    return false;
  }
};
const intRange = (lo: number, hi: number) => (v: string) => /^\d{1,4}$/.test(v) && Number(v) >= lo && Number(v) <= hi;

// Only these keys can be edited from the admin panel, each with a validator. Social links must be https and on
// the platform's own domain, so the footer can never be pointed at a look-alike site by a typo.
const RULES: Record<string, { ok: (v: string) => boolean; msg: string; public?: boolean }> = {
  utme_countdown_date: { ok: (v) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v)), msg: "Use a valid date and time.", public: true },
  utme_countdown_label: { ok: (v) => v.length >= 1 && v.length <= 80, msg: "Label must be 1-80 characters.", public: true },
  social_x: { ok: httpsHost(["x.com", "twitter.com"]), msg: "Must be an https link on x.com.", public: true },
  social_tiktok: { ok: httpsHost(["tiktok.com"]), msg: "Must be an https link on tiktok.com.", public: true },
  social_whatsapp: { ok: httpsHost(["whatsapp.com", "wa.me"]), msg: "Must be an https link on whatsapp.com.", public: true },
  whatsapp_gate_enabled: { ok: (v) => v === "0" || v === "1", msg: "Must be on or off.", public: true },
  whatsapp_share_message: { ok: (v) => v.length >= 5 && v.length <= 300, msg: "Message must be 5-300 characters.", public: true },
  subject_change_cutoff_hours_before_exam: { ok: intRange(0, 72), msg: "0 to 72 hours." },
  late_submit_grace_seconds: { ok: intRange(0, 120), msg: "0 to 120 seconds." },
  tab_hidden_policy: { ok: (v) => ["auto_submit", "warn", "off"].includes(v), msg: "Choose auto_submit, warn or off." },
  site_url: { ok: (v) => v === "" || new URL(v).protocol === "https:", msg: "Must be an https address or empty.", public: true },
  login_max_failures: { ok: intRange(3, 20), msg: "3 to 20." },
  login_lockout_minutes: { ok: intRange(1, 240), msg: "1 to 240 minutes." },
};

export async function getSettings(db: Db, publicOnly = false) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const out: Record<string, string> = {};
  for (const r of results) if (RULES[r.key] && (!publicOnly || RULES[r.key].public)) out[r.key] = r.value;
  return out;
}

export async function updateSettings(ctx: SCtx, raw: unknown): Promise<Out> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: 400, body: { error: "Invalid settings." } };
  const errors: Record<string, string> = {};
  const clean: [string, string][] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const rule = RULES[k];
    if (!rule) { errors[k] = "Unknown setting."; continue; }
    const s = typeof v === "string" ? v.trim() : typeof v === "number" || typeof v === "boolean" ? String(+v) : "";
    let good = false;
    try { good = rule.ok(s); } catch { good = false; }
    if (!good) errors[k] = rule.msg;
    else clean.push([k, s]);
  }
  if (Object.keys(errors).length) return { status: 400, body: { error: "Some settings are invalid.", errors } };
  if (!clean.length) return { status: 400, body: { error: "Nothing to save." } };
  await ctx.db.batch(
    clean.map(([k, v]) =>
      ctx.db.prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at").bind(k, v, ctx.adminId, iso(ctx.now)),
    ),
  );
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "settings.update", details: { keys: clean.map(([k]) => k) }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}

// ---- announcements (plain text only; React escapes it on display) ---------------------------------
export async function listAnnouncements(db: Db) {
  return (await db.prepare("SELECT id, title, body, is_published, pinned, created_at FROM announcements ORDER BY pinned DESC, id DESC LIMIT 100").all()).results;
}
export async function saveAnnouncement(ctx: SCtx, id: number | null, raw: Record<string, unknown>): Promise<Out> {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const body = typeof raw.body === "string" ? raw.body.trim() : "";
  if (title.length < 1 || title.length > 120) return { status: 400, body: { error: "Title must be 1-120 characters." } };
  if (body.length < 1 || body.length > 1000) return { status: 400, body: { error: "Message must be 1-1000 characters." } };
  const pub = raw.is_published ? 1 : 0, pin = raw.pinned ? 1 : 0;
  if (id === null) {
    await ctx.db.prepare("INSERT INTO announcements (title, body, is_published, pinned, created_by, created_at) VALUES (?,?,?,?,?,?)").bind(title, body, pub, pin, ctx.adminId, iso(ctx.now)).run();
  } else {
    const r = await ctx.db.prepare("UPDATE announcements SET title=?, body=?, is_published=?, pinned=? WHERE id=?").bind(title, body, pub, pin, id).run();
    if (!r.meta.changes) return { status: 404, body: { error: "Announcement not found." } };
  }
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: id === null ? "announcement.create" : "announcement.update", targetType: "announcement", targetId: id ?? undefined, ipHash: ctx.ipHash, now: ctx.now });
  return { status: id === null ? 201 : 200, body: { ok: true } };
}
export async function deleteAnnouncement(ctx: SCtx, id: number): Promise<Out> {
  const r = await ctx.db.prepare("DELETE FROM announcements WHERE id = ?").bind(id).run();
  if (!r.meta.changes) return { status: 404, body: { error: "Announcement not found." } };
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "announcement.delete", targetType: "announcement", targetId: id, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}

// ---- logo (small raster image in the database; SVG is refused because it can carry scripts) -------------
export const MAX_LOGO_BYTES = 300_000;
function sniff(b: Uint8Array): string | null {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}
export async function saveLogo(ctx: SCtx, bytes: Uint8Array): Promise<Out> {
  if (bytes.length === 0 || bytes.length > MAX_LOGO_BYTES) return { status: 400, body: { error: "Logo must be a PNG, JPEG or WebP under 300 KB." } };
  const type = sniff(bytes);
  if (!type) return { status: 400, body: { error: "Logo must be a PNG, JPEG or WebP image." } };
  await ctx.db.prepare("INSERT INTO assets (key, content_type, data, updated_at) VALUES ('logo', ?, ?, ?) ON CONFLICT(key) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, updated_at = excluded.updated_at").bind(type, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), iso(ctx.now)).run();
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "settings.logo", ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { ok: true } };
}
export async function getLogo(db: Db): Promise<{ type: string; data: Uint8Array } | null> {
  const r = await db.prepare("SELECT content_type, data FROM assets WHERE key = 'logo'").first<{ content_type: string; data: ArrayBuffer | Uint8Array | number[] }>();
  if (!r) return null;
  // D1 returns BLOBs as arrays of byte values; node:sqlite returns Uint8Array
  return { type: r.content_type, data: r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data as ArrayBuffer | number[]) };
}
