import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeAttempt, getCorrections, getMyResult, getPaper, saveAnswers, startAttempt, submitAttempt, sweepExpired } from "../server/attempts.ts";
import { sha256Hex } from "../server/crypto.ts";
import { approveExam, createExam, generateSubject, publishExam, type ECtx } from "../server/exams.ts";
import type { Ctx } from "../server/participants.ts";
import { createTestDb, PEPPER } from "./helpers/d1.ts";
import { seedAdmin, seedBank } from "./helpers/seed.ts";

const SUBJ = ["physics", "chemistry", "mathematics"];
const ALL = ["english", ...SUBJ];
const T0 = new Date("2026-10-20T08:00:00Z"); // exam window 07:00Z - 19:00Z, 120 min, corrections at 22:00Z+

async function world() {
  const db = createTestDb();
  const adminId = seedAdmin(db);
  await seedBank(db, ALL, 70);
  const ectx: ECtx = { db, now: new Date("2026-10-15T10:00:00Z"), ipHash: "ip", adminId };
  const examId = ((await createExam(ectx, {
    exam_date: "2026-10-20", title: "Mock", subjects: ALL, starts_at: "2026-10-20T08:00:00+01:00", ends_at: "2026-10-20T20:00:00+01:00",
    duration_minutes: 120, correction_release_at: "2026-10-21T00:00:00+01:00",
  })).body as any).id as number;
  for (const s of ALL) await generateSubject(ectx, examId, s);
  await approveExam(ectx, examId);
  await publishExam(ectx, examId);
  return { db, examId };
}
type W = Awaited<ReturnType<typeof world>>;
const ctxAt = (w: W, now: Date): Ctx => ({ db: w.db, pepper: PEPPER, now, ipHash: "ip" });

let n = 0;
async function person(w: W, subjects = SUBJ) {
  const id = `JAMB${String(1000 + ++n)}AB`;
  const device = `device-${id}`;
  w.db.raw.prepare("INSERT INTO participants (id, first_name, last_name, target_score, intended_course, preferred_institution, gender) VALUES (?,?,?,?,?,?,?)").run(id, "Ada", "Obi", 250, "c", "i", "female");
  for (const s of subjects) w.db.raw.prepare("INSERT INTO participant_subjects (participant_id, subject_id) VALUES (?,?)").run(id, s);
  w.db.raw.prepare("INSERT INTO participant_devices (participant_id, token_hash, created_at) VALUES (?,?,?)").run(id, await sha256Hex(device), "2026-10-15T00:00:00Z");
  return { id, device };
}
const start = async (w: W, p: { id: string; device: string }, at = T0, share = true) => startAttempt(ctxAt(w, at), p.id, p.device, { share_confirmed: share });

/** The answer key for an attempt, read straight from the database (the test plays "an honest candidate who knows it all"). */
function key(w: W, attemptId: number) {
  return w.db.raw.prepare(
    `SELECT q.id, q.subject_id, k.correct_option FROM exam_questions q JOIN exam_answer_keys k ON k.exam_question_id = q.id
      WHERE q.exam_id = (SELECT exam_id FROM attempts WHERE id = ?) AND (q.subject_id='english' OR q.subject_id IN (SELECT subject_id FROM attempt_subjects WHERE attempt_id = ?))`,
  ).all(attemptId, attemptId) as { id: number; subject_id: string; correct_option: string }[];
}
const wrong = (l: string) => (l === "A" ? "B" : "A");

test("start: needs a trusted device, an open window, the share confirmation, and covers the person's subjects", async () => {
  const w = await world();
  const p = await person(w);
  assert.equal((await startAttempt(ctxAt(w, T0), p.id, "stolen-or-missing", {})).status, 403);
  assert.equal((await startAttempt(ctxAt(w, T0), p.id, undefined, {})).status, 403);
  assert.equal((await startAttempt(ctxAt(w, T0), "bogus", p.device, {})).status, 400);
  assert.equal((await start(w, p, new Date("2026-10-20T05:00:00Z"))).status, 409); // before the window
  assert.equal((await start(w, p, new Date("2026-10-20T20:00:00Z"))).status, 409); // after the window
  const gate = await start(w, p, T0, false);
  assert.equal(gate.status, 400);
  assert.equal((gate.body as any).needs_share, true);
  assert.equal((await start(w, p)).status, 201);

  const outsider = await person(w, ["biology", "economics", "irk"]);
  assert.equal((await start(w, outsider)).status, 409); // exam lacks his subjects
  w.db.raw.prepare("UPDATE participants SET status='suspended' WHERE id = ?").run(p.id);
  assert.equal((await start(w, p)).status, 403);
});

