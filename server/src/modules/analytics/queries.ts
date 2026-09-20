/**
 * Analytics aggregations (FR-26…FR-31), one function per /api/analytics
 * endpoint.
 *
 * Implementation note (SPEC §5): at this scale (≤ a few thousand rows in any
 * 90-day window) each endpoint loads the date-range rows ONCE with a single
 * joined query and aggregates in JS — identical behaviour on SQLite and
 * PostgreSQL, no dialect-specific SQL.
 *
 * All functions exclude status='removed' (BR-6: removed entries keep their
 * row but lose all credit/visibility). Flagged entries still count — they are
 * genuine until a moderator says otherwise.
 */
import { getDb } from '../../db/knex'
import { formatIst, istWeekStartIso } from '../../db/time'
import { byGradeRank, Direction, directionOf, gradeRank, normalizeGrade } from '../grades'
import { Behaviour } from '../../types'

export interface AnalyticsRange {
  /** Inclusive UTC ISO bounds (already converted from IST dates by the route). */
  fromIso: string
  toIso: string
}

interface RecRow {
  id: number
  created_at: string
  behaviour_id: number
  giver_id: number
  recipient_id: number
  giver_name: string
  giver_function: string
  giver_site: string
  giver_shift: string
  giver_level: string
  recipient_name: string
  recipient_function: string
  recipient_site: string
  recipient_shift: string
  recipient_level: string
  reason_text: string
}

