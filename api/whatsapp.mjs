/**
 * Meta WhatsApp webhook — Vercel Web-signature function.
 *
 * WHY THIS EXISTS AS A SEPARATE FUNCTION
 *
 * Meta signs the exact bytes of the request body (X-Hub-Signature-256). Vercel's
 * Node `(req, res)` handlers — which api/index.js uses for the rest of the app —
 * cannot give you those bytes: the platform drains the request stream before the
 * handler runs and exposes the body only through the lazily-parsed `req.body`
 * helper, with no `req.rawBody` to fall back on. Re-serialising the parsed object
 * yields equivalent JSON with *different* bytes, so the HMAC fails. It fails
 * silently and selectively, too: a plain ASCII payload happens to round-trip
 * byte-identically and verifies, while one carrying an escaped character (an
 * interactive list reply echoing "IT Application · Kolkata", say) does not.
 * The symptom is a webhook that works for typed messages and 401s on button and
 * list taps.
 *
 * The Web signature has no such helper: `request.arrayBuffer()` is the body, as
 * sent. That is the whole reason this one route is not served by the Express app.
 *
 * Routing: vercel.json rewrites /webhook/whatsapp here, ahead of the catch-all
 * that sends the rest of /webhook/* and /api/* to api/index.js.
 *
 * The verification, parsing and delivery logic is NOT duplicated — it is imported
 * from server/dist/routes/webhook.js, the same module the Express route uses.
 */
import { createRequire } from 'node:module'
import { Buffer } from 'node:buffer'

const require = createRequire(import.meta.url)

// Match api/index.js: config reads process.env at import time, and Vercel does
// not reliably set NODE_ENV inside the function runtime.
if (!process.env.NODE_ENV && process.env.VERCEL_ENV) {
  process.env.NODE_ENV = process.env.VERCEL_ENV === 'production' ? 'production' : 'development'
}

const { initDb } = require('../server/dist/db/knex.js')
const { metaHandshake, verifyAndParse, deliverAndReply } = require('../server/dist/routes/webhook.js')

/** One connection pool per warm instance, like the Express app's. */
let dbPromise = null
function db() {
  if (!dbPromise) {
    dbPromise = initDb().catch((err) => {
      dbPromise = null
      throw err
    })
  }
  return dbPromise
}

export async function GET(request) {
  const params = new URL(request.url).searchParams
  const challenge = metaHandshake(
    params.get('hub.mode'),
    params.get('hub.verify_token'),
    params.get('hub.challenge'),
  )
  if (challenge === null) return new Response('Forbidden', { status: 403 })
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } })
}

export async function POST(request) {
  try {
    await db()

    // The bytes Meta signed, untouched.
    const rawBody = Buffer.from(await request.arrayBuffer())

    const { ok, messages } = verifyAndParse(rawBody, request.headers.get('x-hub-signature-256') ?? undefined, true)
    if (!ok) return new Response('Unauthorized', { status: 401 })

    // A serverless instance stops executing the moment the response is flushed,
    // so the engine has to finish before the ack rather than after it.
    if (messages.length > 0) await deliverAndReply(messages)

    return new Response('OK', { status: 200 })
  } catch (err) {
    console.error('[webhook] handler failed:', err)
    // Answer 200 so Meta does not retry a payload that will fail again; the
    // error is in the logs. A 5xx here triggers Meta's retry storm and can get
    // the subscription disabled.
    return new Response('OK', { status: 200 })
  }
}
