/**
 * Indian financial-year quarters — the calendar the appraisal cycle actually
 * runs on.
 *
 *   Q1  Apr–Jun      Q2  Jul–Sep      Q3  Oct–Dec      Q4  Jan–Mar
 *
 * A quarter is identified by its FY START year, never by the calendar year it
 * happens to fall in: Jan–Mar 2027 is Q4 of FY 2026-27, so its code is
 * 'FY2026-Q4'. Getting this backwards is the classic Indian-FY bug — every
 * January the quarter belongs to the year that started nine months earlier.
 *
 * Codes sort lexicographically in chronological order ('FY2026-Q1' <
 * 'FY2026-Q4' < 'FY2027-Q1'), which is what lets the API order and filter on
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
  /** Stable identifier, e.g. 'FY2026-Q2'. Sorts chronologically. */
  code: string
  index: QuarterIndex
  /** Year the financial year STARTED — 2026 for FY 2026-27. */
  fyStartYear: number
  /** 'Q2 FY 2026-27' */
  label: string
  /** 'Jul–Sep 2026' — the months the evidence should describe. */
  months: string
  /** First instant of the quarter, IST, as UTC ISO. */
  startIso: string
  /** Last instant of the quarter, IST, as UTC ISO (inclusive end of day). */
  endIso: string
}

const CODE_RE = /^FY(\d{4})-Q([1-4])$/

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Calendar month (0-based) on which each FY quarter starts, and in which
 *  calendar year relative to the FY start year. */
const QUARTER_START = {
  1: { month: 3, yearOffset: 0 }, // Apr
  2: { month: 6, yearOffset: 0 }, // Jul
  3: { month: 9, yearOffset: 0 }, // Oct
  4: { month: 0, yearOffset: 1 }, // Jan of the NEXT calendar year
} as const

export function buildQuarter(fyStartYear: number, index: QuarterIndex): Quarter {
  const { month, yearOffset } = QUARTER_START[index]
  const calendarYear = fyStartYear + yearOffset
  const start = dayjs.tz(
    `${calendarYear}-${String(month + 1).padStart(2, '0')}-01 00:00:00`,
    IST,
  )
  const end = start.add(3, 'month').subtract(1, 'millisecond')
  const fyEndShort = String((fyStartYear + 1) % 100).padStart(2, '0')
  return {
    code: `FY${fyStartYear}-Q${index}`,
    index,
    fyStartYear,
    label: `Q${index} FY ${fyStartYear}-${fyEndShort}`,
    months: `${MONTH_NAMES[month]}–${MONTH_NAMES[(month + 2) % 12]} ${calendarYear}`,
    startIso: start.utc().toISOString(),
    endIso: end.utc().toISOString(),
  }
}

/** The quarter an instant falls in (defaults to now). */
export function quarterFor(ref?: string | Date): Quarter {
  const d = dayjs(ref).tz(IST)
  const month = d.month() // 0-based
  // Jan/Feb/Mar belong to the financial year that began the PREVIOUS April.
  const fyStartYear = month >= 3 ? d.year() : d.year() - 1
  const index: QuarterIndex = month >= 3 ? ((Math.floor((month - 3) / 3) + 1) as QuarterIndex) : 4
  return buildQuarter(fyStartYear, index)
}

/** The quarter immediately before `q`. */
export function previousQuarter(q: Quarter): Quarter {
  return q.index === 1
    ? buildQuarter(q.fyStartYear - 1, 4)
    : buildQuarter(q.fyStartYear, (q.index - 1) as QuarterIndex)
}

/** Parse a stored code back into a Quarter, or null if it is not one. */
export function parseQuarterCode(code: string): Quarter | null {
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
