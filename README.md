# AlphaPrep NG Mock Exam

**Prepare. Practice. Perform.**

React + TypeScript + Vite frontend, Cloudflare Pages Functions (Workers) backend with Hono, Cloudflare D1 database. No Netlify, no paid services.

## Build status

| Phase | Scope | Status |
|---|---|---|
| 1 | Structure, responsive frontend, database schema, navigation | Done |
| 2 | Participant registration, ID lookup, recovery, admin login | **Written and tested (server logic).** Web routes and React pages **not yet run**, see below |
| 3 | Question bank, bulk import, exam generation | Not started |
| 4 | Exam interface, scoring, answer protection, corrections | Not started |
| 5 | Daily/weekly leaderboards (database views already exist) | Not started |
| 6 | Settings, audit-log viewer, hardening, remaining tests | Not started |
| 7 | Deployment walkthrough | Config files exist; not deployed |

### What is verified, and what is not

**Verified by running it (38 automated tests, all passing):** registration, Participant ID format and uniqueness (including collision retry and atomic rollback), subject rules, duplicate-registration guard, rate limits, ID-guessing protection, privacy of the lookup screen, recovery-code device linking and lockout, subject-change locking around exams, one-attempt-per-day, admin bootstrap (works once only), login, lockout, sessions, CSRF, role permissions. These run the real database migrations on SQLite through Node's built-in test runner.

**Not verified:**
- The Hono web routes (`server/app.ts`) and the React pages have **not been run or type-checked** here, because package installation was blocked in the build workspace. They were syntax-checked and their imports resolve, nothing more. The first `npm install && npm run build` is their first real compile, so expect possible small fixes.
- Behaviour on real Cloudflare (D1, Workers CPU limits) has not been tested. In particular, **PBKDF2 password hashing at 100,000 iterations may exceed the Workers Free 10 ms CPU limit** and make admin login fail. If that happens, set `PBKDF2_ITERATIONS` lower (for example 50000) and tell me; this is a security/free-tier trade-off to decide together.
- Tests are not a security audit.

Run the tests (needs Node 22.13 or newer, because they use Node's built-in SQLite):

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

## Setup notes

1. Secrets, set in the Cloudflare dashboard (Pages project, Settings, Variables and Secrets), never in GitHub:
   - `SESSION_PEPPER`: a long random string (32+ characters).
   - `ADMIN_BOOTSTRAP_SECRET`: another long random string (24+ characters).
2. Create the D1 database `alphaprep-ng`, paste its ID into `wrangler.toml`, bind it to the Pages project as `DB`, and run the three migration files in order.
3. Open `/admin/setup`, enter the bootstrap secret and choose your admin username and password (12+ characters), then sign in at `/admin/login`.

A full phone/PC-friendly deployment walkthrough comes in Phase 7.

## Logo

Put your official logo at `public/logo.png`, then in `src/components/Logo.tsx` uncomment the `<img>` line and delete the text block.
