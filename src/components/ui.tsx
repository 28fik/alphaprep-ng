import type { ReactNode } from "react";

export const btn = "rounded-xl bg-brand-blue px-4 py-2 text-sm font-bold text-brand-navy hover:bg-brand-blue-dark disabled:opacity-50";
export const btn2 = "rounded-xl border border-white/30 px-4 py-2 text-sm font-semibold hover:bg-brand-navy-3 disabled:opacity-50";
export const btnDanger = "rounded-xl bg-rose-600 px-4 py-2 text-sm font-bold text-white hover:bg-rose-500 disabled:opacity-50";
export const input = "w-full rounded-lg border border-white/25 bg-brand-navy px-3 py-2 text-sm";

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-rose-300" role="alert">{error}</span>}
    </label>
  );
}

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/15 bg-brand-navy-2 p-4">
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <span className="text-slate-300">{total} total · page {page} of {pages}</span>
      <span className="flex gap-2">
        <button className={btn2} disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button className={btn2} disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </span>
    </div>
  );
}

export function Chip({ tone, children }: { tone: "green" | "amber" | "red" | "grey" | "blue"; children: ReactNode }) {
  const c = { green: "bg-emerald-900 text-emerald-200", amber: "bg-amber-900 text-amber-200", red: "bg-rose-900 text-rose-200", grey: "bg-slate-700 text-slate-200", blue: "bg-sky-900 text-sky-200" }[tone];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${c}`}>{children}</span>;
}

/** Lagos (UTC+1, no daylight saving) <-> <input type="datetime-local"> */
export const toLagosInput = (iso: string | null | undefined) => (iso ? new Date(Date.parse(iso) + 3600_000).toISOString().slice(0, 16) : "");
export const fromLagosInput = (v: string) => (v ? `${v}:00+01:00` : "");
export const fmtLagos = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Lagos", dateStyle: "medium", timeStyle: "short" }) + " WAT" : "";