test("share gate: configurable, and only a self-declared confirmation is recorded", async () => {
  const w = await world();
  w.db.raw.prepare("UPDATE settings SET value='0' WHERE key='whatsapp_gate_enabled'").run();
  const p = await person(w);
  const r = await start(w, p, T0, false);
  assert.equal(r.status, 201);
  assert.equal((w.db.raw.prepare("SELECT share_confirmed_at s FROM attempts WHERE id = ?").get((r.body as any).attempt_id) as any).s, null);
  const q = await person(w);
  w.db.raw.prepare("UPDATE settings SET value='1' WHERE key='whatsapp_gate_enabled'").run();
  const r2 = await start(w, q, T0, true);
  assert.ok((w.db.raw.prepare("SELECT share_confirmed_at s FROM attempts WHERE id = ?").get((r2.body as any).attempt_id) as any).s);
});

test("paper: 180 questions, English first, and NO answer key anywhere in the response", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p)).body;
  const paper = await getPaper({ db: w.db, now: T0 }, s.attempt_id, s.attempt_token);
  const body: any = paper.body;
  assert.equal(body.questions.length, 180);
  assert.equal(body.questions[0].subject_id, "english");
  assert.equal(body.questions.filter((q: any) => q.subject_id === "english").length, 60);
  const order = [...new Set(body.questions.map((q: any) => q.subject_id))] as string[];
  assert.equal(order[0], "english");
  assert.deepEqual([...order].sort(), ["chemistry", "english", "mathematics", "physics"]);
  const text = JSON.stringify(paper.body);
  assert.ok(!/correct|answer_key|explanation/i.test(text));
  assert.equal((await getPaper({ db: w.db, now: T0 }, s.attempt_id, "wrong-token")).status, 403);
  assert.equal((await getPaper({ db: w.db, now: T0 }, s.attempt_id + 1, s.attempt_token)).status, 403);
  // another participant's paper cannot be opened with my token
  const q = await person(w);
  const s2: any = (await start(w, q)).body;
  assert.equal((await getPaper({ db: w.db, now: T0 }, s2.attempt_id, s.attempt_token)).status, 403);
});

test("deadline is set by the server: start + 120 minutes, whatever the browser claims", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p, new Date("2026-10-20T09:30:00Z"))).body;
  assert.equal(s.deadline_at, "2026-10-20T11:30:00Z");
});

test("autosave: deltas merge, clearing works, foreign questions refused, rate-limited, one row write", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p)).body;
  const k = key(w, s.attempt_id);
  const at = (sec: number) => ({ db: w.db, now: new Date(+T0 + sec * 1000) });
  assert.equal((await saveAnswers(at(10), s.attempt_id, s.attempt_token, { [k[0].id]: "A", [k[1].id]: "B" })).status, 200);
  assert.equal((await saveAnswers(at(10.5), s.attempt_id, s.attempt_token, { [k[2].id]: "C" })).status, 429); // too fast
  assert.equal((await saveAnswers(at(20), s.attempt_id, s.attempt_token, { [k[0].id]: null, [k[2].id]: "C" })).status, 200);
  const paper: any = (await getPaper(at(21), s.attempt_id, s.attempt_token)).body;
  assert.deepEqual(paper.answers, { [k[1].id]: "B", [k[2].id]: "C" });

  assert.equal((await saveAnswers(at(30), s.attempt_id, s.attempt_token, { [k[0].id]: "E" })).status, 400);
  assert.equal((await saveAnswers(at(30), s.attempt_id, s.attempt_token, { abc: "A" })).status, 400);
  assert.equal((await saveAnswers(at(30), s.attempt_id, s.attempt_token, [1])).status, 400);
  assert.equal((await saveAnswers(at(30), s.attempt_id, "nope", { [k[0].id]: "A" })).status, 403);
});

