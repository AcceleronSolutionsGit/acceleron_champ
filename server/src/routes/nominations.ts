/**
 * /api/nominations — quarterly self-nomination (employee), approval (reporting
 * manager) and the committee's read-only view.
 *
 * Access model, in three layers:
 *   · everything here requires a signed-in session;
 *   · the employee routes additionally require the session to be LINKED to a
 *     directory row (`employeeId`). An admin signing in on an email with no
 *     employee record can administer the programme but cannot nominate
 *     themself, which is correct — there is nobody to approve them;
 *   · /all is committee-or-admin.
 *
 * Manager authorization is NOT a role check. It is derived from
 * `employees.manager_id`, so it survives re-orgs and needs no separate
 * "manager" role to be granted or revoked by hand.
 */
import { Router } from 'express'
import { z } from 'zod'
import { apiError } from '../middleware/errorHandler'
import { asyncHandler, requireAuth, requireRole } from '../middleware/requireAuth'
import { apiLimiter } from '../middleware/rateLimits'
import { logAudit } from '../modules/audit'
import {
  CommitteeFilters,
  decideNomination,
  getMyNominations,
  listAllForExport,
  listForCommittee,
  listForManager,
  NominationResult,
  managerNavState,
  removeNomination,
  REMOVAL_REASON_MIN_LENGTH,
  submitNomination,
  withdrawNomination,
} from '../modules/nominations/nominations'
import { openQuarters, recentQuarters } from '../modules/nominations/quarter'
import { getSettings } from '../modules/settings'
import { NominationItem, NominationStatus, SessionUser } from '../types'

const router = Router()
router.use(apiLimiter)
router.use(requireAuth)

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw apiError(400, 'BAD_INPUT', result.error.issues[0]?.message ?? 'Invalid input')
  }
  return result.data
}

/**
 * Which HTTP status each service error deserves. A 409 for the conflict cases
 * matters: the browser retrying a 500 would be reasonable, retrying a "already
 * approved" is not.
 */
const STATUS_BY_CODE: Record<string, number> = {
  NOMINATIONS_DISABLED: 403,
  NOT_LINKED: 403,
  EMPLOYEE_INACTIVE: 403,
  NOT_YOUR_REPORT: 403,
  NO_MANAGER: 409,
  QUARTER_CLOSED: 409,
  ALREADY_APPROVED: 409,
  ALREADY_DECIDED: 409,
  UNKNOWN_QUARTER: 400,
  EVIDENCE_TOO_SHORT: 400,
  EVIDENCE_TOO_LONG: 400,
  BEHAVIOUR_REQUIRED: 400,
  UNKNOWN_BEHAVIOUR: 400,
  REASON_REQUIRED: 400,
  ALREADY_REMOVED: 409,
  REMOVED: 409,
  NOT_FOUND: 404,
}

/** Unwrap a service result or throw the mapped API error. */
function unwrap<T>(result: NominationResult<T>): T {
  if (result.ok) return result.value
  throw apiError(STATUS_BY_CODE[result.error.code] ?? 400, result.error.code, result.error.message)
}

/** The session's linked employee id, or a 403 explaining why there isn't one. */
function requireEmployeeId(user: SessionUser): number {
  if (user.employeeId === null) {
    throw apiError(
      403,
      'NOT_LINKED',
      'Your sign-in is not linked to a directory record, so you cannot file a nomination. Please ask HR to check the email on your employee record.',
    )
  }
  return user.employeeId
}

const statusEnum = z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'removed'])

// ── employee ──────────────────────────────────────────────────────────────────

/** Quarters currently open for filing, plus the evidence limits, for the form. */
router.get(
  '/quarters',
  asyncHandler(async (_req, res) => {
    const settings = await getSettings()
    res.json({
      open: openQuarters(settings.nominationGraceDays),
      recent: recentQuarters(8),
      enabled: settings.nominationsEnabled,
      minLength: settings.nominationEvidenceMinLength,
      maxLength: settings.nominationEvidenceMaxLength,
      graceDays: settings.nominationGraceDays,
    })
  }),
)

