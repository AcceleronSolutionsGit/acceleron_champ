import { Knex } from 'knex'

/**
 * Idempotency for inbound WhatsApp deliveries.
 *
 * Meta retries a webhook until it gets a 200, and the same message can also be
 * delivered more than once in normal operation. Without a record of what has
 * already been handled, every retry re-runs the conversation engine and sends
 * the replies again — which is how a spell of failing webhooks turns into a
 * burst of duplicate bot messages once the endpoint recovers.
 *
 * `message_id` is Meta's own per-message id (wamid.*), so the unique constraint
 * is what makes claiming a message atomic: the insert either succeeds (we own
 * it) or violates the constraint (someone already handled it).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('processed_messages'))) {
    await knex.schema.createTable('processed_messages', (t) => {
      t.increments('id').primary()
      t.string('message_id', 128).notNullable().unique()
      t.string('created_at', 40).notNullable()
      t.index(['created_at'])
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('processed_messages')) {
    await knex.schema.dropTable('processed_messages')
  }
}