test("a question from a subject the candidate did not choose cannot be answered", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p)).body;
  const bio: any = w.db.raw.prepare("SELECT id FROM exam_questions WHERE exam_id = ? AND subject_id NOT IN ('english','physics','chemistry','mathematics') LIMIT 1").get(w.examId);
  assert.equal(bio, undefined); // exam only covers 4 subjects in this fixture
  // so cross-check with a second person who chose different subjects
  const w2 = await world();
  const a = await person(w2, ["physics", "chemistry", "mathematics"]);
  const sa: any = (await start(w2, a)).body;
  w2.db.raw.prepare("DELETE FROM attempt_subjects WHERE attempt_id = ? AND subject_id = 'mathematics'").run(sa.attempt_id);
  const math: any = w2.db.raw.prepare("SELECT id FROM exam_questions WHERE exam_id = ? AND subject_id = 'mathematics' LIMIT 1").get(w2.examId);
  assert.equal((await saveAnswers({ db: w2.db, now: new Date(+T0 + 5000) }, sa.attempt_id, sa.attempt_token, { [math.id]: "A" })).status, 400);
  void s;
});

test("scoring: each subject is out of 100, total out of 400, computed from the server's own key", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p)).body;
  const k = key(w, s.attempt_id);
  // English: all 60 right (100). Physics: 30/40 (75). Chemistry: 10/40 (25). Mathematics: none answered (0).
  const answers: Record<string, string> = {};
  let phys = 0, chem = 0;
  for (const q of k) {
    if (q.subject_id === "english") answers[q.id] = q.correct_option;
    else if (q.subject_id === "physics") answers[q.id] = phys++ < 30 ? q.correct_option : wrong(q.correct_option);
    else if (q.subject_id === "chemistry") answers[q.id] = chem++ < 10 ? q.correct_option : wrong(q.correct_option);
  }
  const r: any = (await submitAttempt({ db: w.db, now: new Date(+T0 + 3600_000) }, s.attempt_id, s.attempt_token, { answers })).body;
  assert.equal(r.submitted, true);
  assert.equal(r.result.total_score, 200);
  const by = Object.fromEntries(r.result.subjects.map((x: any) => [x.subject_id, x.score]));
  assert.deepEqual(by, { english: 100, physics: 75, chemistry: 25, mathematics: 0 });
  assert.equal(r.result.duration_seconds, 3600);
  assert.equal(r.result.daily_rank, 1);
  const row: any = w.db.raw.prepare("SELECT status, submit_reason FROM attempts WHERE id = ?").get(s.attempt_id);
  assert.deepEqual({ ...row }, { status: "submitted", submit_reason: "manual" });
  assert.equal(JSON.stringify(r).includes("correct_option"), false);
});

test("perfect and zero scores, and the browser cannot send a score or a rank", async () => {
  const w = await world();
  const a = await person(w), b = await person(w);
  const sa: any = (await start(w, a)).body, sb: any = (await start(w, b)).body;
  const perfect = Object.fromEntries(key(w, sa.attempt_id).map((q) => [q.id, q.correct_option]));
  const ra: any = (await submitAttempt({ db: w.db, now: new Date(+T0 + 600_000) }, sa.attempt_id, sa.attempt_token, { answers: perfect, total_score: 1, score: 400 } as any)).body;
  assert.equal(ra.result.total_score, 400);
  const rb: any = (await submitAttempt({ db: w.db, now: new Date(+T0 + 600_000) }, sb.attempt_id, sb.attempt_token, { answers: {}, total_score: 400 } as any)).body;
  assert.equal(rb.result.total_score, 0);
  assert.equal(ra.result.daily_rank, 1);
});

