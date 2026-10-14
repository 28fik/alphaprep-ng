import { useEffect, useState } from "react";

function parts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(s / 86400),
    hours: Math.floor((s % 86400) / 3600),
    minutes: Math.floor((s % 3600) / 60),
    seconds: s % 60,
  };
}

/** Display-only countdown. Anything that affects exams uses SERVER time, never this. */
export default function Countdown({ target, label }: { target: string; label: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const end = Date.parse(target);
  if (Number.isNaN(end)) return null;
  const p = parts(end - now);
  const cells: [string, number][] = [
    ["Days", p.days],
    ["Hours", p.hours],
    ["Mins", p.minutes],
    ["Secs", p.seconds],
  ];
  return (
    <div role="timer" aria-label={`${label} countdown`}>
      <p className="text-sm font-medium text-slate-300">{label}</p>
      <div className="mt-2 grid grid-cols-4 gap-2">
        {cells.map(([name, v]) => (
          <div key={name} className="rounded-xl bg-brand-navy-3 py-3 text-center">
            <div className="text-2xl font-bold tabular-nums text-white">{String(v).padStart(2, "0")}</div>
            <div className="text-xs text-slate-300">{name}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
