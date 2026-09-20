/**
 * FR-1 / architecture §3.1 — nightly employee directory sync from DarwinBox
 * (the HRMS master). The directory is read-only here: the tool never writes
 * back to DarwinBox.
 *
 * ── PRODUCTION (real integration) ─────────────────────────────────────────
 * Supports DarwinBox Employee Master API (/masterapi/employee) using
 * api_key + datasetKey, with fallback to Report Builder API (/reportdatav2).
 * Filtered by target company code (e.g. ASPL).
 */
import { z } from 'zod'
import { Knex } from 'knex'
import { config } from '../../config'
import { getDb } from '../../db/knex'
import { nowIso } from '../../db/time'
import { isKnownGrade, normalizeGrade } from '../grades'
import { Employee } from '../../types'

export interface DirectorySyncResult {
  mode: 'demo' | 'live'
  upserts: number
  deactivated: number
  unchanged?: number
  matched?: number
  /** How many synced employees landed on a grade the ladder recognises. */
  gradedOnLadder?: number
  /** Grades seen that are NOT on the ladder, so a new rung is visible at once. */
  unmappedGrades?: string[]
  message: string
}

// ── DarwinBox payload validation ─────────────────────────────────────────────

const dbxEmployeeSchema = z
  .object({
    // Employee Master API (/masterapi/employee) fields:
    employee_id: z.string().nullish(),
    personal_mobile_no: z.string().nullish(),
    company_email_id: z.string().nullish(),
    direct_manager_employee_id: z.string().nullish(),
    office_location: z.string().nullish(),
    job_level: z.string().nullish(),
    employee_type: z.string().nullish(),
    date_of_exit: z.string().nullish(),
    full_name: z.string().nullish(),
    group_company_code: z.string().nullish(),
    date_of_joining: z.string().nullish(),
    function_name: z.string().nullish(),
    // Legacy Report Builder API (/reportdatav2) fallback fields:
    'Employee Id': z.string().nullish(),
    'Full Name': z.string().nullish(),
    'Parent Function Name': z.string().nullish(),
    'Top Department': z.string().nullish(),
    'Location': z.string().nullish(),
    'Personal Mobile Number': z.string().nullish(),
    'Official Email Id': z.string().nullish(),
    'Employee Type': z.string().nullish(),
    'Job Level': z.string().nullish(),
    'Direct Manager Employee Id': z.string().nullish(),
    'Date Of Exit': z.string().nullish(),
    'Updated On': z.string().nullish(),
    'Group Company Code': z.string().nullish(),
  })
  .passthrough()

const dbxPageSchema = z
  .object({
    response: z
      .object({
        data: z.array(dbxEmployeeSchema).optional().default([]),
      })
      .optional(),
  })
  .passthrough()

type DbxEmployee = z.infer<typeof dbxEmployeeSchema>

// ── helpers ──────────────────────────────────────────────────────────────────

/** Normalize an HRMS mobile to E.164. Indian 10-digit numbers get +91. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.replace(/[^\d+]/g, '')
  if (/^\+\d{8,15}$/.test(cleaned)) return cleaned
  const bare = cleaned.replace(/^\+/, '').replace(/^0+/, '')
  if (/^91\d{10}$/.test(bare)) return `+${bare}`
  if (/^\d{10}$/.test(bare)) return `+91${bare}`
  return null // unusable — WhatsApp identification needs a real E.164 number
}

function getEmployeeCode(rec: DbxEmployee): string {
  return String(rec.employee_id ?? rec['Employee Id'] ?? '').trim()
}

function getCompanyCode(rec: DbxEmployee): string {
  return String(rec.group_company_code ?? rec['Group Company Code'] ?? '').trim()
}

function getMobileRaw(rec: DbxEmployee): string | null {
  return rec.personal_mobile_no ?? rec['Personal Mobile Number'] ?? null
}

function getManagerCode(rec: DbxEmployee): string {
  return String(rec.direct_manager_employee_id ?? rec['Direct Manager Employee Id'] ?? '').trim()
}

function isDbxActive(rec: DbxEmployee): boolean {
  const exit = String(rec.date_of_exit ?? rec['Date Of Exit'] ?? '').trim()
  return exit === '' || exit === 'N.A.' || exit.toLowerCase() === 'null'
}

/**
 * Where the seniority grade might live in the payload.
 *
 * The Employee Master API calls it job_level; the Report Builder reports this
 * deployment actually uses name their columns in title case, and which one
 * carries the grade depends on how the report was built. Trying the likely
 * spellings beats hard-coding one and silently storing nothing — which is how
 * every employee ended up on a default grade in the first place.
 *
 * DARWINBOX_GRADE_FIELD overrides the lot when the column is named something
 * this list does not guess.
 */
