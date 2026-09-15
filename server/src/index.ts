/**
 * Acceleron Champ · Spot Recognition Tool — long-running process entry point
 * (`npm start`, PM2, Docker).
 *
 * The Express app itself lives in src/app.ts so the Vercel serverless function
 * (api/index.js) can reuse it verbatim. This file adds the two things a
 * serverless deployment must not have: an HTTP listener and the in-process
 * node-cron scheduler.
 */
import http from 'http'
import { config } from './config'
import { createApp } from './app'
import { closeDb } from './db/knex'
import { startScheduler } from './scheduler'

async function main(): Promise<void> {
  const app = await createApp()

  startScheduler()

  const server = http.createServer(app)
  server.listen(config.port, () => {
    console.log(`[champ] listening on http://localhost:${config.port} (${config.nodeEnv})`)
    console.log(`[champ] whatsapp=${config.whatsapp.provider} email=${config.email.provider} db=${config.db.client}`)
    if (config.simulatorEnabled) console.log('[champ] WhatsApp simulator API enabled at /api/dev/simulator')
  })

  const shutdown = async (signal: string) => {
    console.log(`[champ] ${signal} — shutting down`)
    server.close()
    await closeDb()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[champ] fatal boot error:', err)
  process.exit(1)
})
