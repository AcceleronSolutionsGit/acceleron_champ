# Deploying Acceleron CHAMP to Vercel

The whole application — React console, Express API, WhatsApp webhooks and the three
scheduled jobs — runs from one Vercel project. The SPA is served as static files, the
Express app runs as a single serverless function, and the jobs run as Vercel Cron.

---

## 0. Two things to confirm before you start

**Your MySQL server must accept connections from the public internet.**
Vercel functions and build machines have rotating egress IPs, so an IP allowlist or a
VPN-only database will not work. If the MySQL box is on the office network, you need
either a publicly reachable managed MySQL (PlanetScale, Aiven, AWS RDS with public
access, Railway) or a tunnel. Static egress IPs need Vercel Pro + Secure Compute.

**Check your Vercel plan against the cron limits.**
This app has three jobs. Hobby allows 2 cron jobs; Pro allows 40. On Hobby, drop one
entry from `vercel.json` and trigger that job from an external scheduler
(cron-job.org, GitHub Actions) — the endpoints are plain HTTPS, see §7.

---

## 1. What changed in the repo

Vercel is serverless: no persistent disk, no long-lived process, and the instance is
frozen the moment a response is sent. Four things in the app assumed otherwise.

| Assumption | Now |
|---|---|
| SQLite file on disk | MySQL via `DATABASE_CLIENT=mysql2` + `DATABASE_URL` |
| `node-cron` timers in-process | Vercel Cron → `GET /api/cron/<job>` (`server/src/routes/cron.ts`) |
| Migrations + seeding on every boot | Once per deploy, in the build (`server/src/db/migrate.ts`) |
| Webhook acks first, replies after | On Vercel it finishes the reply, *then* acks |

New files:

- `vercel.json` — build, routing, function limits, cron schedules
- `api/index.js` — the serverless entry point; wraps the Express app
- `server/src/app.ts` — the Express app factory, split out of `index.ts`
- `server/src/runtime.ts` — `isServerless` / `migrateAtBoot` flags
- `server/src/routes/cron.ts` — the three jobs as authenticated HTTP endpoints
- `server/src/db/migrate.ts` — `npm run migrate -w server`

`npm run dev`, `npm start` and the PM2 deployment behave exactly as before — every
serverless branch is behind `process.env.VERCEL`, which only Vercel sets.

---

## 2. Prepare the MySQL database

Create an empty database and a user:

```sql
CREATE DATABASE champ CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'champ'@'%' IDENTIFIED BY '<strong-password>';
GRANT ALL PRIVILEGES ON champ.* TO 'champ'@'%';
FLUSH PRIVILEGES;
```

Your connection string:

```
mysql://champ:<password>@<host>:3306/champ
```

If the host requires TLS (most managed providers do), append:

```
?ssl={"rejectUnauthorized":true}
```

Don't create any tables — the build step runs the migrations.

---

## 3. Push to GitHub

The remote is already `AcceleronSolutionsGit/acceleron_champ`.

```bash
git add .
git commit -m "Add Vercel deployment: serverless entry, cron endpoints, build-time migrations"
git push origin master
```

---

## 4. Import the project into Vercel

1. vercel.com → **Add New… → Project** → import `acceleron_champ`.
2. Framework Preset: **Other**.
3. **Root Directory must be `./` — the repo root.** This is the setting Vercel's
   monorepo detection tends to get wrong here: it sees the `server` and `web`
   workspaces and offers to build one of them. It must not. `vercel.json`, `api/` and
   `web/` all live at the repo root and none of them are visible from inside a
   workspace folder. Getting this wrong fails the build with:

   ```
   npm error Lifecycle script `vercel-build` failed with error:
   npm error workspace @champ/server@0.1.0
   npm error location /vercel/path0/server
   npm error Missing script: "vercel-build"
   ```

   The `location` line is the tell — it names the folder Vercel actually built from.
   Fix it in Settings → Build & Deployment → Root Directory, then redeploy.
4. Don't touch Build Command / Output Directory — `vercel.json` sets them
   (`npm run vercel-build`, output `web/dist`).
5. **Add the environment variables in §5 before clicking Deploy** — the build runs
   the migrations, so it fails without `DATABASE_URL`.

---

## 5. Environment variables

Settings → Environment Variables. Add each to **Production** (and Preview if you want
working preview deploys — point those at a separate database).

### Required

| Name | Value |
|---|---|
| `SESSION_SECRET` | 32+ random bytes — `openssl rand -hex 32`. The app refuses to boot in production with the dev default. |
| `DATABASE_CLIENT` | `mysql2` |
| `DATABASE_URL` | the string from §2 |
| `VITE_BASE_PATH` | `/` — the console lives at the domain root on Vercel, not under `/acceleron_champ/` |
| `CRON_SECRET` | `openssl rand -hex 32`. Vercel sends it as `Authorization: Bearer …` on cron calls; `/api/cron/*` rejects everything else. |
| `ALLOWED_EMAIL_DOMAIN` | e.g. `acceleronsolutions.io` |
| `ADMIN_EMAILS` | comma-separated |
| `COMMITTEE_EMAILS` | comma-separated |

### Email (OTP login won't work without it)

