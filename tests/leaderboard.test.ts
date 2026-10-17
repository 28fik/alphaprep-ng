import assert from "node:assert/strict";
import { test } from "node:test";
import { availableDates, dailyLeaderboard, exportDailyCsv, exportWeeklyCsv, weekStartOf, weeklyLeaderboard } from "../server/leaderboard.ts";
import { createTestDb } from "./helpers/d1.ts";
import { seedAdmin } from "./helpers/seed.ts";

type TDb = ReturnType<typeof createTestDb>;
let n = 0;
function mkExam(db: TDb, date: string) {
  db.raw.prepare("INSERT INTO exams (exam_date, title, status, starts_at, ends_at, correction_release_at) VALUES (?, 'm', 'published', ?, ?, ?)").run(date, date + "T07:00:00Z", date + "T19:00:00Z", date + "T23:00:00Z");
  return Number((db.raw.prepare("SELECT id FROM exams WHERE exam_date = ?").get(date) as any).id);
}
function mkP(db: TDb, first: string, last: string, status = "active") {
  const id = `JAMB${String(2000 + ++n)}AA`;
  db.raw.prepare("INSERT INTO participants (id, first_name, last_name, target_score, intended_course, preferred_institution, gender, status) VALUES (?,?,?,?,?,?,?,?)").run(id, first, last, 200, "c", "i", "male", status);
  return id;
}
function mkR(db: TDb, examId: number, date: string, pid: string, score: number, dur = 3000, eligible = 1) {
  db.raw.prepare("INSERT INTO attempts (exam_id, participant_id, exam_date, started_at, deadline_at, attempt_token_hash, status, submitted_at) VALUES (?,?,?,?,?,?,'submitted',?)").run(examId, pid, date, date + "T08:00:00Z", date + "T10:00:00Z", "h", date + "T09:00:00Z");
  const aid = Number((db.raw.prepare("SELECT id FROM attempts WHERE participant_id = ? AND exam_id = ?").get(pid, examId) as any).id);
  db.raw.prepare("INSERT INTO results (attempt_id, exam_id, participant_id, exam_date, total_score, duration_seconds, submitted_at, is_eligible) VALUES (?,?,?,?,?,?,?,?)").run(aid, examId, pid, date, score, dur, date + "T09:00:00Z", eligible);
}

test("weekStartOf: weeks run Monday to Sunday", () => {
  assert.equal(weekStartOf("2026-10-19"), "2026-10-19"); // Monday
  assert.equal(weekStartOf("2026-10-25"), "2026-10-19"); // Sunday
  assert.equal(weekStartOf("2026-10-26"), "2026-10-26");
  assert.equal(weekStartOf("2026-01-01"), "2025-12-29"); // across a year boundary
});

test("daily: tied scores share a rank, the next rank skips, ties ordered by time; IDs never published", async () => {
  const db = createTestDb();
  const e = mkExam(db, "2026-10-20");
  const [a, b, c, d] = [mkP(db, "Ada", "Obi"), mkP(db, "Bola", "Lawal"), mkP(db, "Chi", "Eze"), mkP(db, "Dayo", "Ade")];
  mkR(db, e, "2026-10-20", a, 300, 4000);
  mkR(db, e, "2026-10-20", b, 350, 5000);
  mkR(db, e, "2026-10-20", c, 300, 3000); // ties with Ada, faster
  mkR(db, e, "2026-10-20", d, 100);
  const lb = await dailyLeaderboard(db, "2026-10-20");
  assert.deepEqual(lb.rows.map((r: any) => [r.rank, r.display_name]), [[1, "Bola L."], [2, "Chi E."], [2, "Ada O."], [4, "Dayo A."]]);
  assert.equal(lb.total, 4);
  assert.equal(JSON.stringify(lb).includes("JAMB"), false);
  assert.equal(JSON.stringify(lb).includes("Lawal"), false); // only last initial
  assert.equal((await dailyLeaderboard(db, "2026-10-20", 2)).rows.length, 2);
  assert.equal((await dailyLeaderboard(db, "2026-10-20", 2, 2)).rows.length, 2);
  assert.equal((await dailyLeaderboard(db, "2026-10-21")).rows.length, 0);
});