interface ActiveEmployee {
  id: number
  function: string
  sub_team: string | null
  shift: string
  site: string
  level_grade: string
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function pct(part: number, whole: number): number {
  return whole > 0 ? round1((part / whole) * 100) : 0
}

/** The one date-range query all endpoints share. */
async function loadRecognitions(range: AnalyticsRange): Promise<RecRow[]> {
  return (await getDb()('recognitions as rec')
    .join('employees as g', 'g.id', 'rec.giver_id')
    .join('employees as r', 'r.id', 'rec.recipient_id')
    .whereNot('rec.status', 'removed')
    .andWhere('rec.created_at', '>=', range.fromIso)
    .andWhere('rec.created_at', '<=', range.toIso)
    .select(
      'rec.id as id',
      'rec.created_at as created_at',
      'rec.reason_text as reason_text',
      'rec.behaviour_id as behaviour_id',
      'rec.giver_id as giver_id',
      'rec.recipient_id as recipient_id',
      'g.name as giver_name',
      'g.function as giver_function',
      'g.site as giver_site',
      'g.shift as giver_shift',
      'g.level_grade as giver_level',
      'r.name as recipient_name',
      'r.function as recipient_function',
      'r.site as recipient_site',
      'r.shift as recipient_shift',
      'r.level_grade as recipient_level',
    )) as RecRow[]
}

async function loadActiveEmployees(): Promise<ActiveEmployee[]> {
  return (await getDb()('employees')
    .where({ active: 1 })
    .select('id', 'function', 'sub_team', 'shift', 'site', 'level_grade')) as ActiveEmployee[]
}

// ── GET /summary (FR-26) ─────────────────────────────────────────────────────

export async function getSummary(range: AnalyticsRange): Promise<{
  recognitions: number
  activeEmployees: number
  givers: number
  receivers: number
  pctGivers: number
  pctReceivers: number
  weekly: { weekStartIst: string; count: number }[]
}> {
  const [rows, employees] = await Promise.all([loadRecognitions(range), loadActiveEmployees()])
  // Participation counts people, and headcount counts ACTIVE people — so a
  // giver/receiver who has since been deactivated (attrition + DarwinBox
  // sync, FR-4) must not inflate the numerator past 100%.
  const activeIds = new Set(employees.map((e) => e.id))
  const givers = new Set(rows.map((r) => r.giver_id).filter((id) => activeIds.has(id))).size
  const receivers = new Set(rows.map((r) => r.recipient_id).filter((id) => activeIds.has(id))).size

  // Bucket by IST Monday-start week, zero-filling quiet weeks so the trend
  // line has a continuous x-axis.
  const countByWeek = new Map<string, number>()
  for (const r of rows) {
    const week = istWeekStartIso(r.created_at)
    countByWeek.set(week, (countByWeek.get(week) ?? 0) + 1)
  }
  const weekly: { weekStartIst: string; count: number }[] = []
  const endMs = new Date(range.toIso).getTime()
  // Stepping 7 exact days is safe: IST has no DST, so week starts stay aligned.
  for (let ms = new Date(istWeekStartIso(range.fromIso)).getTime(); ms <= endMs; ms += WEEK_MS) {
    const weekIso = new Date(ms).toISOString()
    weekly.push({ weekStartIst: formatIst(weekIso, 'YYYY-MM-DD'), count: countByWeek.get(weekIso) ?? 0 })
  }

  return {
    recognitions: rows.length,
    activeEmployees: employees.length,
    givers,
    receivers,
    pctGivers: pct(givers, employees.length),
    pctReceivers: pct(receivers, employees.length),
    weekly,
  }
}

// ── GET /function-site (FR-27 equity across the org) ────────────────────────

interface GroupStat {
  name: string
  headcount: number
  given: number
  received: number
  giverParticipationPct: number
}

function groupStats(
  employees: ActiveEmployee[],
  rows: RecRow[],
  empKey: (e: ActiveEmployee) => string,
  giverKey: (r: RecRow) => string,
  recipientKey: (r: RecRow) => string,
): GroupStat[] {
  const groups = new Map<string, { headcount: number; given: number; received: number; givers: Set<number> }>()
  const ensure = (name: string) => {
    let g = groups.get(name)
    if (!g) {
      g = { headcount: 0, given: 0, received: 0, givers: new Set() }
      groups.set(name, g)
    }
    return g
  }
  const activeIds = new Set(employees.map((e) => e.id))
  for (const e of employees) ensure(empKey(e)).headcount += 1
  for (const r of rows) {
    // Row-side keys may name a group with zero ACTIVE headcount (e.g. history
    // from since-deactivated people) — still surfaced, with headcount 0.
    const given = ensure(giverKey(r))
    given.given += 1
    // Participation divides by ACTIVE headcount, so only count still-active
    // givers — a giver deactivated after the window would push past 100%.
    if (activeIds.has(r.giver_id)) given.givers.add(r.giver_id)
    ensure(recipientKey(r)).received += 1
  }
  return [...groups.entries()].map(([name, g]) => ({
    name,
    headcount: g.headcount,
    given: g.given,
    received: g.received,
    giverParticipationPct: pct(g.givers.size, g.headcount),
  }))
}

/**
 * Equity across the two dimensions a software org actually splits on.
 *
 * Was function-vs-SHIFT, inherited from a plant where the question was
 * whether the night shift got the same attention as the day office. There is
 * no shift rotation here, so the second dimension is the office — the real
 * risk being that whichever site leadership sits in quietly gets the lion's
 * share of the recognition.
 */
export async function getFunctionSite(range: AnalyticsRange): Promise<{
  functions: GroupStat[]
  sites: GroupStat[]
}> {
  const [rows, employees] = await Promise.all([loadRecognitions(range), loadActiveEmployees()])
  const byName = (a: GroupStat, b: GroupStat) => a.name.localeCompare(b.name)
  const functions = groupStats(
    employees,
    rows,
    (e) => e.function,
    (r) => r.giver_function,
    (r) => r.recipient_function,
  ).sort(byName)
  const sites = groupStats(
    employees,
    rows,
    (e) => e.site,
    (r) => r.giver_site,
    (r) => r.recipient_site,
  ).sort(byName)
  return { functions, sites }
}

// ── GET /behaviours (FR-28) ──────────────────────────────────────────────────

export async function getBehaviourBreakdown(range: AnalyticsRange): Promise<
  { behaviourId: number; name: string; colour: string; count: number; pct: number }[]
> {
  const [rows, behaviours] = await Promise.all([
    loadRecognitions(range),
    getDb()('behaviours').orderBy('sort_order') as Promise<Behaviour[]>,
  ])
  const counts = new Map<number, number>()
  for (const r of rows) counts.set(r.behaviour_id, (counts.get(r.behaviour_id) ?? 0) + 1)
  return behaviours
    .filter((b) => !!b.active || (counts.get(b.id) ?? 0) > 0) // inactive only when it has history
    .map((b) => ({
      behaviourId: b.id,
      name: b.name,
      colour: b.colour,
      count: counts.get(b.id) ?? 0,
      pct: pct(counts.get(b.id) ?? 0, rows.length),
    }))
    .sort((a, b) => b.count - a.count)
}

// ── GET /direction (FR-29) ───────────────────────────────────────────────────

/**
 * Which way recognition travels, by seniority and across function boundaries.
 *
 * `unknown` is a first-class bucket, not a rounding error: a recognition where
 * either side's grade is not on the ladder tells us nothing about direction,
 * and folding those into `peer` is how this number came to read 100% peer-to-
 * peer on live data. The console shows the unknown count and, when it is a
 * meaningful share, says the split is computed on the rest.
 */
export async function getDirectionMix(range: AnalyticsRange): Promise<{
  total: number
  /** Rows where both grades are on the ladder — the denominator for the split. */
  ranked: number
  unknownGrade: number
  juniorToSenior: number
  seniorToJunior: number
  peer: number
  crossFunction: number
  sameFunction: number
  /** Grades seen in the data that modules/grades.ts does not recognise. */
  unmappedGrades: string[]
}> {
  const rows = await loadRecognitions(range)
  const counts: Record<Direction, number> = { upward: 0, downward: 0, peer: 0, unknown: 0 }
  const unmapped = new Set<string>()
  let crossFunction = 0

  for (const r of rows) {
    counts[directionOf(r.giver_level, r.recipient_level)] += 1
    if (gradeRank(r.giver_level) === null) unmapped.add(normalizeGrade(r.giver_level) || '(blank)')
    if (gradeRank(r.recipient_level) === null) unmapped.add(normalizeGrade(r.recipient_level) || '(blank)')
    if (r.giver_function !== r.recipient_function) crossFunction += 1
  }

  return {
    total: rows.length,
    ranked: counts.upward + counts.downward + counts.peer,
    unknownGrade: counts.unknown,
    juniorToSenior: counts.upward,
    seniorToJunior: counts.downward,
    peer: counts.peer,
    crossFunction,
    sameFunction: rows.length - crossFunction,
    unmappedGrades: [...unmapped].sort(),
  }
}

// ── GET /grades (grade-wise flow) ────────────────────────────────────────────

export interface GradeStat {
  grade: string
  /** 1-based tier on the ladder; null when the grade is not recognised. */
  tier: number | null
  headcount: number
  given: number
  received: number
  /**
   * Per-head rates. Raw counts flatter big grades — a 40-person engineering
   * rung will out-count a 4-person leadership one however quiet it is — so
   * every comparison across grades uses these instead.
   */
  givenPerHead: number
  receivedPerHead: number
  /** Share of this grade's people who gave / received at least once. */
  giverParticipationPct: number
  receiverCoveragePct: number
}

export interface GradeMatrixCell {
  giverGrade: string
  recipientGrade: string
  count: number
  /** Share of the giver grade's own output — reads as "where this rung sends it". */
  pctOfGiverRow: number
}

export async function getGradeAnalysis(range: AnalyticsRange): Promise<{
  grades: GradeStat[]
  matrix: GradeMatrixCell[]
  total: number
  /** Rows where both sides are on the ladder; the matrix only covers these. */
  ranked: number
}> {
  const [rows, employees] = await Promise.all([loadRecognitions(range), loadActiveEmployees()])
  const activeIds = new Set(employees.map((e) => e.id))

  interface Acc {
    headcount: number
    given: number
    received: number
    givers: Set<number>
    receivers: Set<number>
  }
  const acc = new Map<string, Acc>()
  const ensure = (grade: string): Acc => {
    let a = acc.get(grade)
    if (!a) {
      a = { headcount: 0, given: 0, received: 0, givers: new Set(), receivers: new Set() }
      acc.set(grade, a)
    }
    return a
  }

  for (const e of employees) ensure(normalizeGrade(e.level_grade) || 'UNKNOWN').headcount += 1

  for (const r of rows) {
    const g = ensure(normalizeGrade(r.giver_level) || 'UNKNOWN')
    g.given += 1
    // Participation is a share of ACTIVE headcount, so a giver who has since
    // left must not push their old grade past 100%.
    if (activeIds.has(r.giver_id)) g.givers.add(r.giver_id)
    const rec = ensure(normalizeGrade(r.recipient_level) || 'UNKNOWN')
    rec.received += 1
    if (activeIds.has(r.recipient_id)) rec.receivers.add(r.recipient_id)
  }

  const grades: GradeStat[] = [...acc.entries()]
    .map(([grade, a]) => ({
      grade,
      tier: gradeRank(grade),
      headcount: a.headcount,
      given: a.given,
      received: a.received,
      givenPerHead: a.headcount > 0 ? round1(a.given / a.headcount) : 0,
      receivedPerHead: a.headcount > 0 ? round1(a.received / a.headcount) : 0,
      giverParticipationPct: pct(a.givers.size, a.headcount),
      receiverCoveragePct: pct(a.receivers.size, a.headcount),
    }))
    .sort((a, b) => byGradeRank(a.grade, b.grade))

  // ── giver grade × recipient grade ──────────────────────────────────────────
  // Only rows where BOTH sides are on the ladder: a cell keyed on a grade the
  // ladder does not know would be a row in the heatmap that cannot be placed
  // in seniority order, which is the one thing the heatmap is for.
  const cellCounts = new Map<string, number>()
  const rowTotals = new Map<string, number>()
  let ranked = 0
  for (const r of rows) {
    const gg = normalizeGrade(r.giver_level)
    const rg = normalizeGrade(r.recipient_level)
    if (gradeRank(gg) === null || gradeRank(rg) === null) continue
    ranked += 1
    const key = `${gg}\u0000${rg}`
    cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1)
    rowTotals.set(gg, (rowTotals.get(gg) ?? 0) + 1)
  }

