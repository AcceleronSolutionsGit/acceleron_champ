/**
 * Express application factory.
 *
 * Extracted from index.ts so the same app can be driven two ways:
 *   - server/src/index.ts  — `npm start` / PM2: listens on a port and runs the
 *     node-cron scheduler in-process;
 *   - api/index.js         — Vercel: one serverless function per request, with
 *     the scheduler replaced by Vercel Cron Jobs hitting /api/cron/<job>.
 *
 * The factory itself never listens and never starts cron.
 */
import express, { Express } from 'express'
import cookieParser from 'cookie-parser'
import path from 'path'
import fs from 'fs'
import { assertProductionSecrets, config } from './config'
import { initDb } from './db/knex'
import { seedIfEmpty, upsertAdminUsers } from './db/seed/demo'
import { errorHandler } from './middleware/errorHandler'
import { isServerless, migrateAtBoot } from './runtime'
import authRouter from './routes/auth'
import feedRouter from './routes/feed'
import employeesRouter from './routes/employees'
import adminRouter from './routes/admin'
import analyticsRouter from './routes/analytics'
import boardRouter from './routes/board'
import cronRouter from './routes/cron'
import webhookRouter from './routes/webhook'
import gallaboxWebhookRouter from './routes/gallaboxWebhook'
import simulatorRouter from './routes/simulator'

/** True only when ENABLE_SIMULATOR is explicitly set to a truthy value. */
function simulatorExplicitlyEnabled(): boolean {
  const v = (process.env.ENABLE_SIMULATOR ?? '').toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(v)
}

export async function createApp(): Promise<Express> {
  // ── AWS Secrets Manager (optional) ─────────────────────────────────────────
  // const { loadAwsSecretsIntoEnv } = await import('./aws/secretsManager')
  // await loadAwsSecretsIntoEnv()
  // rebuildConfig() // ← import { rebuildConfig } from './config'

  assertProductionSecrets()

  const db = await initDb()

  // On serverless this already happened during the build (server/src/db/migrate.ts);
  // doing it per cold start would hammer the database for no benefit.
  if (migrateAtBoot()) {
    await seedIfEmpty(db)
    await upsertAdminUsers(db)
  }

  const app = express()
  app.set('trust proxy', 1) // behind Vercel's edge / an ALB in production

  // Strip optional /acceleron_champ base prefix for API and webhook routes
  app.use((req, _res, next) => {
    if (req.url.startsWith('/acceleron_champ/api') || req.url.startsWith('/acceleron_champ/webhook')) {
      req.url = req.url.slice('/acceleron_champ'.length)
    }
    next()
  })

  // The WhatsApp webhooks must be mounted BEFORE global body parsing where needed
  app.use('/webhook/whatsapp', webhookRouter)
  app.use('/webhook/gallabox', gallaboxWebhookRouter)

  app.use(express.json({ limit: '256kb' }))
  app.use(cookieParser())

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      env: config.nodeEnv,
      whatsapp: config.whatsapp.provider,
      email: config.email.provider,
      db: config.db.client,
      serverless: isServerless,
    })
  })

  app.use('/api/auth', authRouter)
  app.use('/api/feed', feedRouter)
  app.use('/api/employees', employeesRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api/analytics', analyticsRouter)
  app.use('/api/board', boardRouter)
  // Scheduled jobs as HTTP endpoints, so Vercel Cron can invoke them.
  app.use('/api/cron', cronRouter)
  // Dev-only in-app WhatsApp phone — it drives the real conversation engine with
  // no authentication, so an accidentally-exposed one lets anyone post
  // recognitions as any employee. config.simulatorEnabled defaults to ON
  // whenever NODE_ENV is not "production", which is one missing environment
  // variable away on a hosted deployment. On serverless it therefore requires an
  // explicit ENABLE_SIMULATOR opt-in rather than inheriting that default.
  if (isServerless ? simulatorExplicitlyEnabled() : config.simulatorEnabled) {
    app.use('/api/dev/simulator', simulatorRouter)
  }

  // Serve the built web console when it sits next to the server (PM2 / `npm start`).
  // On Vercel the SPA is served by the static layer, so web/dist is absent here
  // and this block is skipped.
  const webDist = path.join(config.projectRoot, 'web', 'dist')
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/webhook/')) return next()
      res.sendFile(path.join(webDist, 'index.html'))
    })
  }

  app.use(errorHandler)

  return app
}