/** Everything I have filed, plus who has to approve it. */
router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    res.json(await getMyNominations(requireEmployeeId(req.user!)))
  }),
)

const submitBody = z.object({
  quarter: z.string().trim().min(1, 'Choose a quarter'),
  behaviourId: z.coerce
    .number({ required_error: 'Choose a CHAMP behaviour' })
    .int()
    .positive('Choose a CHAMP behaviour'),
  title: z
    .string({ required_error: 'Give your nomination a short headline' })
    .trim()
    .min(8, 'The headline needs at least 8 characters')
    .max(140, 'Keep the headline under 140 characters'),
  // Length limits are enforced in the service against the ADMIN-CONFIGURED
  // bounds; this cap only stops an absurd payload reaching the database.
  evidence: z.string({ required_error: 'Evidence is required' }).trim().min(1).max(20_000),
})

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const employeeId = requireEmployeeId(req.user!)
    const body = parse(submitBody, req.body)
    const item = unwrap(
      await submitNomination({
        employeeId,
        quarterCode: body.quarter,
        behaviourId: body.behaviourId,
        title: body.title,
        evidenceText: body.evidence,
      }),
    )
    await logAudit(req.user!.email, 'submit_nomination', 'nomination', item.id, {
      quarter: item.quarter.code,
      behaviour: item.behaviour?.name,
    })
    res.json({ ok: true, item })
  }),
)

router.post(
  '/:id/withdraw',
  asyncHandler(async (req, res) => {
    const employeeId = requireEmployeeId(req.user!)
    const id = parse(z.coerce.number().int().positive(), req.params.id)
    const item = unwrap(await withdrawNomination(id, employeeId))
    await logAudit(req.user!.email, 'withdraw_nomination', 'nomination', id, {
      quarter: item.quarter.code,
    })
    res.json({ ok: true, item })
  }),
)

// ── reporting manager ─────────────────────────────────────────────────────────

/**
 * Just the counters, for the nav. Separate from /approvals so the shell can
 * poll it on every page without pulling every evidence paragraph down with it.
 */
router.get(
  '/approvals/count',
  asyncHandler(async (req, res) => {
    const employeeId = req.user!.employeeId
    // An unlinked session simply manages nobody — not an error worth a 403 on
    // a route the nav calls on every page load.
    res.json(employeeId === null ? { isManager: false, pending: 0 } : await managerNavState(employeeId))
  }),
)

router.get(
  '/approvals',
  asyncHandler(async (req, res) => {
    const employeeId = req.user!.employeeId
    if (employeeId === null) {
      res.json({ items: [] })
      return
    }
    const status = parse(statusEnum.or(z.literal('all')).optional(), req.query.status)
    res.json({ items: await listForManager(employeeId, status) })
  }),
)

const decideBody = z.object({
  decision: z.enum(['approved', 'rejected'], {
    errorMap: () => ({ message: 'Decision must be approved or rejected' }),
  }),
  note: z.string().trim().max(1000, 'Keep the note under 1000 characters').optional(),
})

router.post(
  '/:id/decide',
  asyncHandler(async (req, res) => {
    const id = parse(z.coerce.number().int().positive(), req.params.id)
    const body = parse(decideBody, req.body)
    const user = req.user!
    const item = unwrap(
      await decideNomination({
        nominationId: id,
        actorEmployeeId: user.employeeId,
        actorEmail: user.email,
        actorIsAdmin: user.role === 'admin',
        decision: body.decision,
        note: body.note,
      }),
    )
    await logAudit(user.email, `nomination_${body.decision}`, 'nomination', id, {
      quarter: item.quarter.code,
      employee: item.employee.name,
      // Recorded because an admin override is a materially different act from
      // a manager deciding on their own report.
      viaAdminOverride: user.role === 'admin' && item.manager?.id !== user.employeeId,
    })
    res.json({ ok: true, item })
  }),
)

// ── committee / admin ─────────────────────────────────────────────────────────

