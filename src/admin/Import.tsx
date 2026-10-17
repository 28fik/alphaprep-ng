import { useCallback, useEffect, useRef, useState } from "react";
import StateBox from "../components/StateBox";
import { btn, btn2, Card, Chip, Field, input, Pager } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { ALL_SUBJECTS } from "../lib/constants";
import { parseCsv, parsePastedText, readXlsx, rowsFromTable, type RawQuestion } from "../lib/importParse";
import QuestionForm, { qToApi, type QValues } from "./QuestionForm";

type Row = Record<string, any>;
type Source = "csv" | "xlsx" | "paste" | "pdf_text" | "pdf_ocr";
const CHUNK = 20;
const SOURCES: { id: Source; label: string }[] = [
  { id: "csv", label: "CSV file" }, { id: "xlsx", label: "Excel file (.xlsx)" }, { id: "paste", label: "Paste text" },
  { id: "pdf_text", label: "PDF with text" }, { id: "pdf_ocr", label: "Scanned PDF (OCR)" },
];

const rawToForm = (q: Row): QValues => ({
  subject: q.subject_id, topic: q.topic ?? "", year: q.exam_year ? String(q.exam_year) : "", question: q.question_text,
  option_a: q.option_a, option_b: q.option_b, option_c: q.option_c, option_d: q.option_d, answer: q.correct_option ?? "", explanation: q.explanation ?? "", source: q.source ?? "", verification_status: q.verification_status,
});

