import { Knex } from 'knex'

/**
 * Set the CHAMP behaviours to the Acceleron six, in the agreed display order:
 *
 *   IMPACT · INNOVATION · INTEGRITY · CARING · CUSTOMER CENTRICITY · ENTREPRENEURSHIP
 *
 * Why a migration rather than editing the rows by hand: the console can edit a
 * behaviour's label, description and colour but not its sort_order, and a hand
 * edit on production is not reproducible on a fresh database or a second
 * environment. This runs from `vercel-build` on every deploy and is idempotent.
 *
 * ── The important part: rows are RENAMED, never replaced ────────────────────
 * `recognitions.behaviour_id` and `nominations.behaviour_id` both point here.
 * Deleting a behaviour would either be refused by the foreign key or strip the
 * behaviour off historical records. So each target name claims an existing row
 * and rewrites it in place; ids survive, and so does every recognition.
 *
 * A consequence worth being explicit about: where a row is renamed, past
 * records filed under the OLD label now display under the NEW one. That is the
 * unavoidable cost of keeping six rows and six names — the alternative is
 * retiring the old set and inserting a new one, which keeps history literal but
 * leaves deactivated behaviours in the table forever.
 *
 * Claiming order, per target name:
 *   1. a row that already has that name (case-insensitive) — keeps its id, so
 *      INNOVATION and CUSTOMER CENTRICITY carry their history untouched;
 *   2. otherwise the lowest-id row not yet claimed by another target;
 *   3. otherwise a fresh insert (an empty table, or fewer than six rows).
 * Anything left unclaimed is DEACTIVATED, not deleted.
 */

interface BehaviourRow {
  id: number
  name: string
}

/** The agreed set. Array order IS the display order (sort_order 1..6). */
const CHAMP_BEHAVIOURS = [
  { name: 'IMPACT', description: 'Outcomes that outlast the project.', colour: '#19559c' },
  { name: 'INNOVATION', description: "Think ahead. Build what's next.", colour: '#752d81' },
  { name: 'INTEGRITY', description: 'Do right. Always.', colour: '#5a623e' },
  { name: 'CARING', description: 'People first in every decision.', colour: '#619c77' },
  { name: 'CUSTOMER CENTRICITY', description: 'Your outcomes. Our responsibility.', colour: '#e58f00' },
  { name: 'ENTREPRENEURSHIP', description: 'Own it. Drive it. Deliver it.', colour: '#ba232b' },
]

export async function up(knex: Knex): Promise<void> {
  const existing = (await knex('behaviours').orderBy('id', 'asc').select('id', 'name')) as BehaviourRow[]

  const claimedIds = new Set<number>()
  const plan: { target: (typeof CHAMP_BEHAVIOURS)[number]; id: number | null }[] = []

  // Pass 1 — exact name matches keep their own row, so their history is intact.
  for (const target of CHAMP_BEHAVIOURS) {
    const match = existing.find(
      (row) => row.name.trim().toLowerCase() === target.name.toLowerCase() && !claimedIds.has(row.id),
    )
    if (match) claimedIds.add(match.id)
    plan.push({ target, id: match?.id ?? null })
  }

  // Pass 2 — everything still unmatched takes over a leftover row.
  const leftovers = existing.filter((row) => !claimedIds.has(row.id))
  for (const entry of plan) {
    if (entry.id !== null) continue
    const row = leftovers.shift()
    if (row) {
      entry.id = row.id
      claimedIds.add(row.id)
    }
  }

  // `name` is UNIQUE, so renaming in one pass can collide with a row that has
  // not been renamed yet (Quality → INTEGRITY while INTEGRITY still sits on
  // another row). Park every row on a guaranteed-unique placeholder first.
  for (const id of claimedIds) {
    await knex('behaviours').where({ id }).update({ name: `__champ_migrating_${id}` })
  }

  for (const [index, entry] of plan.entries()) {
    const patch = {
      name: entry.target.name,
      description: entry.target.description,
      colour: entry.target.colour,
      sort_order: index + 1,
      active: 1,
    }
    if (entry.id === null) await knex('behaviours').insert(patch)
    else await knex('behaviours').where({ id: entry.id }).update(patch)
  }

  // Retire, never delete: a foreign key would block the delete anyway wherever
  // records exist, and a deactivated row keeps old recognitions readable.
  if (leftovers.length > 0) {
    await knex('behaviours')
      .whereIn('id', leftovers.map((r) => r.id))
      .update({ active: 0 })
  }
}

/**
 * Irreversible by design. The previous labels are not recorded anywhere this
 * migration can read back, and guessing at them would be worse than refusing.
 */
export async function down(): Promise<void> {
  // no-op
}
