import { useState, type FormEvent } from "react";
import { btn, btn2, Field, input } from "../components/ui";
import { ALL_SUBJECTS } from "../lib/constants";

export interface QValues {
  subject: string; topic: string; year: string; question: string;
  option_a: string; option_b: string; option_c: string; option_d: string;
  answer: string; explanation: string; source: string; verification_status?: string;
}

export const emptyQ = (subject = "mathematics"): QValues => ({
  subject, topic: "", year: "", question: "", option_a: "", option_b: "", option_c: "", option_d: "", answer: "", explanation: "", source: "",
});

/** Used by the question bank (create/edit) and by the import preview (fix a flagged row). */
export default function QuestionForm({ initial, busy, error, onSubmit, onCancel, submitLabel = "Save" }: {
  initial: QValues; busy?: boolean; error?: string; onSubmit: (v: QValues) => void; onCancel: () => void; submitLabel?: string;
}) {
  const [v, setV] = useState<QValues>(initial);
  const set = (k: keyof QValues) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const submit = (e: FormEvent) => { e.preventDefault(); onSubmit(v); };
  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Subject"><select className={input} value={v.subject} onChange={set("subject")}>{ALL_SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Topic"><input className={input} value={v.topic} onChange={set("topic")} maxLength={120} /></Field>
        <Field label="Year"><input className={input} value={v.year} onChange={set("year")} inputMode="numeric" maxLength={4} /></Field>
      </div>
      <Field label="Question"><textarea className={input} rows={3} value={v.question} onChange={set("question")} maxLength={4000} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["option_a", "option_b", "option_c", "option_d"] as const).map((k) => (
          <Field key={k} label={`Option ${k.slice(-1).toUpperCase()}`}><input className={input} value={v[k]} onChange={set(k)} maxLength={1000} /></Field>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Correct answer" hint="Leave blank if unknown. The question is kept out of exams until you set one.">
          <select className={input} value={v.answer} onChange={set("answer")}><option value="">(not set)</option>{["A", "B", "C", "D"].map((l) => <option key={l}>{l}</option>)}</select>
        </Field>
        <Field label="Source (optional)"><input className={input} value={v.source} onChange={set("source")} maxLength={200} /></Field>
      </div>
      <Field label="Explanation (shown after corrections are released)"><textarea className={input} rows={2} value={v.explanation} onChange={set("explanation")} maxLength={4000} /></Field>
      {error && <p className="text-sm text-rose-300" role="alert">{error}</p>}
      <div className="flex gap-2"><button className={btn} disabled={busy}>{busy ? "Saving…" : submitLabel}</button><button type="button" className={btn2} onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

export function qToApi(v: QValues) {
  return { subject: v.subject, topic: v.topic, year: v.year, question: v.question, option_a: v.option_a, option_b: v.option_b, option_c: v.option_c, option_d: v.option_d, answer: v.answer, explanation: v.explanation, source: v.source, verification_status: v.verification_status };
}
