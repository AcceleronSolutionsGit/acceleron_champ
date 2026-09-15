/**
 * Meta WhatsApp Cloud API webhook (SPEC §4) — mounted at /webhook/whatsapp
 * BEFORE express.json() so the raw body is available for HMAC verification.
 *
 * GET  /  — Meta verification handshake (hub.mode / hub.verify_token / hub.challenge).
 * POST /  — signed event delivery: verify X-Hub-Signature-256 over the raw
 *           body, parse messages to InboundMessage, ack 200 immediately, then
 *           run the conversation engine and send replies via the provider.
 */
import express, { Router, Request, Response } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { config } from '../config'
import { InboundMessage } from '../types'
import { processInboundMessage } from '../modules/conversation/engine'
import { getWhatsAppProvider } from '../modules/whatsapp/provider'
import { getDb } from '../db/knex'
import { nowIso } from '../db/time'
import { isServerless } from '../runtime'

const router = Router()

// Raw body inside this router only — the HMAC is computed over exact bytes.
router.use(express.raw({ type: '*/*' }))

// ── GET — subscription verification handshake ─────────────────────────────────

router.get('/', (req: Request, res: Response) => {
  const challenge = metaHandshake(req.query['hub.mode'], req.query['hub.verify_token'], req.query['hub.challenge'])
  if (challenge === null) {
    res.sendStatus(403)
    return
  }
  res.status(200).send(challenge)
})

// ── POST — event delivery ─────────────────────────────────────────────────────

/** Tolerant schema for the slice of the Meta payload we consume; everything
 *  else (statuses, contacts, metadata) passes through unvalidated. */
