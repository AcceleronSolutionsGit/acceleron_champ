import { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('employees')) {
    if (!(await knex.schema.hasColumn('employees', 'company_code'))) {
      await knex.schema.table('employees', (t) => {
        t.string('company_code', 30)
        t.index(['company_code'])
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('employees')) {
    if (await knex.schema.hasColumn('employees', 'company_code')) {
      await knex.schema.table('employees', (t) => {
        t.dropIndex(['company_code'])
        t.dropColumn('company_code')
      })
    }
  }
}