  const matrix: GradeMatrixCell[] = [...cellCounts.entries()]
    .map(([key, count]) => {
      const [giverGrade, recipientGrade] = key.split('\u0000')
      return {
        giverGrade,
        recipientGrade,
        count,
        pctOfGiverRow: pct(count, rowTotals.get(giverGrade) ?? 0),
      }
    })
    .sort(
      (a, b) =>
        byGradeRank(a.giverGrade, b.giverGrade) || byGradeRank(a.recipientGrade, b.recipientGrade),
    )

  return { grades, matrix, total: rows.length, ranked }
}


// ── GET /grade-flow (who → whom, behind a matrix cell) ───────────────────────

export interface GradeFlowFilter {
  giverGrade?: string
  recipientGrade?: string
  /** 'upward' | 'downward' | 'peer' — an alternative to naming both grades. */
  direction?: Direction
  /** Restrict to one person, on EITHER side of the arrow. */
  personId?: number
  page: number
  pageSize: number
}

interface FlowPerson {
  id: number
  name: string
  grade: string
  tier: number | null
  function: string
  site: string
}

export interface GradeFlowPair {
  giver: FlowPerson
  recipient: FlowPerson
  count: number
}

export interface GradeFlowItem {
  id: number
  createdAt: string
  giver: FlowPerson
  recipient: FlowPerson
  behaviour: { id: number; name: string; colour: string }
  reason: string
  direction: Direction
}

