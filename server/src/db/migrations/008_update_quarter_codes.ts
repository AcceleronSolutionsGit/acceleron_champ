import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  const rows = await knex('nominations').select('id', 'quarter')
  for (const row of rows) {
    const m = /^FY(\d{4})-Q([1-4])$/.exec(row.quarter)
    if (m) {
      const fyStart = Number(m[1])
      const fyQ = Number(m[2])
      let newCode = ''
      if (fyQ === 4) newCode = `${fyStart + 1}-Q1`
      else if (fyQ === 1) newCode = `${fyStart}-Q2`
      else if (fyQ === 2) newCode = `${fyStart}-Q3`
      else if (fyQ === 3) newCode = `${fyStart}-Q4`
      
      if (newCode) {
        await knex('nominations').where({ id: row.id }).update({ quarter: newCode })
      }
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  // Irreversible semantic change; not strictly needed for this.
}
