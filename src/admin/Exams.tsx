import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import StateBox from "../components/StateBox";
import { btn, btn2, btnDanger, Card, Chip, Field, fmtLagos, fromLagosInput, input, toLagosInput } from "../components/ui";
import { api, ApiError } from "../lib/api";
import { ALL_SUBJECTS, subjectName } from "../lib/constants";
import { useAdmin } from "./AdminShell";

type Row = Record<string, any>;
const tone = (s: string) => (s === "published" ? "green" : s === "approved" ? "blue" : s === "cancelled" ? "red" : "amber");

export function ExamList() {
  const { can } = useAdmin();
  const navigate = useNavigate();
  const [exams, setExams] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  useEffect(() => { api<{ exams: Row[] }>("/admin/exams").then((r) => setExams(r.exams)).catch((e) => setErr(e.message)); }, []);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h1 className="text-2xl font-bold">Exams</h1>
        {can("exams.write") && <button className={btn} onClick={() => setCreating((v) => !v)}>{creating ? "Close" : "New exam"}</button>}</div>
      {creating && <Card title="New exam"><ExamForm onDone={(id) => navigate(`/admin/exams/${id}`)} /></Card>}
      {err ? <StateBox kind="error">{err}</StateBox> : !exams ? <StateBox kind="loading">Loading…</StateBox> : exams.length === 0 ? <StateBox kind="empty">No exams yet.</StateBox> : (
        <ul className="divide-y divide-white/10 rounded-2xl border border-white/15 bg-brand-navy-2">
          {exams.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <Link className="font-semibold text-brand-blue underline" to={`/admin/exams/${e.id}`}>{e.exam_date} · {e.title}</Link>
              <span className="flex items-center gap-3"><span className="text-xs text-slate-300">{e.questions_ready}/{e.questions_needed} questions · {e.attempts} attempts</span><Chip tone={tone(e.status)}>{e.status}</Chip></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ExamForm({ exam, onDone }: { exam?: Row; onDone: (id: number) => void }) {
  const [v, setV] = useState({
    exam_date: exam?.exam_date ?? "", title: exam?.title ?? "AlphaPrep NG Daily Mock",
    registration_opens_at: toLagosInput(exam?.registration_opens_at), starts_at: toLagosInput(exam?.starts_at), ends_at: toLagosInput(exam?.ends_at),
    duration_minutes: String(exam?.duration_minutes ?? 120), correction_release_at: toLagosInput(exam?.correction_release_at),
    share_gate_enabled: exam ? !!exam.share_gate_enabled : true,
  });
  const [subjects, setSubjects] = useState<string[]>(ALL_SUBJECTS.map((s) => s.id));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(""); setErrors({});
    const body: Row = {
      exam_date: v.exam_date, title: v.title, registration_opens_at: fromLagosInput(v.registration_opens_at) || null,
      starts_at: fromLagosInput(v.starts_at), ends_at: fromLagosInput(v.ends_at), duration_minutes: Number(v.duration_minutes),
      correction_release_at: fromLagosInput(v.correction_release_at), share_gate_enabled: v.share_gate_enabled,
    };
    if (!exam) body.subjects = subjects;
    try {
      const r: Row = exam ? await api(`/admin/exams/${exam.id}`, { method: "PUT", body: JSON.stringify(body) }) : await api("/admin/exams", { method: "POST", body: JSON.stringify(body) });
      onDone(exam ? exam.id : r.id);
    } catch (x) { const ae = x as ApiError; setErr(ae.message); setErrors(ae.data?.errors ?? {}); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <p className="text-xs text-slate-300">All times are Nigerian time (WAT). Answers must stay hidden until the window has closed plus the full duration, and the system enforces that.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Exam date" error={errors.exam_date}><input type="date" className={input} value={v.exam_date} onChange={set("exam_date")} disabled={!!exam && exam.status !== "draft"} /></Field>
        <Field label="Title" error={errors.title}><input className={input} value={v.title} onChange={set("title")} /></Field>
        <Field label="Registration opens (optional)" error={errors.registration_opens_at}><input type="datetime-local" className={input} value={v.registration_opens_at} onChange={set("registration_opens_at")} /></Field>
        <Field label="Duration (minutes)" error={errors.duration_minutes}><input className={input} inputMode="numeric" value={v.duration_minutes} onChange={set("duration_minutes")} /></Field>
        <Field label="Participants may start from" error={errors.starts_at}><input type="datetime-local" className={input} value={v.starts_at} onChange={set("starts_at")} /></Field>
        <Field label="Last time to start" error={errors.ends_at}><input type="datetime-local" className={input} value={v.ends_at} onChange={set("ends_at")} /></Field>
        <Field label="Release answers and corrections at" error={errors.correction_release_at}><input type="datetime-local" className={input} value={v.correction_release_at} onChange={set("correction_release_at")} /></Field>
        <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" className="h-5 w-5" checked={v.share_gate_enabled} onChange={(e) => setV({ ...v, share_gate_enabled: e.target.checked })} />Require the WhatsApp share confirmation</label>
      </div>
      {!exam && (
        <fieldset><legend className="text-sm font-medium">Subjects included (English is always included)</legend>
          <div className="mt-1 flex flex-wrap gap-3 text-sm">{ALL_SUBJECTS.filter((s) => s.id !== "english").map((s) => (
            <label key={s.id} className="flex items-center gap-1"><input type="checkbox" checked={subjects.includes(s.id)} onChange={(e) => setSubjects(e.target.checked ? [...subjects, s.id] : subjects.filter((x) => x !== s.id))} />{s.name}</label>))}</div>
          <p className="mt-1 text-xs text-slate-400">A participant can only take an exam that includes all three of their subjects.</p></fieldset>
      )}
      {err && <p className="text-sm text-rose-300" role="alert">{err}</p>}
      <button className={btn} disabled={busy}>{busy ? "Saving…" : exam ? "Save schedule" : "Create draft"}</button>
    </form>
  );
}

export function ExamDetail() {
  const { id } = useParams();
  const { can } = useAdmin();
  const [data, setData] = useState<Row | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [showPreview, setShowPreview] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const write = can("exams.write");

  const load = useCallback(() => {
    if (!can("questions.read")) { setErr("You do not have permission to preview exams."); return; }
    api<Row>(`/admin/exams/${id}/preview`).then(setData).catch((e) => setErr(e.message));
  }, [id, can]);
  useEffect(load, [load]);

  async function act(path: string, label: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(label); setErr(""); setMsg("");
    try { await api(`/admin/exams/${id}/${path}`, { method: "POST", body: "{}" }); setMsg(`${label}: done.`); load(); }
    catch (e) { const ae = e as ApiError; setErr(ae.data?.incomplete ? `${ae.message} ${ae.data.incomplete.join(", ")}` : ae.message); } finally { setBusy(""); }
  }
  async function generate(subject: string) {
    setBusy(`Generating ${subjectName(subject)}…`); setErr(""); setMsg("");
    try { await api(`/admin/exams/${id}/generate`, { method: "POST", body: JSON.stringify({ subject }) }); load(); }
    catch (e) { setErr(`${subjectName(subject)}: ${(e as ApiError).message}`); throw e; } finally { setBusy(""); }
  }
  async function generateAll() {
    for (const s of data!.subjects as Row[]) { if (s.generated !== s.question_count) { try { await generate(s.subject_id); } catch { return; } } }
    setMsg("All subjects generated. Review them, then approve.");
  }

  if (err && !data) return <StateBox kind="error">{err}</StateBox>;
  if (!data) return <StateBox kind="loading">Loading exam…</StateBox>;
  const e = data.exam as Row;
  const frozen = !!e.frozen_at;
  const editable = write && !frozen && ["draft", "approved"].includes(e.status);
  const complete = (data.subjects as Row[]).every((s) => s.generated === s.question_count);
  const qs = (data.questions as Row[]).filter((q) => q.subject_id === showPreview);

  return (
    <div className="space-y-4">
      <Link to="/admin/exams" className="text-sm text-brand-blue underline">← All exams</Link>
      <div className="flex flex-wrap items-center gap-3"><h1 className="text-2xl font-bold">{e.exam_date} · {e.title}</h1><Chip tone={tone(e.status)}>{e.status}</Chip></div>
      {err && <StateBox kind="error">{err}</StateBox>}{msg && <StateBox kind="success">{msg}</StateBox>}{busy && <StateBox kind="loading">{busy}</StateBox>}

      <Card title="Schedule (Nigerian time)" actions={write && e.status !== "cancelled" && <button className={btn2} onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit schedule"}</button>}>
        {editing ? <ExamForm exam={e} onDone={() => { setEditing(false); load(); }} /> : (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-slate-400">Start window</dt><dd>{fmtLagos(e.starts_at)} to {fmtLagos(e.ends_at)}</dd></div>
            <div><dt className="text-slate-400">Duration</dt><dd>{e.duration_minutes} minutes from each participant's start</dd></div>
            <div><dt className="text-slate-400">Corrections released</dt><dd>{fmtLagos(e.correction_release_at)}</dd></div>
            <div><dt className="text-slate-400">WhatsApp share gate</dt><dd>{e.share_gate_enabled ? "On" : "Off"}</dd></div>
            {frozen && <div><dt className="text-slate-400">Frozen</dt><dd>{fmtLagos(e.frozen_at)}</dd></div>}
          </dl>
        )}
      </Card>

      <Card title="Questions" actions={editable && <button className={btn} disabled={!!busy} onClick={generateAll}>Generate all missing</button>}>
        {frozen && <p className="mb-2 text-sm text-slate-300">This exam is published and frozen: its questions and answers can no longer change.</p>}
        <ul className="divide-y divide-white/10 text-sm">
          {(data.subjects as Row[]).map((s) => (
            <li key={s.subject_id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>{subjectName(s.subject_id)} <span className={s.generated === s.question_count ? "text-emerald-300" : "text-amber-300"}>{s.generated}/{s.question_count}</span></span>
              <span className="flex gap-2">
                {s.generated > 0 && <button className={btn2} onClick={() => setShowPreview(showPreview === s.subject_id ? null : s.subject_id)}>{showPreview === s.subject_id ? "Hide" : "Preview"}</button>}
                {editable && <button className={btn2} disabled={!!busy} onClick={() => generate(s.subject_id).catch(() => undefined)}>{s.generated ? "Regenerate" : "Generate"}</button>}
              </span>
            </li>
          ))}
        </ul>
        {showPreview && (
          <ol className="mt-4 space-y-3">
            {qs.map((q) => (
              <li key={q.id} className="rounded-xl bg-brand-navy p-3 text-sm">
                <p className="whitespace-pre-line"><span className="mr-2 text-slate-400">{q.position}.</span>{q.question_text}</p>
                <ul className="mt-2 space-y-1 text-xs">{(["A", "B", "C", "D"] as const).map((l) => <li key={l} className={q.correct_option === l ? "font-semibold text-emerald-300" : "text-slate-300"}>{l}. {q[`option_${l.toLowerCase()}`]}{q.correct_option === l ? "  ✓" : ""}</li>)}</ul>
                {q.topic && <p className="mt-1 text-xs text-slate-400">Topic: {q.topic}</p>}
              </li>
            ))}
          </ol>
        )}
      </Card>

      {write && e.status !== "cancelled" && (
        <Card title="Publishing">
          <p className="mb-3 text-sm text-slate-300">Generate every subject, review the preview, approve, then publish. Publishing freezes the questions and answer keys permanently.</p>
          <div className="flex flex-wrap gap-2">
            {e.status === "draft" && <button className={btn} disabled={!complete || !!busy} onClick={() => act("approve", "Approve")}>Approve</button>}
            {e.status === "approved" && <><button className={btn2} disabled={!!busy} onClick={() => act("unapprove", "Back to draft")}>Back to draft</button>
              <button className={btn} disabled={!!busy} onClick={() => act("publish", "Publish", "Publish this exam? Its questions and answers will be frozen and participants will be able to take it in the window.")}>Publish</button></>}
            {e.attempts === 0 && <button className={btnDanger} disabled={!!busy} onClick={() => act("cancel", "Cancel exam", "Cancel this exam?")}>Cancel exam</button>}
          </div>
          {!complete && e.status === "draft" && <p className="mt-2 text-xs text-amber-300">Every subject needs its full set of questions before approval.</p>}
        </Card>
      )}
    </div>
  );
}