`EMAIL_PROVIDER=console` prints the OTP to the server log instead of sending it, which
is no good in production.

| Name | Value |
|---|---|
| `EMAIL_PROVIDER` | `smtp` |
| `EMAIL_FROM` | `no-reply@acceleronsolutions.io` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | from your mail provider |

### WhatsApp

| Name | Value |
|---|---|
| `WHATSAPP_PROVIDER` | `meta` or `gallabox` |
| Meta | `META_WA_PHONE_NUMBER_ID`, `META_WA_TOKEN`, `META_WA_APP_SECRET`, `META_WA_VERIFY_TOKEN` |
| Gallabox | `GALLABOX_API_KEY`, `GALLABOX_API_SECRET`, `GALLABOX_CHANNEL_ID`, `GALLABOX_WEBHOOK_SECRET` |

### Optional

| Name | Value |
|---|---|
| `DISPLAY_TIMEZONE` | `Asia/Kolkata` (default) |
| `ENABLE_SIMULATOR` | leave unset — off in production |
| `BOARD_TOKEN` | token for the public plant board |
| `SEED_DEMO_DATA` | `true` **only** if you want the demo directory loaded into an empty database. Leave unset for real data. |
| `DARWINBOX_ENABLED` + `DARWINBOX_*` | if the nightly HRMS sync is in use |

`NODE_ENV=production` and `VERCEL=1` are set by Vercel — don't add them.
Don't set `PORT`; there's no listener.

---

## 6. Deploy and verify

Click Deploy, then check in order:

```bash
# 1. the API is alive and talking to MySQL
curl https://<your-app>.vercel.app/api/health
# → {"ok":true,"env":"production","whatsapp":"meta","email":"smtp","db":"mysql2","serverless":true}

# 2. cron auth is closed
curl -i https://<your-app>.vercel.app/api/cron/flag-scan          # → 401

# 3. cron works with the secret
curl -H "Authorization: Bearer $CRON_SECRET" \
     https://<your-app>.vercel.app/api/cron/flag-scan             # → {"ok":true,...}
```

Then open the app, request an OTP, and confirm the email arrives. Check
Vercel → Deployments → Build Logs for the `[migrate] migrations up to date` line, and
confirm the tables exist in phpMyAdmin.

---

## 7. Cron schedules

Vercel Cron runs in **UTC**. The IST times are already converted in `vercel.json`:

| Job | IST | UTC (`vercel.json`) |
|---|---|---|
| `darwinbox-sync` | 02:30 daily | `0 21 * * *` |
| `flag-scan` | 03:15 daily | `45 21 * * *` |
| `weekly-digest` | Mon 09:00 | `30 3 * * 1` |

They appear under Project → Cron Jobs after the first deploy. To run one from an
external scheduler instead:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/cron/weekly-digest
```

---

## 8. Point WhatsApp at the new URL

Meta (developers.facebook.com → your app → WhatsApp → Configuration):

- Callback URL: `https://<your-app>.vercel.app/webhook/whatsapp`
- Verify token: the value of `META_WA_VERIFY_TOKEN`

Gallabox: `https://<your-app>.vercel.app/webhook/gallabox`

Do this **after** adding a custom domain if you plan to use one — changing it later
means re-verifying with Meta.

---

## 9. Known limits of this deployment

Worth knowing before they surprise you.

- **Function timeout is 60s** (`vercel.json` → `maxDuration`). A full Darwinbox
  directory sync of a large org can exceed that and get killed mid-run. On Pro you can
  raise it to 300; otherwise run the sync from a machine that isn't time-limited
  (`npm run sync:darwinbox -w server`).
- **npm 12 blocks dependency install scripts.** The root `package.json` carries an
  `allowScripts` block for `esbuild` and `better-sqlite3`. Remove it and the build
  still "succeeds" at install time, then `vite build` dies with *"You installed
  esbuild for another platform"* — the postinstall that fetches the platform binary
  never ran. Adding a dependency with an install script means adding it there too;
  `npm install` warns when one is uncovered.
- **Rate limiting is per-instance.** `express-rate-limit` keeps counters in memory, so
  the OTP and API limits now apply per warm lambda rather than globally. For a real
  ceiling, move to `rate-limit-redis` with Upstash.
- **The WhatsApp webhook is slower to ack.** It now completes the conversation-engine
  reply before returning 200, because a serverless instance stops executing the moment
  it responds. If Meta starts reporting delivery failures, that's the thing to look at.
- **Cold starts.** The first request after idle pays the Express boot plus a new MySQL
  connection — roughly 1–3 seconds.
- **Connection pool is capped at 2 per instance** (`server/src/db/knex.ts`), because
  each concurrent lambda opens its own. Watch `max_connections` under load.
- **Migrations run at build time.** A deploy whose build fails leaves the database
  untouched, which is the safe direction, but it also means a migration failure fails
  the deploy.
- **No persistent disk.** Anything writing to `data/` or the filesystem won't survive a
  request. The Excel export streams its response, so it's fine.

---

## 10. Rolling back

Vercel → Deployments → pick the previous one → **Promote to Production**. Note this
does *not* roll back database migrations; write a down-migration if you need that.
