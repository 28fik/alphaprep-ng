# Deploying AlphaPrep NG (free, from a phone or a PC)

Everything below uses Cloudflare's free plan and GitHub. No card is needed. Do the steps in this order.

## 1. Create the database
1. Sign in at **dash.cloudflare.com**. Open **Storage & Databases → D1 SQL database → Create database**. Name it `alphaprep-ng`.
2. Open the new database and copy its **Database ID** (a long code with dashes).
3. In GitHub, open `wrangler.toml` in this repository, press the pencil (edit) icon, replace `REPLACE_WITH_YOUR_D1_DATABASE_ID` with that ID, and commit. (The ID is not a secret.)

## 2. Create the tables (run each file once, in order)
In the D1 database page open the **Console** tab. For each file below, open it on GitHub, press **Raw**, copy everything, paste it into the Console and run it:

1. `migrations/0001_init.sql`
2. `migrations/0002_seed.sql`
3. `migrations/0003_phase2.sql`
4. `migrations/0004_phase3_freeze.sql`

If the console rejects a large paste, run the file in two halves, splitting only **after a line that ends with `;`**. Alternatively, on a PC with Node installed: `npm install`, then `npx wrangler login`, then `npm run db:migrate:remote`.

## 3. Create the website
1. **Workers & Pages → Create → Pages → Connect to Git**, choose this repository.
2. Build settings: framework **None**, build command `npm run build`, output directory `dist`.
3. Save and deploy. The first build takes a few minutes.

## 4. Secrets (never put these in GitHub)
Pages project → **Settings → Variables and Secrets** → add as **Secret**:
- `SESSION_PEPPER`: a random string of 32+ characters.
- `ADMIN_BOOTSTRAP_SECRET`: another random string of 24+ characters.

Keep both somewhere safe (a password manager). Then **redeploy** (Deployments → the latest → Retry deployment) so they take effect.

## 5. Create the first administrator
Open `https://YOUR-SITE.pages.dev/admin/setup`, enter the bootstrap secret, choose a username and a strong password (12+ characters). This page stops working once an administrator exists. Sign in at `/admin/login`.

If sign-in fails with a timeout-like error, Cloudflare's free CPU limit is probably too tight for password hashing. Add a plain variable `PBKDF2_ITERATIONS` = `50000` (or lower) and redeploy. Lower numbers are weaker; this is a trade-off.

## 6. First-day checklist
1. **Settings**: set the UTME countdown, check the social links, upload the logo, set the public site address.
2. **Import** questions (template available on the page). Use the preview. Questions without answers are kept out of exams.
3. **Question bank**: mark reviewed questions as verified.
4. **Exams → New exam**: pick the date and times (Lagos time), generate every subject, preview, approve, publish.
5. Register yourself as a participant on the public site and sit a test exam on a second device before announcing.

## Backups
- Weekly: **Leaderboards and exports** page → download Participants, All results and Question bank CSVs; store them privately.
- Full database copy (PC): `npx wrangler d1 export alphaprep-ng --remote --output backup.sql`. Keep it private: it contains personal data.
- D1 also offers Time Travel (point-in-time restore) for a limited recent window; check Cloudflare's docs for how long the free plan keeps it. Do not rely on it instead of your own exports.

## Free-plan limits to watch
Workers Free: 100,000 requests/day and 10 ms CPU per request. D1 Free: 5 million rows read and 100,000 rows written per day; when exceeded, the site fails until 00:00 UTC. Each saved batch of answers is one write, plus a few per participant for start and submit, so roughly one to two thousand participants a day is the practical ceiling. Check Cloudflare's current pricing page before launch day.
