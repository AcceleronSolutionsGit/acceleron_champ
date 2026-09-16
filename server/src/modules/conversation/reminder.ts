/**
 * The one nudge — a single reminder for a conversation abandoned mid-flow.
 *
 * Contract, deliberately narrow:
 *   · fires once and only once per abandoned flow. A second reminder is never
 *     sent, no matter how long the flow sits there;
 *   · fires only after config.conversation.reminderAfterMinutes (default 5) of
 *     silence, measured from the user's own last message;
 *   · fires only while the flow is still resumable (inside the state TTL) —
 *     reminding someone about a flow that has already expired would be a lie;
 *   · fires only for a flow the user actually started. A user sitting on the
 *     welcome menu having tapped nothing is not mid-anything, and gets nothing;
 *   · fires only inside the WhatsApp customer-service window, which by
 *     construction it always is: the user messaged us five minutes ago. That
 *     also means it goes out as a normal free-form reply, not a template.
 *
 * Any new activity — a tap, a message, a step change — rewrites the state row
 * through saveState(), which drops `remindedAt` along with it. So a user who
 * replies to the reminder and then wanders off again is eligible for exactly
 * one more reminder on that next flow, which is the intended reading of "once".
 */
import { config } from '../../config'
import { getDb } from '../../db/knex'
import { Employee } from '../../types'
import { getWhatsAppProvider } from '../whatsapp/provider'
import { Lang, MessageKey, normalizeLang, t } from './i18n'
import { ConvState, Step, markReminded, parseState } from './engine'

export interface ReminderSweepResult {
  /** Rows examined this pass. */
  checked: number
  /** Reminders actually delivered. */
  sent: number
  /** Rows skipped because the flow had already been reminded about. */
  alreadyReminded: number
}

/**
 * Steps worth reminding about, and the copy for each.
 *
 * 'menu' is absent on purpose: showing the welcome buttons and receiving no tap
 * is not an abandoned task, it is someone deciding they are busy. Chasing that
 * is exactly the unsolicited-message behaviour this whole change removes.
 */
const REMINDER_COPY: Partial<Record<Step, MessageKey>> = {
  dpdp_consent: 'reminder_consent',
  recipient_query: 'reminder_recipient',
  behaviour: 'reminder_behaviour',
  reason: 'reminder_reason',
}

/**
 * One sweep. Safe to run every minute, and safe to run concurrently with
 * itself: the remindedAt marker is written before the send is attempted, so a
 * double-invocation cannot produce a double message.
 */
export async function sendInactivityReminders(): Promise<ReminderSweepResult> {
  const result: ReminderSweepResult = { checked: 0, sent: 0, alreadyReminded: 0 }

  if (!config.conversation.remindersEnabled) {
    console.log('[reminder] disabled (REMINDERS_ENABLED=false) — skipping sweep')
    return result
  }

  const db = getDb()
  const now = Date.now()
  const idleMs = config.conversation.reminderAfterMinutes * 60_000
  const ttlMs = config.conversation.stateTtlMinutes * 60_000

  // The eligible band is [now-ttl, now-idle]: idle long enough to have been
  // abandoned, but not so long that the flow has already expired. Both bounds
  // are ISO strings, which sort chronologically (see db/time.ts).
  const idleBefore = new Date(now - idleMs).toISOString()
  const expiredBefore = new Date(now - ttlMs).toISOString()

  const rows = (await db('conversation_state')
    .where('updated_at', '<=', idleBefore)
    .andWhere('updated_at', '>', expiredBefore)
    .select('mobile', 'state', 'updated_at')) as {
    mobile: string
    state: string
    updated_at: string
  }[]

  for (const row of rows) {
    result.checked += 1
    try {
      const state = parseState(row.state)
      if (!state) continue

      // Belt and braces: the row's updated_at is maintained alongside the JSON,
      // but the JSON's own timestamp is what loadState() trusts, so trust it here.
      const stateUpdatedMs = Date.parse(state.updatedAt ?? row.updated_at)
      if (!Number.isFinite(stateUpdatedMs) || now - stateUpdatedMs < idleMs) continue

      if (state.remindedAt) {
        result.alreadyReminded += 1
        continue
      }

      const key = REMINDER_COPY[state.step]
      if (!key) continue // 'menu' and anything new we have not written copy for

      const employee = (await db('employees').where({ mobile: row.mobile }).first()) as
        | Employee
        | undefined
      if (!employee || !employee.active) continue

      // Claim it FIRST. If the send then fails the user simply gets no
      // reminder — strictly better than a retry loop that eventually delivers
      // several at once, which is the failure mode we are here to remove.
      await markReminded(row.mobile)

      const lang: Lang = state.lang ?? normalizeLang(employee.language)
      const body = t(lang, key, { name: await recipientName(state) })
      await getWhatsAppProvider().sendReplies(row.mobile, [{ type: 'text', text: body }])
      result.sent += 1
    } catch (err) {
      console.error(`[reminder] failed for ${row.mobile}:`, err)
    }
  }

  // Only speak when something was actually sent — this runs every minute.
  if (result.sent > 0) {
    console.log(
      `[reminder] sent ${result.sent} of ${result.checked} idle flow(s)` +
        (result.alreadyReminded ? `, ${result.alreadyReminded} already reminded` : ''),
    )
  }
  return result
}

/**
 * The behaviour- and reason-step copy names the person being recognised, which
 * is the detail that makes the nudge worth sending at all. Falls back to an
 * empty string if the row vanished — the surrounding sentence still reads.
 */
async function recipientName(state: ConvState): Promise<string> {
  if (!state.data.recipientId) return ''
  const row = (await getDb()('employees').where({ id: state.data.recipientId }).first('name')) as
    | { name: string }
    | undefined
  return row?.name ?? ''
}
