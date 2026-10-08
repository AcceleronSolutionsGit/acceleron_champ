import { getDb } from '../../db/knex'
import { nowIso } from '../../db/time'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

/**
 * Archives nominations from a quarter that ended more than a month ago.
 */
export async function archiveOldNominations(): Promise<{ archived: number }> {
  const db = getDb()
  const oneMonthAgo = dayjs().subtract(1, 'month').utc().toISOString()
  const now = nowIso()

  // Any nomination where the quarter_end is before oneMonthAgo
  // and status is not already 'archived' will be archived.
  
  const updated = await db('nominations')
    .where('quarter_end', '<', oneMonthAgo)
    .whereNot('status', 'archived')
    .update({
      status: 'archived',
      updated_at: now
    })

  return { archived: updated }
}
