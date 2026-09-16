/**
 * Outbound messaging policy — the single place that decides whether the bot is
 * allowed to message a number it has not just been messaged by.
 *
 * Two kinds of outbound exist in this codebase and they are NOT the same thing:
 *
 *   REPLY      — produced by the conversation engine in direct response to an
 *                inbound message, delivered by the webhook. Always allowed: the
 *                user is holding their phone, they just typed something.
 *
 *   PROACTIVE  — the recipient notification (FR-19) and the weekly digest
 *                (FR-20). Nobody asked for these. They arrive whenever the
 *                sending event happens, which for a recognition notification is
 *                whatever hour the giver happened to be working.
 *
 * The default policy (config.outbound.proactiveRequiresSession, on) permits a
 * proactive send ONLY while the target's WhatsApp customer-service window is
 * open — that is, only while they are in an active conversation they started
 * themselves. A number that has not messaged the bot within
 * config.outbound.sessionWindowHours receives nothing, and the skip is counted
 * and logged rather than silently swallowed.
 *
 * Turning the switch off restores the previous behaviour (unconditional
 * template broadcasts).
 */
import { config } from '../config'
import { getDb } from '../db/knex'
import { nowIso } from '../db/time'

/**
 * Record that `mobile` just sent us a message. Called once per inbound message
 * from the conversation engine, which is the single funnel both WhatsApp
 * webhooks and the dev simulator pass through.
 *
 * Deliberately swallows its own errors: a failure to write an activity row must
 * never stop us answering the user who is waiting for a reply.
 */
export async function recordInbound(mobile: string, at: string = nowIso()): Promise<void> {
  try {
    await getDb()('contact_activity')
      .insert({ mobile, last_inbound_at: at })
      .onConflict('mobile')
      .merge({ last_inbound_at: at })
  } catch (err) {
    console.error(`[outbound] could not record inbound activity for ${mobile}:`, err)
  }
}

/** UTC ISO instant before which a conversation counts as closed. */
export function sessionWindowStartIso(): string {
  return new Date(Date.now() - config.outbound.sessionWindowHours * 3_600_000).toISOString()
}

/** Is `mobile` inside its customer-service window right now? */
export async function hasOpenSession(mobile: string): Promise<boolean> {
  const row = (await getDb()('contact_activity').where({ mobile }).first('last_inbound_at')) as
    | { last_inbound_at: string }
    | undefined
  if (!row) return false
  return row.last_inbound_at >= sessionWindowStartIso()
}

/**
 * Narrow a list of numbers to those currently inside their window — one query
 * instead of N, for the digest audience.
 */
export async function withOpenSession(mobiles: string[]): Promise<Set<string>> {
  if (mobiles.length === 0) return new Set()
  const rows = (await getDb()('contact_activity')
    .whereIn('mobile', mobiles)
    .where('last_inbound_at', '>=', sessionWindowStartIso())
    .select('mobile')) as { mobile: string }[]
  return new Set(rows.map((r) => r.mobile))
}

/**
 * The gate every proactive send must pass through.
 *
 * `label` names the caller ('recognition-notification', 'weekly-digest') so a
 * suppression is traceable in the logs to the feature that was suppressed.
 */
export async function maySendProactive(
  mobile: string,
  label: string,
): Promise<{ allowed: boolean; reason?: string }> {
  if (!config.outbound.proactiveRequiresSession) return { allowed: true }
  if (await hasOpenSession(mobile)) return { allowed: true }
  const reason = `no inbound message in the last ${config.outbound.sessionWindowHours}h`
  console.log(`[outbound] ${label} to ${mobile} suppressed — ${reason}`)
  return { allowed: false, reason }
}
