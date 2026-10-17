import { useEffect, useState } from "react";
import StateBox from "../components/StateBox";
import { api, fmtDuration, type LeaderboardRow } from "../lib/api";

interface Daily { date: string; total: number; rows: LeaderboardRow[] }
interface Weekly { week_start: string; week_end: string; total: number; max_score: number; rows: LeaderboardRow[] }

export default function Leaderboard() {
  const [tab, setTab] = useState<"daily" | "weekly">("daily");
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState("");
  const [daily, setDaily] = useState<Daily | null>(null);
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => { api<{ dates: string[] }>("/leaderboard/dates").then((r) => setDates(r.dates)).catch(() => undefined); }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    const q = date ? `?date=${date}&limit=100` : "?limit=100";
    api<Daily | Weekly>(`/leaderboard/${tab}${q}`)
      .then((r) => { if (!alive) return; if (tab === "daily") setDaily(r as Daily); else setWeekly(r as Weekly); })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [tab, date]);

  const data = tab === "daily" ? daily : weekly;
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold">Leaderboards</h1>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div role="tablist" aria-label="Leaderboard type" className="flex gap-2">
          {(["daily", "weekly"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
              className={`rounded-lg px-4 py-2 text-sm font-semibold ${tab === t ? "bg-brand-blue text-brand-navy" : "bg-brand-navy-2"}`}>
              {t === "daily" ? "Daily (out of 400)" : "Weekly (out of 2,800)"}
            </button>
          ))}
        </div>
        <label className="text-sm">
          <span className="mr-2 text-slate-300">{tab === "daily" ? "Exam date" : "Any date in the week"}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} list="known-dates" className="rounded-lg border border-white/25 bg-brand-navy px-3 py-2" />
          <datalist id="known-dates">{dates.map((d) => <option key={d} value={d} />)}</datalist>
        </label>
        {date && <button onClick={() => setDate("")} className="text-sm text-brand-blue underline">Today</button>}
      </div>

      <p className="mt-3 text-sm text-slate-300">
        {tab === "daily" ? `Results for ${daily?.date ?? "today"}.` : weekly ? `Week ${weekly.week_start} to ${weekly.week_end} (Monday to Sunday). A missed day counts as 0.` : ""}
        {" "}Participants with the same score share a rank.
      </p>

      <div className="mt-4">
        {loading ? <StateBox kind="loading">Loading rankings…</StateBox> : error ? <StateBox kind="error">{error}</StateBox> : !data || data.rows.length === 0 ? (
          <StateBox kind="empty">No results for this {tab === "daily" ? "day" : "week"} yet.</StateBox>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-white/15 bg-brand-navy-2">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">{tab} leaderboard</caption>
              <thead className="text-xs uppercase tracking-wider text-slate-300">
                <tr><th scope="col" className="px-4 py-3">Rank</th><th scope="col" className="px-4 py-3">Name</th>
                  <th scope="col" className="px-4 py-3 text-right">{tab === "daily" ? "Score" : "Total"}</th>
                  <th scope="col" className="px-4 py-3 text-right">{tab === "daily" ? "Time" : "Exams"}</th></tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {data.rows.map((r, i) => (
                  <tr key={`${r.rank}-${i}`}>
                    <td className="px-4 py-2 font-bold text-brand-blue">{r.rank}</td>
                    <td className="px-4 py-2">{r.display_name}</td>
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{tab === "daily" ? r.total_score : `${r.weekly_total} (${r.weekly_percentage}%)`}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{tab === "daily" ? fmtDuration(r.duration_seconds ?? 0) : r.exams_taken}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
