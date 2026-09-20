/**
 * /api/analytics — committee/admin dashboard endpoints (FR-26…FR-31), plus
 * /grades for the seniority-ladder view.
 *
 * Every endpoint takes optional from/to as IST calendar dates (YYYY-MM-DD),
 * defaulting to the last 90 days, and excludes removed recognitions. The
 * heavy lifting lives in modules/analytics/queries.ts.
 */
import { Router } from 'express'
import { z } from 'zod'
import { istDayEndIso, istDayStartIso } from '../db/time'
import { apiError } from '../middleware/errorHandler'
import { asyncHandler, requireRole } from '../middleware/requireAuth'
import { apiLimiter } from '../middleware/rateLimits'
import {
  AnalyticsRange,
  getBehaviourBreakdown,
  getConcentration,
  getDarkSpots,
  getDirectionMix,
  getFunctionSite,
  getGradeAnalysis,
  getGradeFlow,
  getSummary,
} from '../modules/analytics/queries'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_DAYS = 90

const router = Router()
router.use(apiLimiter)
router.use(requireRole('committee')) // committee AND admin

const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD (IST)')
const rangeQuery = z.object({ from: istDate.optional(), to: istDate.optional() })

function parseRange(query: Record<string, unknown>): AnalyticsRange {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(query)) if (v !== '' && v !== undefined) cleaned[k] = v
  const result = rangeQuery.safeParse(cleaned)
  if (!result.success) {
    throw apiError(400, 'BAD_INPUT', result.error.issues[0]?.message ?? 'Invalid date range')
  }
  const { from, to } = result.data
  const range: AnalyticsRange = {
    fromIso: from ? istDayStartIso(from) : istDayStartIso(new Date(Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS)),
    toIso: to ? istDayEndIso(to) : istDayEndIso(new Date()),
  }
  if (range.fromIso > range.toIso) throw apiError(400, 'BAD_INPUT', "'from' must not be after 'to'")
  return range
}

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    res.json(await getSummary(parseRange(req.query as Record<string, unknown>)))
  }),
)

/**
 * Kept at its old path so an already-deployed console does not 404 mid-roll,
 * but the second dimension is the office now rather than the shift rotation.
 */
router.get(
  ['/function-site', '/function-shift'],
  asyncHandler(async (req, res) => {
    res.json(await getFunctionSite(parseRange(req.query as Record<string, unknown>)))
  }),
)

router.get(
  '/behaviours',
  asyncHandler(async (req, res) => {
    res.json(await getBehaviourBreakdown(parseRange(req.query as Record<string, unknown>)))
  }),
)

router.get(
  '/direction',
  asyncHandler(async (req, res) => {
    res.json(await getDirectionMix(parseRange(req.query as Record<string, unknown>)))
  }),
)

router.get(
  '/grades',
  asyncHandler(async (req, res) => {
    res.json(await getGradeAnalysis(parseRange(req.query as Record<string, unknown>)))
  }),
)

/**
 * The people behind a matrix cell. Every parameter is optional — with none of
 * them this is simply the whole range, newest first, which is what the panel
 * shows before anyone clicks anything.
 */
const gradeFlowQuery = rangeQuery.extend({
  giverGrade: z.string().max(32).optional(),
  recipientGrade: z.string().max(32).optional(),
  direction: z.enum(['upward', 'downward', 'peer']).optional(),
  personId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

router.get(
  '/grade-flow',
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const cleaned: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(query)) if (v !== '' && v !== undefined) cleaned[k] = v
    const parsed = gradeFlowQuery.safeParse(cleaned)
    if (!parsed.success) {
      throw apiError(400, 'BAD_INPUT', parsed.error.issues[0]?.message ?? 'Invalid filter')
    }
    const { giverGrade, recipientGrade, direction, personId, page, pageSize } = parsed.data
    res.json(
      await getGradeFlow(parseRange(query), {
        giverGrade,
        recipientGrade,
        direction,
        personId,
        page,
        pageSize,
      }),
    )
  }),
)

router.get(
  '/dark-spots',
  asyncHandler(async (req, res) => {
    res.json(await getDarkSpots(parseRange(req.query as Record<string, unknown>)))
  }),
)

router.get(
  '/concentration',
  asyncHandler(async (req, res) => {
    res.json(await getConcentration(parseRange(req.query as Record<string, unknown>)))
  }),
)

export default router
