import type { Db } from "./db.ts";

/** Append-only audit trail. Never put secrets, answer keys or recovery codes in `details`. */
export async function writeAudit(
  db: Db,
  a: { adminId: number | null; action: string; targetType?: string; targetId?: string | number; details?: Record<string, unknown>; ipHash?: string; now: Date },
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_logs (admin_id, action, target_type, target_id, details_json, ip_hash, created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(
      a.adminId,
      a.action,
      a.targetType ?? null,
      a.targetId === undefined ? null : String(a.targetId),
      a.details ? JSON.stringify(a.details).slice(0, 4000) : null,
      a.ipHash ?? null,
      a.now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    )
    .run();
}
