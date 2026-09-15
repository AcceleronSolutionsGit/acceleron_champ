# Deploying Acceleron CHAMP to Vercel

The whole application — React console, Express API, WhatsApp webhooks and the three
scheduled jobs — runs from one Vercel project. The SPA is served as static files, the
Express app runs as a single serverless function, and the jobs run as Vercel Cron.

---

## 0. Two things to confirm before you start

**Your database must accept connections from the public internet.**
Vercel functions and build machines have rotating egress IPs, so an IP allowlist or a
VPN-only database will not work. Neon (§2) is a public managed service, so this is a
non-issue there — it only bites if you point `DATABASE_URL` at a database on the office
network. Static egress IPs need Vercel Pro + Secure Compute.

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
| SQLite file on disk | Managed Postgres via `DATABASE_CLIENT=pg` + `DATABASE_URL` |
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
- `api/whatsapp.mjs` — the Meta webhook, as a Web-signature function (see §9)

`npm run dev`, `npm start` and the PM2 deployment behave exactly as before — every
serverless branch is behind `process.env.VERCEL`, which only Vercel sets.

---

## 2. Prepare the database (Neon Postgres)

The app runs on Postgres, MySQL or SQLite — knex picks the dialect from
`DATABASE_CLIENT`. Postgres is the right choice on Vercel: Neon's pooled endpoint is
built for many short-lived serverless connections, where a fixed-connection MySQL box
is not, and Neon has a free tier that does not expire.

1. Sign up at neon.tech and create a project. **Pick the region closest to your users**
   — see the residency note below.
2. Copy the **pooled** connection string from the dashboard. The hostname contains
   `-pooler`; that is the one you want on serverless:

   ```
   postgresql://champ:<password>@ep-xxxx-pooler.<region>.aws.neon.tech/champ?sslmode=require
   ```

3. Don't create any tables — the build step runs the migrations.

**Keep `?sslmode=require`.** The `pg` driver maps it to a verified TLS connection
against Neon's publicly trusted certificate. Only use `sslmode=no-verify` if you move
to a provider with a self-signed certificate — it turns certificate checking off.

**Data residency.** This database holds employee names, phone numbers and recognition
history. The original design called for ap-south-1 (Mumbai) for DPDP. Check Neon's
region list before you create the project; if Mumbai isn't offered on your plan and
residency is a hard requirement, Supabase has a Mumbai region — but its free projects
pause after about a week of inactivity, which is a poor fit for a tool people sign into
occasionally.

### Staying on MySQL instead

Nothing in the code stops you. Set `DATABASE_CLIENT=mysql2` and a
`mysql://user:pass@host:3306/champ` URL (add `?ssl={"rejectUnauthorized":true}` if the
host requires TLS). Everything in this guide otherwise applies unchanged.

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
| `DATABASE_CLIENT` | `pg` |
| `DATABASE_URL` | the string from §2 |
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
| `VITE_BASE_PATH` | Not needed on Vercel — `vite.config.ts` defaults to `/` when `VERCEL` is set. Only set it to deploy under some other prefix, and note it is a **build-time** variable: changing it does nothing until you redeploy. |
| `DISPLAY_TIMEZONE` | `Asia/Kolkata` (default) |
| `ENABLE_SIMULATOR` | leave unset — off in production |
| `BOARD_TOKEN` | token for the public plant board |
| `SEED_DEMO_DATA` | `true` **only** if you want the demo directory loaded into an empty database. Leave unset for real data. |
| `DARWINBOX_ENABLED` + `DARWINBOX_*` | if the nightly HRMS sync is in use |

Don't set `PORT`; there's no listener. `NODE_ENV` is unnecessary too — `api/index.js`
derives it from `VERCEL_ENV`, and `config.ts` also treats `VERCEL_ENV=production` as
production regardless. Setting it by hand is harmless (the value is lower-cased, so
`PRODUCTION` works), but it is one more thing to get wrong.

Check `/api/health` reports `"env":"production"` — if it says `development`, the app is
running with its production safety checks off (see §9).

---

## 6. Deploy and verify

Click Deploy, then check in order:

