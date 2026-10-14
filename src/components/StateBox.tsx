import type { ReactNode } from "react";

type Kind = "loading" | "error" | "empty" | "success";

const STYLES: Record<Kind, string> = {
  loading: "border-white/15 bg-brand-navy-2 text-slate-200",
  error: "border-red-400/60 bg-red-950/40 text-red-100",
  empty: "border-white/15 bg-brand-navy-2 text-slate-300",
  success: "border-emerald-400/60 bg-emerald-950/40 text-emerald-100",
};

export default function StateBox({ kind, children }: { kind: Kind; children: ReactNode }) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`flex items-center gap-3 rounded-xl border px-4 py-4 text-sm ${STYLES[kind]}`}
    >
      {kind === "loading" && (
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-blue border-t-transparent" aria-hidden="true" />
      )}
      <div>{children}</div>
    </div>
  );
}
