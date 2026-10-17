import { sha256Hex } from "./crypto.ts";
import { isUniqueViolation, type Db } from "./db.ts";
import { writeAudit } from "./audit.ts";
import { toCsv } from "./csv.ts";

export interface QCtx {
  db: Db;
  now: Date;
  ipHash: string;
  adminId: number;
}

export interface QuestionInput {
  subject_id: string;
  topic: string | null;
  exam_year: number | null;
  question_text: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: "A" | "B" | "C" | "D" | null; // null = answer unknown (never invented)
  explanation: string | null;
  source: string | null;
  verification_status: "verified" | "unverified" | "needs_review";
}

export type Issue = { code: string; message: string; blocking: boolean };

export const MAX_TEXT = 4000;
export const IMPORT_CHUNK = 20; // keep each request small: free plan = 10 ms CPU, limited sub-requests

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Same question + same four options (in any order) => same fingerprint. */
export async function fingerprint(q: Pick<QuestionInput, "question_text" | "option_a" | "option_b" | "option_c" | "option_d">): Promise<string> {
  const opts = [q.option_a, q.option_b, q.option_c, q.option_d].map(norm).sort();
  return sha256Hex([norm(q.question_text), ...opts].join("\u0001"));
}

const clean = (v: unknown, max = MAX_TEXT): string => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const optional = (v: unknown, max: number): string | null => clean(v, max) || null;

/** Accepts messy imported rows. Never fabricates an answer: a missing/invalid answer stays null. */
export function normalizeQuestion(raw: Record<string, unknown>, validSubjects: Set<string>): { value: QuestionInput; issues: Issue[] } {
  const issues: Issue[] = [];
  const bad = (code: string, message: string, blocking = true) => issues.push({ code, message, blocking });

  const subject_id = clean(raw.subject_id ?? raw.subject, 40).toLowerCase().replace(/[\s-]+/g, "_");
  if (!validSubjects.has(subject_id)) bad("bad_subject", `Unknown subject "${subject_id || "(blank)"}".`);

  const question_text = clean(raw.question_text ?? raw.question);
  if (!question_text) bad("missing_question", "Question text is empty.");

  const opts = {
    option_a: clean(raw.option_a ?? raw.a),
    option_b: clean(raw.option_b ?? raw.b),
    option_c: clean(raw.option_c ?? raw.c),
    option_d: clean(raw.option_d ?? raw.d),
  };
  for (const [k, v] of Object.entries(opts)) if (!v) bad("missing_option", `Option ${k.slice(-1).toUpperCase()} is empty.`);
  const filled = Object.values(opts).filter(Boolean).map(norm);
  if (filled.length === 4 && new Set(filled).size < 4) bad("duplicate_options", "Two options are identical.");

  let correct: QuestionInput["correct_option"] = null;
  const ansRaw = clean(raw.correct_option ?? raw.answer ?? raw.correct, 10).toUpperCase().replace(/[^A-D]/g, "");
  if (ansRaw.length === 1) correct = ansRaw as "A";
  else if (clean(raw.correct_option ?? raw.answer ?? raw.correct, 10) === "") bad("missing_answer", "No answer given: saved as 'needs review' and kept out of exams until you add one.", false);
  else bad("bad_answer", "Answer must be a single letter A, B, C or D.", false);

  let exam_year: number | null = null;
  const yRaw = clean(raw.exam_year ?? raw.year, 8);
  if (yRaw) {
    const y = Number(yRaw);
    if (Number.isInteger(y) && y >= 1978 && y <= 2100) exam_year = y;
    else bad("bad_year", "Year ignored (must be 1978-2100).", false);
  }

  const wanted = clean(raw.verification_status, 20);
  let verification_status: QuestionInput["verification_status"] = correct ? "unverified" : "needs_review";
  if (correct && wanted === "verified") verification_status = "verified";
  if (wanted === "needs_review") verification_status = "needs_review"; // never upgrade on re-validation
  if (!correct) verification_status = "needs_review";
  if (raw.low_confidence === true && verification_status !== "needs_review") {
    verification_status = "needs_review"; // uncertain OCR is never trusted
    bad("low_confidence", "Text recognised with low confidence: marked 'needs review'.", false);
  }

  return {
    value: {
      subject_id,
      topic: optional(raw.topic, 120),
      exam_year,
      question_text,
      ...opts,
      correct_option: correct,
      explanation: optional(raw.explanation, MAX_TEXT),
      source: optional(raw.source, 200),
      verification_status,
    },
    issues,
  };
}

