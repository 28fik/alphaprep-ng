import { useEffect, useState, type FormEvent } from "react";
import StateBox from "../components/StateBox";
import { btn, btn2, btnDanger, Card, Field, fromLagosInput, input, toLagosInput } from "../components/ui";
import { api, ApiError, apiUpload } from "../lib/api";

type Row = Record<string, any>;

export default function Settings() {
  const [s, setS] = useState<Record<string, string> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [anns, setAnns] = useState<Row[]>([]);
  const [ann, setAnn] = useState<{ id: number | null; title: string; body: string; is_published: boolean; pinned: boolean } | null>(null);
  const [logoKey, setLogoKey] = useState(0);

  const loadAnns = () => api<{ announcements: Row[] }>("/admin/announcements").then((r) => setAnns(r.announcements)).catch((e) => setErr(e.message));
  useEffect(() => { api<{ settings: Record<string, string> }>("/admin/settings").then((r) => setS(r.settings)).catch((e) => setErr(e.message)); loadAnns(); }, []);

  if (!s) return err ? <StateBox kind="error">{err}</StateBox> : <StateBox kind="loading">Loading settings…</StateBox>;
  const set = (k: string) => (e: { target: { value: string } }) => setS({ ...s, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(""); setMsg(""); setErrors({});
    const body = { ...s!, utme_countdown_date: fromLagosInput(toLagosInput(s!.utme_countdown_date)) || s!.utme_countdown_date };
    try { await api("/admin/settings", { method: "PUT", body: JSON.stringify(body) }); setMsg("Settings saved."); }
    catch (x) { const ae = x as ApiError; setErr(ae.message); setErrors(ae.data?.errors ?? {}); } finally { setBusy(false); }
  }
  async function saveAnn(e: FormEvent) {
    e.preventDefault();
    if (!ann) return;
    try {
      const body = JSON.stringify({ title: ann.title, body: ann.body, is_published: ann.is_published, pinned: ann.pinned });
      if (ann.id) await api(`/admin/announcements/${ann.id}`, { method: "PUT", body }); else await api("/admin/announcements", { method: "POST", body });
      setAnn(null); loadAnns();
    } catch (x) { setErr((x as ApiError).message); }
  }
  async function logo(file: File | undefined) {
    if (!file) return;
    setErr(""); setMsg("");
    try { await apiUpload("/admin/logo", file); setLogoKey((k) => k + 1); setMsg("Logo updated. Reload the site to see it everywhere."); } catch (x) { setErr((x as ApiError).message); }
  }

  const countdown = toLagosInput(s.utme_countdown_date);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Settings</h1>
      {err && <StateBox kind="error">{err}</StateBox>}{msg && <StateBox kind="success">{msg}</StateBox>}
      <form onSubmit={save} className="space-y-4" noValidate>
        <Card title="UTME countdown (Nigerian time)">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date and time" error={errors.utme_countdown_date}><input type="datetime-local" className={input} value={countdown} onChange={(e) => setS({ ...s, utme_countdown_date: fromLagosInput(e.target.value) })} /></Field>
            <Field label="Label" error={errors.utme_countdown_label}><input className={input} value={s.utme_countdown_label ?? ""} onChange={set("utme_countdown_label")} /></Field>
          </div>
        </Card>
        <Card title="Official social links">
          <div className="grid gap-3">
            <Field label="X" error={errors.social_x}><input className={input} value={s.social_x ?? ""} onChange={set("social_x")} /></Field>
            <Field label="TikTok" error={errors.social_tiktok}><input className={input} value={s.social_tiktok ?? ""} onChange={set("social_tiktok")} /></Field>
            <Field label="WhatsApp channel" error={errors.social_whatsapp}><input className={input} value={s.social_whatsapp ?? ""} onChange={set("social_whatsapp")} /></Field>
            <Field label="Website address (used in the WhatsApp share message)" hint="Leave empty to use the current address." error={errors.site_url}><input className={input} value={s.site_url ?? ""} onChange={set("site_url")} placeholder="https://" /></Field>
          </div>
        </Card>
        <Card title="WhatsApp share gate">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={s.whatsapp_gate_enabled === "1"} onChange={(e) => setS({ ...s, whatsapp_gate_enabled: e.target.checked ? "1" : "0" })} />Ask participants to confirm they shared before starting</label>
          <p className="mt-1 text-xs text-slate-400">The site cannot verify that a message was sent; it only records that the participant ticked the box. Each exam can also switch the gate off.</p>
          <div className="mt-3"><Field label="Share message" error={errors.whatsapp_share_message}><textarea className={input} rows={2} value={s.whatsapp_share_message ?? ""} onChange={set("whatsapp_share_message")} /></Field></div>
        </Card>
        <Card title="Exam rules">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Leaving the exam page" error={errors.tab_hidden_policy}><select className={input} value={s.tab_hidden_policy} onChange={set("tab_hidden_policy")}><option value="auto_submit">Submit automatically</option><option value="warn">Show a warning</option><option value="off">Ignore</option></select></Field>
            <Field label="Late submit grace (seconds)" error={errors.late_submit_grace_seconds}><input className={input} inputMode="numeric" value={s.late_submit_grace_seconds ?? ""} onChange={set("late_submit_grace_seconds")} /></Field>
            <Field label="Lock subject changes (hours before exam)" error={errors.subject_change_cutoff_hours_before_exam}><input className={input} inputMode="numeric" value={s.subject_change_cutoff_hours_before_exam ?? ""} onChange={set("subject_change_cutoff_hours_before_exam")} /></Field>
          </div>
          <p className="mt-2 text-xs text-slate-400">Detecting that someone left the page is best effort: a browser can fail to report it, and a locked phone also counts as leaving.</p>
        </Card>
        <Card title="Admin sign-in protection">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Failed logins before lockout" error={errors.login_max_failures}><input className={input} inputMode="numeric" value={s.login_max_failures ?? ""} onChange={set("login_max_failures")} /></Field>
            <Field label="Lockout minutes" error={errors.login_lockout_minutes}><input className={input} inputMode="numeric" value={s.login_lockout_minutes ?? ""} onChange={set("login_lockout_minutes")} /></Field>
          </div>
        </Card>
        <button className={btn} disabled={busy}>{busy ? "Saving…" : "Save settings"}</button>
      </form>

      <Card title="Logo">
        <div className="flex flex-wrap items-center gap-4">
          <img key={logoKey} src={`/api/logo?v=${logoKey}`} alt="Current logo" className="h-12 w-auto rounded bg-white/5 p-1" onError={(e) => ((e.currentTarget.style.display = "none"))} />
          <input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Upload logo" onChange={(e) => void logo(e.target.files?.[0])} className="text-sm" />
        </div>
        <p className="mt-2 text-xs text-slate-400">PNG, JPEG or WebP, under 300 KB. SVG is not accepted for security reasons.</p>
      </Card>

      <Card title="Announcements" actions={<button className={btn2} onClick={() => setAnn({ id: null, title: "", body: "", is_published: true, pinned: false })}>New announcement</button>}>
        {ann && (
          <form onSubmit={saveAnn} className="mb-4 space-y-3 rounded-xl bg-brand-navy p-3">
            <Field label="Title"><input className={input} value={ann.title} maxLength={120} onChange={(e) => setAnn({ ...ann, title: e.target.value })} /></Field>
            <Field label="Message (plain text)"><textarea className={input} rows={3} value={ann.body} maxLength={1000} onChange={(e) => setAnn({ ...ann, body: e.target.value })} /></Field>
            <div className="flex gap-4 text-sm"><label className="flex items-center gap-1"><input type="checkbox" checked={ann.is_published} onChange={(e) => setAnn({ ...ann, is_published: e.target.checked })} />Published</label>
              <label className="flex items-center gap-1"><input type="checkbox" checked={ann.pinned} onChange={(e) => setAnn({ ...ann, pinned: e.target.checked })} />Pinned</label></div>
            <div className="flex gap-2"><button className={btn}>Save</button><button type="button" className={btn2} onClick={() => setAnn(null)}>Cancel</button></div>
          </form>
        )}
        <ul className="divide-y divide-white/10 text-sm">
          {anns.length === 0 && <li className="py-2 text-slate-300">No announcements.</li>}
          {anns.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span><strong>{a.title}</strong> {a.is_published ? "" : <em className="text-slate-400">(draft)</em>} {a.pinned ? "📌" : ""}</span>
              <span className="flex gap-2"><button className={btn2} onClick={() => setAnn({ id: a.id, title: a.title, body: a.body, is_published: !!a.is_published, pinned: !!a.pinned })}>Edit</button>
                <button className={btnDanger} onClick={async () => { if (window.confirm("Delete this announcement?")) { await api(`/admin/announcements/${a.id}`, { method: "DELETE" }).catch((x) => setErr(x.message)); loadAnns(); } }}>Delete</button></span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
