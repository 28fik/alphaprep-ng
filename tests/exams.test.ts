import assert from "node:assert/strict";
import { test } from "node:test";
import {
  approveExam, cancelExam, createExam, generateSubject, pickBalanced, previewExam, publishExam, shuffleOptions, unapproveExam, updateExam,
  validateExamInput, type ECtx,
} from "../server/exams.ts";
import { deleteQuestions, type QCtx } from "../server/questions.ts";
import { createTestDb, NOW } from "./helpers/d1.ts";
import { seedAdmin, seedBank } from "./helpers/seed.ts";

const SUBJECTS = ["english", "mathematics", "physics", "chemistry"];

function setup() {
  const db = createTestDb();
  const adminId = seedAdmin(db);
  const ctx: ECtx = { db, now: NOW, ipHash: "ip", adminId };
  return { db, ctx, adminId };
}
const sched = (over: Record<string, unknown> = {}) => ({
  exam_date: "2026-10-20", title: "Mock Exam 20 Oct", subjects: SUBJECTS,
  starts_at: "2026-10-20T08:00:00+01:00", ends_at: "2026-10-20T20:00:00+01:00", duration_minutes: 120,
  correction_release_at: "2026-10-21T00:00:00+01:00", ...over,
});
async function fullyGenerated() {
  const s = setup();
  await seedBank(s.db, SUBJECTS, 70);
  const id = ((await createExam(s.ctx, sched())).body as any).id as number;
  for (const sub of SUBJECTS) assert.equal((await generateSubject(s.ctx, id, sub)).status, 200);
  return { ...s, id };
}

test("schedule validation: dates, ordering, and answers hidden until the last starter has finished", () => {
  assert.equal(validateExamInput(sched()).ok, true);
  const bad = (o: Record<string, unknown>) => (validateExamInput(sched(o)) as any).errors ?? {};
  assert.ok(bad({ exam_date: "2026-02-31" }).exam_date);
  assert.ok(bad({ title: "x" }).title);
  assert.ok(bad({ starts_at: "tomorrow" }).starts_at);
  assert.ok(bad({ ends_at: "2026-10-20T07:00:00+01:00" }).ends_at);
  assert.ok(bad({ duration_minutes: 0 }).duration_minutes);
  // window closes 20:00 + 120 min exam = 22:00 (Lagos): release at 21:00 would leak answers mid-exam
  assert.ok(bad({ correction_release_at: "2026-10-20T21:00:00+01:00" }).correction_release_at);
  assert.ok(bad({ correction_release_at: "2026-10-20T22:00:00+01:00" }).correction_release_at); // exactly 22:00 is still too early: the grace period must fit too
  assert.equal(bad({ correction_release_at: "2026-10-20T22:03:00+01:00" }).correction_release_at, undefined);
  // the whole window must sit on the exam date (Lagos): otherwise the exam would be offered on the wrong day
  assert.ok(bad({ starts_at: "2026-10-18T08:00:00+01:00" }).starts_at);
  assert.ok(bad({ ends_at: "2026-10-21T01:00:00+01:00", correction_release_at: "2026-10-22T00:00:00+01:00" }).ends_at);
  assert.equal(bad({ starts_at: "2026-10-20T00:30:00+01:00" }).starts_at, undefined);
  assert.ok(bad({ starts_at: "2026-10-19T23:30:00Z", ends_at: "2026-10-20T20:00:00+01:00" }).starts_at === undefined); // 23:30Z = 00:30 Lagos on the 20th
  // offsets are normalised to UTC
  assert.equal((validateExamInput(sched()) as any).value.starts_at, "2026-10-20T07:00:00Z");
});

test("create: duplicate date 409, English is always included, needs 4+ subjects", async () => {
  const { ctx, db } = setup();
  assert.equal((await createExam(ctx, sched())).status, 201);
  assert.equal((await createExam(ctx, sched())).status, 409);
  assert.equal((await createExam(ctx, sched({ exam_date: "2026-10-21", starts_at: "2026-10-21T08:00:00+01:00", ends_at: "2026-10-21T20:00:00+01:00", correction_release_at: "2026-10-22T00:00:00+01:00", subjects: ["physics", "chemistry", "mathematics"] }))).status, 201); // english auto-added
  assert.equal((await createExam(ctx, sched({ exam_date: "2026-10-22", starts_at: "2026-10-22T08:00:00+01:00", ends_at: "2026-10-22T20:00:00+01:00", correction_release_at: "2026-10-23T00:00:00+01:00", subjects: ["english", "physics"] }))).status, 400);
  const n: any = db.raw.prepare("SELECT question_count c FROM exam_subjects es JOIN exams e ON e.id = es.exam_id WHERE e.exam_date='2026-10-20' AND subject_id='english'").get();
  assert.equal(n.c, 60);
  const m: any = db.raw.prepare("SELECT question_count c FROM exam_subjects es JOIN exams e ON e.id = es.exam_id WHERE e.exam_date='2026-10-20' AND subject_id='physics'").get();
  assert.equal(m.c, 40);
});