/**
 * The people behind a cell of the grade matrix.
 *
 * Two shapes of the same slice, because they answer different questions. The
 * PAIRS roll-up answers "is this a pattern or one relationship" — twelve
 * recognitions from G3 to SRG1 read very differently when they are one lead
 * recognising one report twelve times versus nine different people. The
 * ITEMS list is the evidence underneath, so a committee member can read what
 * was actually written before acting on the shape.
 *
 * Filtering by grade uses the NORMALIZED grade, so a row stored as ' srg2 '
 * is found by a click on the SRG2 column.
 */
export async function getGradeFlow(
  range: AnalyticsRange,
  filter: GradeFlowFilter,
): Promise<{
  total: number
  page: number
  pageSize: number
  pairs: GradeFlowPair[]
  items: GradeFlowItem[]
}> {
  const [rows, behaviours] = await Promise.all([
    loadRecognitions(range),
    getDb()('behaviours').select('id', 'name', 'colour') as Promise<
      { id: number; name: string; colour: string }[]
    >,
  ])
  const behaviourById = new Map(behaviours.map((b) => [b.id, b]))

  const wantGiver = filter.giverGrade ? normalizeGrade(filter.giverGrade) : null
  const wantRecipient = filter.recipientGrade ? normalizeGrade(filter.recipientGrade) : null

  const matched = rows.filter((r) => {
    const gg = normalizeGrade(r.giver_level)
    const rg = normalizeGrade(r.recipient_level)
    if (wantGiver !== null && gg !== wantGiver) return false
    if (wantRecipient !== null && rg !== wantRecipient) return false
    if (filter.direction && directionOf(gg, rg) !== filter.direction) return false
    if (
      filter.personId !== undefined &&
      r.giver_id !== filter.personId &&
      r.recipient_id !== filter.personId
    ) {
      return false
    }
    return true
  })

  const giverOf = (r: RecRow): FlowPerson => ({
    id: r.giver_id,
    name: r.giver_name,
    grade: normalizeGrade(r.giver_level),
    tier: gradeRank(r.giver_level),
    function: r.giver_function,
    site: r.giver_site,
  })
  const recipientOf = (r: RecRow): FlowPerson => ({
    id: r.recipient_id,
    name: r.recipient_name,
    grade: normalizeGrade(r.recipient_level),
    tier: gradeRank(r.recipient_level),
    function: r.recipient_function,
    site: r.recipient_site,
  })

  // ── pair roll-up ──────────────────────────────────────────────────────────
  const pairMap = new Map<string, GradeFlowPair>()
  for (const r of matched) {
    const key = `${r.giver_id}>${r.recipient_id}`
    const existing = pairMap.get(key)
    if (existing) existing.count += 1
    else pairMap.set(key, { giver: giverOf(r), recipient: recipientOf(r), count: 1 })
  }
  const pairs = [...pairMap.values()].sort(
    (a, b) => b.count - a.count || a.giver.name.localeCompare(b.giver.name),
  )

  // ── the recognitions themselves, newest first ─────────────────────────────
  const sorted = [...matched].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const start = (filter.page - 1) * filter.pageSize
  const items: GradeFlowItem[] = sorted.slice(start, start + filter.pageSize).map((r) => {
    const b = behaviourById.get(r.behaviour_id)
    return {
      id: r.id,
      createdAt: r.created_at,
      giver: giverOf(r),
      recipient: recipientOf(r),
      behaviour: b ?? { id: r.behaviour_id, name: 'Unknown', colour: '#94a3b8' },
      reason: r.reason_text,
      direction: directionOf(r.giver_level, r.recipient_level),
    }
  })

  return { total: matched.length, page: filter.page, pageSize: filter.pageSize, pairs, items }
}