export async function validSubjectSet(db: Db): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT id FROM subjects WHERE is_active = 1").all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
export const blocking = (issues: Issue[]) => issues.some((i) => i.blocking);

// ---- single-question CRUD ------------------------------------------------------------------
export async function createQuestion(ctx: QCtx, raw: Record<string, unknown>, answerSource: "manual_admin" | "import_file" = "manual_admin") {
  const { value, issues } = normalizeQuestion(raw, await validSubjectSet(ctx.db));
  if (blocking(issues)) return { status: 400, body: { error: "Please fix the highlighted problems.", issues } };
  const fp = await fingerprint(value);
  const dup = await ctx.db.prepare("SELECT id FROM questions WHERE subject_id = ? AND fingerprint = ?").bind(value.subject_id, fp).first<{ id: number }>();
  if (dup) return { status: 409, body: { error: "This question already exists in the bank.", duplicate_of: dup.id } };
  const stmts = insertStatements(ctx, value, fp, answerSource);
  try {
    await ctx.db.batch(stmts);
  } catch (e) {
    if (isUniqueViolation(e)) return { status: 409, body: { error: "This question already exists in the bank." } };
    throw e;
  }
  const row = await ctx.db.prepare("SELECT id FROM questions WHERE subject_id = ? AND fingerprint = ?").bind(value.subject_id, fp).first<{ id: number }>();
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "question.create", targetType: "question", targetId: row?.id, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 201, body: { id: row?.id, issues } };
}

