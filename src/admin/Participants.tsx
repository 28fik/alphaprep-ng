import { useCallback, useEffect, useState, type FormEvent } from "react";
import StateBox from "../components/StateBox";
import { btn, btn2, btnDanger, Card, Chip, Field, input, Pager } from "../components/ui";
import { api, ApiError, fmtDuration } from "../lib/api";
import { subjectName } from "../lib/constants";
import { useAdmin } from "./AdminShell";

type Row = Record<string, any>;

export default function Participants() {
  const { can } = useAdmin();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Row | null>(null);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<string | null>(null);

  useEffect(() => {
    setErr("");
    api<Row>(`/admin/participants?q=${encodeURIComponent(query)}&page=${page}`).then(setData).catch((e) => setErr(e.message));
  }, [query, page]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Participants</h1>
      <form className="flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); setPage(1); setQuery(q.trim()); }}>
        <input className={input} aria-label="Search by ID or name" placeholder="Search by ID or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={btn}>Search</button>
      </form>
      {err ? <StateBox kind="error">{err}</StateBox> : !data ? <StateBox kind="loading">Loading…</StateBox> : (
        <>
          <ul className="divide-y divide-white/10 rounded-2xl border border-white/15 bg-brand-navy-2">
            {data.rows.length === 0 && <li className="px-4 py-3 text-sm text-slate-300">No participants found.</li>}
            {data.rows.map((r: Row) => (
              <li key={r.id}><button className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left text-sm hover:bg-brand-navy-3" onClick={() => setSel(r.id)}>
                <span><strong>{r.id}</strong> · {r.first_name} {r.last_name}</span>
                <span className="flex items-center gap-2 text-xs text-slate-300">{r.exams_taken} exams {r.status === "suspended" && <Chip tone="red">suspended</Chip>}</span></button></li>
            ))}
          </ul>
          <Pager page={page} pageSize={data.page_size} total={data.total} onPage={setPage} />
        </>
      )}
      {sel && <Detail id={sel} canWrite={can("participants.write")} onClose={() => setSel(null)} />}
    </div>
  );
}

function Detail({ id, canWrite, onClose }: { id: string; canWrite: boolean; onClose: () => void }) {
  const [d, setD] = useState<Row | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [adj, setAdj] = useState<{ attempt: number; score: string; reason: string } | null>(null);

  const load = useCallback(() => { api<Row>(`/admin/participants/${id}`).then(setD).catch((e) => setErr(e.message)); }, [id]);
  useEffect(() => { setD(null); setCode(""); setMsg(""); load(); }, [load]);

  async function call(path: string, body: Row, ok: string) {
    setErr(""); setMsg("");
    try { const r: Row = await api(path, { method: "POST", body: JSON.stringify(body) }); setMsg(ok); if (r.recovery_code) setCode(r.recovery_code); load(); return r; }
    catch (e) { setErr((e as ApiError).message); }
  }

  if (err && !d) return <StateBox kind="error">{err}</StateBox>;
  if (!d) return <StateBox kind="loading">Loading participant…</StateBox>;
  const p = d.participant as Row;
  return (
    <Card title={`${p.id} · ${p.first_name} ${p.last_name}`} actions={<button className={btn2} onClick={onClose}>Close</button>}>
      {err && <StateBox kind="error">{err}</StateBox>}{msg && <StateBox kind="success">{msg}</StateBox>}
      {code && <div className="my-3 rounded-xl border border-amber-300/50 bg-amber-950/40 p-3 text-sm"><p>New recovery code (show it to the participant once, it cannot be displayed again):</p><p className="mt-1 text-2xl font-bold tracking-widest">{code}</p></div>}
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-slate-400">Target score</dt><dd>{p.target_score}</dd></div><div><dt className="text-slate-400">Gender</dt><dd>{p.gender}</dd></div>
        <div><dt className="text-slate-400">Course</dt><dd>{p.intended_course}</dd></div><div><dt className="text-slate-400">Institution</dt><dd>{p.preferred_institution}</dd></div>
        <div><dt className="text-slate-400">Subjects</dt><dd>English, {(d.subjects as string[]).map(subjectName).join(", ")}</dd></div>
        <div><dt className="text-slate-400">Linked devices</dt><dd>{d.linked_devices}</dd></div>
        <div><dt className="text-slate-400">Status</dt><dd>{p.status}{p.suspended_reason ? ` (${p.suspended_reason})` : ""}</dd></div>
      </dl>

      <h3 className="mt-4 text-sm font-semibold text-brand-blue">Results</h3>
      {(d.results as Row[]).length === 0 ? <p className="text-sm text-slate-300">No results yet.</p> : (
        <ul className="divide-y divide-white/10 text-sm">
          {(d.results as Row[]).map((r) => (
            <li key={r.attempt_id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{r.exam_date}: <strong>{r.total_score}</strong>/400 · {fmtDuration(r.duration_seconds)} · {r.submit_reason} {!r.is_eligible && <Chip tone="red">hidden from boards</Chip>} {r.adjustments > 0 && <Chip tone="amber">adjusted</Chip>}</span>
                {canWrite && <span className="flex gap-2">
                  <button className={btn2} onClick={() => setAdj({ attempt: r.attempt_id, score: String(r.total_score), reason: "" })}>Adjust score</button>
                  <button className={btn2} onClick={() => { const why = window.prompt(r.is_eligible ? "Reason for hiding this result from leaderboards (min 5 characters):" : "Reason for restoring this result:"); if (why) void call(`/admin/results/${r.attempt_id}/eligibility`, { eligible: !r.is_eligible, reason: why }, "Updated."); }}>{r.is_eligible ? "Hide" : "Restore"}</button>
                </span>}
              </div>
              {adj && adj.attempt === r.attempt_id && (
                <form className="mt-2 grid gap-2 sm:grid-cols-[8rem_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void call(`/admin/results/${r.attempt_id}/adjust`, { new_total: Number(adj.score), reason: adj.reason }, "Score adjusted and logged.").then(() => setAdj(null)); }}>
                  <Field label="New total"><input className={input} inputMode="decimal" value={adj.score} onChange={(e) => setAdj({ ...adj, score: e.target.value })} /></Field>
                  <Field label="Reason (recorded in the audit log)"><input className={input} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} /></Field>
                  <button className={`${btn} self-end`}>Save</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="mt-5 space-y-3 border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1"><Field label={p.status === "suspended" ? "Reason (optional)" : "Reason for suspending"}><input className={input} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div>
            {p.status === "suspended" ? <button className={btn} onClick={() => call(`/admin/participants/${id}/status`, { suspend: false }, "Reinstated.")}>Reinstate</button>
              : <button className={btnDanger} onClick={() => call(`/admin/participants/${id}/status`, { suspend: true, reason }, "Suspended.")}>Suspend</button>}
          </div>
          <div><button className={btn2} onClick={() => { if (window.confirm("Issue a new recovery code? The old code stops working and every linked device is signed out.")) void call(`/admin/participants/${id}/reset-recovery`, {}, "New recovery code issued."); }}>Reset recovery code</button>
            <p className="mt-1 text-xs text-slate-400">Use this when a participant lost their code. Confirm who they are through your official channels first: the ID alone is not proof of identity.</p></div>
        </div>
      )}
    </Card>
  );
}
