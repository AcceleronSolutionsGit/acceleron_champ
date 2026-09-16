/**
 * Scheduled jobs as HTTP endpoints — mounted at /api/cron.
 *
 * On a long-running host the three jobs are driven in-process by node-cron
 * (src/scheduler.ts). Serverless has no process to hold a timer, so Vercel Cron
 * Jobs call these endpoints instead; the schedules live in vercel.json and the
 * job bodies are the same functions the scheduler calls.
 *
 * AUTH: Vercel sends `Authorization: Bearer $CRON_SECRET` on every cron
 * invocation once CRON_SECRET is set as an environment variable. Without that
 * variable these endpoints refuse every request — an unauthenticated
 * /api/cron/darwinbox-sync would let anyone trigger a full directory sync.
 *
 * TIMEZONES: vercel.json schedules are UTC. The IST times the programme is
 * specified in (02:30 / 03:15 daily, Mon 09:00) are UTC−5:30 of those:
 * 21:00, 21:45 the previous day, and Mon 03:30.
 */
import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import { runDirectorySync } from '../modules/sync/darwinbox'
import { nightlySweep } from '../modules/flags/flagScan'
import { sendWeeklyDigest } from '../modules/digest/digest'
import { sendInactivityReminders } from '../modules/conversation/reminder'

const router = Router()

const JOBS: Record<string, () => Promise<unknown>> = {
  'darwinbox-sync': runDirectorySync,
  'flag-scan': nightlySweep,
  'weekly-digest': sendWeeklyDigest,
  // Minute-resolution. On Vercel this needs a Pro plan (Hobby cron is limited
  // to one run per day); any external minute scheduler hitting this endpoint
  // with the CRON_SECRET bearer works just as well.
  'flow-reminder': sendInactivityReminders,
}

/** Jobs whose every-minute completion line would flood the log. */
const QUIET_JOBS = new Set(['flow-reminder'])

/** Constant-time bearer check against CRON_SECRET. */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const header = req.header('authorization') ?? ''
  const expected = `Bearer ${secret}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

async function handle(req: Request, res: Response): Promise<void> {
  const name = req.params.job
  const job = JOBS[name]

  if (!job) {
    res.status(404).json({ error: { code: 'UNKNOWN_JOB', message: `No scheduled job named "${name}"` } })
    return
  }

  if (!authorized(req)) {
    if (!process.env.CRON_SECRET) {
      console.error('[cron] CRON_SECRET is not set — refusing to run jobs over HTTP')
    }
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron credentials' } })
    return
  }

  const startedAt = Date.now()
  try {
    const result = await job()
    const seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1))
    const idle = QUIET_JOBS.has(name) && (result as { sent?: number } | undefined)?.sent === 0
    if (!idle) console.log(`[cron] ${name} completed in ${seconds}s`)
    res.json({ ok: true, job: name, seconds, result: result ?? null })
  } catch (err) {
    console.error(`[cron] ${name} failed:`, err)
    res.status(500).json({
      error: { code: 'JOB_FAILED', message: err instanceof Error ? err.message : String(err) },
    })
  }
}

// Vercel Cron issues GET; POST is here so you can trigger a job manually with curl.
router.get('/:job', (req, res) => void handle(req, res))
router.post('/:job', (req, res) => void handle(req, res))

export default router
