import { useEffect, useState } from "react";
import StateBox from "../components/StateBox";
import { Card, input, Pager } from "../components/ui";
import { api } from "../lib/api";

type Row = Record<string, any>;
export default function Audit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [data, setData] = useState<Row | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setErr("");
    api<Row>(`/admin/audit?page=${page}${action ? `&action=${encodeURIComponent(action)}` : ""}`).then(setData).catch((e) => setErr(e.message));
  }, [page, action]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Audit log</h1>
      <select className={`${input} max-w-xs`} aria-label="Filter by area" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
        <option value="">All actions</option>
        {["admin.", "exam.", "question.", "participant.", "result.", "settings.", "announcement."].map((a) => <option key={a} value={a}>{a}*</option>)}
      </select>
      {err ? <StateBox kind="error">{err}</StateBox> : !data ? <StateBox kind="loading">Loading…</StateBox> : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-400"><tr><th className="py-2 pr-3">Time (UTC)</th><th className="pr-3">Who</th><th className="pr-3">Action</th><th className="pr-3">Target</th><th>Details</th></tr></thead>
              <tbody className="divide-y divide-white/10">
                {data.rows.map((r: Row) => (
                  <tr key={r.id} className="align-top"><td className="whitespace-nowrap py-2 pr-3">{r.created_at.replace("T", " ").replace("Z", "")}</td><td className="pr-3">{r.admin ?? "system"}</td><td className="pr-3 font-semibold">{r.action}</td><td className="pr-3">{r.target_type ? `${r.target_type} ${r.target_id ?? ""}` : ""}</td><td className="break-all text-slate-300">{r.details_json ?? ""}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageSize={data.page_size} total={data.total} onPage={setPage} />
        </Card>
      )}
    </div>
  );
}
