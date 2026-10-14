import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generateParticipantId, generateRecoveryCode, lookupParticipant, registerParticipant, updateSubjects, verifyRecovery,
  type Ctx,
} from "../server/participants.ts";
import { createTestDb, NOW, PEPPER } from "./helpers/d1.ts";

type TestDb = ReturnType<typeof createTestDb>;

const base = {
  first_name: "Ada",
  last_name: "Okafor",
  target_score: 320,
  intended_course: "Medicine and Surgery",
  preferred_institution: "University of Lagos",
  gender: "female",
  subjects: ["physics", "chemistry", "mathematics"],
};

const pctx = (db: TestDb, over: Partial<Ctx> = {}): Ctx => ({ db, pepper: PEPPER, now: NOW, ipHash: "ip-1", ...over });

async function register(db: TestDb, over: Record<string, unknown> = {}, ctxOver: Partial<Ctx> = {}) {
  const r = await registerParticipant(pctx(db, ctxOver), { ...base, ...over });
  return { r, id: r.body.participant_id as string, code: r.body.recovery_code as string, token: r.deviceToken as string };
}

const insertExam = (db: TestDb, status: string, start: string, end: string, date = "2026-10-14") =>
  db.raw
    .prepare("INSERT INTO exams (exam_date, title, status, starts_at, ends_at, correction_release_at) VALUES (?, 'Mock', ?, ?, ?, ?)")
    .run(date, status, start, end, end);

const count = (db: TestDb, sql: string, ...p: any[]) => (db.raw.prepare(sql).get(...p) as any).n as number;

// ---- ID and code generation -----------------------------------------------------------------
test("generated IDs are JAMB + 4 digits + 2 uppercase letters", () => {
  for (let i = 0; i < 500; i++) assert.match(generateParticipantId(), /^JAMB\d{4}[A-Z]{2}$/);
});

test("recovery codes look like K7M2-9QXP and avoid look-alike characters", () => {
  for (let i = 0; i < 200; i++) assert.match(generateRecoveryCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

// ---- Registration ---------------------------------------------------------------------------
test("registration stores the participant, 3 subjects and a trusted device; secrets are stored hashed", async () => {
  const db = createTestDb();
  const { r, id, code, token } = await register(db);
  assert.equal(r.status, 201);
  assert.match(id, /^JAMB\d{4}[A-Z]{2}$/);
  assert.ok(code && token);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participant_subjects WHERE participant_id = ?", id), 3);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participant_devices WHERE participant_id = ?", id), 1);
  const row = db.raw.prepare("SELECT recovery_code_hash FROM participants WHERE id = ?").get(id) as any;
  assert.ok(row.recovery_code_hash && !row.recovery_code_hash.includes(code.replace("-", "")));
  const dev = db.raw.prepare("SELECT token_hash FROM participant_devices").get() as any;
  assert.notEqual(dev.token_hash, token);
});

test("invalid registrations return 400 with field messages and store nothing", async () => {
  const db = createTestDb();
  const bad: Record<string, unknown>[] = [
    { first_name: "" }, { last_name: "<script>" }, { target_score: 99 }, { target_score: "320" }, { gender: "other" },
    { intended_course: "" }, { subjects: ["physics", "chemistry"] }, { subjects: ["physics", "physics", "biology"] },
    { subjects: ["english", "physics", "biology"] }, { subjects: ["physics", "chemistry", "astrology"] },
    { subjects: ["physics", "chemistry", "biology", "commerce"] },
  ];
  for (const over of bad) {
    const r = await registerParticipant(pctx(db, { ipHash: `ip-${Math.random()}` }), { ...base, ...over });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.ok(r.body.fields, JSON.stringify(over));
  }
  assert.equal((await registerParticipant(pctx(db), null)).status, 400);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participants"), 0);
});

test("any mix of Science, Commercial and Arts subjects is accepted", async () => {
  const db = createTestDb();
  const { r } = await register(db, { subjects: ["physics", "government", "economics"] });
  assert.equal(r.status, 201);
});

test("honeypot field rejects bots", async () => {
  const db = createTestDb();
  const r = await registerParticipant(pctx(db), { ...base, website: "http://spam.example" });
  assert.equal(r.status, 400);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participants"), 0);
});

test("ID collision: another ID is generated; the database enforces uniqueness and format", async () => {
  const db = createTestDb();
  await register(db, {}, { genId: () => "JAMB1111AA" });
  const seq = ["JAMB1111AA", "JAMB1111AA", "JAMB2222BB"];
  const { r } = await register(db, { first_name: "Bola" }, { genId: () => seq.shift()!, ipHash: "ip-2" });
  assert.equal(r.status, 201);
  assert.equal(r.body.participant_id, "JAMB2222BB");

  const insert = (id: string) =>
    db.raw.prepare("INSERT INTO participants (id, first_name, last_name, target_score, intended_course, preferred_institution, gender) VALUES (?, 'A','B',300,'C','D','male')").run(id);
  assert.throws(() => insert("JAMB1111AA"), /UNIQUE/);
  assert.throws(() => insert("jamb3333cc"), /CHECK/);
  assert.throws(() => insert("JAMB33CC33"), /CHECK/);
});

test("persistent collisions end in 503 and leave no half-created participant (atomic batch)", async () => {
  const db = createTestDb();
  await register(db, {}, { genId: () => "JAMB1111AA" });
  const { r } = await register(db, { first_name: "Bola" }, { genId: () => "JAMB1111AA", ipHash: "ip-2" });
  assert.equal(r.status, 503);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participants"), 1);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participant_subjects"), 3);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participant_devices"), 1);
});

