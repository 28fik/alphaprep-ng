import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import StateBox from "../components/StateBox";
import { btn, btn2, Card, Chip, Field, input } from "../components/ui";
import { api, ApiError, setCsrf } from "../lib/api";
import { useAdmin } from "./AdminShell";

type Row = Record<string, any>;
export default function Security() {
  const me = useAdmin();
  const navigate = useNavigate();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [admins, setAdmins] = useState<Row[] | null>(null);
  const [nu, setNu] = useState({ username: "", display_name: "", password: "", role: "viewer" });

  const loadAdmins = () => api<{ admins: Row[] }>("/admin/admins").then((r) => setAdmins(r.admins)).catch((e) => setErr(e.message));
  useEffect(() => { if (me.can("admins.manage")) void loadAdmins(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function changePw(e: FormEvent) {
    e.preventDefault(); setErr(""); setMsg("");
    try { await api("/admin/password", { method: "POST", body: JSON.stringify({ current: cur, next }) }); setCsrf(""); navigate("/admin/login", { replace: true }); }
    catch (x) { setErr((x as ApiError).message); }
  }
  async function create(e: FormEvent) {
    e.preventDefault(); setErr(""); setMsg("");
    try { await api("/admin/admins", { method: "POST", body: JSON.stringify(nu) }); setMsg("Administrator created."); setNu({ username: "", display_name: "", password: "", role: "viewer" }); void loadAdmins(); }
    catch (x) { setErr((x as ApiError).message); }
  }
  async function update(a: Row, body: Row) {
    setErr(""); setMsg("");
    try { await api(`/admin/admins/${a.id}`, { method: "PUT", body: JSON.stringify({ status: a.status, role: a.role, ...body }) }); void loadAdmins(); } catch (x) { setErr((x as ApiError).message); }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Security & team</h1>
      {err && <StateBox kind="error">{err}</StateBox>}{msg && <StateBox kind="success">{msg}</StateBox>}
      <Card title="Change your password">
        <form onSubmit={changePw} className="grid gap-3 sm:grid-cols-2" noValidate>
          <Field label="Current password"><input type="password" autoComplete="current-password" className={input} value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
          <Field label="New password (12+ characters)"><input type="password" autoComplete="new-password" className={input} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <div><button className={btn}>Change password</button><p className="mt-1 text-xs text-slate-400">You will be signed out everywhere and asked to sign in again.</p></div>
        </form>
      </Card>
      <Card title="Your permissions"><ul className="flex flex-wrap gap-2 text-xs">{me.permissions.map((p) => <li key={p} className="rounded-full bg-brand-navy-3 px-3 py-1">{p}</li>)}</ul></Card>

      {me.can("admins.manage") && (
        <>
          <Card title="Administrators">
            {!admins ? <StateBox kind="loading">Loading…</StateBox> : (
              <ul className="divide-y divide-white/10 text-sm">
                {admins.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span><strong>{a.username}</strong> ({a.display_name}) <Chip tone={a.status === "active" ? "green" : "red"}>{a.status}</Chip> <span className="text-xs text-slate-400">{a.last_login_at ? `last login ${a.last_login_at}` : "never signed in"}</span></span>
                    <span className="flex gap-2">
                      <select className={`${input} w-auto`} aria-label={`Role of ${a.username}`} value={a.role} onChange={(e) => update(a, { role: e.target.value })} disabled={a.id === me.admin.id}>
                        {["super_admin", "exam_manager", "content_editor", "viewer"].map((r) => <option key={r}>{r}</option>)}</select>
                      {a.id !== me.admin.id && <button className={btn2} onClick={() => update(a, { status: a.status === "active" ? "disabled" : "active" })}>{a.status === "active" ? "Disable" : "Enable"}</button>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Add an administrator">
            <form onSubmit={create} className="grid gap-3 sm:grid-cols-2" noValidate>
              <Field label="Username"><input className={input} value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} autoComplete="off" /></Field>
              <Field label="Display name"><input className={input} value={nu.display_name} onChange={(e) => setNu({ ...nu, display_name: e.target.value })} /></Field>
              <Field label="Temporary password (12+ characters)"><input type="password" className={input} value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} autoComplete="new-password" /></Field>
              <Field label="Role"><select className={input} value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                <option value="viewer">viewer: read-only</option><option value="content_editor">content_editor: question bank and imports</option><option value="exam_manager">exam_manager: exams, participants, results</option><option value="super_admin">super_admin: everything</option></select></Field>
              <div><button className={btn}>Create administrator</button></div>
            </form>
          </Card>
        </>
      )}
    </div>
  );
}
