import { useState, type FormEvent } from "react";
import StateBox from "../components/StateBox";
import { api } from "../lib/api";
import SubjectPicker from "../components/SubjectPicker";

interface Form {
  first_name: string;
  last_name: string;
  target_score: string;
  intended_course: string;
  preferred_institution: string;
  gender: "" | "male" | "female";
  subjects: string[];
}

const EMPTY: Form = {
  first_name: "", last_name: "", target_score: "", intended_course: "",
  preferred_institution: "", gender: "", subjects: [],
};

const inputCls =
  "mt-1 w-full rounded-xl border border-white/25 bg-brand-navy px-4 py-3 text-base text-white placeholder:text-slate-500 focus:border-brand-blue";

export default function Register() {
  const [f, setF] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState("");
  const [newId, setNewId] = useState("");
  const [recovery, setRecovery] = useState("");
  const [website, setWebsite] = useState(""); // honeypot, must stay empty
  const [copied, setCopied] = useState(false);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));

  function validate() {
    const e: Record<string, string> = {};
    if (!f.first_name.trim()) e.first_name = "Enter your first name.";
    if (!f.last_name.trim()) e.last_name = "Enter your last name.";
    const t = Number(f.target_score);
    if (!Number.isInteger(t) || t < 100 || t > 400) e.target_score = "Enter a target score between 100 and 400.";
    if (!f.intended_course.trim()) e.intended_course = "Enter your intended course.";
    if (!f.preferred_institution.trim()) e.preferred_institution = "Enter your preferred institution.";
    if (!f.gender) e.gender = "Select a gender.";
    if (f.subjects.length !== 3) e.subjects = "Select exactly three subjects (English is added automatically).";
    return e;
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setServerError("");
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    try {
      const res = await api<{ participant_id: string; recovery_code: string }>("/participants", {
        method: "POST",
        body: JSON.stringify({ ...f, target_score: Number(f.target_score), website }),
      });
      setNewId(res.participant_id);
      setRecovery(res.recovery_code);
    } catch (err: any) {
      if (err.fields) setErrors(err.fields);
      setServerError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(newId);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (newId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-10">
        <StateBox kind="success">Registration complete.</StateBox>
        <div className="mt-6 rounded-2xl border border-brand-blue/50 bg-brand-navy-2 p-6 text-center">
          <p className="text-sm text-slate-300">Your Participant ID</p>
          <p className="mt-2 text-4xl font-bold tracking-widest text-brand-blue" data-testid="new-id">{newId}</p>
          <button type="button" onClick={copy}
            className="mt-5 w-full rounded-xl bg-brand-blue px-4 py-3 font-bold text-brand-navy hover:bg-brand-blue-dark">
            {copied ? "Copied ✓" : "Copy ID"}
          </button>
        </div>
        <div className="mt-4 rounded-2xl border border-white/20 bg-brand-navy-2 p-5 text-center">
          <p className="text-sm text-slate-300">Your Recovery Code (shown only once)</p>
          <p className="mt-2 text-2xl font-bold tracking-widest" data-testid="recovery-code">{recovery}</p>
          <p className="mt-2 text-xs text-slate-300">
            You need this code if you use a different phone or clear your browser data.
          </p>
        </div>
        <p className="mt-5 rounded-xl border border-amber-300/50 bg-amber-950/30 p-4 text-sm text-amber-100">
          Save both the ID and the Recovery Code now (screenshot them or write them down). You will need the ID for every
          future examination. Don't share or post them: anyone with both can act as you.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <h1 className="text-2xl font-bold">Generate your Participant ID</h1>
      <p className="mt-2 text-sm text-slate-300">No email or password required. You'll get a unique ID after this form.</p>

      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-5">
        <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label htmlFor="website">Leave this field empty</label>
          <input id="website" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label htmlFor="fn" className="text-sm font-medium">First name</label>
            <input id="fn" className={inputCls} value={f.first_name} onChange={(e) => set("first_name", e.target.value)} autoComplete="given-name" maxLength={60} aria-invalid={!!errors.first_name} aria-describedby="fn-e" />
            <p id="fn-e" className="mt-1 text-sm text-red-300" role="alert">{errors.first_name}</p>
          </div>
          <div>
            <label htmlFor="ln" className="text-sm font-medium">Last name</label>
            <input id="ln" className={inputCls} value={f.last_name} onChange={(e) => set("last_name", e.target.value)} autoComplete="family-name" maxLength={60} aria-invalid={!!errors.last_name} aria-describedby="ln-e" />
            <p id="ln-e" className="mt-1 text-sm text-red-300" role="alert">{errors.last_name}</p>
          </div>
        </div>

        <div>
          <label htmlFor="ts" className="text-sm font-medium">Target JAMB score (100–400)</label>
          <input id="ts" className={inputCls} inputMode="numeric" value={f.target_score} onChange={(e) => set("target_score", e.target.value.replace(/\D/g, "").slice(0, 3))} aria-invalid={!!errors.target_score} aria-describedby="ts-e" />
          <p id="ts-e" className="mt-1 text-sm text-red-300" role="alert">{errors.target_score}</p>
        </div>

        <div>
          <label htmlFor="ic" className="text-sm font-medium">Intended course</label>
          <input id="ic" className={inputCls} value={f.intended_course} onChange={(e) => set("intended_course", e.target.value)} maxLength={120} aria-invalid={!!errors.intended_course} aria-describedby="ic-e" />
          <p id="ic-e" className="mt-1 text-sm text-red-300" role="alert">{errors.intended_course}</p>
        </div>

        <div>
          <label htmlFor="pi" className="text-sm font-medium">Preferred institution</label>
          <input id="pi" className={inputCls} value={f.preferred_institution} onChange={(e) => set("preferred_institution", e.target.value)} maxLength={120} aria-invalid={!!errors.preferred_institution} aria-describedby="pi-e" />
          <p id="pi-e" className="mt-1 text-sm text-red-300" role="alert">{errors.preferred_institution}</p>
        </div>

        <div>
          <label htmlFor="g" className="text-sm font-medium">Gender</label>
          <select id="g" className={inputCls} value={f.gender} onChange={(e) => set("gender", e.target.value as Form["gender"])} aria-invalid={!!errors.gender} aria-describedby="g-e">
            <option value="">Select…</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
          <p id="g-e" className="mt-1 text-sm text-red-300" role="alert">{errors.gender}</p>
        </div>

        <SubjectPicker value={f.subjects} onChange={(v) => set("subjects", v)} describedBy="sub-e" />
        <p id="sub-e" className="-mt-3 text-sm text-red-300" role="alert">{errors.subjects}</p>

        {serverError && <StateBox kind="error">{serverError}</StateBox>}

        <button type="submit" disabled={busy}
          className="w-full rounded-xl bg-brand-blue px-4 py-4 text-base font-bold text-brand-navy hover:bg-brand-blue-dark disabled:opacity-60">
          {busy ? "Generating…" : "GENERATE MY PARTICIPANT ID"}
        </button>
      </form>
    </div>
  );
}