function insertStatements(ctx: QCtx, v: QuestionInput, fp: string, answerSource: string) {
  const t = iso(ctx.now);
  const stmts = [
    ctx.db
      .prepare(
        `INSERT INTO questions (subject_id, topic, exam_year, question_text, option_a, option_b, option_c, option_d, explanation, source,
           verification_status, fingerprint, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(v.subject_id, v.topic, v.exam_year, v.question_text, v.option_a, v.option_b, v.option_c, v.option_d, v.explanation, v.source, v.verification_status, fp, ctx.adminId, t, t),
  ];
  if (v.correct_option) {
    stmts.push(
      ctx.db
        .prepare(`INSERT INTO question_answer_keys (question_id, correct_option, answer_source, updated_at)
                  SELECT id, ?, ?, ? FROM questions WHERE subject_id = ? AND fingerprint = ?`)
        .bind(v.correct_option, answerSource, t, v.subject_id, fp),
    );
  }
  return stmts;
}

export async function updateQuestion(ctx: QCtx, id: number, raw: Record<string, unknown>) {
  const existing = await ctx.db.prepare("SELECT id FROM questions WHERE id = ?").bind(id).first();
  if (!existing) return { status: 404, body: { error: "Question not found." } };
  const { value, issues } = normalizeQuestion(raw, await validSubjectSet(ctx.db));
  if (blocking(issues)) return { status: 400, body: { error: "Please fix the highlighted problems.", issues } };
  const fp = await fingerprint(value);
  const dup = await ctx.db.prepare("SELECT id FROM questions WHERE subject_id = ? AND fingerprint = ? AND id <> ?").bind(value.subject_id, fp, id).first<{ id: number }>();
  if (dup) return { status: 409, body: { error: "Another question with the same text and options exists.", duplicate_of: dup.id } };
  const t = iso(ctx.now);
  const stmts = [
    ctx.db
      .prepare(
        `UPDATE questions SET subject_id=?, topic=?, exam_year=?, question_text=?, option_a=?, option_b=?, option_c=?, option_d=?, explanation=?, source=?,
           verification_status=?, fingerprint=?, updated_at=? WHERE id=?`,
      )
      .bind(value.subject_id, value.topic, value.exam_year, value.question_text, value.option_a, value.option_b, value.option_c, value.option_d, value.explanation, value.source, value.verification_status, fp, t, id),
  ];
  if (value.correct_option) {
    stmts.push(
      ctx.db
        .prepare(`INSERT INTO question_answer_keys (question_id, correct_option, answer_source, updated_at) VALUES (?,?,'manual_admin',?)
                  ON CONFLICT(question_id) DO UPDATE SET correct_option = excluded.correct_option, answer_source = 'manual_admin', updated_at = excluded.updated_at`)
        .bind(id, value.correct_option, t),
    );
  } else {
    stmts.push(ctx.db.prepare("DELETE FROM question_answer_keys WHERE question_id = ?").bind(id));
  }
  await ctx.db.batch(stmts);
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "question.update", targetType: "question", targetId: id, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { id, issues } };
}

export async function deleteQuestions(ctx: QCtx, ids: number[]) {
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 90);
  if (!clean.length) return { status: 400, body: { error: "No questions selected." } };
  const r = await ctx.db.prepare(`DELETE FROM questions WHERE id IN (${clean.map(() => "?").join(",")})`).bind(...clean).run();
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "question.delete", details: { ids: clean }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { deleted: r.meta.changes } };
}

/** Bulk status change. Only questions that HAVE an answer key can become verified/unverified. */
export async function setVerification(ctx: QCtx, ids: number[], status: string) {
  if (!["verified", "unverified", "needs_review"].includes(status)) return { status: 400, body: { error: "Bad status." } };
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 90);
  if (!clean.length) return { status: 400, body: { error: "No questions selected." } };
  const guard = status === "needs_review" ? "" : "AND id IN (SELECT question_id FROM question_answer_keys)";
  const r = await ctx.db
    .prepare(`UPDATE questions SET verification_status = ?, updated_at = ? WHERE id IN (${clean.map(() => "?").join(",")}) ${guard}`)
    .bind(status, iso(ctx.now), ...clean)
    .run();
  await writeAudit(ctx.db, { adminId: ctx.adminId, action: "question.set_status", details: { ids: clean, status }, ipHash: ctx.ipHash, now: ctx.now });
  return { status: 200, body: { updated: r.meta.changes } };
}

// ---- list / export -------------------------------------------------------------------------
export interface Filters {
  subject?: string;
  topic?: string;
  status?: string;
  has_key?: string; // "1" | "0"
  q?: string;
  page?: number;
  page_size?: number;
}

function where(f: Filters) {
  const w: string[] = [];
  const p: unknown[] = [];
  if (f.subject) (w.push("q.subject_id = ?"), p.push(f.subject));
  if (f.topic) (w.push("q.topic = ?"), p.push(f.topic));
  if (f.status && ["verified", "unverified", "needs_review"].includes(f.status)) (w.push("q.verification_status = ?"), p.push(f.status));
  if (f.has_key === "1") w.push("k.correct_option IS NOT NULL");
  if (f.has_key === "0") w.push("k.correct_option IS NULL");
  if (f.q) (w.push("q.question_text LIKE ? ESCAPE '\\'"), p.push(`%${f.q.replace(/[\\%_]/g, "\\$&")}%`));
  return { sql: w.length ? "WHERE " + w.join(" AND ") : "", p };
}

const COLS = `q.id, q.subject_id, q.topic, q.exam_year, q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
  q.explanation, q.source, q.verification_status, q.is_active, k.correct_option, k.answer_source, q.created_at, q.updated_at`;
const FROM = "FROM questions q LEFT JOIN question_answer_keys k ON k.question_id = q.id";

export async function listQuestions(db: Db, f: Filters) {
  const pageSize = Math.min(100, Math.max(1, Math.floor(f.page_size ?? 25)));
  const page = Math.max(1, Math.floor(f.page ?? 1));
  const { sql, p } = where(f);
  const total = await db.prepare(`SELECT COUNT(*) AS n ${FROM} ${sql}`).bind(...p).first<{ n: number }>();
  const { results } = await db
    .prepare(`SELECT ${COLS} ${FROM} ${sql} ORDER BY q.id DESC LIMIT ? OFFSET ?`)
    .bind(...p, pageSize, (page - 1) * pageSize)
    .all();
  return { rows: results, total: total?.n ?? 0, page, page_size: pageSize };
}

export async function questionStats(db: Db) {
  const { results } = await db
    .prepare(
      `SELECT q.subject_id,
              COUNT(*) AS total,
              SUM(CASE WHEN k.correct_option IS NOT NULL AND q.verification_status <> 'needs_review' AND q.is_active = 1 THEN 1 ELSE 0 END) AS usable,
              SUM(CASE WHEN q.verification_status = 'verified' THEN 1 ELSE 0 END) AS verified,
              SUM(CASE WHEN k.correct_option IS NULL THEN 1 ELSE 0 END) AS missing_key
         FROM questions q LEFT JOIN question_answer_keys k ON k.question_id = q.id GROUP BY q.subject_id`,
    )
    .all();
  return results;
}

export const EXPORT_HEADERS = ["subject", "topic", "year", "question", "option_a", "option_b", "option_c", "option_d", "answer", "explanation", "source", "status"];

export async function exportQuestionsCsv(db: Db, f: Filters): Promise<string> {
  const { sql, p } = where(f);
  const { results } = await db.prepare(`SELECT ${COLS} ${FROM} ${sql} ORDER BY q.id LIMIT 5000`).bind(...p).all<Record<string, unknown>>();
  return toCsv(
    EXPORT_HEADERS,
    results.map((r) => ({
      subject: r.subject_id, topic: r.topic, year: r.exam_year, question: r.question_text,
      option_a: r.option_a, option_b: r.option_b, option_c: r.option_c, option_d: r.option_d,
      answer: r.correct_option, explanation: r.explanation, source: r.source, status: r.verification_status,
    })),
  );
}

// ---- import: staging -> preview -> commit --------------------------------------------------
export async function startImport(ctx: QCtx, fileName: string, fileType: string) {
  if (!["csv", "xlsx", "paste", "pdf_text", "pdf_ocr"].includes(fileType)) return { status: 400, body: { error: "Unsupported import type." } };
  await ctx.db
    .prepare("INSERT INTO import_batches (admin_id, file_name, file_type, created_at) VALUES (?,?,?,?)")
    .bind(ctx.adminId, clean(fileName, 200) || null, fileType, iso(ctx.now))
    .run();
  const row = await ctx.db.prepare("SELECT id FROM import_batches WHERE admin_id = ? ORDER BY id DESC LIMIT 1").bind(ctx.adminId).first<{ id: number }>();
  return { status: 201, body: { batch_id: row?.id } };
}

async function loadBatch(db: Db, id: number, adminId: number) {
  return db.prepare("SELECT id, status, total_rows FROM import_batches WHERE id = ? AND admin_id = ?").bind(id, adminId).first<{ id: number; status: string; total_rows: number }>();
}

/** Validate + stage up to IMPORT_CHUNK rows. Duplicates (against the bank and earlier rows) are flagged. */
export async function addImportRows(ctx: QCtx, batchId: number, rows: unknown[]) {
  const batch = await loadBatch(ctx.db, batchId, ctx.adminId);
  if (!batch) return { status: 404, body: { error: "Import not found." } };
  if (batch.status !== "preview") return { status: 409, body: { error: "This import is already closed." } };
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > IMPORT_CHUNK) return { status: 400, body: { error: `Send 1 to ${IMPORT_CHUNK} rows at a time.` } };
  if (batch.total_rows + rows.length > 5000) return { status: 400, body: { error: "An import can hold at most 5,000 questions." } };

  const subjects = await validSubjectSet(ctx.db);
  const parsed = [];
  for (const r of rows) {
    const obj = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const n = normalizeQuestion(obj, subjects);
    parsed.push({ ...n, fp: await fingerprint(n.value) });
  }
  const fps = [...new Set(parsed.map((p) => p.fp))];
  const inBank = new Map<string, number>();
  const { results: bankHits } = await ctx.db
    .prepare(`SELECT subject_id, fingerprint, id FROM questions WHERE fingerprint IN (${fps.map(() => "?").join(",")})`)
    .bind(...fps)
    .all<{ subject_id: string; fingerprint: string; id: number }>();
  for (const h of bankHits) inBank.set(`${h.subject_id}|${h.fingerprint}`, h.id);
  const keys = [...new Set(parsed.map((p) => `${p.value.subject_id}|${p.fp}`))];
  const seen = new Set(
    (
      await ctx.db
        .prepare(`SELECT dedupe_key AS k FROM import_rows WHERE batch_id = ? AND dedupe_key IN (${keys.map(() => "?").join(",")})`)
        .bind(batchId, ...keys)
        .all<{ k: string }>()
    ).results.map((r) => r.k),
  );

  const stmts = [];
  let n = batch.total_rows;
  const out = [];
  for (const p of parsed) {
    n += 1;
    const key = `${p.value.subject_id}|${p.fp}`;
    const issues = [...p.issues];
    if (inBank.has(key)) issues.push({ code: "duplicate_in_bank", message: `Already in the bank (question #${inBank.get(key)}).`, blocking: true });
    else if (seen.has(key)) issues.push({ code: "duplicate_in_file", message: "Repeated earlier in this import.", blocking: true });
    seen.add(key);
    const status = blocking(issues) ? "rejected" : "approved";
    stmts.push(
      ctx.db
        .prepare("INSERT INTO import_rows (batch_id, row_number, payload_json, issues_json, status, dedupe_key) VALUES (?,?,?,?,?,?)")
        .bind(batchId, n, JSON.stringify(p.value), JSON.stringify(issues), status, key),
    );
    out.push({ row_number: n, status, issues });
  }
  stmts.push(ctx.db.prepare("UPDATE import_batches SET total_rows = ? WHERE id = ?").bind(n, batchId));
  await ctx.db.batch(stmts);
  return { status: 200, body: { added: out.length, rows: out } };
}

export async function importPreview(db: Db, ctxAdmin: number, batchId: number, page: number, pageSize = 25) {
  const batch = await db.prepare("SELECT id, file_name, file_type, status, total_rows, saved_rows, skipped_rows FROM import_batches WHERE id = ? AND admin_id = ?").bind(batchId, ctxAdmin).first();
  if (!batch) return { status: 404, body: { error: "Import not found." } };
  const size = Math.min(100, Math.max(1, pageSize));
  const { results } = await db
    .prepare("SELECT row_number, payload_json, issues_json, status FROM import_rows WHERE batch_id = ? ORDER BY row_number LIMIT ? OFFSET ?")
    .bind(batchId, size, (Math.max(1, page) - 1) * size)
    .all<{ row_number: number; payload_json: string; issues_json: string; status: string }>();
  const counts = await db
    .prepare("SELECT status, COUNT(*) AS n FROM import_rows WHERE batch_id = ? GROUP BY status")
    .bind(batchId)
    .all<{ status: string; n: number }>();
  const missing = await db
    .prepare(`SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND status <> 'rejected' AND json_extract(payload_json,'$.correct_option') IS NULL`)
    .bind(batchId)
    .first<{ n: number }>();
  return {
    status: 200,
    body: {
      batch,
      counts: Object.fromEntries(counts.results.map((c) => [c.status, c.n])),
      missing_answers: missing?.n ?? 0,
      rows: results.map((r) => ({ row_number: r.row_number, status: r.status, question: JSON.parse(r.payload_json), issues: JSON.parse(r.issues_json) })),
    },
  };
}

/** Edit one staged row; it is re-validated, and approved again if the problems are fixed. */
export async function editImportRow(ctx: QCtx, batchId: number, rowNumber: number, raw: Record<string, unknown>) {
  const batch = await loadBatch(ctx.db, batchId, ctx.adminId);
  if (!batch || batch.status !== "preview") return { status: 404, body: { error: "Import not found or closed." } };
  const row = await ctx.db.prepare("SELECT status FROM import_rows WHERE batch_id = ? AND row_number = ?").bind(batchId, rowNumber).first<{ status: string }>();
  if (!row || row.status === "saved") return { status: 404, body: { error: "Row not found or already saved." } };
  const { value, issues } = normalizeQuestion(raw, await validSubjectSet(ctx.db));
  const fp = await fingerprint(value);
  const key = `${value.subject_id}|${fp}`;
  const inBank = await ctx.db.prepare("SELECT id FROM questions WHERE subject_id = ? AND fingerprint = ?").bind(value.subject_id, fp).first<{ id: number }>();
  if (inBank) issues.push({ code: "duplicate_in_bank", message: `Already in the bank (question #${inBank.id}).`, blocking: true });
  const dupRow = await ctx.db.prepare("SELECT row_number FROM import_rows WHERE batch_id = ? AND row_number <> ? AND dedupe_key = ? AND status <> 'rejected'").bind(batchId, rowNumber, key).first();
  if (dupRow) issues.push({ code: "duplicate_in_file", message: "Same as another row in this import.", blocking: true });
  const status = blocking(issues) ? "rejected" : "approved";
  await ctx.db
    .prepare("UPDATE import_rows SET payload_json = ?, issues_json = ?, status = ?, dedupe_key = ? WHERE batch_id = ? AND row_number = ?")
    .bind(JSON.stringify(value), JSON.stringify(issues), status, key, batchId, rowNumber)
    .run();
  return { status: 200, body: { row_number: rowNumber, status, issues } };
}

/** Approve or reject rows. Rows with blocking problems cannot be approved. */
export async function setImportRowStatus(ctx: QCtx, batchId: number, rowNumbers: number[], status: "approved" | "rejected") {
  const batch = await loadBatch(ctx.db, batchId, ctx.adminId);
  if (!batch || batch.status !== "preview") return { status: 404, body: { error: "Import not found or closed." } };
  const nums = [...new Set(rowNumbers.filter((n) => Number.isInteger(n) && n > 0))].slice(0, 90);
  if (!nums.length) return { status: 400, body: { error: "No rows selected." } };
  const ph = nums.map(() => "?").join(",");
  const guard = status === "approved" ? `AND issues_json NOT LIKE '%"blocking":true%'` : "";
  const r = await ctx.db
    .prepare(`UPDATE import_rows SET status = ? WHERE batch_id = ? AND status IN ('pending','approved','rejected') AND row_number IN (${ph}) ${guard}`)
    .bind(status, batchId, ...nums)
    .run();
  return { status: 200, body: { updated: r.meta.changes } };
}

/** Save up to IMPORT_CHUNK approved rows. Call repeatedly until remaining = 0. */
export async function commitImport(ctx: QCtx, batchId: number) {
  const batch = await loadBatch(ctx.db, batchId, ctx.adminId);
  if (!batch) return { status: 404, body: { error: "Import not found." } };
  if (batch.status === "discarded") return { status: 409, body: { error: "This import was discarded." } };
  const { results } = await ctx.db
    .prepare("SELECT row_number, payload_json FROM import_rows WHERE batch_id = ? AND status = 'approved' ORDER BY row_number LIMIT ?")
    .bind(batchId, IMPORT_CHUNK)
    .all<{ row_number: number; payload_json: string }>();
  let saved = 0;
  let skipped = 0;
  const subjects = await validSubjectSet(ctx.db);
  for (const r of results) {
    const payload = JSON.parse(r.payload_json) as Record<string, unknown>;
    const { value, issues } = normalizeQuestion(payload, subjects);
    const fp = await fingerprint(value);
    try {
      if (blocking(issues)) throw new Error("blocking");
      await ctx.db.batch([
        ...insertStatements(ctx, value, fp, "import_file"),
        ctx.db.prepare("UPDATE import_rows SET status = 'saved' WHERE batch_id = ? AND row_number = ? AND status = 'approved'").bind(batchId, r.row_number),
      ]);
      saved += 1;
    } catch (e) {
      // unique violation (someone saved the same question meanwhile) or invalid: skip, never crash the batch
      void e;
      skipped += 1;
      await ctx.db.prepare("UPDATE import_rows SET status = 'rejected' WHERE batch_id = ? AND row_number = ? AND status = 'approved'").bind(batchId, r.row_number).run();
    }
  }
  const left = await ctx.db.prepare("SELECT COUNT(*) AS n FROM import_rows WHERE batch_id = ? AND status = 'approved'").bind(batchId).first<{ n: number }>();
  const remaining = left?.n ?? 0;
  const tot = await ctx.db
    .prepare("SELECT SUM(CASE WHEN status='saved' THEN 1 ELSE 0 END) AS s, SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS k FROM import_rows WHERE batch_id = ?")
    .bind(batchId)
    .first<{ s: number | null; k: number | null }>();
  if (remaining === 0 && batch.status === "preview") {
    await ctx.db
      .prepare("UPDATE import_batches SET status = 'committed', saved_rows = ?, skipped_rows = ?, committed_at = ? WHERE id = ?")
      .bind(tot?.s ?? 0, tot?.k ?? 0, iso(ctx.now), batchId)
      .run();
    await writeAudit(ctx.db, { adminId: ctx.adminId, action: "question.import", targetType: "import", targetId: batchId, details: { saved: tot?.s ?? 0, skipped: tot?.k ?? 0 }, ipHash: ctx.ipHash, now: ctx.now });
  }
  return { status: 200, body: { saved_now: saved, skipped_now: skipped, remaining, done: remaining === 0, saved_total: tot?.s ?? 0, skipped_total: tot?.k ?? 0 } };
}

export async function discardImport(ctx: QCtx, batchId: number) {
  const batch = await loadBatch(ctx.db, batchId, ctx.adminId);
  if (!batch) return { status: 404, body: { error: "Import not found." } };
  if (batch.status === "committed") return { status: 409, body: { error: "Already committed." } };
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM import_rows WHERE batch_id = ?").bind(batchId),
    ctx.db.prepare("UPDATE import_batches SET status = 'discarded' WHERE id = ?").bind(batchId),
  ]);
  return { status: 200, body: { ok: true } };
}

export const IMPORT_TEMPLATE_CSV = toCsv(
  EXPORT_HEADERS,
  [
    { subject: "mathematics", topic: "Algebra", year: 2019, question: "Solve 2x + 3 = 11.", option_a: "2", option_b: "4", option_c: "6", option_d: "8", answer: "B", explanation: "2x = 8 so x = 4", source: "Example row: delete me", status: "" },
  ],
);
