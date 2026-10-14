import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate } from "react-router-dom";
import Logo from "../components/Logo";
import StateBox from "../components/StateBox";
import { api } from "../lib/api";

const field = "mt-1 w-full rounded-xl border border-white/25 bg-brand-navy px-4 py-3 text-base";

/** One-time creation of the first administrator. Disabled by the server once an admin exists. */
export default function AdminSetup() {
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [secret, setSecret] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<{ needs_setup: boolean }>("/admin/status").then((s) => setNeedsSetup(s.needs_setup)).catch(() => setNeedsSetup(false));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await api("/admin/bootstrap", {
        method: "POST",
        body: JSON.stringify({ secret, username, display_name: displayName, password }),
      });
      setDone(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (needsSetup === false && !done) return <Navigate to="/admin/login" replace />;
  if (done) {
    return (
      <div className="mx-auto max-w-sm px-4 py-12">
        <StateBox kind="success">Administrator created. Setup is now disabled.</StateBox>
        <Link to="/admin/login" className="mt-5 inline-block rounded-xl bg-brand-blue px-5 py-3 font-bold text-brand-navy">Sign in</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-12">
      <Logo />
      <h1 className="mt-6 text-2xl font-bold">First-time setup</h1>
      <p className="mt-2 text-sm text-slate-300">
        Create the first administrator. You need the setup secret you stored in Cloudflare as ADMIN_BOOTSTRAP_SECRET.
      </p>
      <form onSubmit={onSubmit} className="mt-5 space-y-4" noValidate>
        <div>
          <label htmlFor="s" className="text-sm font-medium">Setup secret</label>
          <input id="s" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="dn" className="text-sm font-medium">Your name</label>
          <input id="dn" value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={field} maxLength={60} />
        </div>
        <div>
          <label htmlFor="un" className="text-sm font-medium">Username</label>
          <input id="un" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={field} />
        </div>
        <div>
          <label htmlFor="pw" className="text-sm font-medium">Password (at least 12 characters)</label>
          <input id="pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
        </div>
        {error && <StateBox kind="error">{error}</StateBox>}
        <button disabled={busy || needsSetup === null} className="w-full rounded-xl bg-brand-blue px-4 py-3 font-bold text-brand-navy disabled:opacity-60">
          {busy ? "Creating…" : "CREATE ADMINISTRATOR"}
        </button>
      </form>
    </div>
  );
}
