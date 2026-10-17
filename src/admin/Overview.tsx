import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import StateBox from "../components/StateBox";
import { Card } from "../components/ui";
import { api } from "../lib/api";
import { useAdmin } from "./AdminShell";

export default function Overview() {
  const { can } = useAdmin();
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api<Record<string, any>>("/admin/overview").then(setD).catch((e) => setErr(e.message)); }, []);
  if (err) return <StateBox kind="error">{err}</StateBox>;
  if (!d) return <StateBox kind="loading">Loading overview…</StateBox>;
  const tiles: [string, number][] = [
    ["Participants", d.participants], ["Taking exam now", d.in_progress_now], ["Attempts today", d.attempts_today], ["Results today", d.results_today],
    ["Usable questions", d.questions_usable], ["Questions without an answer", d.questions_missing_key], ["Suspended", d.participants_suspended],
  ];
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Overview</h1>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map(([k, v]) => (
          <li key={k} className="rounded-2xl border border-white/15 bg-brand-navy-2 p-4">
            <p className="text-2xl font-bold text-brand-blue tabular-nums">{v}</p>
            <p className="text-xs text-slate-300">{k}</p>
          </li>
        ))}
      </ul>
      <Card title="Upcoming exams">
        {d.upcoming_exams.length === 0 ? <p className="text-sm text-slate-300">No exams scheduled. {can("exams.write") && <Link className="text-brand-blue underline" to="/admin/exams">Create one</Link>}</p> : (
          <ul className="divide-y divide-white/10 text-sm">
            {d.upcoming_exams.map((e: any) => <li key={e.id} className="flex justify-between py-2"><Link className="text-brand-blue underline" to={`/admin/exams/${e.id}`}>{e.exam_date} · {e.title}</Link><span>{e.status}</span></li>)}
          </ul>
        )}
      </Card>
      <Card title="Free-tier reminder">
        <p className="text-sm text-slate-300">Cloudflare Free allows about 100,000 requests a day and 100,000 database row writes a day. Each exam answer save is one write, so a few hundred participants a day is comfortable; thousands may hit the daily limit (it resets at 00:00 UTC). See the README for details.</p>
      </Card>
    </div>
  );
}
