/**
 * FR-19 (email arm) — the mail that goes out the moment a recognition lands.
 *
 *   To  : the recipient
 *   Cc  : the recipient's reporting manager, and the giver
 *
 * Why the manager is on it rather than in a weekly roll-up: a spot
 * recognition is evidence, and evidence is only useful to the person who
 * writes the appraisal if it reaches them while it still has a context. The
 * giver is copied so they can see their shout-out actually landed — the
 * WhatsApp bot only ever confirms it to them in a chat bubble they scroll past.
 *
 * The HTML is deliberately table-based with everything inlined: Outlook on
 * Windows renders through Word, which ignores <style> blocks, flexbox, grid
 * and most of CSS3. This is the same skeleton as the CHAMP launch mails in
 * "Claude outputs/", so the programme looks like one thing in the inbox.
 *
 * Failures never propagate: the recognition is already saved and on the feed,
 * and nobody's WhatsApp conversation should break because Exchange throttled.
 */
import { getDb } from '../../db/knex'
import { formatIst } from '../../db/time'
import { config } from '../../config'
import { Behaviour, Employee, Recognition } from '../../types'
import { sendMessage } from '../auth/mailer'

// ── brand ─────────────────────────────────────────────────────────────────
const NAVY = '#212f60'
const RED = '#de1e24'
const INK = '#0f172a'
const BODY = '#334155'
const MUTED = '#64748b'
const LINE = '#e2e8f0'
const CANVAS = '#f4f6fa'
const FONT = 'Segoe UI,Helvetica Neue,Arial,sans-serif'

/** Everything the template needs, with no database types in sight. */
export interface RecognitionMailInput {
  recipientName: string
  giverName: string
  giverFunction?: string | null
  giverSite?: string | null
  managerName?: string | null
  behaviourName: string
  behaviourDescription?: string | null
  behaviourColour: string
  reason: string
  /** Stored ISO-8601 UTC timestamp; rendered in IST. */
  createdAt: string
  /** Optional deep link to the feed in the web console. */
  consoleUrl?: string | null
}

// ── helpers ───────────────────────────────────────────────────────────────

/** HTML-escape. Reasons are free text typed on WhatsApp by real people. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Escape, then turn newlines into <br> so a multi-line reason keeps its shape. */
function escMultiline(value: string): string {
  return esc(value).replace(/\r?\n/g, '<br>')
}

/** First name only — "Nice work, Priya" reads better than the full HRMS name. */
function firstName(full: string): string {
  const first = full.trim().split(/\s+/)[0]
  return first || full.trim()
}

/**
 * Pick black or white text for a behaviour badge.
 *
 * The six CHAMP colours run from #19559c to #e58f00, and white on that amber
 * is unreadable. WCAG relative luminance settles it per colour instead of
 * hard-coding an exception that the next behaviour rename would break.
 */
function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#ffffff'
  const int = parseInt(m[1], 16)
  const channel = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const lum =
    0.2126 * channel((int >> 16) & 255) +
    0.7152 * channel((int >> 8) & 255) +
    0.0722 * channel(int & 255)
  // Contrast against white vs against near-black; pick the better one.
  return (1.05) / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#ffffff' : INK
}

/** Fall back to the house navy if a behaviour row ever holds junk. */
function safeColour(hex: string | null | undefined): string {
  return /^#[0-9a-f]{6}$/i.test((hex ?? '').trim()) ? (hex as string).trim() : NAVY
}

/** "Engineering · Pune" — either half may be missing. */
function whereFrom(fn?: string | null, site?: string | null): string {
  return [fn, site].map((s) => (s ?? '').trim()).filter(Boolean).join(' · ')
}

// ── subject + plain-text part ─────────────────────────────────────────────

export function recognitionSubject(input: RecognitionMailInput): string {
  return `${input.giverName} recognised you for ${input.behaviourName} — CHAMP`
}

/**
 * The text/plain alternative. Not a courtesy: it is what Outlook's "plain
 * text only" policy, mobile notification previews and screen readers show.
 */
