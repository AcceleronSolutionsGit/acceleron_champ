/**
 * Outbound email (architecture §3.3): sign-in OTP codes, and the HTML
 * recognition mail sent to a recipient with their reporting manager in Cc.
 *
 * Providers (EMAIL_PROVIDER):
 *   - 'console' — local default: pretty-prints the mail (incl. the OTP code)
 *     to the server terminal. The login page additionally shows the devCode
 *     returned by requestOtp() in this mode.
 *   - 'smtp'    — real nodemailer transport using SMTP_* env (works with any
 *     relay: corporate Exchange, SES SMTP interface, Mailgun, …).
 *   - 'ses'     — Amazon SES API. Real code is COMMENTED below because the
 *     project intentionally ships without @aws-sdk/client-ses; the active
 *     stub throws with a pointer to deploy/README-deploy.md.
 *
 * OTP mail is deliberately plain text: transactional one-liners with no HTML
 * score better with spam filters and render everywhere (architecture §3.3).
 */
import nodemailer, { Transporter } from 'nodemailer'
import { config } from '../../config'

let smtpTransporter: Transporter | null = null

/**
 * Build the SMTP transport.
 *
 * Tuned for Microsoft 365 (smtp.office365.com:587), which is what this
 * deployment sends through, but the same settings are correct for any
 * STARTTLS relay:
 *
 *   · requireTLS  — M365 advertises STARTTLS on 587 and nodemailer will use
 *     it opportunistically, but "opportunistic" means it would also send in
 *     the clear if the upgrade failed. An OTP is a credential, so we refuse.
 *   · TLSv1.2 floor — M365 dropped 1.0/1.1. Node negotiates 1.2+ anyway on
 *     modern runtimes; pinning the minimum makes the failure explicit rather
 *     than a confusing handshake error on an older host.
 *   · timeouts — without them a blocked egress port leaves the login request
 *     hanging until the platform kills it, and the user just sees a spinner.
 *   · pool — one authenticated connection reused, on long-running hosts only.
 */
function getSmtpTransporter(): Transporter {
  if (!smtpTransporter) {
    const { host, port, user, pass, secure, requireTls, pool, timeoutMs } = config.email.smtp
    if (!host) {
      throw new Error('EMAIL_PROVIDER=smtp requires SMTP_HOST (and usually SMTP_USER/SMTP_PASS)')
    }
    const shared = {
      host,
      port,
      secure, // true = implicit TLS (465); false = STARTTLS upgrade on 587
      requireTLS: !secure && requireTls,
      auth: user ? { user, pass } : undefined,
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      tls: { minVersion: 'TLSv1.2' as const },
    }
    // Pooled and unpooled are distinct overloads in nodemailer's types, so the
    // literal `pool: true` has to appear in the object literal itself.
    smtpTransporter = pool
      ? nodemailer.createTransport({ ...shared, pool: true, maxConnections: 2 })
      : nodemailer.createTransport(shared)
  }
  return smtpTransporter
}

/**
 * Check the credentials and the route without sending anything.
 *
 * Called at boot (non-fatal) and by `npm run mail:test`. The point is to find
 * out that SMTP AUTH is disabled on the tenant at deploy time rather than the
 * first time somebody tries to sign in.
 */
export async function verifySmtp(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await getSmtpTransporter().verify()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: describeSmtpError(err) }
  }
}

/**
 * Turn an SMTP failure into something an administrator can act on.
 *
 * The raw nodemailer error for a disabled-SMTP-AUTH tenant is a wall of text
 * ending in a support URL, and it is by far the most common way this
 * integration fails on Microsoft 365 — the tenant default is off.
 */
function describeSmtpError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: string; responseCode?: number } | null) ?? {}

  if (/SmtpClientAuthentication is disabled/i.test(raw)) {
    return `${raw}\n  → Microsoft 365 has SMTP AUTH switched off for this mailbox. Enable it in the Microsoft 365 admin centre (Users → the mailbox → Mail → Manage email apps → Authenticated SMTP), and check the tenant-wide setting in Exchange admin → Settings → Mail flow.`
  }
  if (code.responseCode === 535 || /535|authentication unsuccessful/i.test(raw)) {
    return `${raw}\n  → Wrong SMTP_USER/SMTP_PASS, or the mailbox has MFA on and needs an app password rather than the account password.`
  }
  if (/5\.7\.60|does not have permissions to send as this sender/i.test(raw)) {
    return `${raw}\n  → EMAIL_FROM (${config.email.from}) is not the authenticated mailbox (${config.email.smtp.user}). Either set EMAIL_FROM to the mailbox, or grant it Send As on that address.`
  }
  if (code.code === 'ETIMEDOUT' || code.code === 'ESOCKET' || /timeout/i.test(raw)) {
    return `${raw}\n  → Could not reach ${config.email.smtp.host}:${config.email.smtp.port}. Outbound port 587 is often blocked by default on cloud hosts; check egress rules.`
  }
  return raw
}

/** 4xx from a mail server means "try again"; 5xx means "do not bother". */
function isTransient(err: unknown): boolean {
  const responseCode = (err as { responseCode?: number } | null)?.responseCode
  if (typeof responseCode === 'number') return responseCode >= 400 && responseCode < 500
  const code = (err as { code?: string } | null)?.code
  return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ESOCKET'
}