const GRADE_FIELD_CANDIDATES = [
  'job_level',
  'Job Level',
  'Job level',
  'JobLevel',
  'grade',
  'Grade',
  'Employee Grade',
  'employee_grade',
  'band',
  'Band',
  'Job Band',
  'job_band',
  'Designation Grade',
  'Level',
  'level',
] as const

/** Logged once per process so an unmapped report is visible without a redeploy. */
let gradeSchemaLogged = false

/**
 * Pull the grade out of a record, whatever the report calls the column.
 *
 * When nothing matches, the record's column NAMES are logged once — names
 * only, never values, because the payload is full of mobile numbers and
 * personal emails and a sync log is not the place for them.
 */
function readGrade(rec: DbxEmployee): string {
  const configured = config.darwinbox.gradeField.trim()
  const keys = configured ? [configured, ...GRADE_FIELD_CANDIDATES] : GRADE_FIELD_CANDIDATES
  for (const key of keys) {
    const raw = (rec as Record<string, unknown>)[key]
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      return normalizeGrade(String(raw))
    }
  }
  if (!gradeSchemaLogged) {
    gradeSchemaLogged = true
    console.warn(
      '[darwinbox] no seniority grade found on this record. Columns present: ' +
        Object.keys(rec).join(', ') +
        '\n  → set DARWINBOX_GRADE_FIELD to the right one, or run `npm run dbx:fields -w server`.',
    )
  }
  return ''
}

/**
 * Tidy an HRMS office location.
 *
 * DarwinBox's office_location repeats the city before the state — real values
 * out of the directory look like "Asansol Asansol- West Bengal" and "Greater
 * Noida Greater Noida- Uttar Pradesh". On a chart axis or a board footer that
 * is twice the width for none of the meaning, so a leading repeat is collapsed
 * and the separator spaced properly:
 *
 *     "Asansol Asansol- West Bengal"  →  "Asansol – West Bengal"
 *
 * Only an EXACT immediate repeat is touched. A genuine name that happens to
 * start with a repeated word is left alone, and nothing is dropped from the
 * far side of the separator, so no two real offices can collapse into one.
 */
export function tidyLocation(raw: string): string {
  const squeezed = raw.replace(/\s+/g, ' ').trim()
  if (!squeezed) return squeezed
  const deduped = squeezed.replace(/^(.+?)\s+\1(?=\s|,|-|–|$)/i, '$1')
  return deduped.replace(/\s*[-–]\s*/g, ' – ').trim()
}

/** Map a DarwinBox record onto our employees columns (sync-owned fields only). */
/**
 * Grades we have already complained about this run.
 *
 * A directory of a few thousand people with one unmapped rung would otherwise
 * put a few thousand identical lines in the sync log and bury everything else.
 */
const unknownGradesSeen = new Set<string>()