export function renderRecognitionText(input: RecognitionMailInput): string {
  const lines = [
    `Nice work, ${firstName(input.recipientName)}.`,
    '',
    `${input.giverName} recognised you on CHAMP for ${input.behaviourName}.`,
    '',
    'In their words:',
    `  "${input.reason.trim()}"`,
    '',
    `Behaviour : ${input.behaviourName}${
      input.behaviourDescription ? ` — ${input.behaviourDescription}` : ''
    }`,
    `Given by  : ${input.giverName}${
      whereFrom(input.giverFunction, input.giverSite)
        ? ` (${whereFrom(input.giverFunction, input.giverSite)})`
        : ''
    }`,
    `When      : ${formatIst(input.createdAt, 'DD MMM YYYY, h:mm A')} IST`,
  ]
  if (input.managerName) {
    lines.push('', `${input.managerName} (your reporting manager) is copied on this mail.`)
  }
  if (input.consoleUrl) {
    lines.push('', `See it on the CHAMP wall: ${input.consoleUrl}`)
  }
  lines.push(
    '',
    '—',
    'Acceleron CHAMP · Spot Recognition. This is an automated message; there is nobody at this address.',
  )
  return lines.join('\n')
}

// ── HTML part ─────────────────────────────────────────────────────────────

/**
 * Render the mail body. Pure — takes names, returns a string — so it can be
 * previewed and diffed without a database or a mail server.
 */
export function renderRecognitionHtml(input: RecognitionMailInput): string {
  const colour = safeColour(input.behaviourColour)
  const onColour = readableOn(colour)
  const who = whereFrom(input.giverFunction, input.giverSite)
  const when = `${formatIst(input.createdAt, 'DD MMM YYYY, h:mm A')} IST`
  const preheader = `${input.giverName} recognised you for ${input.behaviourName}.`

  const detailRow = (label: string, value: string): string => `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid ${LINE};font:13px ${FONT};color:${MUTED};white-space:nowrap;" valign="top">${esc(
    label,
  )}</td>
        <td style="padding:9px 0 9px 18px;border-bottom:1px solid ${LINE};font:600 14px ${FONT};color:${INK};" align="right" valign="top">${value}</td>
      </tr>`

  const cta = input.consoleUrl
    ? `
   <tr><td style="padding:0 34px 32px;">
     <table role="presentation" cellpadding="0" cellspacing="0" border="0">
       <tr><td align="center" style="background:${NAVY};border-radius:8px;">
         <a href="${esc(input.consoleUrl)}" style="display:inline-block;padding:13px 26px;font:700 14px ${FONT};color:#ffffff;text-decoration:none;">See it on the CHAMP wall &rarr;</a>
       </td></tr>
     </table>
   </td></tr>`
    : ''

  const managerNote = input.managerName
    ? `
   <tr><td style="padding:0 34px 22px;">
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
       <tr><td style="padding:13px 16px;background:${CANVAS};border-left:3px solid ${NAVY};border-radius:0 8px 8px 0;font:13px/1.6 ${FONT};color:${BODY};">
         <span style="font-weight:700;color:${INK};">${esc(
           input.managerName,
         )}</span>, your reporting manager, is copied on this mail so it counts where it should.
       </td></tr>
     </table>
   </td></tr>`
    : ''

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(recognitionSubject(input))}</title></head>
<body style="margin:0;padding:0;background:${CANVAS};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${CANVAS};">
 <tr><td align="center" style="padding:26px 12px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="620"
         style="width:620px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;
                box-shadow:0 1px 3px rgba(15,23,42,.08);">

   <tr><td style="background:${NAVY};padding:28px 34px 26px;">
     <div style="font:800 26px/1 ${FONT};color:#ffffff;letter-spacing:.06em;">CHAMP</div>
     <div style="padding-top:5px;font:13px ${FONT};color:#b9c4e0;">Acceleron Spot Recognition</div>
     <div style="padding-top:18px;font:700 11px ${FONT};color:${RED};
                 background:#ffffff;display:inline-block;padding:5px 11px;border-radius:20px;
                 text-transform:uppercase;letter-spacing:.09em;">Recognition received</div>
   </td></tr>

   <tr><td style="padding:30px 34px 0;">
     <h1 style="margin:0;font:800 27px/1.25 ${FONT};color:${INK};">Nice work, ${esc(
    firstName(input.recipientName),
  )}.</h1>
     <p style="margin:12px 0 0;font:16px/1.6 ${FONT};color:${MUTED};"><span style="font-weight:700;color:${INK};">${esc(
    input.giverName,
  )}</span> just recognised you on CHAMP for living one of the six behaviours. Nothing to do &mdash; it is already on the wall and on your record.</p>
   </td></tr>

   <tr><td style="padding:24px 34px 0;">
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
       <tr>
         <td width="5" style="background:${colour};border-radius:8px 0 0 8px;">&nbsp;</td>
         <td style="padding:18px 20px;background:${CANVAS};border:1px solid ${LINE};border-left:0;border-radius:0 8px 8px 0;">
           <div style="font:700 11px ${FONT};color:${onColour};background:${colour};display:inline-block;padding:6px 12px;border-radius:20px;text-transform:uppercase;letter-spacing:.09em;">${esc(
    input.behaviourName,
  )}</div>${
    input.behaviourDescription
      ? `
           <div style="padding-top:11px;font:15px/1.55 ${FONT};color:${BODY};">${esc(
             input.behaviourDescription,
           )}</div>`
      : ''
  }
         </td>
       </tr>
     </table>
   </td></tr>

   <tr><td style="padding:22px 34px 0;">
     <div style="font:700 11px ${FONT};color:${MUTED};text-transform:uppercase;letter-spacing:.09em;">In their words</div>
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:10px;">
       <tr><td style="padding:18px 20px;background:#ffffff;border:1px solid ${LINE};border-radius:10px;font:italic 16px/1.7 ${FONT};color:${INK};">&ldquo;${escMultiline(
    input.reason.trim(),
  )}&rdquo;</td></tr>
     </table>
   </td></tr>

   <tr><td style="padding:24px 34px 8px;">
     <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${detailRow(
       'Given by',
       `${esc(input.giverName)}${
         who ? `<span style="font-weight:400;color:${MUTED};"> &nbsp;·&nbsp; ${esc(who)}</span>` : ''
       }`,
     )}${detailRow('When', esc(when))}
     </table>
   </td></tr>

   <tr><td style="height:14px;line-height:14px;font-size:0;">&nbsp;</td></tr>
