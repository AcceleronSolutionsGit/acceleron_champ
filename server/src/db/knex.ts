/**
 * Database bootstrap. Local development uses zero-config SQLite
 * (better-sqlite3). Production uses a managed MySQL or PostgreSQL server —
 * switch with DATABASE_CLIENT=mysql2 / pg plus DATABASE_URL (see .env.example).
 *
 * SERVERLESS (Vercel): every concurrent lambda opens its own pool, so the pool
 * ceiling drops to 2 connections — ten lambdas would otherwise be enough to
 * exhaust a default MySQL max_connections. Migrations do not run here either;
 * they run once during the build (src/db/migrate.ts).
 */
import knexFactory, { Knex } from 'knex'
import path from 'path'
import fs from 'fs'
import { config } from '../config'
import { isServerless, migrateAtBoot } from '../runtime'

let db: Knex | null = null

/**
 * Static require hints for serverless bundlers. Knex resolves its drivers with
 * a computed require() that dependency tracing cannot follow, so without these
 * literals the driver is missing from the deployed function. Never called.
 */
export const __driverHints = {
  mysql2: () => require('mysql2'),
  pg: () => require('pg'),
}

function knexConfig(): Knex.Config {
  if (config.db.client === 'pg' || config.db.client === 'mysql2' || config.db.client === 'mysql') {
    // PRODUCTION / EXTERNAL DB (PostgreSQL or MySQL/phpMyAdmin)
    if (!config.db.databaseUrl) {
      throw new Error(`DATABASE_CLIENT=${config.db.client} requires DATABASE_URL`)
    }
    return {
      client: config.db.client,
      connection: config.db.databaseUrl,
      pool: { min: 0, max: isServerless ? 2 : 10 },
      acquireConnectionTimeout: 15000,
    }
  }
  fs.mkdirSync(path.dirname(config.db.sqliteFile), { recursive: true })
  return {
    client: 'better-sqlite3',
    connection: { filename: config.db.sqliteFile },
    useNullAsDefault: true,
  }
}

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

/**
 * Migration identity must be EXTENSION-AGNOSTIC: dev (tsx) loads
 * `001_init.ts`, the production build loads compiled `001_init.js`. Knex's
 * default FsMigrations records the full filename in knex_migrations, so a
 * database created in one mode crashes the other at boot with "the migration
 * directory is corrupt". Recording the bare name ('001_init') lets one
 * SQLite file move freely between `npm run dev`, `npm start` and the Docker
 * image (deploy/docker-compose.yml mounts the same ./data folder).
 */
class ExtensionAgnosticMigrationSource implements Knex.MigrationSource<string> {
  async getMigrations(): Promise<string[]> {
    return fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.js')) && !f.endsWith('.d.ts'))
      .map((f) => f.replace(/\.(ts|js)$/, ''))
      .sort()
  }

  getMigrationName(migration: string): string {
    return migration
  }

  getMigration(migration: string): Promise<Knex.Migration> {
    const base = path.join(MIGRATIONS_DIR, migration)
    const file = [`${base}.ts`, `${base}.js`].find((f) => fs.existsSync(f))
    if (!file) throw new Error(`Migration file not found for "${migration}" in ${MIGRATIONS_DIR}`)
    // .ts resolves under tsx (dev); .js in the compiled dist build.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return Promise.resolve(require(file) as Knex.Migration)
  }
}

/** Databases created before the extension-agnostic source recorded
 *  '001_init.ts' / '001_init.js' — strip the extension once so they load. */
async function normalizeRecordedMigrationNames(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('knex_migrations'))) return
  const rows = (await knex('knex_migrations').select('id', 'name')) as { id: number; name: string }[]
  for (const row of rows) {
    const stripped = row.name.replace(/\.(ts|js)$/, '')
    if (stripped !== row.name) {
      await knex('knex_migrations').where({ id: row.id }).update({ name: stripped })
    }
  }
}

/** Run every pending migration. Safe to call repeatedly. */
export async function runMigrations(knex: Knex): Promise<void> {
  await normalizeRecordedMigrationNames(knex)
  await knex.migrate.latest({
    migrationSource: new ExtensionAgnosticMigrationSource(),
    tableName: 'knex_migrations',
  })
}

/**
 * Open the connection. Called once at boot.
 *
 * `runMigrations` defaults to true off-serverless and false on Vercel, where
 * the build step has already migrated — override with the option or with
 * RUN_MIGRATIONS_AT_BOOT.
 */
export async function initDb(opts?: { runMigrations?: boolean }): Promise<Knex> {
  if (db) return db
  db = knexFactory(knexConfig())
  if (opts?.runMigrations ?? migrateAtBoot()) {
    await runMigrations(db)
  }
  return db
}

export function getDb(): Knex {
  if (!db) throw new Error('Database not initialised — call initDb() first')
  return db
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy()
    db = null
  }
}