function mapFields(rec: DbxEmployee, mobile: string, companyCode: string): Partial<Employee> {
  /**
   * The HRMS grade, kept AS DARWINBOX REPORTS IT.
   *
   * This used to read `/^L[1-5]$/.test(grade) ? grade : 'L2'`, which looks
   * like a guard and behaves like a wipe: the real job_level values are
   * M2 / G1 / SRG1 / G2 / … / G5, none of which match, so every synced
   * employee landed on 'L2'. The direction-of-recognition analysis then
   * compared L2 with L2 for every pair and reported the entire programme as
   * peer-to-peer. Grades are stored verbatim now; modules/grades.ts owns the
   * question of what they mean.
   */
  const grade = readGrade(rec)
  const rawName = String(rec.full_name ?? rec['Full Name'] ?? 'Employee').trim()
  const rawDept = String(rec.function_name ?? rec['Parent Function Name'] ?? 'Unassigned').trim()
  const rawSubTeam = String(rec['Top Department'] ?? '').trim()
  const rawSite = tidyLocation(String(rec.office_location ?? rec['Location'] ?? 'Unassigned'))
  const rawEmail = String(rec.company_email_id ?? rec['Official Email Id'] ?? '').trim().toLowerCase()
  const hrmsUpdatedOn = String(rec['Updated On'] ?? rec.date_of_joining ?? '').trim()

  // A grade off the ladder is a directory problem, not a row to silently
  // reshape: it is stored as-is and those rows are reported separately in the
  // analytics rather than being counted as peer-to-peer.
  if (grade && !isKnownGrade(grade) && !unknownGradesSeen.has(grade)) {
    unknownGradesSeen.add(grade)
    console.warn(
      `[darwinbox] job_level "${grade}" is not on the seniority ladder — ` +
        'recognitions involving these employees will be reported as "grade not mapped". ' +
        'Add the rung to server/src/modules/grades.ts if it is a real one.',
    )
  }

  return {
    name: rawName || 'Employee',
    function: rawDept || 'Unassigned',
    sub_team: rawSubTeam || null,
    shift: 'General',
    site: rawSite || 'Unassigned',
    mobile,
    email: rawEmail || null,
    employment_type: String(rec.employee_type ?? rec['Employee Type'] ?? '')
      .trim()
      .toLowerCase()
      .includes('contract')
      ? 'contractual'
      : 'permanent',
    level_grade: grade || 'UNKNOWN',
    active: isDbxActive(rec) ? 1 : 0,
    hrms_updated_on: hrmsUpdatedOn || null,
    company_code: companyCode || null,
  }
}

/**
 * The columns this sync owns. Anything not listed here (language, consent,
 * manager_id) is set elsewhere and must survive a sync untouched.
 */
const SYNCED_COLUMNS = [
  'name',
  'function',
  'sub_team',
  'shift',
  'site',
  'mobile',
  'email',
  'employment_type',
  'level_grade',
  'active',
  'hrms_updated_on',
  'company_code',
] as const

/**
 * Has anything the sync owns actually changed?
 *
 * This used to be "did DarwinBox bump Updated On", which is a proxy, and a
 * leaky one — DarwinBox does not touch that field for every edit. The cost
 * showed up when job_level was being silently flattened to 'L2': correcting
 * the mapping fixed what NEW rows would get, but every existing employee was
 * skipped on the next sync as "unchanged" and kept the wrong grade forever.
 * There was no way to repair the directory short of editing the database by
 * hand.
 *
 * Comparing the mapped values instead means a fix to mapFields() repairs the
 * whole directory on the next run, and a field DarwinBox edits without
 * touching its timestamp no longer goes missing. The write it saves is one
 * cheap UPDATE on a few thousand rows once a night, which was never the
 * expensive part of this job — the HTTP fetch is.
 */
export function hasChanges(current: Partial<Employee>, fields: Partial<Employee>): boolean {
  for (const col of SYNCED_COLUMNS) {
    const next = fields[col]
    if (next === undefined) continue
    const now = current[col]
    // Null and empty string are the same absence as far as the directory is
    // concerned, and would otherwise rewrite the same row every single night.
    const normalise = (v: unknown) => (v === null || v === undefined ? '' : v)
    if (normalise(now) !== normalise(next)) return true
  }
  return false
}

/** Basic Auth headers for Darwinbox. */
async function authHeaders(): Promise<Record<string, string>> {
  const { basicAuthUser, basicAuthPass } = config.darwinbox
  if (basicAuthUser && basicAuthPass) {
    const encoded = Buffer.from(`${basicAuthUser}:${basicAuthPass}`).toString('base64')
    return { Authorization: `Basic ${encoded}` }
  }
  throw new Error(
    'DarwinBox sync enabled but no credentials — set DARWINBOX_BASIC_AUTH_USER and DARWINBOX_BASIC_AUTH_PASS',
  )
}

