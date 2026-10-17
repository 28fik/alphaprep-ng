import assert from "node:assert/strict";
import { test } from "node:test";
import { toCsv } from "../server/csv.ts";
import {
  addImportRows, commitImport, createQuestion, deleteQuestions, editImportRow, exportQuestionsCsv, fingerprint, importPreview,
  listQuestions, normalizeQuestion, setImportRowStatus, setVerification, startImport, updateQuestion, validSubjectSet, type QCtx,
} from "../server/questions.ts";
import { createTestDb, NOW } from "./helpers/d1.ts";
import { seedAdmin } from "./helpers/seed.ts";

function setup() {
  const db = createTestDb();
  const adminId = seedAdmin(db);
  const ctx: QCtx = { db, now: NOW, ipHash: "ip", adminId };
  return { db, ctx, adminId };
}
const good = (over: Record<string, unknown> = {}) => ({
  subject: "mathematics", question: "What is 2 + 2?", a: "3", b: "4", c: "5", d: "6", answer: "b", ...over,
});

test("normalize: accepts messy columns, never invents an answer", async () => {
  const { db } = setup();
  const subj = await validSubjectSet(db);
  const ok = normalizeQuestion(good(), subj);
  assert.equal(ok.value.correct_option, "B");
  assert.equal(ok.value.verification_status, "unverified");
  assert.equal(ok.issues.length, 0);

  const missing = normalizeQuestion(good({ answer: "" }), subj);
  assert.equal(missing.value.correct_option, null);
  assert.equal(missing.value.verification_status, "needs_review");
  assert.ok(missing.issues.some((i) => i.code === "missing_answer" && !i.blocking));

  const badAns = normalizeQuestion(good({ answer: "banana" }), subj);
  assert.equal(badAns.value.correct_option, null); // "banana" must NOT be read as "B"... A is in banana too
  assert.ok(badAns.issues.some((i) => i.code === "bad_answer"));

  assert.ok(normalizeQuestion(good({ subject: "astrology" }), subj).issues.some((i) => i.code === "bad_subject" && i.blocking));
  assert.ok(normalizeQuestion(good({ question: "  " }), subj).issues.some((i) => i.code === "missing_question"));
  assert.ok(normalizeQuestion(good({ c: "" }), subj).issues.some((i) => i.code === "missing_option"));
  assert.ok(normalizeQuestion(good({ c: "3" }), subj).issues.some((i) => i.code === "duplicate_options"));
  // low-confidence OCR is never trusted, and re-validation never upgrades it
  const ocr = normalizeQuestion(good({ low_confidence: true }), subj);
  assert.equal(ocr.value.verification_status, "needs_review");
  assert.equal(normalizeQuestion({ ...ocr.value }, subj).value.verification_status, "needs_review");
  // a client cannot self-declare "verified" without an answer
  assert.equal(normalizeQuestion(good({ answer: "", verification_status: "verified" }), subj).value.verification_status, "needs_review");
});

