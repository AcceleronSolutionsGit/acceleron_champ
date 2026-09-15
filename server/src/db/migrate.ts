/**
 * CLI: `npm run migrate -w server` — run pending migrations against the
 * configured database, then upsert the ADMIN_EMAILS / COMMITTEE_EMAILS
 * allowlists into admin_users.
 *
 * This is what replaces migrate-on-boot for the Vercel deployment: it runs
 * once per deploy, from the build step (see the root `vercel-build` script),
 * where there is exactly one process and no cold-start race for the migration
 * lock.
 *
 * Demo seed data is opt-in here (SEED_DEMO_DATA=true) — a production database
 * should not get the demo directory just because it happens to be empty.
 */
import dotenv from 'dotenv'
import path from 'path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..')
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') })
dotenv.config()

import { config, rebuildConfig } from '../config'
import { closeDb, initDb } from './knex'
import { seedIfEmpty, upsertAdminUsers } from './seed/demo'

async function main(): Promise<void> {
  rebuildConfig()
  console.log(`[migrate] database client: ${config.db.client}`)

  const db = await initDb({ runMigrations: true })
  console.log('[migrate] migrations up to date')

  if (process.env.SEED_DEMO_DATA === 'true') {
    await seedIfEmpty(db)
    console.log('[migrate] demo seed applied (SEED_DEMO_DATA=true)')
  }

  await upsertAdminUsers(db)
  console.log('[migrate] admin/committee allowlists upserted')

  await closeDb()
}

main().catch((err) => {
  console.error('[migrate] failed:', err)
  process.exit(1)
})