/** Fetch the complete employee dataset using Employee Master API or Report Builder API. */
async function fetchAllEmployees(headers: Record<string, string>): Promise<DbxEmployee[]> {
  const { baseUrl, endpoint, apiKey, datasetKey, reportId } = config.darwinbox

  // 1. Employee Master API (/masterapi/employee)
  if (datasetKey || endpoint?.includes('masterapi')) {
    const ep = endpoint?.startsWith('/') ? endpoint : `/${endpoint || 'masterapi/employee'}`
    const url = new URL(`${baseUrl}${ep}`)
    console.log(`[darwinbox] fetching from Employee Master API: ${url.toString()}`)
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey, datasetKey }),
    })
    if (!res.ok) {
      throw new Error(`DarwinBox employee master fetch failed: HTTP ${res.status}`)
    }
    const rawJson = (await res.json()) as any
    const data = rawJson.employee_data || rawJson.data || rawJson.response?.data
    if (!Array.isArray(data)) {
      throw new Error(`DarwinBox API response missing employee array: ${rawJson.message || 'Unknown error'}`)
    }
    return data as DbxEmployee[]
  }

  // 2. Report Builder API (/reportsbuilderapi/reportdatav2) fallback
  const url = new URL(`${baseUrl}/reportsbuilderapi/reportdatav2`)
  console.log(`[darwinbox] fetching from Report Builder API: ${url.toString()}`)
  const body = {
    api_key: apiKey,
    report_id: reportId,
    get_latest_report: '1',
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`DarwinBox employee fetch failed: HTTP ${res.status}`)
  }
  const rawJson = await res.json()
  const parsed = dbxPageSchema.parse(rawJson)
  return parsed.response?.data ?? []
}

// ── the sync itself ──────────────────────────────────────────────────────────

