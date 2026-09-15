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

/** Refuse bodies larger than this rather than buffering without limit. */
const MAX_BODY_BYTES = 1024 * 1024

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
 * Read the request body as exact bytes, WITHOUT touching req.body first.
 *
 * This ordering is the whole point. On Vercel's Node runtime `req.body` is a
 * lazy accessor: reading it parses the JSON and consumes the stream, and the
 * original bytes are gone — the platform exposes no req.rawBody to recover
 * them. Re-serialising the parsed object with JSON.stringify gets you
 * *equivalent* JSON, not *identical* bytes, and Meta's X-Hub-Signature-256 is
 * an HMAC over the bytes.
 *
 * That difference is invisible for a plain ASCII payload, whose round-trip
 * happens to be byte-identical, and fatal for one where it isn't — a non-ASCII
 * character Meta sent as an escape (·) comes back as a raw UTF-8 byte, the
 * HMAC no longer matches, and the webhook answers 401 while the identical flow
 * with plainer text answers 200. Reading the stream first avoids the whole
 * class of problem.
 *
 * `_body = true` is body-parser's own "already handled" flag, so express.json()
 * and express.raw() downstream leave the consumed stream alone.
 */
function readExactBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false

    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(arg)
    }

    // A stream that never ends would hang the function until its timeout.
    const timer = setTimeout(() => finish(resolve, null), 10000)

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        finish(reject, Object.assign(new Error('Request body too large'), { statusCode: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(resolve, Buffer.concat(chunks)))
    req.on('error', (err) => finish(reject, err))
  })
}

async function captureExactBody(req) {
  const method = (req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return

  // Already consumed by something upstream — fall back below rather than hang.
  if (req.readableEnded || req.complete || req.readable === false) {
    const parsed = req.body
    if (parsed === undefined) return
    req.rawBody = Buffer.isBuffer(parsed)
      ? parsed
      : typeof parsed === 'string'
        ? Buffer.from(parsed, 'utf8')
        : Buffer.from(JSON.stringify(parsed), 'utf8')
    req.rawBodyIsExact = Buffer.isBuffer(parsed) || typeof parsed === 'string'
    req._body = true
    req.body = parsed
    return
  }

  const raw = await readExactBody(req)
  if (raw === null) return // timed out; leave the request for Express to handle

  req.rawBody = raw
  req.rawBodyIsExact = true
  req._body = true

  const contentType = String(req.headers['content-type'] || '')
  if (raw.length === 0) {
    req.body = {}
  } else if (contentType.includes('application/json')) {
    try {
      req.body = JSON.parse(raw.toString('utf8'))
    } catch {
      req.body = {}
    }
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    req.body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')))
  } else {
    req.body = raw
  }
}

module.exports = async (req, res) => {
  try {
    const app = await getApp()
    await captureExactBody(req)
    return app(req, res)
  } catch (err) {
    if (err && err.statusCode === 413) {
      res.statusCode = 413
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } }))
      return
    }
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
