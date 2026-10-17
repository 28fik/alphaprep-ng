import { Link } from "react-router-dom";
import { fmtDuration, type ExamResult } from "../lib/api";

export default function ResultCard({ result, pid }: { result: ExamResult; pid: string }) {
  const released = result.corrections_release_at ? Date.parse(result.corrections_release_at) <= Date.now() : false;
  return (
    <section aria-label="Your result" className="rounded-2xl border border-white/15 bg-brand-navy-2 p-5">
      <p className="text-sm text-slate-300">Exam of {result.exam_date}</p>
      <p className="mt-1 text-5xl font-bold text-brand-blue">
        {result.total_score}
        <span className="text-xl font-semibold text-slate-300"> / {result.max_score}</span>
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl bg-brand-navy p-3">
          <dt className="text-slate-300">Daily rank</dt>
          <dd className="text-lg font-bold">{result.daily_rank ? `#${result.daily_rank}` : "Not ranked"}{result.daily_rank ? <span className="text-sm font-normal text-slate-300"> of {result.participants_ranked}</span> : null}</dd>
        </div>
        <div className="rounded-xl bg-brand-navy p-3">
          <dt className="text-slate-300">Time used</dt>
          <dd className="text-lg font-bold tabular-nums">{fmtDuration(result.duration_seconds)}</dd>
        </div>
      </dl>
      <h2 className="mt-5 text-sm font-semibold uppercase tracking-wider text-brand-blue">By subject</h2>
      <ul className="mt-2 space-y-3">
        {result.subjects.map((s) => (
          <li key={s.subject_id}>
            <div className="flex justify-between text-sm">
              <span>{s.name}</span>
              <span className="font-semibold tabular-nums">{s.score} / 100 <span className="font-normal text-slate-300">({s.correct_count}/{s.question_count})</span></span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-brand-navy" role="img" aria-label={`${s.name}: ${s.score} out of 100`}>
              <div className="h-full rounded-full bg-brand-blue" style={{ width: `${Math.min(100, s.score)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-5 rounded-xl border border-white/15 p-3 text-sm">
        {released ? (
          <Link className="font-semibold text-brand-blue underline" to={`/corrections?id=${pid}&date=${result.exam_date}`}>See corrections and explanations</Link>
        ) : (
          <p className="text-slate-300">
            Correct answers and explanations are released
            {result.corrections_release_at ? ` on ${new Date(result.corrections_release_at).toLocaleString()}` : " later"}.
          </p>
        )}
      </div>
      <Link to="/leaderboard" className="mt-4 inline-block text-sm font-semibold text-brand-blue underline">View leaderboards</Link>
    </section>
  );
}
