/**
 * Gallabox WhatsApp API Webhook Route — mounted at /webhook/gallabox
 *
 * Receives incoming WhatsApp messages from Gallabox webhooks, converts them into
 * the CHAMP canonical InboundMessage format, runs the conversation engine, and
 * responds via getWhatsAppProvider().
 */
import express, { Router, Request, Response } from 'express'
import { config } from '../config'
import { InboundMessage } from '../types'
import { processInboundMessage } from '../modules/conversation/engine'
import { getWhatsAppProvider } from '../modules/whatsapp/provider'
import { isServerless } from '../runtime'

const router = Router()

// Raw body parser for signature / payload validation if needed
router.use(express.json({ limit: '256kb' }))

// GET handler for simple webhook verification check
router.get('/', (_req: Request, res: Response) => {
  res.status(200).send('Gallabox webhook endpoint active')
})

// POST handler for receiving incoming WhatsApp events from Gallabox
router.post('/', async (req: Request, res: Response) => {
  const secret = config.whatsapp.gallabox.webhookSecret
  const providedSecret =
    (req.headers['x-gallabox-secret'] as string) ||
    (req.headers['x-webhook-secret'] as string) ||
    req.query['secret']

  if (secret && providedSecret && secret !== providedSecret) {
    console.warn('[webhook:gallabox] secret mismatch')
    res.sendStatus(401)
    return
  }

  const payload = req.body
  const inboundMessages =
    payload && typeof payload === 'object' ? parseGallaboxPayload(payload) : []

  if (inboundMessages.length === 0) {
    res.status(200).json({ status: 'received' })
    return
  }

  if (isServerless) {
    // The instance freezes as soon as the response is flushed — finish the work
    // before acking rather than queueing it for a process that will not exist.
    await deliverAndReply(inboundMessages)
    res.status(200).json({ status: 'received' })
    return
  }

  // Fast ACK to Gallabox so it doesn't retry
  res.status(200).json({ status: 'received' })
  setImmediate(() => {
    void deliverAndReply(inboundMessages)
  })
})

function parseGallaboxPayload(body: any): InboundMessage[] {
  const messages: InboundMessage[] = []

  // Case 1: Standard Gallabox Message Received Event
  // Body format: { event: "Message.received", data: { from/phone/sender, text, interactive... } }
  const data = body.data || body

  const rawPhone =
    data.from ||
    data.phone ||
    data.sender?.phone ||
    data.message?.from ||
    body.phone ||
    body.from

  if (!rawPhone || typeof rawPhone !== 'string') {
    return messages
  }

  const mobile = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone.replace(/[^\d]/g, '')}`

  // Interactive reply parsing (button or list selection)
  const interactiveReplyId =
    data.interactive?.list_reply?.id ||
    data.interactive?.button_reply?.id ||
    data.interactiveReplyId ||
    data.button_reply?.id ||
    data.list_reply?.id ||
    body.interactiveReplyId

  // Text message parsing
  const text =
    data.text?.body ||
    data.text ||
    data.message?.text?.body ||
    data.message?.text ||
    body.text

  if (interactiveReplyId && typeof interactiveReplyId === 'string') {
    messages.push({ mobile, interactiveReplyId })
  } else if (text && typeof text === 'string') {
    messages.push({ mobile, text })
  } else {
    // Unsupported message type (image, attachment, etc.) — send fallback prompt
    messages.push({ mobile })
  }

  return messages
}

async function deliverAndReply(messages: InboundMessage[]): Promise<void> {
  for (const msg of messages) {
    try {
      const replies = await processInboundMessage(msg)
      if (replies.length > 0) {
        await getWhatsAppProvider().sendReplies(msg.mobile, replies)
      }
    } catch (err) {
      console.error(`[webhook:gallabox] error processing message from ${msg.mobile}:`, err)
    }
  }
}

export default router