${managerNote}${cta}
   <tr><td style="padding:20px 34px 26px;background:${CANVAS};border-top:1px solid ${LINE};">
     <div style="font:12px/1.7 ${FONT};color:${MUTED};">
       <span style="font-weight:700;color:${INK};">Acceleron CHAMP</span> &nbsp;·&nbsp; Spot Recognition<br>
       Recognise someone yourself on WhatsApp &mdash; send <span style="font-weight:700;color:${INK};">hi</span> to the CHAMP number and tap <span style="font-weight:700;color:${INK};">Give recognition</span>.<br>
       This is an automated message; nobody reads replies to this address.
     </div>
   </td></tr>

  </table>
 </td></tr>
</table>
</body></html>`
}

// ── the trigger ───────────────────────────────────────────────────────────

/**
 * Send the recognition mail for a freshly created row.
 *
 * Skipped, quietly, when: the feature is off; the row is flagged (BR-5) or
 * removed; the recipient is inactive or has no directory email address. A
 * flagged row is one the committee may yet strike, and congratulating
 * somebody for it and then taking it away is worse than being a day late.
 */
export async function sendRecognitionMail(recognition: Recognition): Promise<void> {
  if (!config.email.recognitionMail.enabled) return
  if (recognition.status !== 'active') return

  const db = getDb()

  const recipient = (await db('employees').where({ id: recognition.recipient_id }).first()) as
    | Employee
    | undefined
  if (!recipient || !recipient.active) return
  const to = (recipient.email ?? '').trim()
  if (!to) return // FR-4 keeps their history; we just have nowhere to write to

  const giver = (await db('employees').where({ id: recognition.giver_id }).first()) as
    | Employee
    | undefined
  const behaviour = (await db('behaviours').where({ id: recognition.behaviour_id }).first()) as
    | Behaviour
    | undefined
  if (!giver || !behaviour) return

  const manager = recipient.manager_id
    ? ((await db('employees').where({ id: recipient.manager_id }).first()) as Employee | undefined)
    : undefined
  // An inactive manager is a directory mid-transfer, not an error — the mail
  // still goes to the recipient, just without a Cc.
  const managerEmail = manager && manager.active ? (manager.email ?? '').trim() : ''
  const giverEmail = (giver.email ?? '').trim()

  const input: RecognitionMailInput = {
    recipientName: recipient.name,
    giverName: giver.name,
    giverFunction: giver.function,
    giverSite: giver.site,
    managerName: managerEmail ? manager?.name ?? null : null,
    behaviourName: behaviour.name,
    behaviourDescription: behaviour.description,
    behaviourColour: behaviour.colour,
    reason: recognition.reason_text,
    createdAt: recognition.created_at,
    consoleUrl: config.email.recognitionMail.consoleUrl || null,
  }

  try {
    await sendMessage({
      to,
      cc: [managerEmail, giverEmail],
      subject: recognitionSubject(input),
      text: renderRecognitionText(input),
      html: renderRecognitionHtml(input),
    })
  } catch (err) {
    // The recognition itself already succeeded — never fail the giver's
    // conversation because the mail could not be delivered.
    console.error(`[recognition-mail] CHAMP-${recognition.id} to ${to} failed:`, err)
  }
}
