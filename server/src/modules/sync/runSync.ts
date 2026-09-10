import dotenv from 'dotenv'
import path from 'path'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..')
dotenv.config({ path: path.join(PROJECT_ROOT, '.env') })
dotenv.config()

import { initDb, closeDb } from '../../db/knex'
import { rebuildConfig } from '../../config'
import { runDirectorySync } from './darwinbox'

async function main() {
  rebuildConfig()
  console.log('[sync-runner] Initializing database and running migrations…')
  await initDb()

  console.log('[sync-runner] Starting Darwinbox sync…')
  const result = await runDirectorySync()
  console.log('[sync-runner] Sync result:', result)

  await closeDb()
  console.log('[sync-runner] Done.')
}

main().catch((err) => {
  console.error('[sync-runner] Error during sync:', err)
  process.exit(1)
})