// ── GET /dark-spots (FR-30) ──────────────────────────────────────────────────

export interface DarkSpot {
  dimension: 'sub_team' | 'site'
  name: string
  site?: string
  headcount: number
  given: number
  received: number
}

export async function getDarkSpots(range: AnalyticsRange): Promise<DarkSpot[]> {
  const [rows, employees] = await Promise.all([loadRecognitions(range), loadActiveEmployees()])

  interface Group extends DarkSpot {
    perHead: number
  }
  const result: { zeros: Group[]; low: Group[] } = { zeros: [], low: [] }

  const dimensions: {
    dimension: DarkSpot['dimension']
    // key must be unique within the dimension; null = employee not in this dimension
    keyOf: (e: ActiveEmployee) => string | null
    describe: (e: ActiveEmployee) => { name: string; site?: string }
  }[] = [
    {
      dimension: 'sub_team',
      // Sub-team names could repeat across sites — key on both.
      keyOf: (e) => (e.sub_team ? `${e.site}\u0000${e.sub_team}` : null),
      describe: (e) => ({ name: e.sub_team as string, site: e.site }),
    },
    { dimension: 'site', keyOf: (e) => e.site, describe: (e) => ({ name: e.site }) },
  ]

  for (const dim of dimensions) {
    const groups = new Map<string, Group>()
    const memberGroup = new Map<number, string>() // employee id → group key
    for (const e of employees) {
      const key = dim.keyOf(e)
      if (key === null) continue
      let g = groups.get(key)
      if (!g) {
        g = { dimension: dim.dimension, ...dim.describe(e), headcount: 0, given: 0, received: 0, perHead: 0 }
        groups.set(key, g)
      }
      g.headcount += 1
      memberGroup.set(e.id, key)
    }
    for (const r of rows) {
      // Activity by since-deactivated people has no active group — skipped;
      // dark spots are about who is active-but-silent NOW.
      const giverKey = memberGroup.get(r.giver_id)
      if (giverKey) groups.get(giverKey)!.given += 1
      const recipientKey = memberGroup.get(r.recipient_id)
      if (recipientKey) groups.get(recipientKey)!.received += 1
    }

    const all = [...groups.values()]
    for (const g of all) g.perHead = g.headcount > 0 ? (g.given + g.received) / g.headcount : 0

    /**
     * A group is a dark spot when it is silent, or when it is genuinely far
     * behind its peers — not merely last.
     *
     * The old rule took the bottom decile of the dimension, which on a
     * dimension with two groups always named one of them. With two offices
     * running 8.4 and 8.9 recognitions per head, the quieter one was reported
     * as a dark spot every single time, and a table that cries wolf on a 6%
     * gap is one the committee stops opening. Three conditions now:
     *
     *   · the dimension has enough groups for "behind the others" to mean
     *     something at all;
     *   · the group is big enough that its rate is not one person's fortnight;
     *   · and it is at most half the median rate — a real gap, not a ranking.
     */
    const MIN_GROUPS_FOR_COMPARISON = 4
    const MIN_HEADCOUNT_FOR_COMPARISON = 3
    const FAR_BEHIND = 0.5

    const rates = all.map((g) => g.perHead).sort((a, b) => a - b)
    const median =
      rates.length === 0
        ? 0
        : rates.length % 2 === 1
          ? rates[(rates.length - 1) / 2]
          : (rates[rates.length / 2 - 1] + rates[rates.length / 2]) / 2
    const comparable = all.length >= MIN_GROUPS_FOR_COMPARISON && median > 0

    for (const g of all) {
      if (g.perHead === 0) {
        // Silence is always worth naming, whatever the dimension looks like.
        result.zeros.push(g)
      } else if (
        comparable &&
        g.headcount >= MIN_HEADCOUNT_FOR_COMPARISON &&
        g.perHead <= median * FAR_BEHIND
      ) {
        result.low.push(g)
      }
    }
  }

  // Zeros first (bigger silent groups are the bigger problem), then the
  // low-activity tail ascending — the worst spots top the table.
  result.zeros.sort((a, b) => b.headcount - a.headcount)
  result.low.sort((a, b) => a.perHead - b.perHead)

  return [...result.zeros, ...result.low].map(({ dimension, name, site, headcount, given, received }) => ({
    dimension,
    name,
    ...(site !== undefined ? { site } : {}),
    headcount,
    given,
    received,
  }))
}