test("generation: 60 English + 40 per subject, from bank only, answer keys never mixed up", async () => {
  const { db, id } = await fullyGenerated();
  const counts: any[] = db.raw.prepare("SELECT subject_id s, COUNT(*) n FROM exam_questions WHERE exam_id = ? GROUP BY subject_id ORDER BY s").all(id) as any;
  assert.deepEqual(Object.fromEntries(counts.map((c) => [c.s, c.n])), { chemistry: 40, english: 60, mathematics: 40, physics: 40 });
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM exam_answer_keys").get() as any).n, 180);

  // Key alignment: for every exam question, the option the exam key points at must be the same TEXT
  // as the correct option in the bank (shuffling must never detach the answer).
  const rows: any[] = db.raw.prepare(
    `SELECT eq.option_a a, eq.option_b b, eq.option_c c, eq.option_d d, ek.correct_option exam_key, bk.correct_option bank_key,
            q.option_a qa, q.option_b qb, q.option_c qc, q.option_d qd
       FROM exam_questions eq JOIN exam_answer_keys ek ON ek.exam_question_id = eq.id
       JOIN questions q ON q.id = eq.question_id JOIN question_answer_keys bk ON bk.question_id = q.id WHERE eq.exam_id = ?`).all(id) as any;
  assert.equal(rows.length, 180);
  let moved = 0;
  for (const r of rows) {
    const examText = { A: r.a, B: r.b, C: r.c, D: r.d }[r.exam_key as "A"];
    const bankText = { A: r.qa, B: r.qb, C: r.qc, D: r.qd }[r.bank_key as "A"];
    assert.equal(examText, bankText);
    if (r.exam_key !== r.bank_key) moved++;
  }
  assert.ok(moved > 30, "options really were shuffled"); // ~75% expected
  // no duplicate source question inside an exam
  assert.equal((db.raw.prepare("SELECT COUNT(*) - COUNT(DISTINCT question_id) d FROM exam_questions WHERE exam_id = ?").get(id) as any).d, 0);
});

test("generation: balances topics, and rotates away from recently used questions", async () => {
  const { db, ctx } = setup();
  await seedBank(db, SUBJECTS, 70);
  const e1 = ((await createExam(ctx, sched())).body as any).id;
  const e2 = ((await createExam(ctx, sched({ exam_date: "2026-10-21", starts_at: "2026-10-21T08:00:00+01:00", ends_at: "2026-10-21T20:00:00+01:00", correction_release_at: "2026-10-22T00:00:00+01:00" }))).body as any).id;
  await generateSubject(ctx, e1, "mathematics");
  const topics: any[] = db.raw.prepare("SELECT b.topic t, COUNT(*) n FROM exam_questions eq JOIN questions b ON b.id = eq.question_id WHERE eq.exam_id = ? GROUP BY b.topic").all(e1) as any;
  assert.equal(topics.length, 4);
  assert.ok(topics.every((t) => t.n === 10)); // 40 over 4 equal topics
  await generateSubject(ctx, e2, "mathematics");
  const overlap: any = db.raw.prepare("SELECT COUNT(*) n FROM exam_questions a JOIN exam_questions b ON a.question_id = b.question_id WHERE a.exam_id = ? AND b.exam_id = ?").get(e1, e2);
  assert.equal(overlap.n, 10); // 70 questions, 40 used before: all 30 unused are taken first, only 10 repeats needed
});

test("generation: refuses unusable questions (no key / needs review / inactive) and says how many are missing", async () => {
  const { db, ctx } = setup();
  await seedBank(db, ["english"], 59);
  await seedBank(db, ["mathematics"], 40, { status: "needs_review" });
  const id = ((await createExam(ctx, sched())).body as any).id;
  const r = await generateSubject(ctx, id, "english");
  assert.equal(r.status, 422);
  assert.equal((r.body as any).available, 59);
  assert.equal((await generateSubject(ctx, id, "mathematics")).status, 422); // needs_review is excluded
  db.raw.prepare("UPDATE questions SET verification_status='verified'").run();
  db.raw.prepare("UPDATE questions SET is_active = 0 WHERE id = (SELECT MIN(id) FROM questions WHERE subject_id='mathematics')").run();
  assert.equal((await generateSubject(ctx, id, "mathematics")).status, 422); // 39 active
  db.raw.prepare("DELETE FROM question_answer_keys WHERE question_id IN (SELECT id FROM questions WHERE subject_id='english' LIMIT 1)").run();
  assert.equal((await generateSubject(ctx, id, "english")).status, 422); // 58 with keys
  assert.equal((await generateSubject(ctx, id, "biology")).status, 404); // not part of this exam
});

