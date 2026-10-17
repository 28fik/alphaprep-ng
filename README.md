# AlphaPrep NG Mock Exam

**Prepare. Practice. Perform.**

React + TypeScript + Vite frontend, Cloudflare Pages Functions (Workers) backend with Hono, Cloudflare D1 database. No Netlify, no paid services.

## Build status

| Phase | Scope | Status |
|---|---|---|
| 1 | Structure, responsive frontend, database schema | Written |
| 2 | Registration, ID lookup, recovery, admin login | Written, server logic tested |
| 3 | Question bank, bulk import (CSV, Excel, pasted text, text PDF, scanned PDF via OCR), exam generation, preview, approve, publish and freeze | Written, server logic tested; import readers partly tested |
| 4 | Exam screen, server-side deadline, autosave, scoring, corrections release | Written, server logic tested |
| 5 | Daily and weekly leaderboards (ties share a rank) | Written, server logic tested |
| 6 | Admin panel (roles, participants, score adjustment, settings, announcements, logo, audit log, CSV exports) | Written, server logic tested |
| 7 | Deployment walkthrough | See `DEPLOY.md`. **Not deployed or run on Cloudflare yet** |

### What is verified, and what is not

**Verified by running it (99 automated tests, all passing):** the server logic in `server/*.ts` (registration, recovery, rate limits, admin login and roles, question validation and import staging, exam generation and freezing, attempts, deadlines, scoring, leaderboards, score adjustments, settings validation, exports), run against the real migrations on SQLite through Node's built-in test runner. Also tested: the CSV, Excel and PDF-text readers on small sample files.

**Not verified. Please read this:**
- The React pages and the Hono routes (`server/app.ts`) have **never been compiled with the real dependencies** (package installation was blocked in the build workspace). They were bundled and type-checked only against loose stand-ins. The first `npm install && npm run build` is their first real compile, so expect small fixes.
- **Nothing has run on real Cloudflare** (D1 behaviour, Workers limits). PBKDF2 at 100,000 iterations may exceed the free 10 ms CPU limit; if admin login fails, set `PBKDF2_ITERATIONS` lower (for example 50000).
- PDF reading (pdfjs-dist) and scanned-PDF OCR (tesseract.js) have not been run in a browser. OCR output always needs human review.
- The share gate only records that the participant ticked a box; it does **not** verify a WhatsApp share.
- A participant who loses both device and recovery code needs an administrator to reset the recovery code.
- Tests are not a security audit. No browser or load testing was done.

Run the tests (Node 22.13 or newer):

```
npm test
```

## Security design (Phase 2)

**Participants have no passwords.** A Participant ID is only an identifier, never proof of identity.

- Registering gives the browser a random **device cookie** (HttpOnly) and shows a one-time **recovery code**. Only hashes are stored.
- A **trusted device** (one holding that cookie) sees the participant's first name, last initial and subjects. Nobody else sees even that: an unverified visitor learns only that the ID exists.
- Target score, course, institution and gender are never returned by these endpoints.
- Another phone or PC must enter the ID and recovery code. Wrong codes lock that ID after 5 tries per 15 minutes. Lookups, registrations and guesses are rate limited.
- A duplicate guard blocks re-registering the same name, course and institution.
- Subjects can change only from a trusted device and are locked from a configurable number of hours before an exam until it closes. Past results keep their own subject record.

**Honest limits:** anyone who gets both an ID and its recovery code can act as that participant. Anyone with a participant's unlocked phone can too. Clearing browser data loses the device link, so the recovery code is the way back; if it is lost, an administrator must help. The duplicate guard can wrongly block two real people with identical details. This is reasonable protection for a free practice platform, not strong account security.

**Administrators:** no public sign-up and no built-in password. The first admin is created at `/admin/setup` with a one-time secret kept in Cloudflare (not in GitHub); that page stops working once an admin exists. Passwords are hashed with PBKDF2-SHA256, sessions live in the database (the cookie holds a random value, only its hash is stored), cookies are HttpOnly and Secure, state-changing requests need a CSRF token and a same-origin check, logins are rate limited with account lockout, and every permission check happens on the server.

## Free-tier limits that shape the design (checked 14 Oct 2026)

- Workers Free: 100,000 requests/day and **10 ms CPU per invocation**. Pages Functions count against this.
- D1 Free: 5 million rows read/day, **100,000 rows written/day**, 5 GB storage. When a limit is hit, queries fail until 00:00 UTC.
- Rate limiting writes one row per check, so only security-relevant actions are counted. Exam answers will autosave as one block per attempt (Phase 4).

Limits can change; recheck Cloudflare's pricing pages before launch. Free usage is not unlimited.

## Project layout

```
index.html                    Poppins font, mobile viewport
src/                          React app (pages, components)
server/                       Business logic (admin, participants, crypto, rate limits, validation)
server/app.ts                 Hono routes (thin layer over the logic above)
functions/api/[[route]].ts    Cloudflare Pages Functions entry
migrations/                   0001 schema, 0002 seed data, 0003 Phase 2 (devices, recovery)
tests/                        Automated tests (node:test)
wrangler.toml                 Cloudflare config (paste your D1 database_id)
.dev.vars.example             Example secrets (copy to .dev.vars, never commit)
```

## Setup

Follow **DEPLOY.md** (works from a phone or a PC, free plan only). In short: create the D1 database, put its ID in `wrangler.toml`, run the four files in `migrations/` in order, connect the repository to Cloudflare Pages (build `npm run build`, output `dist`), add the secrets `SESSION_PEPPER` and `ADMIN_BOOTSTRAP_SECRET` in the dashboard (never in GitHub), then open `/admin/setup`.

The repository is public, so keep every secret out of it. You can make it private later in GitHub settings; Cloudflare Pages can still build a private repository.

## Logo

Upload the official logo in the admin **Settings** page (PNG, JPEG or WebP, 300 KB or less). Until then the site shows the name as text.