// ── GET /concentration (FR-31) ───────────────────────────────────────────────

interface TopPerson {
  id: number
  name: string
  function: string
  site: string
  count: number
  pctOfTotal: number
}

export async function getConcentration(range: AnalyticsRange): Promise<{
  uniqueGivers: number
  uniqueRecipients: number
  top10PctGiverShare: number
  topGivers: TopPerson[]
  topRecipients: TopPerson[]
}> {
  const rows = await loadRecognitions(range)
  const total = rows.length

  const tally = (
    idOf: (r: RecRow) => number,
    infoOf: (r: RecRow) => { name: string; function: string; site: string },
  ): { id: number; name: string; function: string; site: string; count: number }[] => {
    const map = new Map<number, { id: number; name: string; function: string; site: string; count: number }>()
    for (const r of rows) {
      const id = idOf(r)
      let entry = map.get(id)
      if (!entry) {
        entry = { id, ...infoOf(r), count: 0 }
        map.set(id, entry)
      }
      entry.count += 1
    }
    return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }

  const givers = tally(
    (r) => r.giver_id,
    (r) => ({ name: r.giver_name, function: r.giver_function, site: r.giver_site }),
  )
  const recipients = tally(
    (r) => r.recipient_id,
    (r) => ({ name: r.recipient_name, function: r.recipient_function, site: r.recipient_site }),
  )

  // Share of all recognitions given by the busiest 10% of givers (min 1 giver).
  let top10PctGiverShare = 0
  if (givers.length > 0) {
    const nTop = Math.max(1, Math.ceil(givers.length * 0.1))
    const topSum = givers.slice(0, nTop).reduce((s, g) => s + g.count, 0)
    top10PctGiverShare = pct(topSum, total)
  }

  const withPct = (list: typeof givers): TopPerson[] =>
    list.slice(0, 10).map((p) => ({ ...p, pctOfTotal: pct(p.count, total) }))

  return {
    uniqueGivers: givers.length,
    uniqueRecipients: recipients.length,
    top10PctGiverShare,
    topGivers: withPct(givers),
    topRecipients: withPct(recipients),
  }
}
