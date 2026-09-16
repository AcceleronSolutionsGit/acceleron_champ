import { Knex } from 'knex'

/**
 * Two additions to `nominations`:
 *
 * 1. behaviour_id — every nomination is now filed AGAINST a CHAMP behaviour,
 *    the same six-value taxonomy peer recognitions use (`behaviours`). Without
 *    it a nomination is just free text, and the committee has no way to compare
 *    across people, spot which behaviours nobody is claiming, or reconcile the
 *    quarterly pool with the recognition feed. Sharing the table also means an
 *    admin renaming or retiring a behaviour (FR-23) moves both at once.
 *
 *    Nullable rather than NOT NULL: rows filed before this migration have no
 *    behaviour and there is nothing honest to backfill them with. The service
 *    requires one on every new submission, so the nullable column is a record
 *    of history, not a loophole.
 *
 * 2. removal columns — the committee can strike a nomination from the pool with
 *    a written reason. Modelled on the `recognitions` removal trail
 *    (removal_reason / removed_by / removed_at) rather than reusing the
 *    manager's decision columns, because these are two different people doing
 *    two different things: the manager judges the work, the committee polices
 *    the pool. Collapsing them would make "who decided this" unanswerable.
 */
export async function up(knex: Knex): Promise<void> {
  const hasBehaviour = await knex.schema.hasColumn('nominations', 'behaviour_id')
  const hasRemoval = await knex.schema.hasColumn('nominations', 'removal_reason')

  await knex.schema.alterTable('nominations', (t) => {
    if (!hasBehaviour) {
      t.integer('behaviour_id').unsigned().nullable().references('id').inTable('behaviours')
    }
    if (!hasRemoval) {
      t.text('removal_reason').nullable()
      // Email rather than an employee id: a committee member may be an
      // admin_users row with no directory record of their own.
      t.string('removed_by_email', 160).nullable()
      t.string('removed_at', 30).nullable()
    }
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nominations', (t) => {
    t.dropColumn('behaviour_id')
    t.dropColumn('removal_reason')
    t.dropColumn('removed_by_email')
    t.dropColumn('removed_at')
  })
}