// ── message shape ─────────────────────────────────────────────
/**
 * Everything the providers below need to put one mail on the wire.
 *
 * `text` is not optional even when `html` is set: Outlook's reading pane, a
 * watch, and every "plain text only" corporate policy fall back to it, and a
 * recognition that arrives as an empty bubble is worse than no mail at all.
 */
export interface MailMessage {
  to: string
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  /** Optional multipart/alternative HTML part. */
  html?: string
}

/** Drop blanks/dupes and anyone already on another line of the envelope. */
function cleanRecipients(list: string[] | undefined, exclude: string[]): string[] {
  const seen = new Set(exclude.map((a) => a.trim().toLowerCase()).filter(Boolean))
  const out: string[] = []
  for (const raw of list ?? []) {
    const addr = (raw ?? '').trim()
    const key = addr.toLowerCase()
    if (!addr || seen.has(key)) continue
    seen.add(key)
    out.push(addr)
  }
  return out
}

// ── PRODUCTION (real integration) ─────────────────────────────
// Amazon SES — enabled by EMAIL_PROVIDER=ses after `npm i @aws-sdk/client-ses`
// and verifying the sending domain (SPF + DKIM + DMARC; see
// deploy/README-deploy.md). Runs in ap-south-1 alongside the rest of the
// stack; the App Runner instance role needs ses:SendEmail.
//
// import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
//
// let sesClient: SESClient | null = null
//
// async function sendViaSes(msg: MailMessage): Promise<void> {
//   if (!sesClient) sesClient = new SESClient({ region: process.env.AWS_REGION ?? 'ap-south-1' })
//   await sesClient.send(
//     new SendEmailCommand({
//       Source: config.email.from,
//       Destination: {
//         ToAddresses: [msg.to],
//         CcAddresses: msg.cc ?? [],
//         BccAddresses: msg.bcc ?? [],
//       },
//       Message: {
//         Subject: { Data: msg.subject, Charset: 'UTF-8' },
//         Body: {
//           Text: { Data: msg.text, Charset: 'UTF-8' },
//           ...(msg.html ? { Html: { Data: msg.html, Charset: 'UTF-8' } } : {}),
//         },
//       },
//     }),
//   )
// }
// ── LOCAL (stub) — active until the SES SDK is installed ─────
function sendViaSes(_msg: MailMessage): Promise<void> {
  throw new Error(
    'EMAIL_PROVIDER=ses requires @aws-sdk/client-ses — uncomment the SES block in ' +
      'server/src/modules/auth/mailer.ts and see deploy/README-deploy.md',
  )
}

/**
 * Send one mail — plain text, or multipart/alternative when `html` is set —
 * through the configured provider.
 *
 * Cc and Bcc are normalized here rather than at each call site: the directory
 * genuinely does produce a recipient who is their own manager's report, or a
 * giver who is also the recipient's manager, and nobody should receive the
 * same mail twice because of it.
 */
export async function sendMessage(msg: MailMessage): Promise<void> {
  const cc = cleanRecipients(msg.cc, [msg.to])
  const bcc = cleanRecipients(msg.bcc, [msg.to, ...cc])

  switch (config.email.provider) {
    case 'console': {
      const line = '─'.repeat(60)
      console.log(`\n┌${line}`)
      console.log(`│ ✉  [email:console]  (set EMAIL_PROVIDER=smtp for real mail)`)
      console.log(`│ To:      ${msg.to}`)
      if (cc.length) console.log(`│ Cc:      ${cc.join(', ')}`)
      if (bcc.length) console.log(`│ Bcc:     ${bcc.join(', ')}`)
      console.log(`│ From:    ${config.email.from}`)
      console.log(`│ Subject: ${msg.subject}`)
      if (msg.html) console.log(`│ (HTML part: ${msg.html.length} bytes — text shown below)`)
      console.log(`├${line}`)
      for (const l of msg.text.split('\n')) console.log(`│ ${l}`)
      console.log(`└${line}\n`)
      return
    }
    case 'smtp': {
      const message = {
        from: config.email.from,
        to: msg.to,
        ...(cc.length ? { cc } : {}),
        ...(bcc.length ? { bcc } : {}),
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      }
      try {
        await getSmtpTransporter().sendMail(message)
      } catch (err) {
        // Exchange Online throttles under load and returns a 4xx; one retry
        // turns a failed sign-in into a slightly slow one.
        if (!isTransient(err)) throw new Error(describeSmtpError(err))
        console.warn('[email] transient SMTP failure, retrying once:', describeSmtpError(err))
        await new Promise((resolve) => setTimeout(resolve, 1500))
        try {
          await getSmtpTransporter().sendMail(message)
        } catch (retryErr) {
          throw new Error(describeSmtpError(retryErr))
        }
      }
      return
    }
    case 'ses': {
      await sendViaSes({ ...msg, cc, bcc })
      return
    }
  }
}

/** Send a plain-text mail via the configured provider. */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  await sendMessage({ to, subject, text })
}

/** The one transactional mail this system sends: the login OTP. */
export async function sendOtpEmail(email: string, code: string): Promise<void> {
  const subject = `${code} is your Acceleron Champ sign-in code`
  const text = [
    `Your Acceleron Champ sign-in code is: ${code}`,
    '',
    `It expires in ${config.auth.otpTtlMinutes} minutes and can be used once.`,
    "If you didn't request this code, you can safely ignore this email.",
  ].join('\n')
  await sendMail(email, subject, text)
}
