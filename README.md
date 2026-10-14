# AlphaPrep NG Mock Exam

**Prepare. Practice. Perform.**

React + TypeScript + Vite frontend, Cloudflare Pages Functions (Workers) backend with Hono, Cloudflare D1 database. No Netlify, no paid services.

## Build status (be honest about what exists)

| Phase | Scope | Status |
|---|---|---|
| 1 | Project structure, responsive frontend, DB schema, navigation | **Written.** Schema tested on SQLite. Frontend/backend **not yet compiled** (see below). |
| 2 | Participant registration API, ID safeguards, admin auth | Not started |
| 3 | Question bank, bulk import, exam generation | Not started |
| 4 | Exam interface, scoring, answer protection, corrections | Not started |
| 5 | Daily/weekly leaderboards (database views already exist) | Not started |
| 6 | Settings, audit logs, hardening, automated tests | Not started |
| 7 | Deployment | Config files exist; deployment itself not done |

**Not verified yet:** the TypeScript/React code has not been compiled or run, because package installation was blocked in the build workspace. The first `npm run build` (locally or on Cloudflare Pages) is its first compile, so expect possible small fixes. No automated tests exist yet, so nothing here is "tested" beyond the database schema.

**Verified:** `migrations/0001_init.sql` and `0002_seed.sql` load on SQLite 3.45; participant ID format and uniqueness, one-attempt-per-day, and the daily/weekly views (Monday to Sunday weeks, missed days add zero) behave as designed.

## Free-tier limits that shape the design (checked 14 Oct 2026)

- Workers Free: 100,000 requests/day and **10 ms CPU per invocation**. Pages Functions count against this.
- D1 Free: 5 million rows read/day, **100,000 rows written/day**, 5 GB storage. When a limit is hit, queries fail until 00:00 UTC.

Consequences already built in:
- Exam answers autosave as **one JSON blob per attempt** (`attempts.answers_json`), not one row per answer.
- Indexes also cost row writes, so only needed indexes exist.
- **Risk for Phase 2:** password hashing (PBKDF2) may exceed the 10 ms CPU limit on the free plan. I will test and pick the strongest setting that fits, and tell you if the free plan forces a trade-off.

Limits can change; recheck Cloudflare's pricing pages before launch. Free usage is not unlimited.

## Passwordless participants: trade-offs

A Participant ID is an identifier, not proof of identity. Anyone who learns an ID could try to use it. Planned safeguards (Phase 2): a device token bound at registration, rate limits on lookups and registration, the lookup screen reveals no personal details, profile edits require the registering device, duplicate-registration warnings, and admin suspension. These reduce abuse but do **not** make an ID-only system strongly secure. Participants who clear browser data or switch phones lose device binding; the admin can help recover.

## Project layout

```
index.html            Poppins font, mobile viewport
src/                  React app (pages, components, constants)
server/app.ts         Hono API (health, public status, placeholders)
functions/api/[[route]].ts   Cloudflare Pages Functions entry
migrations/           D1 schema + seed data
wrangler.toml         Cloudflare config (paste your D1 database_id)
.dev.vars.example     Example secrets (copy to .dev.vars, never commit)
```

## Logo

Put your official logo at `public/logo.png`, then in `src/components/Logo.tsx` uncomment the `<img>` line and delete the text block.

## Deploying (summary; full phone-friendly steps come in Phase 7)

1. Put this folder in a GitHub repository.
2. Cloudflare dashboard, Workers & Pages, create a D1 database named `alphaprep-ng`; copy its ID into `wrangler.toml`.
3. Create a Pages project from the GitHub repo. Build command `npm run build`, output directory `dist`.
4. In the Pages project, add the D1 binding `DB`, and the secrets `ADMIN_BOOTSTRAP_SECRET` and `SESSION_PEPPER` (long random strings, never committed).
5. Run the two migration files in order in the D1 console (or `npm run db:migrate:remote` from a computer).

## Running on a computer

```
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run build && npm run preview
```
