import { SUBJECT_GROUPS } from "../lib/constants";

/** Pick exactly three subjects from any group. English is compulsory and added automatically. */
export default function SubjectPicker({
  value,
  onChange,
  describedBy,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  describedBy?: string;
}) {
  function toggle(id: string) {
    if (value.includes(id)) onChange(value.filter((s) => s !== id));
    else if (value.length < 3) onChange([...value, id]);
  }
  return (
    <fieldset aria-describedby={describedBy}>
      <legend className="text-sm font-medium">Subjects</legend>
      <p className="mt-1 text-sm text-slate-300">
        <strong>Use of English</strong> is compulsory and added automatically. Pick exactly 3 more from any group (
        {value.length}/3 selected). You can mix groups.
      </p>
      <div className="mt-3 space-y-4">
        {SUBJECT_GROUPS.map((g) => (
          <div key={g.title}>
            <p className="text-xs font-semibold uppercase tracking-wider text-brand-blue">{g.title}</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {g.subjects.map((s) => {
                const checked = value.includes(s.id);
                const locked = !checked && value.length >= 3;
                const key = `${g.title}-${s.id}`;
                return (
                  <label
                    key={key}
                    htmlFor={key}
                    className={`flex min-h-12 items-center gap-3 rounded-xl border px-4 py-3 text-sm ${
                      checked ? "border-brand-blue bg-brand-navy-3" : "border-white/20 bg-brand-navy-2"
                    } ${locked ? "opacity-50" : ""}`}
                  >
                    <input
                      id={key}
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={() => toggle(s.id)}
                      className="h-5 w-5 accent-brand-blue"
                    />
                    {s.name}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