test("pickBalanced and shuffleOptions are deterministic given an rng and keep the answer attached", () => {
  const seq = (vals: number[]) => { let i = 0; return (n: number) => vals[i++ % vals.length] % n; };
  const pool = Array.from({ length: 12 }, (_, i) => ({ id: i, topic: ["a", "b", "c"][i % 3], uses: 0 }));
  const picked = pickBalanced(pool, 6, seq([1, 2, 3, 0]));
  assert.equal(new Set(picked.map((p) => p.id)).size, 6);
  const t = picked.map((p) => p.topic);
  for (const topic of ["a", "b", "c"]) assert.equal(t.filter((x) => x === topic).length, 2);
  for (let seed = 0; seed < 50; seed++) {
    const r = shuffleOptions(["w", "x", "y", "z"], "C", seq([seed, seed + 3, seed + 5]), true);
    assert.equal(r.opts["ABCD".indexOf(r.correct)], "y");
    assert.deepEqual([...r.opts].sort(), ["w", "x", "y", "z"]);
  }
  assert.deepEqual(shuffleOptions(["w", "x", "y", "z"], "D", seq([1]), false), { opts: ["w", "x", "y", "z"], correct: "D" });
  assert.equal(pickBalanced(pool.slice(0, 2), 5, seq([0])).length, 2); // never invents
});

test("workflow: approve needs complete subjects, publish freezes, frozen exams reject changes at DB level", async () => {
  const { ctx, db, id } = await fullyGenerated();
  assert.equal((await publishExam(ctx, id)).status, 409); // not approved yet
  const empty = ((await createExam(ctx, sched({ exam_date: "2026-11-01", starts_at: "2026-11-01T08:00:00+01:00", ends_at: "2026-11-01T20:00:00+01:00", correction_release_at: "2026-11-02T00:00:00+01:00" }))).body as any).id;
  assert.equal((await approveExam(ctx, empty)).status, 422);

  const prev: any = (await previewExam(db, id, { now: NOW, liveKeysAllowed: true })).body;
  assert.equal(prev.questions.length, 180);
  assert.ok(prev.questions[0].correct_option); // admin preview shows keys

  assert.equal((await approveExam(ctx, id)).status, 200);
  assert.equal((await unapproveExam(ctx, id)).status, 200);
  assert.equal((await approveExam(ctx, id)).status, 200);
  assert.equal((await publishExam(ctx, id)).status, 200);
  assert.ok((db.raw.prepare("SELECT frozen_at f FROM exams WHERE id = ?").get(id) as any).f);

  // application level
  assert.equal((await generateSubject(ctx, id, "physics")).status, 409);
  assert.equal((await unapproveExam(ctx, id)).status, 409);
  // database level (a bug or a manual query cannot alter a frozen exam either)
  const eq: any = db.raw.prepare("SELECT id FROM exam_questions WHERE exam_id = ? LIMIT 1").get(id);
  assert.throws(() => db.raw.prepare("UPDATE exam_questions SET question_text = 'x' WHERE id = ?").run(eq.id), /frozen/);
  assert.throws(() => db.raw.prepare("DELETE FROM exam_questions WHERE id = ?").run(eq.id), /frozen/);
  assert.throws(() => db.raw.prepare("UPDATE exam_answer_keys SET correct_option = 'A' WHERE exam_question_id = ?").run(eq.id), /frozen/);
  assert.throws(() => db.raw.prepare("DELETE FROM exam_answer_keys WHERE exam_question_id = ?").run(eq.id), /frozen/);
  assert.throws(() => db.raw.prepare("INSERT INTO exam_questions (exam_id, subject_id, position, question_text, option_a, option_b, option_c, option_d) VALUES (?, 'physics', 99, 'q','a','b','c','d')").run(id), /frozen/);
  assert.throws(() => db.raw.prepare("DELETE FROM exam_subjects WHERE exam_id = ?").run(id), /frozen/);
});

