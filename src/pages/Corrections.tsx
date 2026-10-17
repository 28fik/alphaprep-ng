import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import StateBox from "../components/StateBox";
import { api, ApiError } from "../lib/api";
import { subjectName } from "../lib/constants";

interface CQ {
  id: number; subject_id: string; position: number; text: string; options: Record<string, string>;
  your_answer: string | null; correct_option: string; explanation: string | null; is_correct: boolean;
}

export default function Corrections() {
  const [params] = useSearchParams();
  const id = (params.get("id") ?? "").toUpperCase();
  const date = params.get("date") ?? "";
  const [qs, setQs] = useState<CQ[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"all" | "wrong">("all");

  useEffect(() => {
    let alive = true;
    api<{ questions: CQ[] }>("/me/corrections", { method: "POST", body: JSON.stringify({ id, date }) })
      .then((r) => alive && setQs(r.questions))
      .catch((e: ApiError) => {
        if (!alive) return;
        setError(e.data?.release_at ? `${e.message} They will be available on ${new Date(e.data.release_at).toLocaleString()}.` : e.message);
      });
    return () => { alive = false; };
  }, [id, date]);

  const shown = (qs ?? []).filter((q) => filter === "all" || !q.is_correct);
  const groups = shown.reduce<Record<string, CQ[]>>((g, q) => { (g[q.subject_id] ??= []).push(q); return g; }, {});

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold">Corrections · {date}</h1>
      {error ? <div className="mt-4"><StateBox kind="error">{error}</StateBox></div> : !qs ? <div className="mt-4"><StateBox kind="loading">Loading corrections…</StateBox></div> : (
        <>
          <div className="mt-4 flex gap-2" role="group" aria-label="Filter">
            {(["all", "wrong"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${filter === f ? "bg-brand-blue text-brand-navy" : "bg-brand-navy-2"}`}>
                {f === "all" ? "All questions" : "Only ones I missed"}
              </button>
            ))}
          </div>
          {Object.entries(groups).map(([sid, list]) => (
            <section key={sid} className="mt-6">
              <h2 className="text-lg font-bold text-brand-blue">{subjectName(sid)}</h2>
              <ol className="mt-3 space-y-4">
                {list.map((q) => (
                  <li key={q.id} className="rounded-2xl border border-white/15 bg-brand-navy-2 p-4">
                    <p className="whitespace-pre-line font-medium"><span className="mr-2 text-slate-300">{q.position}.</span>{q.text}</p>
                    <ul className="mt-3 space-y-1 text-sm">
                      {Object.entries(q.options).map(([l, t]) => {
                        const right = l === q.correct_option, mine = l === q.your_answer;
                        return (
                          <li key={l} className={`rounded-lg px-3 py-2 ${right ? "bg-emerald-900/60 ring-1 ring-emerald-400" : mine ? "bg-rose-900/50 ring-1 ring-rose-400" : "bg-brand-navy"}`}>
                            <strong>{l}.</strong> {t}
                            {right && <span className="ml-2 text-xs font-semibold text-emerald-300">Correct answer</span>}
                            {mine && !right && <span className="ml-2 text-xs font-semibold text-rose-300">Your answer</span>}
                            {mine && right && <span className="ml-2 text-xs font-semibold text-emerald-300">(your answer)</span>}
                          </li>
                        );
                      })}
                    </ul>
                    {!q.your_answer && <p className="mt-2 text-xs text-amber-300">You did not answer this question.</p>}
                    {q.explanation && <p className="mt-3 whitespace-pre-line rounded-lg bg-brand-navy p-3 text-sm text-slate-200"><strong>Explanation:</strong> {q.explanation}</p>}
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {shown.length === 0 && <div className="mt-6"><StateBox kind="empty">Nothing to show here.</StateBox></div>}
        </>
      )}
      <Link to={`/continue?id=${id}`} className="mt-8 inline-block text-sm text-brand-blue underline">Back</Link>
    </div>
  );
}