test("duplicate submissions are harmless: one result, same answer every time, concurrent calls included", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p)).body;
  const perfect = Object.fromEntries(key(w, s.attempt_id).map((q) => [q.id, q.correct_option]));
  const now = new Date(+T0 + 900_000);
  const results = await Promise.all([1, 2, 3].map(() => submitAttempt({ db: w.db, now }, s.attempt_id, s.attempt_token, { answers: perfect })));
  assert.ok(results.every((r) => r.status === 200 && (r.body as any).result.total_score === 400));
  const again: any = (await submitAttempt({ db: w.db, now: new Date(+now + 5000) }, s.attempt_id, s.attempt_token, { answers: {} })).body;
  assert.equal(again.already_submitted, true);
  assert.equal(again.result.total_score, 400); // later empty submission cannot overwrite
  assert.equal((w.db.raw.prepare("SELECT COUNT(*) n FROM results").get() as any).n, 1);
  assert.equal((w.db.raw.prepare("SELECT COUNT(*) n FROM result_subject_scores").get() as any).n, 4);
  assert.equal((await saveAnswers({ db: w.db, now: new Date(+now + 9000) }, s.attempt_id, s.attempt_token, { [Object.keys(perfect)[0]]: "A" })).status, 409);
  // and a second attempt for the same day is refused
  assert.equal((await start(w, p, new Date(+now + 10_000))).status, 409);
});

test("timeout: server closes the exam at the deadline; late answers are not counted", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p)).body; // deadline 10:00Z
  const k = key(w, s.attempt_id);
  const e0 = k.find((q) => q.subject_id === "english")!; // 1 of 60 English = 1.67
  await saveAnswers({ db: w.db, now: new Date(+T0 + 60_000) }, s.attempt_id, s.attempt_token, { [e0.id]: e0.correct_option });
  // browser tries to slip in a full set of correct answers 5 minutes late
  const late = new Date("2026-10-20T10:05:00Z");
  const perfect = Object.fromEntries(k.map((q) => [q.id, q.correct_option]));
  const r: any = (await submitAttempt({ db: w.db, now: late }, s.attempt_id, s.attempt_token, { answers: perfect })).body;
  assert.equal(r.result.total_score, 1.67); // only the one answer saved in time
  assert.equal(r.result.duration_seconds, 7200); // capped at the 120-minute limit
  const row: any = w.db.raw.prepare("SELECT status, submit_reason, submitted_at FROM attempts WHERE id = ?").get(s.attempt_id);
  assert.deepEqual({ ...row }, { status: "auto_submitted", submit_reason: "timeout", submitted_at: "2026-10-20T10:00:00Z" });
});

test("grace period: final answers sent within 30 s after the deadline are still accepted", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p)).body;
  const k = key(w, s.attempt_id);
  const e0 = k.find((q) => q.subject_id === "english")!;
  const r: any = (await submitAttempt({ db: w.db, now: new Date("2026-10-20T10:00:10Z") }, s.attempt_id, s.attempt_token, { answers: { [e0.id]: e0.correct_option } })).body;
  assert.equal(r.result.total_score, 1.67); // 10 s late is inside the 30 s grace: the final answers sent with the submit are accepted
  assert.equal(w.db.raw.prepare("SELECT submit_reason r FROM attempts WHERE id = ?").get(s.attempt_id) && (w.db.raw.prepare("SELECT submit_reason r FROM attempts WHERE id = ?").get(s.attempt_id) as any).r, "timeout");
});

test("closing the tab: reading, saving or sweeping after the deadline auto-submits with saved answers", async () => {
  const w = await world();
  const a = await person(w), b = await person(w), c = await person(w);
  const [sa, sb, sc]: any[] = [(await start(w, a)).body, (await start(w, b)).body, (await start(w, c)).body];
  const after = new Date("2026-10-20T10:10:00Z");
  assert.equal(((await getPaper({ db: w.db, now: after }, sa.attempt_id, sa.attempt_token)).body as any).finished, true);
  const sv = await saveAnswers({ db: w.db, now: after }, sb.attempt_id, sb.attempt_token, { 1: "A" });
  assert.equal(sv.status, 409);
  assert.equal(await sweepExpired(w.db, after), 1); // only c is still open
  assert.equal(w.db.raw.prepare("SELECT COUNT(*) n FROM attempts WHERE status = 'in_progress'").get()!.n, 0);
  assert.equal(w.db.raw.prepare("SELECT submit_reason r FROM attempts WHERE id = ?").get(sc.attempt_id)!.r, "server_sweep");
  assert.equal(w.db.raw.prepare("SELECT COUNT(*) n FROM results").get()!.n, 3);
  assert.equal(await sweepExpired(w.db, after), 0);
});

