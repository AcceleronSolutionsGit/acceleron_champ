import { Knex } from 'knex'

/**
 * contact_activity — one row per WhatsApp number, recording the last time that
 * number sent US a message.
 *
 * This is what makes "only message people who are talking to us" decidable.
 * conversation_state cannot answer it: that row is deleted the moment a flow
 * completes or is cancelled, and expires after the resume window, so a user who
 * finished a recognition two minutes ago looks identical to one who has never
 * messaged at all.
 *
 * It also mirrors WhatsApp's own 24-hour customer-service window (FR-21): while
 * last_inbound_at is inside that window free-form replies are deliverable;
 * outside it, only approved templates are — and under the default policy we send
 * nothing at all.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('contact_activity'))) {
    await knex.schema.createTable('contact_activity', (t) => {
      t.string('mobile', 20).primary()
      // ISO-8601 UTC, per the codebase convention in db/time.ts.
      t.string('last_inbound_at', 30).notNullable()
      // Indexed because the digest audience filter scans on it.
      t.index(['last_inbound_at'], 'contact_activity_last_inbound_idx')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('contact_activity')
}
