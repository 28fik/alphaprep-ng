import type { Db } from "./db.ts";

// Fixed-window limiter stored in D1 (rate_limits table). Note: every hit is one D1 row write,
// so keep limits and windows sensible on the free plan (100k row writes/day).

export interface LimitResult {
  allowed: boolean;
  hits: number;
  retryAfterSeconds: number;
}

function windowOf(nowSec: number, windowSec: number) {
  const start = Math.floor(nowSec / windowSec) * windowSec;
  return { start, retryAfterSeconds: start + windowSec - nowSec };
}

/** Count a hit and report whether it is within the limit. */
export async function hit(db: Db, bucket: string, now: Date, windowSec: number, limit: number): Promise<LimitResult> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const w = windowOf(nowSec, windowSec);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, ?, 1)
       ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1
       RETURNING hits`,
    )
    .bind(bucket, w.start)
    .first<{ hits: number }>();
  const hits = row?.hits ?? 1;
  return { allowed: hits <= limit, hits, retryAfterSeconds: w.retryAfterSeconds };
}

/** Read the current count without incrementing. */
export async function peek(db: Db, bucket: string, now: Date, windowSec: number): Promise<number> {
  const w = windowOf(Math.floor(now.getTime() / 1000), windowSec);
  const row = await db
    .prepare("SELECT hits FROM rate_limits WHERE bucket = ? AND window_start = ?")
    .bind(bucket, w.start)
    .first<{ hits: number }>();
  return row?.hits ?? 0;
}

/** Remove counters from old windows. Called opportunistically (e.g. on admin login). */
export async function purgeOld(db: Db, now: Date, olderThanSec = 86400): Promise<void> {
  const cutoff = Math.floor(now.getTime() / 1000) - olderThanSec;
  await db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(cutoff).run();
}