test("tab hidden: client may request tab_hidden auto-submit; unknown reasons fall back to manual", async () => {
  const w = await world();
  const a = await person(w), b = await person(w);
  const sa: any = (await start(w, a)).body, sb: any = (await start(w, b)).body;
  await submitAttempt({ db: w.db, now: new Date(+T0 + 1000) }, sa.attempt_id, sa.attempt_token, { reason: "tab_hidden" });
  await submitAttempt({ db: w.db, now: new Date(+T0 + 1000) }, sb.attempt_id, sb.attempt_token, { reason: "rm -rf" });
  assert.deepEqual({ ...(w.db.raw.prepare("SELECT status, submit_reason FROM attempts WHERE id = ?").get(sa.attempt_id) as object) }, { status: "auto_submitted", submit_reason: "tab_hidden" });
  assert.equal(w.db.raw.prepare("SELECT submit_reason r FROM attempts WHERE id = ?").get(sb.attempt_id)!.r, "manual");
});

test("resume: same participant on a trusted device continues; old token stops working; deadline unchanged", async () => {
  const w = await world();
  const p = await person(w);
  const s1: any = (await start(w, p)).body;
  const k = key(w, s1.attempt_id);
  await saveAnswers({ db: w.db, now: new Date(+T0 + 5000) }, s1.attempt_id, s1.attempt_token, { [k[0].id]: "C" });
  const s2: any = (await start(w, p, new Date(+T0 + 600_000), false)).body; // no share box needed to resume
  assert.equal(s2.resumed, true);
  assert.equal(s2.attempt_id, s1.attempt_id);
  assert.equal(s2.deadline_at, s1.deadline_at);
  assert.notEqual(s2.attempt_token, s1.attempt_token);
  assert.equal((await getPaper({ db: w.db, now: new Date(+T0 + 600_000) }, s1.attempt_id, s1.attempt_token)).status, 403);
  const paper: any = (await getPaper({ db: w.db, now: new Date(+T0 + 600_000) }, s2.attempt_id, s2.attempt_token)).body;
  assert.equal(paper.answers[k[0].id], "C");
  // resuming still works after the start window closed (19:00Z) as long as the personal deadline has not passed
  const q = await person(w);
  const sq: any = (await start(w, q, new Date("2026-10-20T18:30:00Z"))).body;
  const rq: any = (await start(w, q, new Date("2026-10-20T19:30:00Z"))).body;
  assert.equal(rq.resumed, true);
  void sq;
});

test("corrections: hidden until release time, then shown only to the participant who took the exam", async () => {
  const w = await world();
  const p = await person(w), other = await person(w);
  const s: any = (await start(w, p)).body;
  const k = key(w, s.attempt_id);
  await submitAttempt({ db: w.db, now: new Date(+T0 + 1000) }, s.attempt_id, s.attempt_token, { answers: { [k[0].id]: k[0].correct_option, [k[1].id]: wrong(k[1].correct_option) } });

  const before = new Date("2026-10-20T22:59:59Z"); // release = 2026-10-20T23:00:00Z
  const early = await getCorrections(ctxAt(w, before), p.id, p.device, "2026-10-20");
  assert.equal(early.status, 403);
  assert.equal(JSON.stringify(early.body).includes("correct_option"), false);
  assert.equal((early.body as any).release_at, "2026-10-20T23:00:00Z");

  const ok: any = await getCorrections(ctxAt(w, new Date("2026-10-20T23:00:00Z")), p.id, p.device, "2026-10-20");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.questions.length, 180);
  const q0 = ok.body.questions.find((q: any) => q.id === k[0].id), q1 = ok.body.questions.find((q: any) => q.id === k[1].id);
  assert.equal(q0.is_correct, true);
  assert.equal(q1.is_correct, false);
  assert.equal(q1.correct_option, k[1].correct_option);

  assert.equal((await getCorrections(ctxAt(w, new Date("2026-10-21T00:00:00Z")), p.id, "stolen", "2026-10-20")).status, 403);
  assert.equal((await getCorrections(ctxAt(w, new Date("2026-10-21T00:00:00Z")), other.id, other.device, "2026-10-20")).status, 404); // other never took it
  assert.equal((await getCorrections(ctxAt(w, new Date("2026-10-21T00:00:00Z")), p.id, p.device, "20-10-2026")).status, 400);
});