test("frozen snapshot is independent of the bank: editing or deleting bank questions does not change a published exam", async () => {
  const { ctx, db, id, adminId } = await fullyGenerated();
  await approveExam(ctx, id);
  await publishExam(ctx, id);
  const before = JSON.stringify(db.raw.prepare("SELECT question_text, option_a, option_b, option_c, option_d FROM exam_questions WHERE exam_id = ? ORDER BY id").all(id));
  db.raw.prepare("UPDATE questions SET question_text = 'CHANGED', option_a = 'CHANGED'").run();
  const qctx: QCtx = { db, now: NOW, ipHash: "ip", adminId };
  const ids = (db.raw.prepare("SELECT id FROM questions WHERE subject_id = 'physics' LIMIT 50").all() as any[]).map((r) => r.id);
  assert.equal((await deleteQuestions(qctx, ids)).status, 200); // bank deletion is still allowed
  const after = JSON.stringify(db.raw.prepare("SELECT question_text, option_a, option_b, option_c, option_d FROM exam_questions WHERE exam_id = ? ORDER BY id").all(id));
  assert.equal(before, after);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM exam_answer_keys").get() as any).n, 180);
});

test("reschedule and cancel: allowed before attempts, restricted after", async () => {
  const { ctx, db, id } = await fullyGenerated();
  await approveExam(ctx, id);
  await publishExam(ctx, id);
  assert.equal((await updateExam(ctx, id, { ends_at: "2026-10-20T22:00:00+01:00", correction_release_at: "2026-10-21T02:00:00+01:00" })).status, 200);
  assert.equal((await updateExam(ctx, id, { ends_at: "2026-10-20T07:00:00+01:00" })).status, 400);
  assert.equal((await updateExam(ctx, id, { exam_date: "2026-10-25", starts_at: "2026-10-25T08:00:00+01:00", ends_at: "2026-10-25T20:00:00+01:00", correction_release_at: "2026-10-26T00:00:00+01:00" })).status, 409); // date locked once approved/published

  db.raw.prepare("INSERT INTO participants (id, first_name, last_name, target_score, intended_course, preferred_institution, gender) VALUES ('JAMB1234AB','A','B',250,'c','i','male')").run();
  db.raw.prepare(`INSERT INTO attempts (exam_id, participant_id, exam_date, started_at, deadline_at, attempt_token_hash) VALUES (?, 'JAMB1234AB', '2026-10-20', '2026-10-20T08:00:00Z','2026-10-20T10:00:00Z','h')`).run(id);
  assert.equal((await updateExam(ctx, id, { starts_at: "2026-10-20T06:00:00+01:00" })).status, 409);
  assert.equal((await updateExam(ctx, id, { correction_release_at: "2026-10-21T06:00:00+01:00" })).status, 200); // only this may move
  assert.equal((await cancelExam(ctx, id)).status, 409);

  const other = ((await createExam(ctx, sched({ exam_date: "2026-12-01", starts_at: "2026-12-01T08:00:00+01:00", ends_at: "2026-12-01T20:00:00+01:00", correction_release_at: "2026-12-02T00:00:00+01:00" }))).body as any).id;
  assert.equal((await cancelExam(ctx, other)).status, 200);
  assert.equal((await updateExam(ctx, other, { title: "nope nope" })).status, 409);
});

test("publish refuses an exam whose window already closed", async () => {
  const { ctx, db } = setup();
  await seedBank(db, SUBJECTS, 70);
  const id = ((await createExam(ctx, sched({ exam_date: "2026-10-01", starts_at: "2026-10-01T08:00:00+01:00", ends_at: "2026-10-01T20:00:00+01:00", correction_release_at: "2026-10-02T00:00:00+01:00" }))).body as any).id;
  for (const s of SUBJECTS) await generateSubject(ctx, id, s);
  await approveExam(ctx, id);
  assert.equal((await publishExam(ctx, id)).status, 422);
});

test("live exam answer key: only exam managers may preview it before corrections are released", async () => {
  const { ctx, db, id } = await fullyGenerated();
  await approveExam(ctx, id);
  await publishExam(ctx, id);
  const during = new Date("2026-10-20T10:00:00Z");
  assert.equal((await previewExam(db, id, { now: during, liveKeysAllowed: false })).status, 403);
  assert.equal((await previewExam(db, id, { now: during, liveKeysAllowed: true })).status, 200);
  assert.equal((await previewExam(db, id, { now: new Date("2026-10-21T00:00:00Z"), liveKeysAllowed: false })).status, 200); // after release
});
