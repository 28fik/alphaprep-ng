import { useState } from "react";
import { BRAND } from "../lib/constants";

/** Shows the logo uploaded in Admin > Settings; falls back to a text mark until one is uploaded. */
export default function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  const big = size === "lg";
  const [hasLogo, setHasLogo] = useState(true);
  if (hasLogo) {
    return <img src="/api/logo" alt={BRAND.name} className={big ? "h-14 w-auto" : "h-9 w-auto"} onError={() => setHasLogo(false)} />;
  }
  return (
    <span className="inline-flex items-center gap-2" aria-label={BRAND.name}>
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