test("fingerprint ignores case, punctuation and option order", async () => {
  const a = await fingerprint({ question_text: "What is 2+2?", option_a: "3", option_b: "4", option_c: "5", option_d: "6" });
  const b = await fingerprint({ question_text: "what is 2 2", option_a: "6", option_b: "5", option_c: "4", option_d: "3" });
  const c = await fingerprint({ question_text: "What is 3+3?", option_a: "3", option_b: "4", option_c: "5", option_d: "6" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("question CRUD: create, duplicate 409, update, key storage separate, delete", async () => {
  const { db, ctx } = setup();
  const r = await createQuestion(ctx, good());
  assert.equal(r.status, 201);
  const id = (r.body as any).id;
  assert.equal((await createQuestion(ctx, good({ a: "6", d: "3" }))).status, 409); // same options reordered
  assert.equal((await createQuestion(ctx, good({ subject: "nope" }))).status, 400);
  const key: any = db.raw.prepare("SELECT correct_option FROM question_answer_keys WHERE question_id = ?").get(id);
  assert.equal(key.correct_option, "B");
  assert.equal(Object.keys(db.raw.prepare("SELECT * FROM questions WHERE id = ?").get(id) as object).includes("correct_option"), false);

  assert.equal((await updateQuestion(ctx, id, good({ answer: "C", topic: "Algebra" }))).status, 200);
  assert.equal((db.raw.prepare("SELECT correct_option FROM question_answer_keys WHERE question_id = ?").get(id) as any).correct_option, "C");
  // removing the answer removes the key and forces needs_review
  assert.equal((await updateQuestion(ctx, id, good({ answer: "" }))).status, 200);
  assert.equal(db.raw.prepare("SELECT * FROM question_answer_keys WHERE question_id = ?").get(id), undefined);
  assert.equal((db.raw.prepare("SELECT verification_status s FROM questions WHERE id = ?").get(id) as any).s, "needs_review");
  assert.equal((await updateQuestion(ctx, 9999, good())).status, 404);

  assert.equal((await deleteQuestions(ctx, [id])).status, 200);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM questions").get() as any).n, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action LIKE 'question.%'").get() as any).n >= 3, true);
});

test("verification: only questions with a key can be marked verified", async () => {
  const { db, ctx } = setup();
  const a = (await createQuestion(ctx, good())).body as any;
  const b = (await createQuestion(ctx, good({ question: "No key here", answer: "" }))).body as any;
  const r = await setVerification(ctx, [a.id, b.id], "verified");
  assert.equal((r.body as any).updated, 1);
  assert.equal((db.raw.prepare("SELECT verification_status s FROM questions WHERE id = ?").get(b.id) as any).s, "needs_review");
  assert.equal((await setVerification(ctx, [a.id], "bogus")).status, 400);
});

test("list: pagination, filters, search (LIKE wildcards escaped), has_key", async () => {
  const { ctx, db } = setup();
  for (let i = 0; i < 30; i++) await createQuestion(ctx, good({ question: `Item ${i} 100% sure?`, a: `a${i}`, b: `b${i}`, c: `c${i}`, d: `d${i}`, answer: i % 5 === 0 ? "" : "A", topic: i % 2 ? "T1" : "T2" }));
  const p1 = await listQuestions(db, { page: 1, page_size: 10 });
  assert.equal(p1.total, 30);
  assert.equal(p1.rows.length, 10);
  const p3 = await listQuestions(db, { page: 3, page_size: 10 });
  assert.equal(p3.rows.length, 10);
  assert.notEqual((p1.rows[0] as any).id, (p3.rows[0] as any).id);
  assert.equal((await listQuestions(db, { has_key: "0", page_size: 100 })).total, 6);
  assert.equal((await listQuestions(db, { topic: "T1", page_size: 100 })).total, 15);
  assert.equal((await listQuestions(db, { q: "100%" })).total, 30);
  assert.equal((await listQuestions(db, { q: "%" })).total, 30); // literal % matches because every row has one
  assert.equal((await listQuestions(db, { q: "_" })).total, 0); // _ is not a wildcard
  assert.equal((await listQuestions(db, { page_size: 100000 })).page_size, 100);
});

test("export CSV: includes answers, neutralises spreadsheet formulas", async () => {
  const { ctx, db } = setup();
  await createQuestion(ctx, good({ question: "=HYPERLINK(\"http://evil\")", explanation: "ok, with comma" }));
  const csv = await exportQuestionsCsv(db, {});
  assert.ok(csv.startsWith("﻿subject,topic,year,question"));
  assert.ok(csv.includes("'=HYPERLINK"));
  assert.ok(csv.includes('"ok, with comma"'));
  assert.equal(toCsv(["a"], [{ a: '+1' }]).includes("'+1"), true);
});

test("import: preview flags duplicates, missing answers, bad rows; commit saves only approved rows", async () => {
  const { ctx, db } = setup();
  await createQuestion(ctx, good({ question: "Existing question?" }));
  const b = await startImport(ctx, "q.csv", "csv");
  const batchId = (b.body as any).batch_id;
  const rows = [
    good({ question: "Fresh one?" }),
    good({ question: "Fresh two?", answer: "" }), // missing answer: allowed but flagged
    good({ question: "Existing question?" }), // duplicate of bank
    good({ question: "Fresh one?" }), // duplicate in file
    good({ question: "Bad subject", subject: "zzz" }),
    good({ question: "Weird answer", answer: "Z" }),
  ];
  const added = await addImportRows(ctx, batchId, rows);
  assert.equal(added.status, 200);
  const st = ((added.body as any).rows as any[]).map((r) => r.status);
  assert.deepEqual(st, ["approved", "approved", "rejected", "rejected", "rejected", "approved"]);

  const prev: any = (await importPreview(db, ctx.adminId, batchId, 1)).body;
  assert.equal(prev.missing_answers, 2); // rows 2 and 6 have no valid answer
  assert.equal(prev.counts.rejected, 3);
  assert.ok(prev.rows[2].issues.some((i: any) => i.code === "duplicate_in_bank"));
  assert.ok(prev.rows[3].issues.some((i: any) => i.code === "duplicate_in_file"));

  // a blocked row cannot be force-approved
  assert.equal(((await setImportRowStatus(ctx, batchId, [3], "approved")).body as any).updated, 0);
  // reject one good row manually
  await setImportRowStatus(ctx, batchId, [6], "rejected");

  const done: any = (await commitImport(ctx, batchId)).body;
  assert.equal(done.done, true);
  assert.equal(done.saved_total, 2);
  const saved: any[] = db.raw.prepare("SELECT question_text, verification_status FROM questions ORDER BY id").all() as any;
  assert.deepEqual(saved.map((s) => s.question_text), ["Existing question?", "Fresh one?", "Fresh two?"]);
  assert.equal(saved[2].verification_status, "needs_review");
  // no invented key for the row without an answer
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM question_answer_keys").get() as any).n, 2);
  assert.equal((db.raw.prepare("SELECT status FROM import_batches WHERE id = ?").get(batchId) as any).status, "committed");
  // committing again saves nothing more
  assert.equal(((await commitImport(ctx, batchId)).body as any).saved_now, 0);
});

test("import: edit a rejected row to fix it, then it commits; chunk limits and ownership enforced", async () => {
  const { ctx, db } = setup();
  const other = seedAdmin(db, "other");
  const batchId = ((await startImport(ctx, "x", "paste")).body as any).batch_id;
  await addImportRows(ctx, batchId, [good({ question: "Needs fix", c: "" })]);
  assert.equal(((await importPreview(db, ctx.adminId, batchId, 1)).body as any).rows[0].status, "rejected");
  const fixed: any = (await editImportRow(ctx, batchId, 1, good({ question: "Needs fix", c: "5" }))).body;
  assert.equal(fixed.status, "approved");
  await commitImport(ctx, batchId);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM questions").get() as any).n, 1);

  const b2 = ((await startImport(ctx, "y", "csv")).body as any).batch_id;
  assert.equal((await addImportRows(ctx, b2, Array.from({ length: 21 }, (_, i) => good({ question: `q${i}` })))).status, 400);
  assert.equal((await addImportRows(ctx, b2, [])).status, 400);
  // another admin cannot see or touch this batch
  assert.equal((await importPreview(db, other, b2, 1)).status, 404);
  assert.equal((await addImportRows({ ...ctx, adminId: other }, b2, [good()])).status, 404);
  assert.equal((await startImport(ctx, "z", "docx")).status, 400);
});

test("import: a large file is saved over several commit calls", async () => {
  const { ctx, db } = setup();
  const batchId = ((await startImport(ctx, "big.csv", "csv")).body as any).batch_id;
  for (let c = 0; c < 3; c++) {
    await addImportRows(ctx, batchId, Array.from({ length: 20 }, (_, i) => good({ question: `Big ${c}-${i}`, a: `a${c}${i}`, b: `b${c}${i}`, c: `c${c}${i}`, d: `d${c}${i}` })));
  }
  let calls = 0;
  for (;;) {
    const r: any = (await commitImport(ctx, batchId)).body;
    calls++;
    if (r.done) break;
    assert.ok(calls < 10);
  }
  assert.equal(calls, 3); // 20 + 20 + 20 rows, the last call reports done
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM questions").get() as any).n, 60);
});
