/**
 * Mail delivery check — `npm run mail:test -w server -- you@acceleronsolutions.io`
 *
 * Two steps, reported separately, because they fail for different reasons:
 *
 *   1. verify  — can we reach the relay and authenticate? This is where a
 *      disabled SMTP AUTH tenant, a wrong password, an MFA-protected mailbox
 *      or a blocked outbound port 587 shows up.
 *   2. send    — will the relay accept mail FROM this address TO that address?
 *      This is where Send As permissions and recipient restrictions show up.
 *
 * Run it after any change to the SMTP settings, and on the production host
 * rather than a laptop: egress rules are usually the thing that differs.
 */
import { config } from './config'
import { sendMail, verifySmtp } from './modules/auth/mailer'

function fail(message: string): never {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

async function main(): Promise<void> {
  const to = process.argv[2]
  if (!to || !to.includes('@')) {
    fail('Usage: npm run mail:test -w server -- someone@acceleronsolutions.io')
  }

  console.log('\nMail configuration')
  console.log(`  provider   ${config.email.provider}`)
  console.log(`  from       ${config.email.from}`)
  if (config.email.provider === 'smtp') {
    const { host, port, user, secure, requireTls, pool } = config.email.smtp
    console.log(`  host       ${host}:${port}`)
    console.log(`  user       ${user || '(none — unauthenticated relay)'}`)
    console.log(`  password   ${config.email.smtp.pass ? 'set' : 'NOT SET'}`)
    console.log(`  tls        ${secure ? 'implicit (465)' : requireTls ? 'STARTTLS, required' : 'STARTTLS, optional'}`)
    console.log(`  pooled     ${pool}`)
  }

  if (config.email.provider === 'console') {
    console.log('\nEMAIL_PROVIDER is "console" — nothing will be sent anywhere.')
    console.log('The code is printed to this terminal instead. Set EMAIL_PROVIDER=smtp to send real mail.\n')
  }

  if (config.email.provider === 'smtp') {
    // A From that is not the authenticated mailbox is the single most common
    // misconfiguration on Microsoft 365, and it fails at send time with a
    // message that does not obviously point at EMAIL_FROM. Say so up front.
    if (config.email.smtp.user && config.email.from.toLowerCase() !== config.email.smtp.user.toLowerCase()) {
      console.warn(
        `\n⚠ EMAIL_FROM (${config.email.from}) is not the authenticated mailbox (${config.email.smtp.user}).` +
          '\n  Microsoft 365 will reject this unless that mailbox has Send As on the address.',
      )
    }

    process.stdout.write('\nStep 1 — connecting and authenticating… ')
    const verified = await verifySmtp()
    if (!verified.ok) {
      console.log('failed')
      fail(verified.error)
    }
    console.log('ok')
  }

  process.stdout.write(`Step 2 — sending a test mail to ${to}… `)
  try {
    await sendMail(
      to,
      'Acceleron Champ — mail delivery test',
      [
        'This is a test message from the Acceleron Champ server.',
        '',
        'If you received it, sign-in codes will reach your people too.',
        '',
        `Sent ${new Date().toISOString()} from ${config.email.from}.`,
      ].join('\n'),
    )
  } catch (err) {
    console.log('failed')
    fail(err instanceof Error ? err.message : String(err))
  }
  console.log('ok')

  console.log(`\n✔ Sent. Check ${to}, including the junk folder.`)
  console.log('  If it landed in junk, the domain needs SPF/DKIM/DMARC records for this sender.\n')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
