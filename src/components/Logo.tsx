import { BRAND } from "../lib/constants";

/**
 * Text-based brand placeholder.
 * To use the official logo later: put the file at public/logo.png and
 * uncomment the <img> line (and delete the text block).
 */
export default function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  const big = size === "lg";
  return (
    <span className="inline-flex items-center gap-2" aria-label={BRAND.name}>
      {/* <img src="/logo.png" alt={BRAND.name} className={big ? "h-14" : "h-9"} /> */}
      <span
        className={`grid place-items-center rounded-lg bg-brand-blue font-bold text-brand-navy ${
          big ? "h-12 w-12 text-2xl" : "h-9 w-9 text-lg"
        }`}
        aria-hidden="true"
      >
        α
      </span>
      <span className={`font-bold tracking-tight text-white ${big ? "text-2xl" : "text-lg"}`}>
        AlphaPrep <span className="text-brand-blue">NG</span>
      </span>
    </span>
  );
}
