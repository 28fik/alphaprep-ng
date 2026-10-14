import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import Logo from "../components/Logo";
import StateBox from "../components/StateBox";
import { api, ApiError, setCsrf, type AdminSessionInfo } from "../lib/api";

/** Phase 2 dashboard shell: proves server-side session + CSRF work. Real panels come in later phases. */
export default function AdminHome() {
  const navigate = useNavigate();
  const [state, setState] = useState<"loading" | "out" | "error" | "in">("loading");
  const [session, setSession] = useState<AdminSessionInfo | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    api<AdminSessionInfo>("/admin/me")
      .then((s) => { setCsrf(s.csrf); setSession(s); setState("in"); })
      .catch((e: ApiError) => {
        if (e.status === 401) setState("out");
        else { setMessage(e.message); setState("error"); }
      });
  }, []);

  async function logout() {
    try { await api("/admin/logout", { method: "POST", body: "{}" }); } catch { /* session may already be gone */ }
    setCsrf("");
    navigate("/admin/login", { replace: true });
  }

  if (state === "out") return <Navigate to="/admin/login" replace />;
  if (state === "loading") return <div className="mx-auto max-w-xl px-4 py-12"><StateBox kind="loading">Checking your session…</StateBox></div>;
  if (state === "error") return <div className="mx-auto max-w-xl px-4 py-12"><StateBox kind="error">{message}</StateBox></div>;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-center justify-between">
        <Logo />
        <button onClick={logout} className="rounded-xl border border-white/30 px-4 py-2 text-sm font-semibold">Sign out</button>
      </div>
      <h1 className="mt-6 text-2xl font-bold">Admin dashboard</h1>
      <p className="mt-1 text-sm text-slate-300">
        Signed in as {session!.admin.display_name} ({session!.admin.username}) · role: {session!.admin.role}
      </p>
      <div className="mt-5"><StateBox kind="empty">
        Overview, exams, participants, leaderboards and settings panels are added in the next build phases.
      </StateBox></div>
      <h2 className="mt-6 text-sm font-semibold uppercase tracking-wider text-brand-blue">Your permissions</h2>
      <ul className="mt-2 flex flex-wrap gap-2 text-xs">
        {session!.permissions.map((p) => <li key={p} className="rounded-full bg-brand-navy-3 px-3 py-1">{p}</li>)}
      </ul>
    </div>
  );
}