test("corrections: nothing for an unfinished attempt, and getMyResult needs a trusted device", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p)).body;
  void s;
  assert.equal((await getCorrections(ctxAt(w, new Date("2026-10-22T00:00:00Z")), p.id, p.device, "2026-10-20")).status, 404);
  assert.equal((await getMyResult(ctxAt(w, T0), p.id, "stolen")).status, 403);
  assert.equal((await getMyResult(ctxAt(w, T0), p.id, p.device)).status, 404);
  await finalizeAttempt(w.db, s.attempt_id, "manual", new Date(+T0 + 5000));
  const r: any = await getMyResult(ctxAt(w, new Date(+T0 + 6000)), p.id, p.device);
  assert.equal(r.status, 200);
  assert.equal(r.body.result.total_score, 0);
});

test("D1 parameter limit: a final submit carrying every answer (180) works, saving 150 at once works", async () => {
  const w = await world();
  const p = await person(w);
  const s: any = (await start(w, p)).body;
  const k = key(w, s.attempt_id);
  const first150 = Object.fromEntries(k.slice(0, 150).map((q) => [q.id, q.correct_option]));
  assert.equal((await saveAnswers({ db: w.db, now: new Date(+T0 + 5000) }, s.attempt_id, s.attempt_token, first150)).status, 200);
  const all = Object.fromEntries(k.map((q) => [q.id, q.correct_option]));
  const r: any = (await submitAttempt({ db: w.db, now: new Date(+T0 + 60_000) }, s.attempt_id, s.attempt_token, { answers: all })).body;
  assert.equal(r.result.total_score, 400);
});

test("anonymous spam with someone's ID cannot lock that person out of starting", async () => {
  const w = await world();
  const victim = await person(w);
  for (let i = 0; i < 25; i++) await startAttempt({ ...ctxAt(w, T0), ipHash: "attacker" }, victim.id, "no-device", {});
  const r = await startAttempt({ ...ctxAt(w, T0), ipHash: "victim-ip" }, victim.id, victim.device, { share_confirmed: true });
  assert.equal(r.status, 201);
});

test("resume works after midnight (Lagos) and an overdue attempt from an earlier day does not block today", async () => {
  const w = await world();
  const p = await person(w);
  // started 22:30 Lagos on exam day (21:30Z), deadline 23:30Z = 00:30 Lagos next day
  const s: any = (await start(w, p, new Date("2026-10-20T18:30:00Z"))).body;
  const r: any = await startAttempt(ctxAt(w, new Date("2026-10-20T19:10:00Z")), p.id, p.device, {});
  assert.equal(r.body.resumed, true);
  void s;
  // later a different day's exam: the old attempt is long overdue and gets closed, not 409
  const ectx = { db: w.db, now: new Date("2026-10-15T10:00:00Z"), ipHash: "ip", adminId: 1 };
  const e2 = ((await createExam(ectx, { exam_date: "2026-10-22", title: "Day two", subjects: ALL, starts_at: "2026-10-22T08:00:00+01:00", ends_at: "2026-10-22T20:00:00+01:00", duration_minutes: 120, correction_release_at: "2026-10-23T00:00:00+01:00" })).body as any).id;
  for (const sub of ALL) await generateSubject(ectx, e2, sub);
  await approveExam(ectx, e2);
  await publishExam(ectx, e2);
  const next: any = await startAttempt(ctxAt(w, new Date("2026-10-22T08:30:00Z")), p.id, p.device, { share_confirmed: true });
  assert.equal(next.status, 201);
  assert.equal((w.db.raw.prepare("SELECT status FROM attempts WHERE id = ?").get(s.attempt_id) as any).status, "auto_submitted");
});
