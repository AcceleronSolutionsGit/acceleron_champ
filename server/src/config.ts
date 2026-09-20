/**
 * Central configuration for the CHAMP Spot Recognition Tool.
 *
 * Every value has a safe local-development default so the app runs with no
 * .env at all (SQLite + console email + WhatsApp simulator + demo directory).
 *
 * PRODUCTION (AWS): secrets should come from AWS Secrets Manager, not .env —
 * see src/aws/secretsManager.ts and the commented block in src/index.ts.
 */
import dotenv from 'dotenv'
import path from 'path'

/** Repo root (…/champ-spot-tool) — stable from both src/ (tsx) and dist/ (build). */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') })
dotenv.config() // also honour a server-local .env and real environment variables

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

function num(v: string | undefined, dflt: number): number {
  if (v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

function list(v: string | undefined, dflt: string[]): string[] {
  if (!v) return dflt
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function buildConfig() {
  const env = process.env
  // Normalised, because a hosting dashboard will happily hand you "PRODUCTION"
  // or " production". An unrecognised value silently means "not production",
  // which switches off the SESSION_SECRET check and the secure-cookie flag —
  // too quiet a failure to leave to an exact string match.
  const nodeEnv = (env.NODE_ENV ?? 'development').trim().toLowerCase()
  const isProd = nodeEnv === 'production' || env.VERCEL_ENV === 'production'
  return {
    nodeEnv,
    isProd,
    projectRoot: PROJECT_ROOT,
    port: num(env.PORT, 8080),
    /** All calendar logic (monthly cap reset, digests, display) uses IST. */
    timezone: env.DISPLAY_TIMEZONE ?? 'Asia/Kolkata',
    session: {
      secret: env.SESSION_SECRET ?? 'dev-insecure-secret-change-me',
      idleMinutes: num(env.SESSION_IDLE_MINUTES, 60),
      absoluteHours: num(env.SESSION_ABSOLUTE_HOURS, 12),
    },
    db: {
      client: (env.DATABASE_CLIENT ?? 'better-sqlite3') as 'better-sqlite3' | 'pg' | 'mysql2' | 'mysql',
      sqliteFile: path.resolve(PROJECT_ROOT, env.SQLITE_FILE ?? './data/champ.sqlite3'),
      databaseUrl: env.DATABASE_URL ?? '',
    },
    auth: {
      allowedEmailDomains: list(env.ALLOWED_EMAIL_DOMAIN, ['acceleronsolutions.io']),
      adminEmails: list(env.ADMIN_EMAILS, ['sabarnik.lahiri@acceleronsolutions.io']),
      committeeEmails: list(env.COMMITTEE_EMAILS, []),
      otpTtlMinutes: num(env.OTP_TTL_MINUTES, 10),
      otpMaxAttempts: num(env.OTP_MAX_ATTEMPTS, 5),
    },
    email: {
      provider: (env.EMAIL_PROVIDER ?? 'console') as 'console' | 'smtp' | 'ses',
      /**
       * Envelope sender. Microsoft 365 rejects a From that is not the
       * authenticated mailbox (550 5.7.60 "Client does not have permissions to
       * send as this sender") unless Send As has been granted, so the
       * authenticated user is the safest default when EMAIL_FROM is unset.
       */
      from: env.EMAIL_FROM || env.SMTP_USER || 'no-reply@acceleronsolutions.io',
      smtp: {
        host: env.SMTP_HOST ?? '',
        port: num(env.SMTP_PORT, 587),
        user: env.SMTP_USER ?? '',
        pass: env.SMTP_PASS ?? '',
        /** true = implicit TLS (465). M365 uses STARTTLS on 587, so false. */
        secure: bool(env.SMTP_SECURE, false),
        /**
         * Refuse to send if STARTTLS cannot be negotiated. On by default: an
         * OTP is a credential, and silently downgrading to plaintext because a
         * relay did not advertise STARTTLS is not a trade worth making.
         */
        requireTls: bool(env.SMTP_REQUIRE_TLS, true),
        /**
         * Reuse one authenticated connection across sends. Worth it on a
         * long-running host; pointless on serverless, where every invocation
         * is a fresh process, so it follows the runtime.
         */
        pool: bool(env.SMTP_POOL, !env.VERCEL),
        /** Fail fast rather than leaving a user staring at a spinner. */
        timeoutMs: num(env.SMTP_TIMEOUT_MS, 15_000),
      },
      /** Verify the SMTP connection at boot and log the result (non-fatal). */
      verifyOnBoot: bool(env.SMTP_VERIFY_ON_BOOT, true),
      /**
       * FR-19 (email arm) — the recognition mail to the recipient with their
       * reporting manager in Cc. On by default: it is the arm of FR-19 that
       * does not depend on a WhatsApp template being approved. Switch it off
       * with RECOGNITION_EMAIL=false while a directory import is running and
       * addresses are half-populated.
       */
      recognitionMail: {
        enabled: bool(env.RECOGNITION_EMAIL, true),
        /** Absolute URL of the web console; omitted ⇒ the mail has no button. */
        consoleUrl: (env.CONSOLE_URL ?? '').replace(/\/+$/, ''),
      },
    },
    whatsapp: {
      provider: (env.WHATSAPP_PROVIDER ?? 'simulator') as 'simulator' | 'meta' | 'gallabox',
      meta: {
        apiVersion: env.META_WA_API_VERSION ?? 'v20.0',
        phoneNumberId: env.META_WA_PHONE_NUMBER_ID ?? '',
        accessToken: env.META_WA_TOKEN ?? '',
        appSecret: env.META_WA_APP_SECRET ?? '',
        verifyToken: env.META_WA_VERIFY_TOKEN ?? 'champ-verify-token',
      },
      gallabox: {
        baseUrl: env.GALLABOX_BASE_URL ?? 'https://server.gallabox.com',
        apiKey: env.GALLABOX_API_KEY ?? '',
        apiSecret: env.GALLABOX_API_SECRET ?? '',
        channelId: env.GALLABOX_CHANNEL_ID ?? '',
        webhookSecret: env.GALLABOX_WEBHOOK_SECRET ?? '',
      },
    },
    darwinbox: {
      enabled: bool(env.DARWINBOX_ENABLED, false),
      baseUrl: env.DARWINBOX_BASE_URL ?? 'https://onegainwellonehr.darwinbox.in',
      endpoint: env.DARWINBOX_ENDPOINT ?? '/masterapi/employee',
      basicAuthUser: env.DARWINBOX_BASIC_AUTH_USER ?? '',
      basicAuthPass: env.DARWINBOX_BASIC_AUTH_PASS ?? '',
      apiKey: env.DARWINBOX_API_KEY ?? '',
      datasetKey: env.DARWINBOX_DATASET_KEY ?? '',
      reportId: env.DARWINBOX_REPORT_ID ?? '',
      companyCode: env.DARWINBOX_COMPANY_CODE ?? 'ASPL',
      /**
       * Which column of the report carries the seniority grade.
       *
       * Left empty, the sync tries the usual DarwinBox spellings (see
       * GRADE_FIELD_CANDIDATES) and logs the report's actual column names if
       * none of them are present. Set this once you know the name — a report
       * column rename should not need a deploy.
       */
      gradeField: env.DARWINBOX_GRADE_FIELD ?? '',
    },
    simulatorEnabled: bool(env.ENABLE_SIMULATOR, !isProd),
    boardToken: env.BOARD_TOKEN || null,
    /**
     * Outbound messaging policy — what the bot is allowed to send on its own
     * initiative, as opposed to replying to something the user just sent.
     *
     * The programme's default is REPLY-ONLY: a recognition notification or a
     * weekly digest is delivered only to someone whose WhatsApp customer-service
     * window is still open (i.e. they messaged the bot within the last
     * `sessionWindowHours`). Anyone else is skipped and the skip is logged.
     * That is also what keeps the bot off people's phones at 2am — it can only
     * reach a conversation the person themself started.
     *
     * Set PROACTIVE_REQUIRES_SESSION=false to restore unconditional broadcasts
     * (both sends then go out as approved templates, as WhatsApp requires
     * outside the window — FR-21).
     */
    outbound: {
      proactiveRequiresSession: bool(env.PROACTIVE_REQUIRES_SESSION, true),
      sessionWindowHours: num(env.SESSION_WINDOW_HOURS, 24),
    },
    /** Conversation state machine timings (FR-10 + the inactivity nudge). */
    conversation: {
      /** Resume window: an unfinished flow older than this is greeted fresh. */
      stateTtlMinutes: num(env.CONVERSATION_STATE_TTL_MINUTES, 30),
      /** Master switch for the single mid-flow inactivity reminder. */
      remindersEnabled: bool(env.REMINDERS_ENABLED, true),
      /** Idle minutes before that one reminder fires. Never fires twice. */
      reminderAfterMinutes: num(env.REMINDER_AFTER_MINUTES, 5),
    },
    cron: {
      darwinboxSync: env.SYNC_CRON ?? '30 2 * * *',
      flagScan: env.FLAGSCAN_CRON ?? '15 3 * * *',
      weeklyDigest: env.DIGEST_CRON ?? '0 9 * * 1',
      /** Minute-resolution sweep — the reminder is only as punctual as this. */
      flowReminder: env.REMINDER_CRON ?? '* * * * *',
    },
  }
}

export let config = buildConfig()

/**
 * Re-read the environment. Used after AWS Secrets Manager populates
 * process.env in production (see src/aws/secretsManager.ts).
 */
export function rebuildConfig(): void {
  config = buildConfig()
}

/**
 * Fail fast rather than run production with a known signing secret.
 *
 * Deliberately NOT run at module scope: in the AWS deployment SESSION_SECRET
 * lives only in Secrets Manager and reaches process.env via
 * loadAwsSecretsIntoEnv() + rebuildConfig() inside main() — a module-scope
 * throw would fire during import, before that load could ever run. Called
 * from src/index.ts after the (optional) secrets load.
 */
export function assertProductionSecrets(): void {
  if (config.isProd && config.session.secret === 'dev-insecure-secret-change-me') {
    throw new Error(
      'SESSION_SECRET must be set in production (env var, or AWS Secrets Manager — see deploy/README-deploy.md)',
    )
  }
}
