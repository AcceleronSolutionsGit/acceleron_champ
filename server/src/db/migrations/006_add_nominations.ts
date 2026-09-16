import { Knex } from 'knex'

/**
 * nominations — quarterly self-nomination for performance recognition.
 *
 * Distinct from `recognitions` on purpose and never merged into it: a
 * recognition is peer-to-peer, instant, and capped; a nomination is about
 * yourself, filed once a quarter, carries a paragraph of evidence, and is
 * worthless until the person's reporting manager has stood behind it. Sharing a
 * table would mean every feed, cap, flag-scan and digest query had to learn to
 * exclude a row type it has no business seeing.
 *
 * Reporting line: NOT stored as the authority. `submitted_manager_id` is a
 * snapshot for the record — who the manager was at the moment of filing — but
 * every approval query and permission check reads `employees.manager_id` live,
 * so a DarwinBox re-sync that moves someone to a new manager moves their
 * pending nomination with them instead of stranding it with someone who has
 * left.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nominations')) return

  await knex.schema.createTable('nominations', (t) => {
    t.increments('id').primary()
    t.integer('employee_id').unsigned().notNullable().references('id').inTable('employees')
    /** Informational snapshot; authority lives on employees.manager_id. */
    t.integer('submitted_manager_id').unsigned().nullable().references('id').inTable('employees')

    /** 'FY2026-Q2' — Indian financial year, sorts chronologically. */
    t.string('quarter', 12).notNullable()
    /** Denormalised bounds so reports can filter on dates without parsing codes. */
    t.string('quarter_start', 30).notNullable()
    t.string('quarter_end', 30).notNullable()

    t.string('title', 140).notNullable()
    t.text('evidence_text').notNullable()

    /** pending | approved | rejected | withdrawn */
    t.string('status', 12).notNullable().defaultTo('pending')

    /** Who actually decided — normally the manager, possibly an admin. */
    t.integer('decided_by_employee_id').unsigned().nullable().references('id').inTable('employees')
    t.string('decided_by_email', 160).nullable()
    t.string('decided_at', 30).nullable()
    t.text('decision_note').nullable()

    t.string('created_at', 30).notNullable()
    t.string('updated_at', 30).notNullable()

    // One nomination per person per quarter — the whole premise of the feature.
    // A rejected or withdrawn one is EDITED back into pending rather than
    // duplicated, so the history stays one row per quarter and the committee
    // never sees two competing entries from the same person.
    t.unique(['employee_id', 'quarter'], { indexName: 'nominations_person_quarter_unq' })
    // The approvals queue filters on these two together.
    t.index(['status', 'quarter'], 'nominations_status_quarter_idx')
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nominations')
}
