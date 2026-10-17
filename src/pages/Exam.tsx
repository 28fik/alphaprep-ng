import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ResultCard from "../components/ResultCard";
import StateBox from "../components/StateBox";
import { api, ApiError, fmtDuration, loadAttempt, saveAttempt, type ExamResult, type StoredAttempt } from "../lib/api";

interface Q {
  id: number;
  subject_id: string;
  subject_name: string;
  position: number;
  text: string;
  options: Record<"A" | "B" | "C" | "D", string>;
}
interface Paper {
  finished: boolean;
  deadline_at: string;
  server_now: string;
  tab_hidden_policy: "auto_submit" | "warn" | "off";
  answers: Record<string, string>;
  questions: Q[];
}

type Phase = "loading" | "ready" | "submitting" | "done" | "error";
const LETTERS = ["A", "B", "C", "D"] as const;
const SAVE_EVERY_MS = 10_000;

export default function Exam() {
  const navigate = useNavigate();
  const attempt = useMemo<StoredAttempt | null>(() => loadAttempt(), []);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [paper, setPaper] = useState<Paper | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [idx, setIdx] = useState(0);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "offline">("saved");
  const [confirming, setConfirming] = useState(false);
  const [warn, setWarn] = useState(false);
  const [result, setResult] = useState<ExamResult | null>(null);
  const [submitNote, setSubmitNote] = useState("");

  const offset = useRef(0); // server time minus device time, so the countdown follows the SERVER clock
  const pending = useRef<Record<string, string | null>>({});
  const saving = useRef(false);
  const submitted = useRef(false);
  const headers = useCallback(() => ({ "X-Attempt-Token": attempt?.token ?? "" }), [attempt]);

  // ---- load the paper -------------------------------------------------------------------------
  useEffect(() => {
    if (!attempt) { setError("No exam in progress on this device. Open the Continue page to resume."); setPhase("error"); return; }
    let alive = true;
    api<Paper>(`/exam/${attempt.id}/paper`, { headers: headers() })
      .then(async (p) => {
        if (!alive) return;
        if (p.finished) { await showResult(); return; }
        offset.current = Date.parse(p.server_now) - Date.now();
        setPaper(p);
        setAnswers(p.answers);
        setPhase("ready");
      })
      .catch((e: ApiError) => { if (alive) { setError(e.message); setPhase("error"); } });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function showResult() {
    submitted.current = true;
    try {
      const r = await api<{ result: ExamResult | null }>("/me/result", { method: "POST", body: JSON.stringify({ id: attempt!.pid }) });
      setResult(r.result);
    } catch { /* the result page can be opened later */ }
    saveAttempt(null);
    setPhase("done");
  }

  // ---- autosave (answers are sent as small changes, not the whole paper) -----------------------------
  const flush = useCallback(async () => {
    if (!attempt || saving.current || Object.keys(pending.current).length === 0 || submitted.current) return;
    const batch = pending.current;
    pending.current = {};
    saving.current = true;
    setSaveState("saving");
    try {
      await api(`/exam/${attempt.id}/answers`, { method: "PUT", headers: headers(), body: JSON.stringify({ answers: batch }) });
      setSaveState(Object.keys(pending.current).length ? "saving" : "saved");
    } catch (e) {
      const err = e as ApiError;
      pending.current = { ...batch, ...pending.current }; // keep unsent answers, newer ones win
      if (err.status === 409 && !submitted.current) { await showResult(); }
      else setSaveState("offline");
    } finally {
      saving.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, headers]);

  useEffect(() => {
    if (phase !== "ready") return;
    const t = setInterval(flush, SAVE_EVERY_MS);
    return () => clearInterval(t);
  }, [phase, flush]);

  function choose(q: Q, letter: string) {
    setAnswers((a) => (a[q.id] === letter ? a : { ...a, [q.id]: letter }));
    pending.current[String(q.id)] = letter;
    setSaveState("saving");
  }
  function clear(q: Q) {
    setAnswers((a) => { const n = { ...a }; delete n[q.id]; return n; });
    pending.current[String(q.id)] = null;
    setSaveState("saving");
  }

  // ---- submit -------------------------------------------------------------------------------------
  const submit = useCallback(async (reason: "manual" | "tab_hidden" | "timeout", keepalive = false) => {
    if (!attempt || submitted.current) return;
    submitted.current = true;
    setPhase("submitting");
    setConfirming(false);
    try {
      const body = { answers: pending.current, reason };
      const r = await api<{ result: ExamResult | null }>(`/exam/${attempt.id}/submit`, { method: "POST", headers: headers(), body: JSON.stringify(body), keepalive });
      pending.current = {};
      setResult(r.result);
      if (reason !== "manual") setSubmitNote(reason === "timeout" ? "Time was up, so your exam was submitted automatically." : "Your exam was submitted because the exam page was left or hidden.");
      saveAttempt(null);
      setPhase("done");
    } catch (e) {
      submitted.current = false;
      setError((e as ApiError).message + " Your answers are saved on the server. Try again.");
      setPhase("ready");
    }
  }, [attempt, headers]);

  // ---- countdown (server clock) -----------------------------------------------------------------------
  useEffect(() => {
    if (!paper || phase !== "ready") return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((Date.parse(paper.deadline_at) - (Date.now() + offset.current)) / 1000));
      setRemaining(left);
      if (left <= 0) void submit("timeout");
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [paper, phase, submit]);

  // ---- leaving the page ----------------------------------------------------------------------------------
  useEffect(() => {
    if (phase !== "ready" || !paper) return;
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        if (paper.tab_hidden_policy === "auto_submit") void submit("tab_hidden", true);
        else if (paper.tab_hidden_policy === "warn") setWarn(true);
      }
    };
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("beforeunload", onUnload);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("beforeunload", onUnload); };
  }, [phase, paper, submit]);

  // ---- keyboard: A-D answer, arrows move ------------------------------------------------------------------
  useEffect(() => {
    if (phase !== "ready" || !paper) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "TEXTAREA" || (tag === "INPUT" && (e.target as HTMLInputElement).type !== "radio")) return;
      const q = paper.questions[idx];
      const k = e.key.toUpperCase();
      if ((LETTERS as readonly string[]).includes(k) && !e.ctrlKey && !e.metaKey && !e.altKey) { choose(q, k); }
      else if (e.key === "ArrowRight") setIdx((i) => Math.min(paper.questions.length - 1, i + 1));
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, paper, idx]);

  // ---- render ------------------------------------------------------------------------------------------------
  if (phase === "loading") return <Wrap><StateBox kind="loading">Loading your exam…</StateBox></Wrap>;
  if (phase === "error" && !paper) {
    return (
      <Wrap>
        <StateBox kind="error">{error}</StateBox>
        <Link to="/start" className="mt-4 inline-block text-sm font-semibold text-brand-blue underline">Go to Start</Link>
      </Wrap>
    );
  }
  if (phase === "submitting") return <Wrap><StateBox kind="loading">Submitting your exam…</StateBox></Wrap>;
  if (phase === "done") {
    return (
      <Wrap>
        <h1 className="text-2xl font-bold">Exam submitted</h1>
        {submitNote && <div className="mt-3"><StateBox kind="success">{submitNote}</StateBox></div>}
        <div className="mt-4">
          {result ? <ResultCard result={result} pid={attempt?.pid ?? ""} /> : <StateBox kind="success">Your exam was submitted. Open the Continue page to see your result.</StateBox>}
        </div>
        <button onClick={() => navigate("/")} className="mt-5 rounded-xl border border-white/30 px-5 py-3 font-semibold">Back to home</button>
      </Wrap>
    );
  }

  const p = paper!;
  const q = p.questions[idx];
  const answered = Object.keys(answers).length;
  const sections: { id: string; name: string; start: number; count: number }[] = [];
  p.questions.forEach((x, i) => {
    const last = sections[sections.length - 1];
    if (last && last.id === x.subject_id) last.count++;
    else sections.push({ id: x.subject_id, name: x.subject_name, start: i, count: 1 });
  });
  const low = (remaining ?? 9999) <= 300;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-24 pt-4">
      <div className="sticky top-[57px] z-30 -mx-4 flex items-center justify-between gap-3 border-b border-white/10 bg-brand-navy/95 px-4 py-2 backdrop-blur">
        <p className="text-sm"><span className="font-semibold">{answered}</span> of {p.questions.length} answered</p>
        <p className={`rounded-lg px-3 py-1 text-lg font-bold tabular-nums ${low ? "bg-rose-600" : "bg-brand-navy-3"}`} role="timer" aria-label="Time remaining">
          {remaining === null ? "--:--" : fmtDuration(remaining)}
        </p>
        <p className={`text-xs ${saveState === "offline" ? "text-amber-300" : "text-slate-300"}`} aria-live="polite">
          {saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : "Offline: will retry"}
        </p>
      </div>

      {warn && <div className="mt-3"><StateBox kind="error">You left this page. Staying on the exam page is required; leaving again may be recorded.</StateBox></div>}
      {error && <div className="mt-3"><StateBox kind="error">{error}</StateBox></div>}

      <nav aria-label="Subjects" className="mt-4 flex gap-2 overflow-x-auto pb-1">
        {sections.map((s) => {
          const active = idx >= s.start && idx < s.start + s.count;
          return (
            <button key={s.id} onClick={() => setIdx(s.start)} aria-current={active}
              className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ${active ? "bg-brand-blue text-brand-navy" : "bg-brand-navy-2 text-slate-200"}`}>
              {s.name}
            </button>
          );
        })}
      </nav>

      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_16rem]">
        <section aria-labelledby="qtitle" className="rounded-2xl border border-white/15 bg-brand-navy-2 p-4 md:p-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-blue">{q.subject_name} · Question {q.position}</p>
          <h2 id="qtitle" className="mt-2 whitespace-pre-line text-lg font-medium leading-relaxed">{q.text}</h2>
          <fieldset className="mt-4 space-y-2">
            <legend className="sr-only">Choose one answer</legend>
            {LETTERS.map((l) => (
              <label key={l} className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 ${answers[q.id] === l ? "border-brand-blue bg-brand-navy-3" : "border-white/15 hover:bg-brand-navy-3/50"}`}>
                <input type="radio" name={`q${q.id}`} value={l} checked={answers[q.id] === l} onChange={() => choose(q, l)} className="mt-1 h-5 w-5 accent-[#2d9cf1]" />
                <span><strong className="mr-2">{l}.</strong>{q.options[l]}</span>
              </label>
            ))}
          </fieldset>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} className="rounded-xl border border-white/30 px-5 py-3 font-semibold disabled:opacity-40">Previous</button>
            {answers[q.id] && <button onClick={() => clear(q)} className="text-sm text-slate-300 underline">Clear answer</button>}
            <button onClick={() => setIdx((i) => Math.min(p.questions.length - 1, i + 1))} disabled={idx === p.questions.length - 1} className="rounded-xl bg-brand-blue px-5 py-3 font-bold text-brand-navy disabled:opacity-40">Next</button>
          </div>
          <p className="mt-3 text-xs text-slate-400">Shortcuts: press A, B, C or D to answer; use the left and right arrow keys to move.</p>
        </section>

        <aside aria-label="Question palette" className="rounded-2xl border border-white/15 bg-brand-navy-2 p-3">
          {sections.map((s) => (
            <div key={s.id} className="mb-3">
              <p className="mb-1 text-xs font-semibold text-slate-300">{s.name}</p>
              <div className="grid grid-cols-8 gap-1 md:grid-cols-6">
                {p.questions.slice(s.start, s.start + s.count).map((x, j) => {
                  const i = s.start + j;
                  const a = !!answers[x.id];
                  return (
                    <button key={x.id} onClick={() => setIdx(i)} aria-label={`Question ${x.position}${a ? ", answered" : ", not answered"}`} aria-current={i === idx}
                      className={`h-8 rounded text-xs font-semibold ${i === idx ? "ring-2 ring-white" : ""} ${a ? "bg-brand-blue text-brand-navy" : "bg-brand-navy text-slate-300"}`}>
                      {x.position}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-white/10 bg-brand-navy/95 p-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl justify-end">
          <button onClick={() => setConfirming(true)} className="rounded-xl bg-emerald-500 px-6 py-3 font-bold text-brand-navy hover:bg-emerald-400">SUBMIT EXAM</button>
        </div>
      </div>

      {confirming && (
        <div role="dialog" aria-modal="true" aria-labelledby="cf" className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/20 bg-brand-navy-2 p-5">
            <h2 id="cf" className="text-lg font-bold">Submit your exam?</h2>
            <p className="mt-2 text-sm text-slate-200">
              You have answered {answered} of {p.questions.length} questions.
              {answered < p.questions.length && ` ${p.questions.length - answered} are unanswered and will score zero.`} You cannot change anything after submitting.
            </p>
            <div className="mt-4 flex gap-3">
              <button autoFocus onClick={() => setConfirming(false)} className="flex-1 rounded-xl border border-white/30 px-4 py-3 font-semibold">Keep working</button>
              <button onClick={() => void submit("manual")} className="flex-1 rounded-xl bg-emerald-500 px-4 py-3 font-bold text-brand-navy">Submit now</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Wrap({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-xl px-4 py-8">{children}</div>;
}