const committeeQuery = z.object({
  quarter: z.string().trim().optional(),
  status: statusEnum.optional(),
  behaviourId: z.coerce.number().int().positive().optional(),
  function: z.string().trim().optional(),
  site: z.string().trim().optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

/** Drop empty strings so an untouched <select> doesn't filter on ''. */
function cleanQuery(q: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(q)) if (v !== '' && v !== undefined) out[k] = v
  return out
}

router.get(
  '/all',
  requireRole('committee'),
  asyncHandler(async (req, res) => {
    const filters = parse(committeeQuery, cleanQuery(req.query as Record<string, unknown>))
    res.json(await listForCommittee(filters as CommitteeFilters))
  }),
)

const removeBody = z.object({
  reason: z
    .string({ required_error: 'A reason is required' })
    .trim()
    .min(
      REMOVAL_REASON_MIN_LENGTH,
      `Give a reason of at least ${REMOVAL_REASON_MIN_LENGTH} characters — the employee sees it`,
    )
    .max(1000, 'Keep the reason under 1000 characters'),
})

/**
 * Remove a nomination from the pool. Committee-or-admin, reason mandatory.
 *
 * This is the one action in the feature that is gated on a ROLE rather than on
 * the reporting line: policing the pool is the committee's job and has nothing
 * to do with who reports to whom.
 */
router.post(
  '/:id/remove',
  requireRole('committee'),
  asyncHandler(async (req, res) => {
    const id = parse(z.coerce.number().int().positive(), req.params.id)
    const { reason } = parse(removeBody, req.body)
    const item = unwrap(
      await removeNomination({ nominationId: id, actorEmail: req.user!.email, reason }),
    )
    await logAudit(req.user!.email, 'remove_nomination', 'nomination', id, {
      quarter: item.quarter.code,
      employee: item.employee.name,
      behaviour: item.behaviour?.name,
      // The previous status matters: striking an approved nomination overrides
      // a manager's judgement, striking a pending one does not.
      previousStatus: item.decision ? 'decided' : 'pending',
      reason,
    })
    res.json({ ok: true, item })
  }),
)

// ── CSV export ────────────────────────────────────────────────────────────────

/** RFC-4180 quoting — evidence paragraphs contain commas, quotes and newlines. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function toCsv(items: NominationItem[]): string {
  const header = [
    'Quarter',
    'CHAMP behaviour',
    'Employee code',
    'Employee',
    'Function',
    'Site',
    'Level',
    'Reporting manager',
    'Status',
    'Headline',
    'Evidence',
    'Decided by',
    'Decided at',
    'Decision note',
    'Removed by',
    'Removed at',
    'Removal reason',
    'Submitted at',
  ]
  const rows = items.map((n) => [
    n.quarter.label,
    n.behaviour?.name ?? '',
    n.employee.employeeCode ?? '',
    n.employee.name,
    n.employee.function,
    n.employee.site,
    n.employee.levelGrade ?? '',
    n.manager?.name ?? '',
    n.status,
    n.title,
    n.evidence,
    n.decision?.by ?? '',
    n.decision?.at ?? '',
    n.decision?.note ?? '',
    n.removal?.by ?? '',
    n.removal?.at ?? '',
    n.removal?.reason ?? '',
    n.createdAt,
  ])
  // A BOM so Excel on Windows opens the Hindi/Bengali names as UTF-8 rather
  // than mojibake — this file is opened in Excel, not a text editor.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

router.get(
  '/all/export',
  requireRole('committee'),
  asyncHandler(async (req, res) => {
    const filters = parse(
      committeeQuery.omit({ page: true, pageSize: true }),
      cleanQuery(req.query as Record<string, unknown>),
    )
    const items = await listAllForExport(filters)
    await logAudit(req.user!.email, 'export_nominations', 'nomination', undefined, {
      filters,
      rows: items.length,
    })
    const stamp = new Date().toISOString().slice(0, 10)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="champ-nominations-${stamp}.csv"`)
    res.send(toCsv(items))
  }),
)

export default router

/** Re-exported for tests and for anything that needs the status union. */
export type { NominationStatus }
