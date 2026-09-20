/**
 * Print the shape of the DarwinBox payload, so the seniority grade column can
 * be identified without guessing.
 *
 *   npm run dbx:fields -w server
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The report this deployment reads is built in DarwinBox, so its column names
 * are whatever whoever built it chose. The sync guesses from a list of usual
 * spellings; when the guess misses, every employee lands on no grade and the
 * whole junior/senior analysis reads as unmapped. One command settles it.
 *
 * ── What it will and will not print ───────────────────────────────────────
 * Column NAMES always. Column VALUES only where a column has few distinct,
 * short values across the whole dataset — which is true of grades, employment
 * types and locations, and false of names, emails, mobile numbers and dates.
 * That is a deliberate guard: this output gets pasted into chats and tickets,
 * and an HR payload is full of personal data that has no business there.
 */
import { config } from './config'

const MAX_DISTINCT_TO_PRINT = 20
const MAX_VALUE_LENGTH = 16
/** Anything matching these is never printed, whatever its cardinality. */
const NEVER_PRINT = /mobile|phone|email|name|dob|birth|address|pan|aadha|bank|salary|ctc/i

async function main(): Promise<void> {
  const { baseUrl, endpoint, apiKey, datasetKey, reportId, basicAuthUser, basicAuthPass } =
    config.darwinbox
  if (!basicAuthUser || !basicAuthPass) {
    console.error('Set DARWINBOX_BASIC_AUTH_USER and DARWINBOX_BASIC_AUTH_PASS in .env first.')
    process.exit(1)
  }
  const headers = {
    Authorization: `Basic ${Buffer.from(`${basicAuthUser}:${basicAuthPass}`).toString('base64')}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }

  const useMaster = Boolean(datasetKey) || endpoint.includes('masterapi')
  const url = useMaster
    ? `${baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`
    : `${baseUrl}/reportsbuilderapi/reportdatav2`
  const body = useMaster
    ? { api_key: apiKey, datasetKey }
    : { api_key: apiKey, report_id: reportId, get_latest_report: '1' }

  console.log(`Fetching ${url} …\n`)
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) {
    console.error(`HTTP ${res.status} — check the credentials and report id.`)
    process.exit(1)
  }
  const json = (await res.json()) as Record<string, unknown>
  const data = ((json.employee_data ?? json.data ?? (json.response as any)?.data) ??
    []) as Record<string, unknown>[]
  if (!Array.isArray(data) || data.length === 0) {
    console.error('No records came back. Response keys:', Object.keys(json).join(', '))
    process.exit(1)
  }

  console.log(`${data.length} records.\n`)

  // Union of keys — reports are not guaranteed to be rectangular.
  const columns = [...new Set(data.flatMap((r) => Object.keys(r)))].sort()

  console.log('── COLUMNS ' + '─'.repeat(58))
  for (const col of columns) {
    const values = data
      .map((r) => (r[col] === null || r[col] === undefined ? '' : String(r[col]).trim()))
      .filter((v) => v !== '')
    const distinct = [...new Set(values)]
    const filled = Math.round((values.length / data.length) * 100)

    let sample = ''
    const printable =
      !NEVER_PRINT.test(col) &&
      distinct.length > 0 &&
      distinct.length <= MAX_DISTINCT_TO_PRINT &&
      distinct.every((v) => v.length <= MAX_VALUE_LENGTH)
    if (printable) sample = `  ${distinct.sort().join(', ')}`
    else if (distinct.length > 0) sample = `  (${distinct.length} distinct values, not shown)`

    // date_of_exit is genuinely 0.3% filled; printing "0%" made it look empty.
    const filledLabel = values.length === 0 ? '  0' : filled === 0 ? ' <1' : String(filled).padStart(3)
    console.log(`${col.padEnd(34)} ${filledLabel}% filled${sample}`)
  }

  // ── the point of the exercise ─────────────────────────────────────────────
  const LADDER = ['M2', 'G1', 'SRG1', 'G2', 'SRG2', 'G3', 'SRG3', 'G4', 'SRG4', 'G5']
  const norm = (v: unknown) => String(v ?? '').toUpperCase().replace(/[\s._-]+/g, '')
  const targetCompany = config.darwinbox.companyCode.trim().toUpperCase()

  console.log('\n── COLUMNS THAT LOOK LIKE THE SENIORITY LADDER ' + '─'.repeat(23))
  const gradeColumns: string[] = []
  for (const col of columns) {
    const values = data.map((r) => norm(r[col])).filter(Boolean)
    if (values.length === 0) continue
    const hitRate = Math.round((values.filter((v) => LADDER.includes(v)).length / values.length) * 100)
    if (hitRate >= 20) {
      gradeColumns.push(col)
      console.log(`  ${col}  — ${hitRate}% of values are on the ladder`)
    }
  }

  if (gradeColumns.length === 0) {
    console.log(
      '\n→ Nothing matches the ladder. Either the directory has no grade column,\n' +
        '  or the grades are spelled differently — send the column list above and\n' +
        '  the ladder can be updated in server/src/modules/grades.ts.',
    )
    return
  }

  /**
   * Every distinct value of the grade column, with counts.
   *
   * The generic cap above deliberately hides high-cardinality columns, because
   * those are the ones full of names and numbers. A grade column is the
   * exception and the whole reason this script exists: the values are short
   * non-personal codes, and the ones NOT on the ladder are precisely what has
   * to be read off and added to it. Hiding them behind a cap made the first
   * run of this script useless.
   */
  for (const col of gradeColumns) {
    console.log(`\n── ALL VALUES OF "${col}" ` + '─'.repeat(Math.max(3, 46 - col.length)))

    const tally = (rows: Record<string, unknown>[]) => {
      const counts = new Map<string, number>()
      for (const r of rows) {
        const v = norm(r[col]) || '(blank)'
        counts.set(v, (counts.get(v) ?? 0) + 1)
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])
    }

    const scopes: { label: string; rows: Record<string, unknown>[] }[] = [
      { label: `all ${data.length} records`, rows: data },
    ]
    if (targetCompany) {
      const own = data.filter(
        (r) => String(r.group_company_code ?? r['Group Company Code'] ?? '').trim().toUpperCase() === targetCompany,
      )
      // The sync only ever writes this company, so its coverage is the number
      // that decides whether the dashboard works — not the group-wide one.
      scopes.push({ label: `${targetCompany} only — ${own.length} records`, rows: own })
    }

    for (const scope of scopes) {
      if (scope.rows.length === 0) {
        console.log(`\n  ${scope.label}: no records matched.`)
        continue
      }
      const rows = tally(scope.rows)
      const known = rows.filter(([v]) => LADDER.includes(v))
      const unknown = rows.filter(([v]) => !LADDER.includes(v))
      const knownTotal = known.reduce((s, [, n]) => s + n, 0)
      const unknownTotal = unknown.reduce((s, [, n]) => s + n, 0)

      console.log(`\n  ${scope.label}`)
      console.log(`    ON the ladder   (${knownTotal} people, ${known.length} grades):`)
      // Ladder order, not frequency — so the shape of the org is readable.
      for (const g of LADDER) {
        const hit = known.find(([v]) => v === g)
        if (hit) console.log(`      ${g.padEnd(8)} ${String(hit[1]).padStart(5)}`)
      }
      if (unknown.length > 0) {
        console.log(`    NOT on the ladder (${unknownTotal} people, ${unknown.length} grades):`)
        for (const [v, n] of unknown) console.log(`      ${v.padEnd(8)} ${String(n).padStart(5)}`)
      } else {
        console.log('    NOT on the ladder: none — every grade is mapped.')
      }
    }
  }

  console.log(
    '\n→ The values under "NOT on the ladder" are the ones to place. Send that\n' +
      '  list back and they can be slotted into the right rungs in\n' +
      '  server/src/modules/grades.ts. Until they are, people on those grades\n' +
      '  are reported as "grade not mapped" rather than counted as peers.',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
