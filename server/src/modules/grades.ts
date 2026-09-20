/**
 * The seniority ladder, as DarwinBox reports it in `job_level`.
 *
 * This is the single source of truth for "is A more senior than B", which is
 * what the whole direction-of-recognition analysis rests on (FR-29): whether
 * recognition flows up the organisation, down it, or across.
 *
 * The official progression, lowest to highest:
 *
 *     M2 → G1 → SRG1 → G2 → SRG2 → G3 → SRG3 → G4 → SRG4 → G5
 *
 * Note the interleaving — SRG1 sits ABOVE G1 but BELOW G2. Any attempt to
 * derive rank by parsing the digit out of the string gets this wrong, which
 * is why the order is written out rather than computed.
 *
 * ── Why unknown grades return null rather than a default ──────────────────
 * A grade this file does not recognise is a directory problem (a new rung, a
 * typo, a contractor on a different scheme), and the honest answer for those
 * rows is "we cannot say which way this went". Defaulting them to a middle
 * rung would quietly classify them as peer-to-peer and inflate that number —
 * which is exactly the bug this module was written to end.
 */

/** Lowest to highest. Index + 1 is the tier number shown in the console. */
export const GRADE_LADDER = [
  'M2',
  'G1',
  'SRG1',
  'G2',
  'SRG2',
  'G3',
  'SRG3',
  'G4',
  'SRG4',
  'G5',
] as const

export type Grade = (typeof GRADE_LADDER)[number]

const RANK_BY_GRADE = new Map<string, number>(GRADE_LADDER.map((g, i) => [g, i + 1]))

/**
 * Canonical spelling for a grade as it arrives from the HRMS.
 *
 * DarwinBox has been seen returning 'srg2', ' G3 ' and 'SR G2' for the same
 * rung depending on who typed it into the master, so case, spaces, dots and
 * hyphens are all stripped before matching. Anything still unrecognised comes
 * back trimmed and upper-cased so it at least displays consistently.
 */
export function normalizeGrade(raw: string | null | undefined): string {
  const cleaned = String(raw ?? '')
    .toUpperCase()
    .replace(/[\s._-]+/g, '')
  return cleaned
}

/** 1-based tier, or null when the grade is not on the ladder. */
export function gradeRank(raw: string | null | undefined): number | null {
  return RANK_BY_GRADE.get(normalizeGrade(raw)) ?? null
}

export function isKnownGrade(raw: string | null | undefined): boolean {
  return gradeRank(raw) !== null
}

/** Sort comparator for grades, junior first; unknown grades sort last. */
export function byGradeRank(a: string, b: string): number {
  const ra = gradeRank(a)
  const rb = gradeRank(b)
  if (ra === null && rb === null) return a.localeCompare(b)
  if (ra === null) return 1
  if (rb === null) return -1
  return ra - rb
}

export type Direction = 'upward' | 'downward' | 'peer' | 'unknown'

/**
 * Which way a recognition travelled.
 *
 *   upward   — a more junior person recognised a more senior one
 *   downward — a manager or senior recognised someone below them
 *   peer     — same rung
 *   unknown  — either side's grade is not on the ladder
 */
export function directionOf(
  giverGrade: string | null | undefined,
  recipientGrade: string | null | undefined,
): Direction {
  const g = gradeRank(giverGrade)
  const r = gradeRank(recipientGrade)
  if (g === null || r === null) return 'unknown'
  if (g < r) return 'upward'
  if (g > r) return 'downward'
  return 'peer'
}