test("same name + course + institution is blocked as a duplicate registration", async () => {
  const db = createTestDb();
  await register(db);
  const again = await registerParticipant(pctx(db, { ipHash: "ip-2" }), { ...base, first_name: "  ADA ", last_name: "okafor" });
  assert.equal(again.status, 409);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participants"), 1);
});

test("registration is rate limited per connection (20 per hour)", async () => {
  const db = createTestDb();
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let i = 0; i < 20; i++) {
    const { r } = await register(db, { first_name: `Tester${letters[i]}` });
    assert.equal(r.status, 201, `registration ${i}`);
  }
  assert.equal((await register(db, { first_name: "Overflow" })).r.status, 429);
  assert.equal((await register(db, { first_name: "Overflow" }, { ipHash: "other-ip" })).r.status, 201);
});

// ---- Lookup and privacy ---------------------------------------------------------------------
test("a trusted device sees only first name, last initial, subjects and exam eligibility", async () => {
  const db = createTestDb();
  const { id, token } = await register(db);
  const r = await lookupParticipant(pctx(db), id.toLowerCase(), token);
  assert.equal(r.status, 200);
  assert.equal(r.body.trusted, true);
  const text = JSON.stringify(r.body);
  for (const secret of ["Okafor", "320", "Medicine", "Lagos", "female"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  assert.ok(text.includes("Ada"));
  assert.equal((r.body.subjects as any[]).length, 4, "English + 3");
  assert.equal((r.body.subjects as any[])[0].id, "english");
});

test("an unverified visitor learns only that the ID exists", async () => {
  const db = createTestDb();
  const { id } = await register(db);
  const r = await lookupParticipant(pctx(db, { ipHash: "attacker" }), id);
  assert.deepEqual(r.body, { found: true, trusted: false });
});

test("unknown ID -> 404, bad format -> 400", async () => {
  const db = createTestDb();
  assert.equal((await lookupParticipant(pctx(db), "JAMB0000ZZ")).status, 404);
  for (const bad of ["nope", "JAMB123", "", null, 42]) assert.equal((await lookupParticipant(pctx(db), bad)).status, 400);
});

test("ID guessing is blocked after 10 misses from one connection", async () => {
  const db = createTestDb();
  const { id } = await register(db);
  for (let i = 0; i < 10; i++) assert.equal((await lookupParticipant(pctx(db, { ipHash: "guesser" }), "JAMB0000ZZ")).status, 404);
  assert.equal((await lookupParticipant(pctx(db, { ipHash: "guesser" }), id)).status, 429);
  assert.equal((await lookupParticipant(pctx(db, { ipHash: "someone-else" }), id)).status, 200);
});

test("a device trusted for one participant is not trusted for another; junk tokens are ignored", async () => {
  const db = createTestDb();
  const a = await register(db);
  const b = await register(db, { first_name: "Chidi", last_name: "Eze" }, { ipHash: "ip-2" });
  assert.equal((await lookupParticipant(pctx(db, { ipHash: "ip-3" }), b.id, a.token)).body.trusted, false);
  assert.equal((await lookupParticipant(pctx(db, { ipHash: "ip-3" }), a.id, "x' OR 1=1 --")).body.trusted, false);
});

test("suspended IDs are refused for trusted devices and reveal nothing to others", async () => {
  const db = createTestDb();
  const { id, token } = await register(db);
  db.raw.prepare("UPDATE participants SET status = 'suspended' WHERE id = ?").run(id);
  assert.equal((await lookupParticipant(pctx(db), id, token)).status, 403);
  assert.deepEqual((await lookupParticipant(pctx(db, { ipHash: "x" }), id)).body, { found: true, trusted: false });
});

// ---- Eligibility ----------------------------------------------------------------------------
test("eligibility follows the exam window, and a second attempt is refused", async () => {
  const db = createTestDb();
  const { id, token } = await register(db);
  const elig = async () => ((await lookupParticipant(pctx(db), id, token)).body as any).eligibility;

  assert.equal((await elig()).can_start, false, "no exam scheduled");
  insertExam(db, "published", "2026-10-14T09:00:00Z", "2026-10-14T20:00:00Z");
  const open = await elig();
  assert.equal(open.phase, "ongoing");
  assert.equal(open.can_start, true);

  db.raw.prepare(
    "INSERT INTO attempts (exam_id, participant_id, exam_date, started_at, deadline_at, attempt_token_hash, status) VALUES (1, ?, '2026-10-14', 'a', 'b', 'h', 'submitted')",
  ).run(id);
  const after = await elig();
  assert.equal(after.already_attempted, true);
  assert.equal(after.can_start, false);
  assert.throws(
    () => db.raw.prepare("INSERT INTO attempts (exam_id, participant_id, exam_date, started_at, deadline_at, attempt_token_hash) VALUES (1, ?, '2026-10-14', 'a', 'b', 'h2')").run(id),
    /UNIQUE/,
    "database enforces one attempt per participant per day",
  );
});

// ---- Recovery (new device) ------------------------------------------------------------------
test("the recovery code links a new device; case and hyphen do not matter", async () => {
  const db = createTestDb();
  const { id, code } = await register(db);
  const r = await verifyRecovery(pctx(db, { ipHash: "phone-2" }), id, code.toLowerCase().replace("-", " "));
  assert.equal(r.status, 200);
  assert.ok(r.deviceToken);
  const again = await lookupParticipant(pctx(db, { ipHash: "phone-2" }), id, r.deviceToken);
  assert.equal(again.body.trusted, true);
});

test("wrong recovery codes are rejected generically and give no device", async () => {
  const db = createTestDb();
  const { id } = await register(db);
  for (const bad of ["AAAA-AAAA", "nonsense", "", null]) {
    const r = await verifyRecovery(pctx(db, { ipHash: `ip-${Math.random()}` }), id, bad);
    assert.equal(r.status, 401);
    assert.equal(r.deviceToken, undefined);
  }
  assert.equal((await verifyRecovery(pctx(db), "JAMB0000ZZ", "AAAA-AAAA")).status, 401, "unknown ID looks the same");
});

test("recovery guessing locks an ID after 5 attempts, even for the right code", async () => {
  const db = createTestDb();
  const { id, code } = await register(db);
  for (let i = 0; i < 5; i++) assert.equal((await verifyRecovery(pctx(db, { ipHash: `ip-${i}` }), id, "AAAA-AAAA")).status, 401);
  assert.equal((await verifyRecovery(pctx(db, { ipHash: "ip-new" }), id, code)).status, 429);
  const later = new Date(NOW.getTime() + 16 * 60_000);
  assert.equal((await verifyRecovery(pctx(db, { ipHash: "ip-new", now: later }), id, code)).status, 200, "unlocks after the window");
});

test("each participant keeps at most 5 trusted devices", async () => {
  const db = createTestDb();
  const { id, code } = await register(db);
  for (let i = 1; i <= 6; i++) {
    const r = await verifyRecovery(pctx(db, { now: new Date(NOW.getTime() + i * 16 * 60_000) }), id, code);
    assert.equal(r.status, 200);
  }
  assert.equal(count(db, "SELECT COUNT(*) n FROM participant_devices WHERE participant_id = ?", id), 5);
});

test("a suspended participant cannot regain access with the recovery code", async () => {
  const db = createTestDb();
  const { id, code } = await register(db);
  db.raw.prepare("UPDATE participants SET status = 'suspended' WHERE id = ?").run(id);
  const r = await verifyRecovery(pctx(db, { ipHash: "x" }), id, code);
  assert.equal(r.status, 403);
  assert.equal(r.deviceToken, undefined);
});

// ---- Subject changes ------------------------------------------------------------------------
const NEW_SUBJECTS = ["biology", "commerce", "irk"];

test("subjects can change between exams, from a trusted device only", async () => {
  const db = createTestDb();
  const { id, token } = await register(db);
  assert.equal((await updateSubjects(pctx(db, { ipHash: "x" }), id, NEW_SUBJECTS)).status, 403);
  assert.equal((await updateSubjects(pctx(db, { ipHash: "x" }), id, NEW_SUBJECTS, "wrong-token")).status, 403);
  const ok = await updateSubjects(pctx(db), id, NEW_SUBJECTS, token);
  assert.equal(ok.status, 200);
  const ids = db.raw.prepare("SELECT subject_id FROM participant_subjects WHERE participant_id = ? ORDER BY subject_id").all(id) as any[];
  assert.deepEqual(ids.map((x) => x.subject_id), ["biology", "commerce", "irk"]);
});

test("subjects are locked while an exam is open or inside the cutoff, and unlock after it closes", async () => {
  const db = createTestDb();
  const { id, token } = await register(db);
  insertExam(db, "published", "2026-10-14T11:00:00Z", "2026-10-14T20:00:00Z"); // opens in 1h; cutoff is 2h
  assert.equal((await updateSubjects(pctx(db), id, NEW_SUBJECTS, token)).status, 409);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participant_subjects WHERE participant_id = ? AND subject_id = 'physics'", id), 1, "unchanged");

  const during = new Date("2026-10-14T15:00:00Z");
  assert.equal((await updateSubjects(pctx(db, { now: during }), id, NEW_SUBJECTS, token)).status, 409);
  const after = new Date("2026-10-14T21:00:00Z");
  assert.equal((await updateSubjects(pctx(db, { now: after }), id, NEW_SUBJECTS, token)).status, 200);
});

test("draft or cancelled exams do not lock subjects", async () => {
  const db = createTestDb();
  const { id, token } = await register(db);
  insertExam(db, "draft", "2026-10-14T09:00:00Z", "2026-10-14T20:00:00Z");
  assert.equal((await updateSubjects(pctx(db), id, NEW_SUBJECTS, token)).status, 200);
});

test("invalid subject changes and in-progress attempts are rejected, keeping the old subjects", async () => {
  const db = createTestDb();
  const { id, token } = await register(db);
  assert.equal((await updateSubjects(pctx(db), id, ["biology"], token)).status, 400);
  assert.equal((await updateSubjects(pctx(db), id, ["english", "biology", "irk"], token)).status, 400);
  insertExam(db, "draft", "2026-10-14T09:00:00Z", "2026-10-14T20:00:00Z");
  db.raw.prepare(
    "INSERT INTO attempts (exam_id, participant_id, exam_date, started_at, deadline_at, attempt_token_hash, status) VALUES (1, ?, '2026-10-14', 'a', 'b', 'h', 'in_progress')",
  ).run(id);
  assert.equal((await updateSubjects(pctx(db), id, NEW_SUBJECTS, token)).status, 409);
  assert.equal(count(db, "SELECT COUNT(*) n FROM participant_subjects WHERE participant_id = ? AND subject_id = 'physics'", id), 1);
});
