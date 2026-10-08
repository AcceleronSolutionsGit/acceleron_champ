/**
 * Calendar-year quarters — the calendar the appraisal cycle actually runs on.
 *
 *   Q1  Jan–Mar      Q2  Apr–Jun      Q3  Jul–Sep      Q4  Oct–Dec
 *
 * A quarter is identified by its calendar year: Jan–Mar 2026 is Q1 of 2026, so its code is
 * '2026-Q1'.
 *
 * Codes sort lexicographically in chronological order ('2026-Q1' <
 * '2026-Q4' < '2027-Q1'), which is what lets the API order and filter on
 * the column without a join or a computed key.
 *
 * Boundaries follow the codebase convention in db/time.ts: computed in IST,
 * stored and compared as UTC ISO strings.
 */
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { IST } from '../../db/time'

dayjs.extend(utc)
dayjs.extend(timezone)

export type QuarterIndex = 1 | 2 | 3 | 4

export interface Quarter {
  /** Stable identifier, e.g. '2026-Q2'. Sorts chronologically. */
  code: string
  index: QuarterIndex
  /** Year the quarter falls in — 2026. */
  year: number
  /** 'Q2 2026' */
  label: string
  /** 'Apr–Jun 2026' — the months the evidence should describe. */
  months: string
  /** First instant of the quarter, IST, as UTC ISO. */
  startIso: string
  /** Last instant of the quarter, IST, as UTC ISO (inclusive end of day). */
  endIso: string
}

const CODE_RE = /^(\d{4})-Q([1-4])$/

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Calendar month (0-based) on which each quarter starts. */
const QUARTER_START = {
  1: { month: 0 }, // Jan
  2: { month: 3 }, // Apr
  3: { month: 6 }, // Jul
  4: { month: 9 }, // Oct
} as const

export function buildQuarter(year: number, index: QuarterIndex): Quarter {
  const { month } = QUARTER_START[index]
  const start = dayjs.tz(
    `${year}-${String(month + 1).padStart(2, '0')}-01 00:00:00`,
    IST,
  )
  const end = start.add(3, 'month').subtract(1, 'millisecond')
  return {
    code: `${year}-Q${index}`,
    index,
    year,
    label: `Q${index} ${year}`,
    months: `${MONTH_NAMES[month]}–${MONTH_NAMES[(month + 2) % 12]} ${year}`,
    startIso: start.utc().toISOString(),
    endIso: end.utc().toISOString(),
  }
}

/** The quarter an instant falls in (defaults to now). */
export function quarterFor(ref?: string | Date): Quarter {
  const d = dayjs(ref).tz(IST)
  const month = d.month() // 0-based
  const year = d.year()
  const index = (Math.floor(month / 3) + 1) as QuarterIndex
  return buildQuarter(year, index)
}

/** The quarter immediately before `q`. */
export function previousQuarter(q: Quarter): Quarter {
  return q.index === 1
    ? buildQuarter(q.year - 1, 4)
    : buildQuarter(q.year, (q.index - 1) as QuarterIndex)
}

/** Parse a stored code back into a Quarter, or null if it is not one. */
export function parseQuarterCode(code: string): Quarter | null {
  // Gracefully parse old FY codes if any are in the DB during transition
  const oldMatch = /^FY(\d{4})-Q([1-4])$/.exec(code)
  if (oldMatch) {
    const fyStart = Number(oldMatch[1])
    const fyQ = Number(oldMatch[2])
    if (fyQ === 4) return buildQuarter(fyStart + 1, 1)
    if (fyQ === 1) return buildQuarter(fyStart, 2)
    if (fyQ === 2) return buildQuarter(fyStart, 3)
    if (fyQ === 3) return buildQuarter(fyStart, 4)
  }

  const m = CODE_RE.exec(code)
  if (!m) return null
  return buildQuarter(Number(m[1]), Number(m[2]) as QuarterIndex)
}

/**
 * Which quarters may be nominated for right now.
 *
 * Always the current quarter — you can write up an achievement the week it
 * happens. Plus the quarter that just ended, for `graceDays` after it closed,
 * because a quarter's best evidence is usually only obvious once it is over and
 * nobody files on 31 March. Past that, the quarter is closed and the committee
 * can shortlist from a stable set.
 *
 * Returned newest-first, which is the order the picker should offer them in.
 */
export function openQuarters(graceDays: number, ref?: string | Date): Quarter[] {
  const current = quarterFor(ref)
  const quarters = [current]
  const previous = previousQuarter(current)
  const now = dayjs(ref).valueOf()
  const graceEndsAt = Date.parse(previous.endIso) + graceDays * 24 * 3_600_000
  if (now <= graceEndsAt) quarters.push(previous)
  return quarters
}

/** Is `code` currently open for filing? */
export function isQuarterOpen(code: string, graceDays: number, ref?: string | Date): boolean {
  return openQuarters(graceDays, ref).some((q) => q.code === code)
}

/**
 * Recent quarters, newest first — for filter dropdowns, where the committee
 * needs to look back further than the filing window allows.
 */
export function recentQuarters(count: number, ref?: string | Date): Quarter[] {
  const out: Quarter[] = []
  let q = quarterFor(ref)
  for (let i = 0; i < count; i += 1) {
    out.push(q)
    q = previousQuarter(q)
  }
  return out
}
