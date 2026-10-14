import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import Logo from "../components/Logo";
import StateBox from "../components/StateBox";
import { api, setCsrf, type AdminSessionInfo } from "../lib/api";

const field = "mt-1 w-full rounded-xl border border-white/25 bg-brand-navy px-4 py-3 text-base";

export default function AdminLogin() {
  const navigate = useNavigate();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ needs_setup: boolean }>("/admin/status").then((s) => setNeedsSetup(s.needs_setup)).catch(() => setNeedsSetup(false));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const s = await api<AdminSessionInfo>("/admin/login", { method: "POST", body: JSON.stringify({ username, password }) });
      setCsrf(s.csrf);
      navigate("/admin", { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (needsSetup) return <Navigate to="/admin/setup" replace />;

  return (
    <div className="mx-auto max-w-sm px-4 py-12">
      <Logo />
      <h1 className="mt-6 text-2xl font-bold">Administrator sign in</h1>
      <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
        <div>
          <label htmlFor="u" className="text-sm font-medium">Username</label>
          <input id="u" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="p" className="text-sm font-medium">Password</label>
          <input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        </div>
        {error && <StateBox kind="error">{error}</StateBox>}
        <button disabled={busy || needsSetup === null} className="w-full rounded-xl bg-brand-blue px-4 py-3 font-bold text-brand-navy disabled:opacity-60">
          {busy ? "Signing in…" : "SIGN IN"}
        </button>
      </form>
      <Link to="/" className="mt-6 inline-block text-sm text-slate-300 underline">Back to site</Link>
    </div>
  );
}