export default function Import() {
  const [src, setSrc] = useState<Source>("csv");
  const [defaults, setDefaults] = useState({ subject: "mathematics", topic: "", year: "", source: "" });
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [batchId, setBatchId] = useState<number | null>(null);
  const [preview, setPreview] = useState<Row | null>(null);
  const [page, setPage] = useState(1);
  const [editRow, setEditRow] = useState<number | null>(null);
  const [rowErr, setRowErr] = useState("");
  const [summary, setSummary] = useState<Row | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadPreview = useCallback((id: number, p: number) => {
    api<Row>(`/admin/imports/${id}?page=${p}`).then(setPreview).catch((e) => setErr(e.message));
  }, []);
  useEffect(() => { if (batchId) loadPreview(batchId, page); }, [batchId, page, loadPreview]);

  /** Read the chosen source in the browser and turn it into raw rows. */
  async function extract(): Promise<{ rows: RawQuestion[]; low: boolean }> {
    const notesOut: string[] = [];
    let rows: RawQuestion[] = [];
    let low = false;
    if (src === "paste") {
      const r = parsePastedText(text, defaults); rows = r.rows; notesOut.push(...r.notes);
    } else {
      if (!file) throw new Error("Choose a file first.");
      if (file.size > 25_000_000) throw new Error("That file is larger than 25 MB.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (src === "csv") {
        const t = rowsFromTable(parseCsv(new TextDecoder().decode(bytes)));
        rows = t.rows; if (t.unknownColumns.length) notesOut.push(`Ignored columns: ${t.unknownColumns.join(", ")}.`);
        if (t.missingColumns.length) throw new Error(`Missing columns: ${t.missingColumns.join(", ")}. Download the template to see the expected layout.`);
        rows = rows.map((r) => ({ ...r, subject: r.subject || defaults.subject, source: r.source || defaults.source }));
      } else if (src === "xlsx") {
        const t = rowsFromTable(await readXlsx(bytes));
        rows = t.rows; if (t.unknownColumns.length) notesOut.push(`Ignored columns: ${t.unknownColumns.join(", ")}.`);
        if (t.missingColumns.length) throw new Error(`Missing columns: ${t.missingColumns.join(", ")}. Download the CSV template and use the same headings.`);
        rows = rows.map((r) => ({ ...r, subject: r.subject || defaults.subject, source: r.source || defaults.source }));
      } else if (src === "pdf_text") {
        const { loadPdfJs } = await import("../lib/pdfLoad");
        const { pdfToText } = await import("../lib/pdfText");
        setBusy("Reading the PDF…");
        const out = await pdfToText(await loadPdfJs(), bytes, (p, n) => setBusy(`Reading page ${p} of ${n}…`));
        if (out.looksScanned) throw new Error("This PDF has almost no selectable text, so it is probably scanned. Choose “Scanned PDF (OCR)” instead.");
        const r = parsePastedText(out.text, defaults); rows = r.rows; notesOut.push(...r.notes);
      } else {
        const { ocrPdf } = await import("../lib/pdfLoad");
        const out = await ocrPdf(bytes, setBusy);
        low = out.confidence < 80;
        notesOut.push(`OCR confidence ${Math.round(out.confidence)}%.${low ? " That is low, so every question is marked “needs review”." : ""} OCR can misread symbols and numbers: check each question carefully.`);
        const r = parsePastedText(out.text, defaults); rows = r.rows; notesOut.push(...r.notes);
      }
    }
    setNotes(notesOut);
    return { rows, low };
  }

  async function check() {
    setErr(""); setSummary(null); setPreview(null); setBatchId(null);
    try {
      setBusy("Reading your data…");
      const { rows, low } = await extract();
      if (rows.length === 0) throw new Error("No questions were found.");
      if (rows.length > 5000) throw new Error("Please import at most 5,000 questions at a time.");
      const b = await api<{ batch_id: number }>("/admin/imports", { method: "POST", body: JSON.stringify({ file_name: file?.name ?? "pasted text", file_type: src }) });
      for (let i = 0; i < rows.length; i += CHUNK) {
        setBusy(`Checking ${Math.min(i + CHUNK, rows.length)} of ${rows.length}…`);
        const chunk = rows.slice(i, i + CHUNK).map((r) => (low ? { ...r, low_confidence: true } : r));
        await api(`/admin/imports/${b.batch_id}/rows`, { method: "POST", body: JSON.stringify({ rows: chunk }) });
      }
      setPage(1); setBatchId(b.batch_id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(""); }
  }

  async function setStatus(rows: number[], status: "approved" | "rejected") {
    try { await api(`/admin/imports/${batchId}/rows-status`, { method: "POST", body: JSON.stringify({ rows, status }) }); loadPreview(batchId!, page); } catch (e) { setErr((e as ApiError).message); }
  }
  async function saveRow(n: number, v: QValues) {
    setRowErr("");
    try { await api(`/admin/imports/${batchId}/rows/${n}`, { method: "PUT", body: JSON.stringify(qToApi(v)) }); setEditRow(null); loadPreview(batchId!, page); } catch (e) { setRowErr((e as ApiError).message); }
  }
  async function commit() {
    setErr("");
    try {
      let r: Row;
      do {
        setBusy("Saving questions…");
        r = await api<Row>(`/admin/imports/${batchId}/commit`, { method: "POST", body: "{}" });
        setBusy(`Saved ${r.saved_total} so far… (${r.remaining} left)`);
      } while (!r.done);
      setSummary(r); loadPreview(batchId!, page);
    } catch (e) { setErr((e as ApiError).message); } finally { setBusy(""); }
  }
  async function discard() {
    if (!window.confirm("Discard this import? Nothing will be saved.")) return;
    await api(`/admin/imports/${batchId}/discard`, { method: "POST", body: "{}" }).catch(() => undefined);
    setBatchId(null); setPreview(null); setSummary(null);
  }

  const counts = (preview?.counts ?? {}) as Record<string, number>;
  const closed = preview?.batch?.status !== "preview";
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Import questions</h1>
      <p className="text-sm text-slate-300">Files are read in your browser. You review everything before anything is saved. Answers are never guessed: rows without an answer are saved as “needs review” and kept out of exams until you add one.</p>

      {!batchId && (
        <Card title="1. Choose a source">
          <div role="tablist" aria-label="Import source" className="flex flex-wrap gap-2">
            {SOURCES.map((s) => <button key={s.id} role="tab" aria-selected={src === s.id} onClick={() => setSrc(s.id)} className={`rounded-lg px-3 py-2 text-sm font-semibold ${src === s.id ? "bg-brand-blue text-brand-navy" : "bg-brand-navy"}`}>{s.label}</button>)}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <Field label="Default subject" hint="Used when the file has no subject column"><select className={input} value={defaults.subject} onChange={(e) => setDefaults({ ...defaults, subject: e.target.value })}>{ALL_SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Topic (optional)"><input className={input} value={defaults.topic} onChange={(e) => setDefaults({ ...defaults, topic: e.target.value })} /></Field>
            <Field label="Year (optional)"><input className={input} inputMode="numeric" maxLength={4} value={defaults.year} onChange={(e) => setDefaults({ ...defaults, year: e.target.value })} /></Field>
            <Field label="Source (optional)"><input className={input} value={defaults.source} onChange={(e) => setDefaults({ ...defaults, source: e.target.value })} /></Field>
          </div>
          <div className="mt-4">
            {src === "paste" ? (
              <Field label="Paste questions" hint="Format: 1. Question, then A. B. C. D. options, then “Answer: B”. An answer list at the end (1.B 2.C) also works.">
                <textarea className={`${input} font-mono`} rows={12} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
            ) : (
              <Field label={src === "csv" ? "CSV file" : src === "xlsx" ? "Excel file" : "PDF file"} hint={src === "pdf_ocr" ? "Slow and less accurate. Up to 30 pages. Loads an OCR engine from a public CDN the first time." : undefined}>
                <input ref={fileRef} type="file" className={input} accept={src === "csv" ? ".csv,text/csv" : src === "xlsx" ? ".xlsx" : "application/pdf,.pdf"} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </Field>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className={btn} disabled={!!busy || (src === "paste" ? !text.trim() : !file)} onClick={check}>{busy || "Check my questions"}</button>
            {(src === "csv" || src === "xlsx") && <a className="text-sm text-brand-blue underline" href="/api/admin/questions/template">Download CSV template</a>}
          </div>
        </Card>
      )}

      {err && <StateBox kind="error">{err}</StateBox>}
      {notes.map((n, i) => <StateBox key={i} kind="empty">{n}</StateBox>)}
      {busy && batchId && <StateBox kind="loading">{busy}</StateBox>}

      {batchId && preview && (
        <Card title={`2. Review (import #${batchId})`} actions={!closed && <button className={btn2} onClick={discard}>Discard import</button>}>
          <ul className="flex flex-wrap gap-3 text-sm">
            <li><Chip tone="green">{counts.approved ?? 0} ready</Chip></li><li><Chip tone="red">{counts.rejected ?? 0} skipped</Chip></li><li><Chip tone="blue">{counts.saved ?? 0} saved</Chip></li>
            <li><Chip tone="amber">{preview.missing_answers} without an answer</Chip></li><li className="text-slate-300">{preview.batch.total_rows} rows read</li>
          </ul>
          {summary && <div className="mt-3"><StateBox kind="success">Import finished: {summary.saved_total} saved, {summary.skipped_total} skipped.</StateBox></div>}
          <ul className="mt-3 divide-y divide-white/10">
            {preview.rows.map((r: Row) => {
              const q = r.question as Row;
              return (
                <li key={r.row_number} className="py-3 text-sm">
                  {editRow === r.row_number ? (
                    <QuestionForm initial={rawToForm(q)} error={rowErr} onSubmit={(v) => saveRow(r.row_number, v)} onCancel={() => setEditRow(null)} submitLabel="Save row" />
                  ) : (
                    <div className="flex gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="whitespace-pre-line"><span className="mr-2 text-slate-400">#{r.row_number}</span>{q.question_text || <em>(empty)</em>}</p>
                        <p className="mt-1 text-xs text-slate-300">A. {q.option_a} · B. {q.option_b} · C. {q.option_c} · D. {q.option_d}</p>
                        <p className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                          <Chip tone={r.status === "approved" ? "green" : r.status === "saved" ? "blue" : "red"}>{r.status === "rejected" ? "will be skipped" : r.status}</Chip>
                          <span>{q.subject_id}</span>{q.correct_option ? <Chip tone="grey">Answer {q.correct_option}</Chip> : <Chip tone="amber">No answer</Chip>}
                          {r.issues.map((i: Row, k: number) => <span key={k} className={i.blocking ? "text-rose-300" : "text-amber-300"}>{i.message}</span>)}
                        </p>
                      </div>
                      {!closed && r.status !== "saved" && (
                        <div className="flex shrink-0 flex-col gap-1">
                          <button className={btn2} onClick={() => { setEditRow(r.row_number); setRowErr(""); }}>Edit</button>
                          {r.status === "approved" ? <button className={btn2} onClick={() => setStatus([r.row_number], "rejected")}>Skip</button> : r.issues.some((i: Row) => i.blocking) ? null : <button className={btn2} onClick={() => setStatus([r.row_number], "approved")}>Include</button>}
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <Pager page={page} pageSize={25} total={preview.batch.total_rows} onPage={setPage} />
          {!closed && <div className="mt-4"><button className={btn} disabled={!!busy || (counts.approved ?? 0) === 0} onClick={commit}>{busy || `Save ${counts.approved ?? 0} questions to the bank`}</button></div>}
          {closed && <div className="mt-4"><button className={btn2} onClick={() => { setBatchId(null); setPreview(null); setSummary(null); setNotes([]); setText(""); setFile(null); }}>Start another import</button></div>}
        </Card>
      )}
    </div>
  );
}
