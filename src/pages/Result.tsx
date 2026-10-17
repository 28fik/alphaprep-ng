import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import ResultCard from "../components/ResultCard";
import StateBox from "../components/StateBox";
import { api, type ExamResult } from "../lib/api";
import { PARTICIPANT_ID_PATTERN } from "../lib/constants";

export default function Result() {
  const [params] = useSearchParams();
  const id = (params.get("id") ?? "").toUpperCase();
  const date = params.get("date") ?? undefined;
  const [result, setResult] = useState<ExamResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!PARTICIPANT_ID_PATTERN.test(id)) { setError("That ID is not in the correct format."); setLoading(false); return; }
    let alive = true;
    api<{ result: ExamResult | null }>("/me/result", { method: "POST", body: JSON.stringify({ id, date }) })
      .then((r) => alive && setResult(r.result))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [id, date]);

  return (
    <div className="mx-auto max-w-xl px-4 py-8">
      <h1 className="mb-5 text-2xl font-bold">Your result</h1>
      {loading ? <StateBox kind="loading">Loading your result…</StateBox> : error ? <StateBox kind="error">{error}</StateBox> : result ? <ResultCard result={result} pid={id} /> : <StateBox kind="empty">No result yet.</StateBox>}
      <Link to={`/continue?id=${id}`} className="mt-6 inline-block text-sm text-brand-blue underline">Back</Link>
    </div>
  );
}
