import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PARTICIPANT_ID_PATTERN } from "../lib/constants";

export default function ParticipantIdForm() {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const id = value.trim().toUpperCase();
    if (!PARTICIPANT_ID_PATTERN.test(id)) {
      setError("Enter your ID exactly as given, for example JAMB4827QX.");
      return;
    }
    setError("");
    navigate(`/continue?id=${encodeURIComponent(id)}`);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="rounded-2xl border border-white/15 bg-brand-navy-2 p-5">
      <label htmlFor="pid" className="block text-base font-semibold">
        Enter Participant ID to Start Exam
      </label>
      <input
        id="pid"
        name="pid"
        value={value}
        onChange={(e) => setValue(e.target.value.toUpperCase())}
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        maxLength={10}
        placeholder="JAMB1234AB"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "pid-error" : undefined}
        className="mt-3 w-full rounded-xl border border-white/25 bg-brand-navy px-4 py-3 text-lg font-semibold tracking-widest text-white placeholder:text-slate-500 focus:border-brand-blue"
      />
      {error && (
        <p id="pid-error" role="alert" className="mt-2 text-sm text-red-300">
          {error}
        </p>
      )}
      <button
        type="submit"
        className="mt-4 w-full rounded-xl bg-brand-blue px-4 py-3 text-base font-bold text-brand-navy hover:bg-brand-blue-dark active:scale-[0.99]"
      >
        CONTINUE
      </button>
      <p className="mt-4 text-center text-sm text-slate-300">
        Don't have a Participant ID?{" "}
        <Link to="/register" className="font-semibold text-brand-blue underline underline-offset-2">
          Generate One
        </Link>
      </p>
    </form>
  );
}