```bash
# 1. the API is alive and talking to the database
curl https://<your-app>.vercel.app/api/health
# → {"ok":true,"env":"production","whatsapp":"meta","email":"smtp","db":"pg","serverless":true}

# 2. cron auth is closed
curl -i https://<your-app>.vercel.app/api/cron/flag-scan          # → 401

# 3. cron works with the secret
curl -H "Authorization: Bearer $CRON_SECRET" \
     https://<your-app>.vercel.app/api/cron/flag-scan             # → {"ok":true,...}

# 4. the dev WhatsApp simulator is NOT exposed
curl -i https://<your-app>.vercel.app/api/dev/simulator/contacts  # → 404

# 5. the webhook handshake endpoint answers (the Web-signature function)
curl -i "https://<your-app>.vercel.app/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=$META_WA_VERIFY_TOKEN&hub.challenge=12345"
# → 200 with body: 12345   (403 means META_WA_VERIFY_TOKEN does not match)

# 6. the console's assets load from the domain root, not /acceleron_champ/
curl -s https://<your-app>.vercel.app/ | grep -o 'src="[^"]*"'
# → src="/assets/index-xxxx.js"   (a /acceleron_champ/ prefix means VITE_BASE_PATH
#                                  was missing when the build ran)
```

In `/api/health`, `"env"` must read `production` and `"db"` must read `pg`.

Then open the app, request an OTP, and confirm the email arrives. Check
Vercel → Deployments → Build Logs for the `[migrate] migrations up to date` line, and
confirm the tables exist in Neon's SQL editor.

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
- **Two settings used to be manual and are now derived.** The console's base path
  comes from `VERCEL` in `vite.config.ts`, and production-ness from `VERCEL_ENV` in
  `config.ts` / `api/index.js`. Both were environment variables you had to set
  exactly right, and both failed silently when you didn't: a blank page with one
  console error, and production safety checks quietly off. If you ever move off
  Vercel, those two derivations are the first thing to revisit.
- **`NODE_ENV` is not guaranteed in the function.** `config.ts` falls back to
  `development` when it is absent, and that fallback turns off three production
  behaviours at once: the missing-`SESSION_SECRET` check, the `secure` flag on the
  session cookie, and — worst — `ENABLE_SIMULATOR` defaults to ON, publishing the
  unauthenticated dev WhatsApp simulator. `api/index.js` now sets `NODE_ENV` from
  `VERCEL_ENV` before config loads, and `app.ts` additionally refuses to mount the
  simulator on serverless without an explicit `ENABLE_SIMULATOR` opt-in. Keep both.
- **npm 12 blocks dependency install scripts.** The root `package.json` carries an
  `allowScripts` block for `esbuild` and `better-sqlite3`. Remove it and the build
  still "succeeds" at install time, then `vite build` dies with *"You installed
  esbuild for another platform"* — the postinstall that fetches the platform binary
  never ran. Adding a dependency with an install script means adding it there too;
  `npm install` warns when one is uncovered.
- **Rate limiting is per-instance.** `express-rate-limit` keeps counters in memory, so
  the OTP and API limits now apply per warm lambda rather than globally. For a real
  ceiling, move to `rate-limit-redis` with Upstash.
- **The Meta webhook is deliberately NOT served by the Express app.**
  `/webhook/whatsapp` is rewritten to `api/whatsapp.mjs`, a Web-signature
  function, because that is the only shape on Vercel that yields the request
  body as sent. Meta signs the exact bytes; Vercel's Node `(req, res)` handlers
  drain the stream before the handler runs and expose the body only via the
  lazily-parsed `req.body` helper, with no `req.rawBody` to recover it.
  Re-serialising gives equivalent JSON with different bytes, which passes for
  plain ASCII and fails for anything with an escaped character — a webhook that
  works for typed messages and 401s on button and list taps. The verification
  and delivery logic is shared with the Express route (`verifyAndParse` /
  `deliverAndReply` in `server/src/routes/webhook.ts`), so there is one
  implementation. Don't move this route back under `api/index.js`.
- **The WhatsApp webhook is slower to ack.** It now completes the conversation-engine
  reply before returning 200, because a serverless instance stops executing the moment
  it responds. If Meta starts reporting delivery failures, that's the thing to look at.
- **Cold starts.** The first request after idle pays the Express boot plus a new
  database connection — roughly 1–3 seconds. Neon scales its compute to zero when idle,
  so the first query after a quiet spell wakes it and adds a little more.
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
