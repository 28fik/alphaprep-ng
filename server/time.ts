// Africa/Lagos (WAT, UTC+1, no daylight saving) is the authoritative timezone.
// All "now" values come from the server clock, never from the browser.

export function nowIso(d: Date = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Lagos calendar date (YYYY-MM-DD) for a given instant. */
export function lagosDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
