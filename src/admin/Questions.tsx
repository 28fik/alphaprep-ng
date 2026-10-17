import { useCallback, useEffect, useState } from "react";
import StateBox from "../components/StateBox";
import { btn, btn2, btnDanger, Card, Chip, input, Pager } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { ALL_SUBJECTS, subjectName } from "../lib/constants";
import { useAdmin } from "./AdminShell";
import QuestionForm, { emptyQ, qToApi, type QValues } from "./QuestionForm";

type Row = Record<string, any>;
const toForm = (r: Row): QValues => ({
  subject: r.subject_id, topic: r.topic ?? "", year: r.exam_year ? String(r.exam_year) : "", question: r.question_text,
  option_a: r.option_a, option_b: r.option_b, option_c: r.option_c, option_d: r.option_d, answer: r.correct_option ?? "", explanation: r.explanation ?? "", source: r.source ?? "", verification_status: r.verification_status,
});

export default function Questions() {
  const { can } = useAdmin();
  const write = can("questions.write");
  const [f, setF] = useState({ subject: "", status: "", has_key: "", q: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: Row[]; total: number; page_size: number } | null>(null);
  const [stats, setStats] = useState<Row[]>([]);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<number[]>([]);
  const [editing, setEditing] = useState<{ id: number | null; v: QValues } | null>(null);
  const [formErr, setFormErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const qs = useCallback(() => new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), page: String(page) }).toString(), [f, page]);
  const load = useCallback(() => {
    setErr("");
    api<{ rows: Row[]; total: number; page_size: number }>(`/admin/questions?${qs()}`).then((d) => { setData(d); setSel([]); }).catch((e) => setErr(e.message));
  }, [qs]);
  useEffect(load, [load]);
  useEffect(() => { api<{ subjects: Row[] }>("/admin/questions/stats").then((r) => setStats(r.subjects)).catch(() => undefined); }, [data]);

  async function save(v: QValues) {
    setBusy(true); setFormErr("");
    try {
      if (editing?.id) await api(`/admin/questions/${editing.id}`, { method: "PUT", body: JSON.stringify(qToApi(v)) });
      else await api("/admin/questions", { method: "POST", body: JSON.stringify(qToApi(v)) });
      setEditing(null); setMsg("Saved."); load();
    } catch (e) {
      const ae = e as ApiError;
      setFormErr(ae.data?.issues ? ae.data.issues.map((i: Row) => i.message).join(" ") : ae.message);
    } finally { setBusy(false); }
  }
  async function bulk(kind: "delete" | "verified" | "needs_review" | "unverified") {
    if (!sel.length) return;
    if (kind === "delete" && !window.confirm(`Delete ${sel.length} question(s)? Published exams are not affected.`)) return;
    try {
      const r: Row = kind === "delete"
        ? await api("/admin/questions/delete", { method: "POST", body: JSON.stringify({ ids: sel }) })
        : await api("/admin/questions/status", { method: "POST", body: JSON.stringify({ ids: sel, status: kind }) });
      setMsg(kind === "delete" ? `Deleted ${r.deleted}.` : `Updated ${r.updated} (questions with no answer key cannot be marked ${kind}).`);
      load();
    } catch (e) { setErr((e as ApiError).message); }
  }

  const tone = (s: string) => (s === "verified" ? "green" : s === "unverified" ? "blue" : "amber");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Question bank</h1>
        <div className="flex gap-2">
          <a className={btn2} href={`/api/admin/questions/export?${qs()}`}>Export CSV</a>
          {write && <button className={btn} onClick={() => { setEditing({ id: null, v: emptyQ(f.subject || "mathematics") }); setFormErr(""); }}>Add question</button>}
        </div>
      </div>

      <Card title="Usable questions per subject">
        <p className="mb-2 text-xs text-slate-300">An exam needs 60 usable English and 40 for each other subject. Usable = has an answer key and is not “needs review”.</p>
        <ul className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 md:grid-cols-4">
          {ALL_SUBJECTS.map((s) => {
            const r = stats.find((x) => x.subject_id === s.id);
            const need = s.id === "english" ? 60 : 40;
            const have = r?.usable ?? 0;
            return <li key={s.id} className="rounded-lg bg-brand-navy p-2"><p className="font-semibold">{s.name}</p><p className={have >= need ? "text-emerald-300" : "text-amber-300"}>{have} usable{have < need ? ` (need ${need})` : ""}</p><p className="text-slate-400">{r?.total ?? 0} total · {r?.missing_key ?? 0} no answer</p></li>;
          })}
        </ul>
      </Card>

      {editing && (
        <Card title={editing.id ? `Edit question #${editing.id}` : "New question"}>
          <QuestionForm initial={editing.v} busy={busy} error={formErr} onSubmit={save} onCancel={() => setEditing(null)} />
        </Card>
      )}

      <Card>
        <form className="grid gap-2 sm:grid-cols-5" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
          <select className={input} aria-label="Subject" value={f.subject} onChange={(e) => { setF({ ...f, subject: e.target.value }); setPage(1); }}><option value="">All subjects</option>{ALL_SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <select className={input} aria-label="Status" value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); setPage(1); }}><option value="">Any status</option><option value="verified">Verified</option><option value="unverified">Unverified</option><option value="needs_review">Needs review</option></select>
          <select className={input} aria-label="Answer key" value={f.has_key} onChange={(e) => { setF({ ...f, has_key: e.target.value }); setPage(1); }}><option value="">Any answer state</option><option value="1">Has answer</option><option value="0">Missing answer</option></select>
          <input className={`${input} sm:col-span-2`} aria-label="Search" placeholder="Search question text" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        </form>
        {msg && <div className="mt-3"><StateBox kind="success">{msg}</StateBox></div>}
        {write && sel.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm"><span>{sel.length} selected</span>
            <button className={btn2} onClick={() => bulk("verified")}>Mark verified</button>
            <button className={btn2} onClick={() => bulk("unverified")}>Mark unverified</button>
            <button className={btn2} onClick={() => bulk("needs_review")}>Needs review</button>
            <button className={btnDanger} onClick={() => bulk("delete")}>Delete</button></div>
        )}
        <div className="mt-3">
          {err ? <StateBox kind="error">{err}</StateBox> : !data ? <StateBox kind="loading">Loading questions…</StateBox> : data.rows.length === 0 ? <StateBox kind="empty">No questions match.</StateBox> : (
            <ul className="divide-y divide-white/10">
              {data.rows.map((r) => (
                <li key={r.id} className="flex gap-3 py-3 text-sm">
                  {write && <input type="checkbox" aria-label={`Select question ${r.id}`} className="mt-1 h-4 w-4" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} />}
                  <div className="min-w-0 flex-1">
                    <p className="whitespace-pre-line">{r.question_text}</p>
                    <p className="mt-1 text-xs text-slate-300">A. {r.option_a} · B. {r.option_b} · C. {r.option_c} · D. {r.option_d}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs"><span>#{r.id}</span><span>{subjectName(r.subject_id)}</span>{r.topic && <span>{r.topic}</span>}{r.exam_year && <span>{r.exam_year}</span>}
                      <Chip tone={tone(r.verification_status)}>{r.verification_status.replace("_", " ")}</Chip>
                      {r.correct_option ? <Chip tone="grey">Answer {r.correct_option}</Chip> : <Chip tone="red">No answer</Chip>}</p>
                  </div>
                  {write && <button className={btn2} onClick={() => { setEditing({ id: r.id, v: toForm(r) }); setFormErr(""); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button>}
                </li>
              ))}
            </ul>
          )}
          {data && <Pager page={page} pageSize={data.page_size} total={data.total} onPage={setPage} />}
        </div>
      </Card>
    </div>
  );
}
