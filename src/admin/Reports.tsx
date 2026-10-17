import { useEffect, useState } from "react";
import StateBox from "../components/StateBox";
import { btn2, Card, Field, input } from "../components/ui";
import { api, fmtDuration } from "../lib/api";
import { useAdmin } from "./AdminShell";

type Row = Record<string, any>;
export default function Reports() {
  const { can } = useAdmin();
  const [date, setDate] = useState("");
  const [daily, setDaily] = useState<Row | null>(null);
  const [weekly, setWeekly] = useState<Row | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const q = date ? `?date=${date}&limit=50` : "?limit=50";
    setErr("");
    api<Row>(`/leaderboard/daily${q}`).then(setDaily).catch((e) => setErr(e.message));
    api<Row>(`/leaderboard/weekly${q}`).then(setWeekly).catch((e) => setErr(e.message));
  }, [date]);
  const ref = date || daily?.date || new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Leaderboards & exports</h1>
      <Card title="Date"><Field label="Exam date, or any date in the week (blank = today)"><input type="date" className={`${input} max-w-xs`} value={date} onChange={(e) => setDate(e.target.value)} /></Field></Card>
      {err && <StateBox kind="error">{err}</StateBox>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Daily ${daily?.date ?? ""}`} actions={<a className={btn2} href={`/api/admin/export/daily?date=${ref}`}>Download CSV</a>}>
          <ul className="divide-y divide-white/10 text-sm">{(daily?.rows ?? []).map((r: Row, i: number) => <li key={i} className="flex justify-between py-1.5"><span>{r.rank}. {r.display_name}</span><span className="tabular-nums">{r.total_score} · {fmtDuration(r.duration_seconds)}</span></li>)}</ul>
          {daily && daily.rows.length === 0 && <p className="text-sm text-slate-300">No results.</p>}
        </Card>
        <Card title={`Weekly ${weekly?.week_start ?? ""} to ${weekly?.week_end ?? ""}`} actions={<a className={btn2} href={`/api/admin/export/weekly?date=${ref}`}>Download CSV</a>}>
          <ul className="divide-y divide-white/10 text-sm">{(weekly?.rows ?? []).map((r: Row, i: number) => <li key={i} className="flex justify-between py-1.5"><span>{r.rank}. {r.display_name}</span><span className="tabular-nums">{r.weekly_total}/2800 ({r.weekly_percentage}%)</span></li>)}</ul>
          {weekly && weekly.rows.length === 0 && <p className="text-sm text-slate-300">No results.</p>}
        </Card>
      </div>
      <Card title="Backups and full exports">
        <p className="text-sm text-slate-300">Download these regularly and keep them somewhere safe. They contain personal data: do not share them publicly. They never contain passwords, recovery codes or answer keys.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {can("participants.read") && <a className={btn2} href="/api/admin/export/participants">All participants (CSV)</a>}
          <a className={btn2} href="/api/admin/export/results">All results (CSV)</a>
          {can("questions.read") && <a className={btn2} href="/api/admin/questions/export">Question bank incl. answers (CSV)</a>}
        </div>
        <p className="mt-3 text-xs text-slate-400">A complete database backup is made with Cloudflare's tools; see the README (“Backups”).</p>
      </Card>
    </div>
  );
}
