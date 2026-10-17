import { createContext, useContext, useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useNavigate } from "react-router-dom";
import Logo from "../components/Logo";
import StateBox from "../components/StateBox";
import { api, ApiError, setCsrf, type AdminSessionInfo } from "../lib/api";

const Ctx = createContext<AdminSessionInfo | null>(null);
export const useAdmin = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useAdmin outside AdminShell");
  return { ...s, can: (p: string) => s.permissions.includes(p) };
};

const NAV: { to: string; label: string; perm?: string; end?: boolean }[] = [
  { to: "/admin", label: "Overview", end: true },
  { to: "/admin/exams", label: "Exams", perm: "exams.read" },
  { to: "/admin/questions", label: "Question bank", perm: "questions.read" },
  { to: "/admin/import", label: "Import", perm: "questions.write" },
  { to: "/admin/participants", label: "Participants", perm: "participants.read" },
  { to: "/admin/reports", label: "Leaderboards & exports", perm: "reports.read" },
  { to: "/admin/settings", label: "Settings", perm: "settings.write" },
  { to: "/admin/audit", label: "Audit log", perm: "audit.read" },
  { to: "/admin/security", label: "Security & team" },
];

export default function AdminShell() {
  const navigate = useNavigate();
  const [state, setState] = useState<"loading" | "out" | "error" | "in">("loading");
  const [session, setSession] = useState<AdminSessionInfo | null>(null);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api<AdminSessionInfo>("/admin/me")
      .then((s) => { setCsrf(s.csrf); setSession(s); setState("in"); })
      .catch((e: ApiError) => { if (e.status === 401) setState("out"); else { setMessage(e.message); setState("error"); } });
  }, []);

  async function logout() {
    try { await api("/admin/logout", { method: "POST", body: "{}" }); } catch { /* already gone */ }
    setCsrf("");
    navigate("/admin/login", { replace: true });
  }

  if (state === "out") return <Navigate to="/admin/login" replace />;
  if (state === "loading") return <div className="mx-auto max-w-xl px-4 py-12"><StateBox kind="loading">Checking your session…</StateBox></div>;
  if (state === "error" || !session) return <div className="mx-auto max-w-xl px-4 py-12"><StateBox kind="error">{message}</StateBox></div>;

  const links = NAV.filter((n) => !n.perm || session.permissions.includes(n.perm));
  return (
    <Ctx.Provider value={session}>
      <div className="min-h-screen md:flex">
        <header className="flex items-center justify-between border-b border-white/10 bg-brand-navy-2 px-4 py-3 md:hidden">
          <Logo />
          <button className="rounded-lg border border-white/20 px-3 py-2 text-sm" aria-expanded={open} aria-controls="admin-nav" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Menu"}</button>
        </header>
        <aside id="admin-nav" className={`${open ? "block" : "hidden"} border-white/10 bg-brand-navy-2 p-3 md:block md:min-h-screen md:w-60 md:shrink-0 md:border-r`}>
          <div className="mb-4 hidden px-2 md:block"><Logo /></div>
          <nav aria-label="Admin">
            <ul className="space-y-1">
              {links.map((l) => (
                <li key={l.to}>
                  <NavLink to={l.to} end={l.end} onClick={() => setOpen(false)}
                    className={({ isActive }) => `block rounded-lg px-3 py-2 text-sm font-medium ${isActive ? "bg-brand-blue text-brand-navy" : "text-slate-200 hover:bg-brand-navy-3"}`}>
                    {l.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="mt-6 border-t border-white/10 px-2 pt-3 text-xs text-slate-300">
            <p>{session.admin.display_name}</p>
            <p>{session.admin.role}</p>
            <button onClick={logout} className="mt-2 rounded-lg border border-white/30 px-3 py-1.5 font-semibold">Sign out</button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8"><Outlet /></main>
      </div>
    </Ctx.Provider>
  );
}
