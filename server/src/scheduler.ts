/**
 * Scheduled jobs (architecture §3.1) — all cron expressions come from
 * config.cron (env-overridable) and are evaluated in IST, matching the
 * programme's calendar logic:
 *   darwinboxSync  (default 02:30 IST daily)   → directory sync (FR-1)
 *   flagScan       (default 03:15 IST daily)   → BR-5 nightly sweep
 *   weeklyDigest   (default Mon 09:00 IST)     → FR-20 weekly digest
 */
import { schedule, validate } from 'node-cron'
import { config } from './config'
import { IST } from './db/time'
import { runDirectorySync } from './modules/sync/darwinbox'
import { nightlySweep } from './modules/flags/flagScan'
import { sendWeeklyDigest } from './modules/digest/digest'
import { sendInactivityReminders } from './modules/conversation/reminder'

let started = false

/** One-line result summary for the run log. */
function summarize(result: unknown): string {
  if (result === undefined || result === null) return ''
  if (typeof result === 'object') {
    const message = (result as { message?: unknown }).message
    if (typeof message === 'string') return ` — ${message}`
    return ` — ${JSON.stringify(result)}`
  }
  return ` — ${String(result)}`
}

/**
 * `quietWhenIdle` suppresses the per-run completion line for jobs that run at
 * minute resolution. Without it the flow-reminder sweep writes 1,440 identical
 * "completed in 0.0s" lines a day and buries everything else in the log.
 */
function scheduleJob(
  name: string,
  expression: string,
  run: () => Promise<unknown>,
  quietWhenIdle: (result: unknown) => boolean = () => false,
): void {
  if (!validate(expression)) {
    // A bad env override must not crash boot — log loudly and skip the job.
    console.error(`[scheduler] invalid cron expression for ${name}: "${expression}" — job NOT scheduled`)
    return
  }
  schedule(
    expression,
    async () => {
      const startedAt = Date.now()
      try {
        const result = await run()
        if (quietWhenIdle(result)) return
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1)
        console.log(`[scheduler] ${name} completed in ${secs}s${summarize(result)}`)
      } catch (err) {
        console.error(`[scheduler] ${name} failed:`, err)
      }
    },
    { timezone: IST },
  )
  console.log(`[scheduler] ${name} scheduled: "${expression}" (${IST})`)
}

/** Start all cron jobs. Safe to call once per process — repeats are ignored. */
export function startScheduler(): void {
  if (started) {
    console.warn('[scheduler] already started — ignoring duplicate start')
    return
  }
  started = true
  scheduleJob('darwinbox-sync', config.cron.darwinboxSync, runDirectorySync)
  scheduleJob('flag-scan', config.cron.flagScan, nightlySweep)
  scheduleJob('weekly-digest', config.cron.weeklyDigest, sendWeeklyDigest)
  // Minute-resolution sweep for the single mid-flow inactivity reminder. It is
  // a cheap indexed range query over conversation_state, which only ever holds
  // in-flight conversations, so running it every minute costs nothing.
  if (config.conversation.remindersEnabled) {
    scheduleJob(
      'flow-reminder',
      config.cron.flowReminder,
      sendInactivityReminders,
      (r) => (r as { sent?: number } | undefined)?.sent === 0,
    )
  } else {
    console.log('[scheduler] flow-reminder disabled (REMINDERS_ENABLED=false)')
  }
}
