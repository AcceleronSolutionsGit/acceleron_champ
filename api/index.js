/**
 * Vercel serverless entry point for the Acceleron CHAMP application service.
 *
 * Every /api/* and /webhook/* request is rewritten to this function by
 * vercel.json; the Express app inside handles routing exactly as it does under
 * PM2. The SPA in web/dist is served by Vercel's static layer, not by Express.
 *
 * Differences from `npm start` (server/src/index.ts):
 *   - no server.listen() — Vercel invokes this handler per request;
 *   - no node-cron scheduler — the three jobs run as Vercel Cron Jobs that
 *     call /api/cron/<job> (see server/src/routes/cron.ts and vercel.json);
 *   - no migrations at boot — they run once during the build
 *     (`npm run migrate -w server`, part of `vercel-build`).
 */
/**
 * Normalise NODE_ENV BEFORE anything reads config.
 *
 * Vercel does not reliably set NODE_ENV inside the function runtime, and
 * server/src/config.ts falls back to 'development' when it is absent. That
 * fallback is not cosmetic: it flips config.isProd false, which (a) skips
 * assertProductionSecrets() so a missing SESSION_SECRET silently signs
 * sessions with the public dev default, (b) drops the `secure` flag from the
 * session cookie, and (c) defaults ENABLE_SIMULATOR to ON, exposing the dev
 * WhatsApp simulator publicly.
 *
 * VERCEL_ENV is the authoritative signal — Vercel always sets it to
 * 'production' | 'preview' | 'development'. This runs before the require()
 * below, because config.ts reads process.env at import time.
 */
if (!process.env.NODE_ENV && process.env.VERCEL_ENV) {
  process.env.NODE_ENV = process.env.VERCEL_ENV === 'production' ? 'production' : 'development'
}

/** The app is built once per warm lambda and reused across invocations. */
let appPromise = null

function getApp() {
  if (!appPromise) {
    const { createApp } = require('../server/dist/app.js')
    appPromise = createApp().catch((err) => {
      // Never cache a failed boot — the next request should retry.
      appPromise = null
      throw err
    })
  }
  return appPromise
}

/**
 * Vercel's Node bridge may have already read and parsed the request body.
 * When it has, hand the bytes to Express instead of letting body-parser try to
 * re-read a consumed stream (`_body = true` is body-parser's own "already
 * handled" flag), and expose the raw buffer for the WhatsApp HMAC check.
 *
 * When `req.body` is undefined the stream is untouched — the preferred path,
 * because express.raw() then sees Meta's exact bytes and the signature
 * verifies byte-for-byte.
 */
function adoptPlatformBody(req) {
  const parsed = req.body
  if (parsed === undefined) return

  req.rawBody = Buffer.isBuffer(parsed)
    ? parsed
    : typeof parsed === 'string'
      ? Buffer.from(parsed, 'utf8')
      : Buffer.from(JSON.stringify(parsed), 'utf8')
  req._body = true
  req.body = parsed
}

module.exports = async (req, res) => {
  try {
    const app = await getApp()
    adoptPlatformBody(req)
    return app(req, res)
  } catch (err) {
    console.error('[vercel] failed to start the application service:', err)
    res.statusCode = 500
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        error: { code: 'BOOT_FAILED', message: 'The application service failed to start' },
      }),
    )
  }
}
