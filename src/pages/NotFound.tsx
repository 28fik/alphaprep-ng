import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl px-4 py-16 text-center">
      <h1 className="text-3xl font-bold">Page not found</h1>
      <p className="mt-2 text-slate-300">That page doesn't exist.</p>
      <Link to="/" className="mt-6 inline-block rounded-xl bg-brand-blue px-6 py-3 font-bold text-brand-navy">Go home</Link>
    </div>
  );
}