const metaMessageSchema = z
  .object({
    id: z.string().optional(),
    from: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).optional(),
    interactive: z
      .object({
        list_reply: z.object({ id: z.string() }).optional(),
        button_reply: z.object({ id: z.string() }).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()

const metaPayloadSchema = z
  .object({
    object: z.string().optional(),
    entry: z
      .array(
        z
          .object({
            changes: z
              .array(
                z
                  .object({
                    value: z
                      .object({ messages: z.array(metaMessageSchema).optional() })
                      .passthrough(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

type MetaPayload = z.infer<typeof metaPayloadSchema>

let warnedNoAppSecret = false

/**
 * Exact bytes of the request, for the HMAC.
 *
 * Normally express.raw() above leaves a Buffer in req.body. On Vercel the
 * platform may have consumed and parsed the stream before Express saw it, in
 * which case api/index.js leaves the bytes on req.rawBody. If it could only
 * re-serialise a parsed object the bytes will not match Meta's signature —
 * that case is logged rather than silently accepted.
 */
function exactBody(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body
  const raw = (req as Request & { rawBody?: Buffer }).rawBody
  if (Buffer.isBuffer(raw)) return raw
  return Buffer.alloc(0)
}

/**
 * Meta's GET subscription handshake, framework-free so both the Express route
 * and the Web-signature function in api/whatsapp.mjs can use it.
 * Returns the challenge to echo, or null to answer 403.
 */
export function metaHandshake(
  mode: unknown,
  verifyToken: unknown,
  challenge: unknown,
): string | null {
  if (mode === 'subscribe' && verifyToken === config.whatsapp.meta.verifyToken && typeof challenge === 'string') {
    return challenge
  }
  return null
}

/**
 * Verify the signature over `rawBody` and parse it into InboundMessages.
 *
 * Framework-free and byte-exact by contract: the CALLER is responsible for
 * handing over the bytes Meta actually sent. On Vercel that means a Web
 * signature handler and request.arrayBuffer() — the Node (req, res) helpers
 * expose the body only as a lazily-parsed object, and re-serialising it
 * produces equivalent JSON with different bytes, which the HMAC rejects.
 */
export function verifyAndParse(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  bytesAreExact = true,
): { ok: boolean; messages: InboundMessage[] } {
  const appSecret = config.whatsapp.meta.appSecret
  if (appSecret) {
    if (!verifySignature(rawBody, signatureHeader, appSecret)) {
      console.warn(
        `[webhook] signature mismatch — ${
          rawBody.length === 0
            ? 'no body bytes were captured'
            : !bytesAreExact
              ? 'body bytes are RE-SERIALISED, not the originals — HMAC cannot match'
              : 'exact body bytes; check META_WA_APP_SECRET'
        } (${rawBody.length} bytes)`,
      )
      return { ok: false, messages: [] }
    }
  } else if (!warnedNoAppSecret) {
    warnedNoAppSecret = true
    console.warn('[webhook] META_WA_APP_SECRET not set — accepting unsigned webhook payloads (dev only)')
  }

  let payload: MetaPayload | null = null
  try {
    const parsed = metaPayloadSchema.safeParse(JSON.parse(rawBody.toString('utf8')))
    if (parsed.success) payload = parsed.data
    else console.warn('[webhook] unrecognised payload shape:', parsed.error.issues[0]?.message)
  } catch {
    console.warn('[webhook] non-JSON payload ignored')
  }

  return { ok: true, messages: payload ? toInboundMessages(payload) : [] }
}

router.post('/', async (req: Request, res: Response) => {
  const rawBody = exactBody(req)
  const bytesAreExact = (req as Request & { rawBodyIsExact?: boolean }).rawBodyIsExact !== false

  const { ok, messages } = verifyAndParse(rawBody, req.header('x-hub-signature-256'), bytesAreExact)
  if (!ok) {
    res.sendStatus(401)
    return
  }

  if (messages.length === 0) {
    res.sendStatus(200)
    return
  }

  if (isServerless) {
    // A serverless instance is frozen the moment the response is flushed, so
    // work queued for "after the ack" would never run. Finish first, then ack.
    // Keep the function's maxDuration comfortably above the engine's worst case
    // (vercel.json) — Meta retries anything that does not answer in time.
    await deliverAndReply(messages)
    res.sendStatus(200)
    return
  }

  // Long-running host: ack fast — Meta retries (and eventually disables) slow webhooks.
  res.sendStatus(200)
  setImmediate(() => {
    void deliverAndReply(messages)
  })
})

/** Constant-time comparison of `sha256=<hex>` header vs our own HMAC. */
function verifySignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header) return false
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`
  const a = Buffer.from(header)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Flatten entry[].changes[].value.messages[] into our InboundMessage shape. */
function toInboundMessages(payload: MetaPayload): InboundMessage[] {
  const out: InboundMessage[] = []
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value.messages ?? []) {
        // Meta sends wa_id digits without '+'; the directory stores E.164.
        const mobile = m.from.startsWith('+') ? m.from : `+${m.from}`
        const providerMessageId = m.id
        if (m.type === 'text' && m.text) {
          out.push({ mobile, text: m.text.body, providerMessageId })
        } else if (m.type === 'interactive' && m.interactive) {
          const id = m.interactive.list_reply?.id ?? m.interactive.button_reply?.id
          if (id) out.push({ mobile, interactiveReplyId: id, providerMessageId })
        } else {
          // Unsupported type (image, audio, …) — engine answers with help text.
          out.push({ mobile, providerMessageId })
        }
      }
    }
  }
  return out
}

/**
 * Claim a delivery, returning false if it has already been handled.
 *
 * Meta retries until it receives a 200, and re-delivers in other situations
 * too. Without this, every retry re-runs the engine and re-sends the replies —
 * so a spell of failing webhooks produces a burst of duplicate bot messages the
 * moment the endpoint recovers, most of them the "Say hi for the menu" fallback
 * because the conversation has long since moved on.
 *
 * The unique constraint on processed_messages.message_id is what makes this
 * atomic: two concurrent retries race on the INSERT and exactly one wins. A
 * message with no id (which Meta should always send) is allowed through rather
 * than dropped.
 */
async function claimMessage(msg: InboundMessage): Promise<boolean> {
  if (!msg.providerMessageId) return true
  try {
    await getDb()('processed_messages').insert({
      message_id: msg.providerMessageId,
      created_at: nowIso(),
    })
    return true
  } catch {
    return false
  }
}

/** Run the engine per message (sequentially — keeps per-user ordering) and
 *  send replies via the configured provider. Errors are logged, never thrown:
 *  the webhook already returned 200. */
export async function deliverAndReply(messages: InboundMessage[]): Promise<void> {
  for (const msg of messages) {
    try {
      if (!(await claimMessage(msg))) {
        console.log(`[webhook] duplicate delivery ignored (${msg.providerMessageId})`)
        continue
      }
      const replies = await processInboundMessage(msg)
      if (replies.length > 0) {
        await getWhatsAppProvider().sendReplies(msg.mobile, replies)
      }
    } catch (err) {
      console.error(`[webhook] failed processing message from ${msg.mobile}:`, err)
    }
  }
}

export default router
