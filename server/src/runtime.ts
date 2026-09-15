/**
 * Runtime shape detection.
 *
 * On Vercel the process is frozen the instant a response is flushed, so work
 * queued with setImmediate() after res.send() may never run. Routes that
 * deliberately answer first and work afterwards (the WhatsApp webhooks) check
 * this flag and await their work instead.
 *
 * VERCEL is set automatically in every Vercel build and runtime environment.
 */
export const isServerless = Boolean(process.env.VERCEL)

/**
 * Should migrations + seeding run when the app boots?
 *
 * Long-lived deployments (local dev, PM2) migrate at boot as before. On
 * serverless every cold start would race every other cold start for the
 * migration lock, so migrations run once during the build instead
 * (`npm run migrate -w server`). Override with RUN_MIGRATIONS_AT_BOOT.
 */
export function migrateAtBoot(): boolean {
  const flag = process.env.RUN_MIGRATIONS_AT_BOOT
  if (flag !== undefined && flag !== '') {
    return ['1', 'true', 'yes', 'on'].includes(flag.toLowerCase())
  }
  return !isServerless
}