test("daily: suspended participants and hidden results are excluded", async () => {
  const db = createTestDb();
  const e = mkExam(db, "2026-10-20");
  const ok = mkP(db, "Ok", "Person"), sus = mkP(db, "Sus", "Pended", "suspended"), hid = mkP(db, "Hid", "Den");
  mkR(db, e, "2026-10-20", ok, 100);
  mkR(db, e, "2026-10-20", sus, 399);
  mkR(db, e, "2026-10-20", hid, 398, 3000, 0);
  const lb = await dailyLeaderboard(db, "2026-10-20");
  assert.deepEqual(lb.rows.map((r: any) => r.display_name), ["Ok P."]);
});

test("weekly: sums the week, missed days count as zero, max 2800, Monday-Sunday boundaries, shared ranks", async () => {
  const db = createTestDb();
  const days = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26"];
  const ex = Object.fromEntries(days.map((d) => [d, mkExam(db, d)]));
  const full = mkP(db, "Full", "Week"), part = mkP(db, "Part", "Time"), tie = mkP(db, "Tie", "Time"), next = mkP(db, "Next", "Week");
  for (const d of days.slice(0, 7)) mkR(db, ex[d], d, full, 400);
  mkR(db, ex["2026-10-19"], "2026-10-19", part, 280);
  mkR(db, ex["2026-10-25"], "2026-10-25", part, 120); // Sunday still belongs to this week
  mkR(db, ex["2026-10-21"], "2026-10-21", tie, 400);
  mkR(db, ex["2026-10-26"], "2026-10-26", full, 400); // next week's Monday: must NOT count here
  mkR(db, ex["2026-10-26"], "2026-10-26", next, 50);
  const w = await weeklyLeaderboard(db, "2026-10-22");
  assert.equal(w.week_start, "2026-10-19");
  assert.equal(w.week_end, "2026-10-25");
  assert.equal(w.max_score, 2800);
  assert.deepEqual(w.rows.map((r: any) => [r.rank, r.display_name, r.weekly_total, r.exams_taken]), [[1, "Full W.", 2800, 7], [2, "Tie T.", 400, 1], [2, "Part T.", 400, 2]]);
  assert.equal((w.rows[0] as any).weekly_percentage, 100);
  assert.equal((w.rows[2] as any).weekly_percentage, 14.29); // 400 / 2800
  const w2: any = await weeklyLeaderboard(db, "2026-10-26");
  assert.deepEqual(w2.rows.map((r: any) => [r.display_name, r.weekly_total]), [["Full W.", 400], ["Next W.", 50]]);
});

test("week and date edge cases: Lagos date near midnight is already the stored date (no UTC drift)", async () => {
  const db = createTestDb();
  const e = mkExam(db, "2026-10-25"); // a Sunday
  const p = mkP(db, "Late", "Night");
  mkR(db, e, "2026-10-25", p, 250);
  assert.equal((await weeklyLeaderboard(db, "2026-10-25")).week_start, "2026-10-19");
  assert.deepEqual(await availableDates(db), ["2026-10-25"]);
});

test("exports: CSV includes IDs for admins, neutralises formulas in names", async () => {
  const db = createTestDb();
  const e = mkExam(db, "2026-10-20");
  const p = mkP(db, "=cmd", "Evil");
  mkR(db, e, "2026-10-20", p, 123.5);
  const d = await exportDailyCsv(db, "2026-10-20");
  assert.ok(d.includes("JAMB"));
  assert.ok(d.includes("'=cmd"));
  assert.ok(d.includes("123.5"));
  assert.ok((await exportWeeklyCsv(db, "2026-10-20")).includes("weekly_total"));
  void seedAdmin;
});
