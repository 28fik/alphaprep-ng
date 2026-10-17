import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import StateBox from "../components/StateBox";
import SubjectPicker from "../components/SubjectPicker";
import { api, ApiError, saveAttempt, type ParticipantProfile, type PublicStatus } from "../lib/api";
import { PARTICIPANT_ID_PATTERN } from "../lib/constants";

type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "verify" }
  | { kind: "profile"; profile: ParticipantProfile };

export default function Continue() {
  const [params] = useSearchParams();
  const id = (params.get("id") ?? "").toUpperCase();
  const valid = PARTICIPANT_ID_PATTERN.test(id);

  const [view, setView] = useState<View>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const navigate = useNavigate();
  const [needShare, setNeedShare] = useState(false);
  const [shared, setShared] = useState(false);
  const [site, setSite] = useState<PublicStatus | null>(null);
  const [startError, setStartError] = useState("");

  useEffect(() => { api<PublicStatus>("/status").then(setSite).catch(() => undefined); }, []);

  async function startExam() {
    setStartError("");
    setBusy(true);
    try {
      const r = await api<{ attempt_id: number; attempt_token: string }>("/exam/start", {
        method: "POST",
        body: JSON.stringify({ id, share_confirmed: shared }),
      });
      saveAttempt({ id: r.attempt_id, token: r.attempt_token, pid: id });
      navigate("/exam");
    } catch (err) {
      const e = err as ApiError;
      if (e.data?.needs_share) setNeedShare(true);
      setStartError(e.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    api<ParticipantProfile>("/participants/lookup", { method: "POST", body: JSON.stringify({ id }) })
      .then((p) => alive && setView(p.trusted ? { kind: "profile", profile: p } : { kind: "verify" }))
      .catch((e: ApiError) => alive && setView({ kind: "error", message: e.message }));
    return () => { alive = false; };
  }, [id, valid]);

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    setFormError("");
    setBusy(true);
    try {
      const p = await api<ParticipantProfile>("/participants/verify", {
        method: "POST",
        body: JSON.stringify({ id, recovery_code: code }),
      });
      setView({ kind: "profile", profile: p });
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSubjects() {
    setFormError("");
    setSaved(false);
    setBusy(true);
    try {
      const p = await api<ParticipantProfile>("/participants/subjects", {
        method: "PUT",
        body: JSON.stringify({ id, subjects: picked }),
      });
      setView({ kind: "profile", profile: p });
      setEditing(false);
      setSaved(true);
    } catch (err: any) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!valid) {
    return (
      <Shell>
        <StateBox kind="error">That ID is not in the correct format.</StateBox>
      </Shell>
    );
  }

  if (view.kind === "loading") {
    return <Shell><StateBox kind="loading">Checking your Participant ID…</StateBox></Shell>;
  }
  if (view.kind === "error") {
    return <Shell><StateBox kind="error">{view.message}</StateBox></Shell>;
  }

  if (view.kind === "verify") {
    return (
      <Shell>
        <p className="text-sm text-slate-300">
          This phone isn't linked to <strong className="text-white">{id}</strong> yet. Enter the Recovery Code you were
          given when you registered.
        </p>
        <form onSubmit={onVerify} className="mt-4 rounded-2xl border border-white/15 bg-brand-navy-2 p-5" noValidate>
          <label htmlFor="rc" className="text-sm font-medium">Recovery Code</label>
          <input
            id="rc" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())}
            autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={9} placeholder="ABCD-EFGH"
            className="mt-1 w-full rounded-xl border border-white/25 bg-brand-navy px-4 py-3 text-lg font-semibold tracking-widest"
          />
          {formError && <div className="mt-3"><StateBox kind="error">{formError}</StateBox></div>}
          <button disabled={busy} className="mt-4 w-full rounded-xl bg-brand-blue px-4 py-3 font-bold text-brand-navy disabled:opacity-60">
            {busy ? "Checking…" : "CONFIRM"}
          </button>
        </form>
        <p className="mt-4 text-sm text-slate-300">
          Lost your code? Contact AlphaPrep NG support through our official channels so an administrator can help.
        </p>
      </Shell>
    );
  }

  const { profile } = view;
  const p = profile.participant!;
  const elig = profile.eligibility!;
  const policy = profile.subject_change!;

  return (
    <Shell>
      <section className="rounded-2xl border border-white/15 bg-brand-navy-2 p-5">
        <p className="text-sm text-slate-300">Welcome back</p>
        <p className="text-xl font-bold">{p.first_name} {p.last_initial}.</p>
        <p className="mt-1 text-sm text-slate-300">ID: {p.id}</p>

        <h2 className="mt-5 text-sm font-semibold uppercase tracking-wider text-brand-blue">Your subjects</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {profile.subjects!.map((s) => <li key={s.id}>• {s.name}</li>)}
        </ul>
        {saved && <div className="mt-3"><StateBox kind="success">Subjects updated.</StateBox></div>}

        {!editing ? (
          <div className="mt-3">
            {policy.allowed ? (
              <button type="button" onClick={() => { setPicked(profile.subjects!.filter((s) => s.id !== "english").map((s) => s.id)); setEditing(true); setSaved(false); }}
                className="text-sm font-semibold text-brand-blue underline underline-offset-2">
                Change subjects
              </button>
            ) : (
              <p className="text-sm text-amber-200">{policy.reason}</p>
            )}
            {policy.allowed && policy.deadline && (
              <p className="mt-1 text-xs text-slate-400">
                You can change subjects until {new Date(policy.deadline).toLocaleString()}.
              </p>
            )}
          </div>
        ) : (
          <div className="mt-4">
            <SubjectPicker value={picked} onChange={setPicked} />
            {formError && <div className="mt-3"><StateBox kind="error">{formError}</StateBox></div>}
            <div className="mt-3 flex gap-3">
              <button type="button" disabled={busy || picked.length !== 3} onClick={saveSubjects}
                className="rounded-xl bg-brand-blue px-4 py-3 font-bold text-brand-navy disabled:opacity-50">
                {busy ? "Saving…" : "Save subjects"}
              </button>
              <button type="button" onClick={() => { setEditing(false); setFormError(""); }}
                className="rounded-xl border border-white/30 px-4 py-3 font-semibold">Cancel</button>
            </div>
          </div>
        )}
      </section>

      <section className="mt-5 rounded-2xl border border-white/15 bg-brand-navy-2 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-brand-blue">Today's examination</h2>
        <p className="mt-2 text-sm">
          {elig.exam ? `${elig.exam.title} · ${elig.exam.exam_date}` : "No examination scheduled."}
        </p>
        {elig.reason && <p className="mt-1 text-sm text-slate-300">{elig.reason}</p>}
        {elig.can_start && !elig.in_progress && (
          <div className="mt-4 rounded-xl border border-amber-300/40 bg-amber-950/30 p-3 text-sm text-amber-100">
            <p className="font-semibold">Before you start</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              <li>180 questions in 120 minutes. The timer is kept by the server and cannot be paused.</li>
              <li>Do not leave this page, switch apps or lock your phone: that can submit your exam automatically.</li>
              <li>You get one official attempt per day. Answers save automatically.</li>
            </ul>
          </div>
        )}
        {needShare && (
          <div className="mt-4 rounded-xl border border-white/20 bg-brand-navy p-3 text-sm">
            <p className="font-semibold">Share to unlock today's exam</p>
            <p className="mt-1 text-slate-300">Share AlphaPrep NG with your friends on WhatsApp, then confirm below.</p>
            <a
              target="_blank" rel="noopener noreferrer"
              href={`https://wa.me/?text=${encodeURIComponent(`${site?.settings?.whatsapp_share_message ?? "Join me on the AlphaPrep NG daily UTME mock exam:"} ${site?.settings?.site_url || window.location.origin}`)}`}
              className="mt-2 inline-block rounded-lg bg-emerald-500 px-4 py-2 font-semibold text-brand-navy"
            >
              Share on WhatsApp
            </a>
            <label className="mt-3 flex items-start gap-2">
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="mt-1 h-5 w-5 accent-[#2d9cf1]" />
              <span>I have shared it. <span className="text-xs text-slate-400">(We cannot check whether a message was sent; this is on your honour.)</span></span>
            </label>
          </div>
        )}
        {startError && <div className="mt-3"><StateBox kind="error">{startError}</StateBox></div>}
        <button
          disabled={!elig.can_start || busy || (needShare && !shared)}
          onClick={startExam}
          className="mt-4 w-full rounded-xl bg-brand-blue px-4 py-3 font-bold text-brand-navy disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-300"
        >
          {busy ? "Starting…" : elig.in_progress ? "RESUME EXAM" : "START EXAM"}
        </button>
        {elig.already_attempted && !elig.in_progress && (
          <p className="mt-3 text-sm">
            <Link className="font-semibold text-brand-blue underline" to={`/result?id=${p.id}`}>View my result</Link>
          </p>
        )}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <h1 className="mb-5 text-2xl font-bold">Confirm your details</h1>
      {children}
      <Link to="/start" className="mt-6 inline-block text-sm text-brand-blue underline">Use a different ID</Link>
    </div>
  );
}