async function liveSync(db: Knex): Promise<DirectorySyncResult> {
  const headers = await authHeaders()
  const fetched = await fetchAllEmployees(headers)
  const now = nowIso()

  const targetCompany = config.darwinbox.companyCode?.trim().toUpperCase()
  console.log(`[darwinbox] fetched ${fetched.length} records. Filter company code: "${targetCompany || 'ALL'}"`)

  /**
   * Every column the sync owns, so a redundant write can be detected by
   * comparing values rather than by trusting a timestamp.
   */
  const existing = (await db('employees').select(
    'id',
    'employee_code',
    ...SYNCED_COLUMNS,
  )) as Array<Pick<Employee, 'id' | 'employee_code'> & Partial<Employee> & { company_code?: string | null }>

  const existingByCode = new Map(existing.map((e) => [e.employee_code, e]))

  let upserts = 0
  let unchanged = 0
  let skipped = 0
  let matchedCompanyCount = 0
  const seenCodes = new Set<string>()
  const managerCodeByCode = new Map<string, string>() // for the second pass
  // Grade coverage, reported back so a sync that quietly stored nothing is
  // obvious from the admin console rather than only from the analytics weeks
  // later.
  let gradedOnLadder = 0
  const unmappedGrades = new Set<string>()

  for (const rec of fetched) {
    const recCompany = getCompanyCode(rec)
    if (targetCompany && recCompany.toUpperCase() !== targetCompany) {
      continue
    }
    matchedCompanyCount += 1

    const rawCode = getEmployeeCode(rec)
    if (!rawCode) {
      skipped += 1
      continue
    }
    const code = rawCode
    if (seenCodes.has(code)) continue // dataset duplicate — first record wins

    const mobile = toE164(getMobileRaw(rec))
    if (!mobile) {
      // The mobile is the WhatsApp identity (FR-2) and a NOT NULL UNIQUE
      // column — records without a usable number cannot be enrolled.
      skipped += 1
      continue
    }
    seenCodes.add(code)
    const managerCode = getManagerCode(rec)
    if (managerCode) managerCodeByCode.set(code, managerCode)

    const fields = mapFields(rec, mobile, recCompany || targetCompany || '')
    const syncedGrade = String(fields.level_grade ?? '')
    if (isKnownGrade(syncedGrade)) gradedOnLadder += 1
    else unmappedGrades.add(syncedGrade || '(blank)')
    try {
      const current = existingByCode.get(code)
      if (current) {
        if (!hasChanges(current, fields)) {
          unchanged += 1
          continue
        }
        await db('employees').where({ id: current.id }).update({ ...fields, updated_at: now })
      } else {
        await db('employees').insert({
          employee_code: code,
          ...fields,
          manager_id: null, // resolved in the second pass below
          language: 'en',
          consent_recorded: 0,
          created_at: now,
          updated_at: now,
        })
      }
      upserts += 1
    } catch (err) {
      skipped += 1
      console.error(`[darwinbox] upsert failed for ${code}:`, err)
    }
  }

  // Second pass — resolve manager references now that every row exists.
  const idByCode = new Map<string, number>(
    ((await db('employees').select('id', 'employee_code')) as Pick<
      Employee,
      'id' | 'employee_code'
    >[]).map((e) => [e.employee_code, e.id]),
  )
  for (const [code, managerCode] of managerCodeByCode) {
    const id = idByCode.get(code)
    const managerId = idByCode.get(managerCode) ?? null
    if (id !== undefined && managerId !== null) {
      await db('employees').where({ id }).update({ manager_id: managerId })
    }
  }

  // Deactivate actives that vanished from DarwinBox for the targeted company.
  // Note: Admin & committee emails are protected so dev/admin test accounts remain active.
  const protectedEmails = new Set(
    [...config.auth.adminEmails, ...config.auth.committeeEmails].map((e) => e.trim().toLowerCase()),
  )
  let deactivated = 0
  for (const e of existing) {
    // Only consider deactivating if the employee belongs to the target company (or targetCompany is unset)
    const empCompany = (e.company_code ?? '').trim().toUpperCase()
    if (targetCompany && empCompany && empCompany !== targetCompany) {
      continue
    }

    if (e.active && !seenCodes.has(e.employee_code)) {
      if (e.email && protectedEmails.has(e.email.trim().toLowerCase())) {
        continue
      }
      await db('employees').where({ id: e.id }).update({ active: 0, updated_at: now })
      deactivated += 1
    }
  }

  const filterNote = targetCompany ? ` (filtered by company code "${targetCompany}", matched ${matchedCompanyCount}/${fetched.length})` : ''
  const unchangedNote = unchanged > 0 ? `, ${unchanged} unchanged` : ''
  const skippedNote = skipped ? `, ${skipped} skipped (no usable mobile / conflict)` : ''
  const seen = seenCodes.size
  const gradeNote =
    seen === 0
      ? ''
      : gradedOnLadder === 0
        ? ` NO grades landed on the seniority ladder — the report's grade column is probably named something else; run "npm run dbx:fields -w server" and set DARWINBOX_GRADE_FIELD.`
        : ` Grades on the ladder: ${gradedOnLadder}/${seen}.${
            unmappedGrades.size > 0
              ? ` Unmapped: ${[...unmappedGrades].sort().slice(0, 10).join(', ')}.`
              : ''
          }`
  return {
    mode: 'live',
    upserts,
    unchanged,
    matched: matchedCompanyCount,
    deactivated,
    gradedOnLadder,
    unmappedGrades: [...unmappedGrades].sort(),
    message: `DarwinBox sync complete: ${upserts} upserted${unchangedNote}, ${deactivated} deactivated${filterNote}${skippedNote}.${gradeNote}`,
  }
}

/**
 * Run the directory sync. Called nightly by the scheduler and on demand from
 * the admin console ("Sync from DarwinBox", FR-24).
 */
export async function runDirectorySync(): Promise<DirectorySyncResult> {
  if (!config.darwinbox.enabled) {
    // ── LOCAL (demo fallback) — active by default ──────────────────────────
    return {
      mode: 'demo',
      upserts: 0,
      deactivated: 0,
      message:
        'DarwinBox sync disabled — running on the seeded demo directory. Set DARWINBOX_* env to enable.',
    }
  }
  // ── PRODUCTION (real integration) ────────────────────────────────────────
  return liveSync(getDb())
}
