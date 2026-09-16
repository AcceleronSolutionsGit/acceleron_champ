/**
 * /api/admin — moderation, programme settings, directory management, export
 * and the audit trail (FR-22…FR-25).
 *
 * Access model (SPEC §5): the whole router requires committee-or-admin;
 * settings / behaviours / employees / DarwinBox sync additionally require
 * the admin role. Every mutation and every export is audited (FRD §7).
 */
import { Router } from 'express'
import { Knex } from 'knex'
import { z } from 'zod'
import { getDb } from '../db/knex'
import { istDayEndIso, istDayStartIso, nowIso } from '../db/time'
import { apiError } from '../middleware/errorHandler'
import { asyncHandler, requireRole } from '../middleware/requireAuth'
import { apiLimiter } from '../middleware/rateLimits'
import { logAudit } from '../modules/audit'
import { buildWeeklyDigest } from '../modules/digest/digest'
import { exportRecognitions } from '../modules/exporter'
import { AppSettings, getSettings, updateSettings } from '../modules/settings'
import { runDirectorySync } from '../modules/sync/darwinbox'
import { config } from '../config'
import { Behaviour, Employee, Flag, Recognition } from '../types'
import { countRows, FEED_SELECT, feedJoin, FeedRow, toFeedItem } from './feed'

const router = Router()
router.use(apiLimiter)
router.use(requireRole('committee')) // reads, moderation, export
const adminOnly = requireRole('admin') // settings, behaviours, employees, sync

// ── local helpers ────────────────────────────────────────────────────────────

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data)
  if (!result.success) {
    throw apiError(400, 'BAD_INPUT', result.error.issues[0]?.message ?? 'Invalid input')
  }
  return result.data
}

function cleanQuery(q: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(q)) if (v !== '' && v !== undefined) out[k] = v
  return out
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return value // legacy/hand-written details — surface as-is
  }
}

const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD (IST)')
const idParam = z.coerce.number().int().positive()

/** Accept camelCase aliases for the snake_case employee fields so both key
 *  conventions from the web console parse identically. */
const CAMEL_TO_SNAKE: Record<string, string> = {
  employeeCode: 'employee_code',
  subTeam: 'sub_team',
  employmentType: 'employment_type',
  levelGrade: 'level_grade',
  consentRecorded: 'consent_recorded',
}
function normalizeEmployeeKeys(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) out[CAMEL_TO_SNAKE[k] ?? k] = v
  return out
}

// ── moderation: recognitions (FR-22) ─────────────────────────────────────────

interface AdminFeedRow extends FeedRow {
  channel: string
  removalReason: string | null
  removedBy: string | null
  removedAt: string | null
}

const ADMIN_SELECT = [
  ...FEED_SELECT,
  'rec.channel as channel',
  'rec.removal_reason as removalReason',
  'rec.removed_by as removedBy',
  'rec.removed_at as removedAt',
]

const adminRecognitionsQuery = z.object({
  status: z.enum(['active', 'flagged', 'removed', 'all']).default('all'),
  from: istDate.optional(),
  to: istDate.optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})

router.get(
  '/recognitions',
  asyncHandler(async (req, res) => {
    const q = parse(adminRecognitionsQuery, cleanQuery(req.query as Record<string, unknown>))
    const db = getDb()

    const filtered = feedJoin(db) // admin sees every status, incl. removed
    if (q.status !== 'all') filtered.where('rec.status', q.status)
    if (q.from) filtered.andWhere('rec.created_at', '>=', istDayStartIso(q.from))
    if (q.to) filtered.andWhere('rec.created_at', '<=', istDayEndIso(q.to))
    if (q.q) {
      const like = `%${q.q.toLowerCase()}%`
      filtered.andWhere((w) =>
        w
          .whereRaw('lower(rec.reason_text) like ?', [like])
          .orWhereRaw('lower(g.name) like ?', [like])
          .orWhereRaw('lower(r.name) like ?', [like]),
      )
    }

    const total = await countRows(filtered)
    const rows = (await filtered
      .clone()
      .select(ADMIN_SELECT)
      .orderBy('rec.created_at', 'desc')
      .orderBy('rec.id', 'desc')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)) as AdminFeedRow[]

    // Open-flag context for the moderation table.
    const openFlags = rows.length
      ? ((await db('flags')
          .whereIn(
            'recognition_id',
            rows.map((r) => r.id),
          )
          .where({ status: 'open' })
          .select('id', 'recognition_id', 'type', 'details', 'created_at')) as Pick<
          Flag,
          'id' | 'recognition_id' | 'type' | 'details' | 'created_at'
        >[])
      : []
    const flagsByRec = new Map<number, { id: number; type: string; details: unknown; createdAt: string }[]>()
    for (const f of openFlags) {
      const list = flagsByRec.get(f.recognition_id) ?? []
      list.push({ id: f.id, type: f.type, details: parseJson(f.details), createdAt: f.created_at })
      flagsByRec.set(f.recognition_id, list)
    }

    res.json({
      items: rows.map((r) => ({
        ...toFeedItem(r, { withStatus: true }),
        channel: r.channel,
        removalReason: r.removalReason,
        removedBy: r.removedBy,
        removedAt: r.removedAt,
        openFlags: flagsByRec.get(r.id) ?? [],
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    })
  }),
)

const removeBody = z.object({
  reason: z
    .string({ required_error: 'A removal reason is required' })
    .trim()
    .min(3, 'Give a short removal reason')
    .max(300),
})

router.post(
  '/recognitions/:id/remove',
  asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id)
    const { reason } = parse(removeBody, req.body)
    const actor = req.user!.email
    const db = getDb()

    const rec = (await db('recognitions').where({ id }).first()) as Recognition | undefined
    if (!rec) throw apiError(404, 'NOT_FOUND', 'Recognition not found')
    if (rec.status === 'removed') throw apiError(409, 'ALREADY_REMOVED', 'This recognition is already removed')

    // BR-6: soft delete only — the row stays for audit/analytics history.
    await db('recognitions').where({ id }).update({
      status: 'removed',
      removal_reason: reason,
      removed_by: actor,
      removed_at: nowIso(),
    })
    // Removal settles any open flags on it.
    await db('flags').where({ recognition_id: id, status: 'open' }).update({
      status: 'resolved',
      resolution: 'removed',
      resolved_by: actor,
      resolved_at: nowIso(),
    })
    await logAudit(actor, 'remove_recognition', 'recognition', id, { reason })
    res.json({ ok: true })
  }),
)

// ── moderation: flag queue (BR-5, FR-14) ─────────────────────────────────────

const flagsQuery = z.object({ status: z.enum(['open', 'resolved', 'all']).default('open') })

router.get(
  '/flags',
  asyncHandler(async (req, res) => {
    const q = parse(flagsQuery, cleanQuery(req.query as Record<string, unknown>))
    const db = getDb()

    const flagQuery = db('flags').orderBy('created_at', 'desc').orderBy('id', 'desc')
    if (q.status !== 'all') flagQuery.where({ status: q.status })
    const flags = (await flagQuery) as Flag[]

    const recRows = flags.length
      ? ((await feedJoin(db)
          .whereIn(
            'rec.id',
            flags.map((f) => f.recognition_id),
          )
          .select(FEED_SELECT)) as FeedRow[])
      : []
    const recById = new Map(recRows.map((r) => [r.id, r]))

    res.json(
      flags.map((f) => {
        const rec = recById.get(f.recognition_id)
        return {
          ...f,
          details: parseJson(f.details),
          recognition: rec ? toFeedItem(rec, { withStatus: true }) : null,
        }
      }),
    )
  }),
)

const resolveBody = z.object({
  // The only manual resolution is dismissing a false positive; 'removed' is
  // set automatically when the recognition itself is removed.
  resolution: z.literal('dismissed', { errorMap: () => ({ message: "resolution must be 'dismissed'" }) }),
})

router.post(
  '/flags/:id/resolve',
  asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id)
    const { resolution } = parse(resolveBody, req.body)
    const actor = req.user!.email
    const db = getDb()

    const flag = (await db('flags').where({ id }).first()) as Flag | undefined
    if (!flag) throw apiError(404, 'NOT_FOUND', 'Flag not found')
    if (flag.status === 'resolved') throw apiError(409, 'ALREADY_RESOLVED', 'This flag is already resolved')

    await db('flags').where({ id }).update({
      status: 'resolved',
      resolution,
      resolved_by: actor,
      resolved_at: nowIso(),
    })

    // If nothing else keeps the recognition flagged, restore it to active.
    const rec = (await db('recognitions').where({ id: flag.recognition_id }).first()) as Recognition | undefined
    if (rec && rec.status !== 'removed') {
      const remainingOpen = await countRows(
        db('flags').where({ recognition_id: flag.recognition_id, status: 'open' }),
      )
      if (remainingOpen === 0 && rec.status !== 'active') {
        await db('recognitions').where({ id: rec.id }).update({ status: 'active' })
      }
    }

    await logAudit(actor, 'resolve_flag', 'flag', id, { recognitionId: flag.recognition_id, resolution })
    res.json({ ok: true })
  }),
)

// ── settings (FR-23, admin only) ─────────────────────────────────────────────

router.get(
  '/settings',
  adminOnly,
  asyncHandler(async (_req, res) => {
    res.json(await getSettings())
  }),
)

const settingsBody = z
  .object({
    capPerPairPerMonth: z.number().int().min(1).max(10),
    reasonMinLength: z.number().int().min(5).max(100),
    reasonBlocklist: z.array(z.string().trim().min(1).max(80)).max(200),
    flagBurstCount: z.number().int().min(2).max(50),
    flagBurstWindowMinutes: z.number().int().min(5).max(24 * 60),
    flagLoopWindowHours: z.number().int().min(1).max(14 * 24),
    flagLoopMinTotal: z.number().int().min(2).max(50),
    weeklyDigestEnabled: z.boolean(),
    digestAudience: z.enum(['all', 'leadership']),
    nominationsEnabled: z.boolean(),
    nominationEvidenceMinLength: z.number().int().min(50).max(2000),
    nominationEvidenceMaxLength: z.number().int().min(200).max(10_000),
    nominationGraceDays: z.number().int().min(0).max(120),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one setting to change')
  .refine(
    (patch) =>
      patch.nominationEvidenceMinLength === undefined ||
      patch.nominationEvidenceMaxLength === undefined ||
      patch.nominationEvidenceMinLength < patch.nominationEvidenceMaxLength,
    'The minimum evidence length must be below the maximum',
  )

router.put(
  '/settings',
  adminOnly,
  asyncHandler(async (req, res) => {
    const patch = parse(settingsBody, req.body) as Partial<AppSettings>
    const updated = await updateSettings(patch)
    await logAudit(req.user!.email, 'update_settings', 'settings', undefined, { changed: Object.keys(patch) })
    res.json(updated)
  }),
)

// ── behaviours (FR-23, admin only — fixed set of six, edit only) ────────────

router.get(
  '/behaviours',
  adminOnly,
  asyncHandler(async (_req, res) => {
    const behaviours = (await getDb()('behaviours').orderBy('sort_order')) as Behaviour[]
    res.json(behaviours)
  }),
)

const behaviourBody = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(200),
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #0F6B5C'),
    active: z.boolean(),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to change')

router.patch(
  '/behaviours/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id)
    const patch = parse(behaviourBody, req.body)
    const db = getDb()

    const behaviour = (await db('behaviours').where({ id }).first()) as Behaviour | undefined
    if (!behaviour) throw apiError(404, 'NOT_FOUND', 'Behaviour not found')
    if (patch.name && patch.name !== behaviour.name) {
      const clash = await db('behaviours').where({ name: patch.name }).whereNot({ id }).first()
      if (clash) throw apiError(409, 'DUPLICATE_NAME', 'Another behaviour already has that name')
    }

    await db('behaviours')
      .where({ id })
      .update({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.colour !== undefined ? { colour: patch.colour } : {}),
        ...(patch.active !== undefined ? { active: patch.active ? 1 : 0 } : {}),
      })
    await logAudit(req.user!.email, 'update_behaviour', 'behaviour', id, { changed: Object.keys(patch) })
    res.json((await db('behaviours').where({ id }).first()) as Behaviour)
  }),
)

// ── employees (FR-24, FR-3 consent — admin only) ─────────────────────────────

const employeesQuery = z.object({
  q: z.string().trim().optional(),
  active: z.enum(['true', 'false', '1', '0', 'all']).optional(),
  site: z.string().trim().optional(),
  function: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
})

router.get(
  '/employees',
  adminOnly,
  asyncHandler(async (req, res) => {
    const q = parse(employeesQuery, cleanQuery(req.query as Record<string, unknown>))
    const db = getDb()

    const filtered = db('employees')
    if (q.q) {
      const like = `%${q.q.toLowerCase()}%`
      filtered.where((w) =>
        w
          .whereRaw('lower(name) like ?', [like])
          .orWhereRaw('lower(employee_code) like ?', [like])
          .orWhereRaw('lower(coalesce(email, \'\')) like ?', [like])
          .orWhere('mobile', 'like', `%${q.q}%`),
      )
    }
    if (q.active && q.active !== 'all') {
      filtered.andWhere('active', q.active === 'true' || q.active === '1' ? 1 : 0)
    }
    if (q.site) filtered.andWhere('site', q.site)
    if (q.function) filtered.andWhere('function', q.function)

    const total = await countRows(filtered)
    // Admin sees the full row incl. mobile/email/consent (Employee in types.ts).
    const items = (await filtered
      .clone()
      .orderBy('name')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)) as Employee[]

    res.json({ items, total, page: q.page, pageSize: q.pageSize })
  }),
)

const employeeCreateBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    mobile: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/, 'Mobile must be E.164, e.g. +919810000042'),
    function: z.string().trim().min(2).max(60),
    site: z.string().trim().min(2).max(80),
    employee_code: z.string().trim().min(3).max(20).optional(),
    // sub_team/email are nullable as well as optional: the console's employee
    // modal sends `null` for blanked fields (and PATCH uses null to clear).
    sub_team: z.string().trim().min(1).max(80).nullable().optional(),
    shift: z.string().trim().min(1).max(20).optional(),
    email: z.string().trim().toLowerCase().email().nullable().optional(),
    employment_type: z.enum(['permanent', 'contractual']).optional(),
    level_grade: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']).optional(),
    language: z.enum(['en', 'hi', 'bn']).optional(),
    consent_recorded: z.boolean().optional(),
  })
  .strict()

async function nextEmployeeCode(db: Knex): Promise<string> {
  // Demo codes are GEPL1001…; continue the sequence past the highest one.
  const rows = (await db('employees').select('employee_code')) as { employee_code: string }[]
  let max = 1000
  for (const r of rows) {
    const m = /^GEPL(\d+)$/.exec(r.employee_code)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `GEPL${max + 1}`
}

async function assertUniqueEmployeeFields(
  db: Knex,
  fields: { mobile?: string; employee_code?: string; email?: string },
  excludeId?: number,
): Promise<void> {
  const clash = async (column: string, value: string) => {
    const query = db('employees').where(column, value)
    if (excludeId) query.whereNot('id', excludeId)
    return query.first()
  }
  if (fields.mobile && (await clash('mobile', fields.mobile))) {
    throw apiError(409, 'DUPLICATE_MOBILE', 'Another employee already uses this mobile number')
  }
  if (fields.employee_code && (await clash('employee_code', fields.employee_code))) {
    throw apiError(409, 'DUPLICATE_CODE', 'Another employee already uses this employee code')
  }
  if (fields.email && (await clash('email', fields.email))) {
    // Email drives OTP login — two rows with one address would be ambiguous.
    throw apiError(409, 'DUPLICATE_EMAIL', 'Another employee already uses this email')
  }
}

router.post(
  '/employees',
  adminOnly,
  asyncHandler(async (req, res) => {
    const body = parse(employeeCreateBody, normalizeEmployeeKeys(req.body))
    const db = getDb()

    const employeeCode = body.employee_code ?? (await nextEmployeeCode(db))
    await assertUniqueEmployeeFields(db, {
      mobile: body.mobile,
      employee_code: employeeCode,
      email: body.email ?? undefined,
    })

    const now = nowIso()
    const [inserted] = (await db('employees')
      .insert({
        employee_code: employeeCode,
        name: body.name,
        function: body.function,
        sub_team: body.sub_team ?? null,
        shift: body.shift ?? 'General',
        site: body.site,
        mobile: body.mobile,
        email: body.email ?? null,
        employment_type: body.employment_type ?? 'permanent',
        level_grade: body.level_grade ?? 'L2',
        manager_id: null,
        active: 1,
        language: body.language ?? 'en',
        consent_recorded: body.consent_recorded ? 1 : 0, // FR-3 DPDP consent
        created_at: now,
        updated_at: now,
      })
      .returning('id')) as ({ id: number } | number)[]
    const id = typeof inserted === 'object' && inserted !== null ? inserted.id : (inserted as number)

    await logAudit(req.user!.email, 'create_employee', 'employee', id, {
      employeeCode,
      name: body.name,
      site: body.site,
      consentRecorded: !!body.consent_recorded,
    })
    res.status(201).json({ employee: (await db('employees').where({ id }).first()) as Employee })
  }),
)

const employeeUpdateBody = employeeCreateBody
  .extend({ active: z.boolean() })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'Provide at least one field to change')

router.patch(
  '/employees/:id',
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = parse(idParam, req.params.id)
    const patch = parse(employeeUpdateBody, normalizeEmployeeKeys(req.body))
    const db = getDb()

    const employee = (await db('employees').where({ id }).first()) as Employee | undefined
    if (!employee) throw apiError(404, 'NOT_FOUND', 'Employee not found')

    await assertUniqueEmployeeFields(
      db,
      {
        mobile: patch.mobile !== undefined && patch.mobile !== employee.mobile ? patch.mobile : undefined,
        employee_code:
          patch.employee_code !== undefined && patch.employee_code !== employee.employee_code
            ? patch.employee_code
            : undefined,
        // null clears the address — no uniqueness check needed for that.
        email: patch.email != null && patch.email !== employee.email ? patch.email : undefined,
      },
      id,
    )

    // Deactivation (active:false) keeps every recognition row — FR-4.
    const { active, consent_recorded, ...rest } = patch
    await db('employees')
      .where({ id })
      .update({
        ...rest,
        ...(active !== undefined ? { active: active ? 1 : 0 } : {}),
        ...(consent_recorded !== undefined ? { consent_recorded: consent_recorded ? 1 : 0 } : {}),
        updated_at: nowIso(),
      })

    await logAudit(req.user!.email, 'update_employee', 'employee', id, {
      changed: Object.keys(patch),
      ...(active === false ? { deactivated: true } : {}),
    })
    res.json({ employee: (await db('employees').where({ id }).first()) as Employee })
  }),
)

const bulkStatusBody = z.object({
  ids: z.array(z.number().int().positive()).min(1, 'Select at least one employee'),
  active: z.boolean(),
})

router.post(
  '/employees/bulk-status',
  adminOnly,
  asyncHandler(async (req, res) => {
    const { ids, active } = parse(bulkStatusBody, req.body)
    const db = getDb()

    await db('employees')
      .whereIn('id', ids)
      .update({
        active: active ? 1 : 0,
        updated_at: nowIso(),
      })

    await logAudit(req.user!.email, 'bulk_update_employee_status', 'employee', undefined, {
      ids,
      active,
    })

    res.json({ ok: true })
  }),
)

// ── Bulk upload employees (admin only) ──────────────────────────────────────

function normalizePhone(raw: string): string {
  let cleaned = raw.replace(/[^\d+]/g, '').trim()
  if (!cleaned) return ''
  if (!cleaned.startsWith('+')) {
    if (cleaned.length === 10) cleaned = `+91${cleaned}`
    else if (cleaned.length === 12 && cleaned.startsWith('91')) cleaned = `+${cleaned}`
    else cleaned = `+${cleaned}`
  }
  return cleaned
}

const bulkUploadEmployeeItem = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  mobile: z.string().trim().min(1, 'Mobile is required'),
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  site: z.string().trim().min(2, 'Site must be at least 2 characters').max(80),
  function: z.string().trim().min(2, 'Function must be at least 2 characters').max(60),
  employee_code: z.string().trim().max(20).optional(),
  sub_team: z.string().trim().max(80).nullable().optional(),
  shift: z.string().trim().max(20).optional(),
  employment_type: z.enum(['permanent', 'contractual']).optional(),
  level_grade: z.enum(['L1', 'L2', 'L3', 'L4', 'L5']).optional(),
  language: z.enum(['en', 'hi', 'bn']).optional(),
  consent_recorded: z.boolean().optional(),
})

const bulkUploadBody = z.object({
  employees: z.array(z.record(z.unknown())).min(1, 'Please provide at least one employee row'),
})

router.post(
  '/employees/bulk-upload',
  adminOnly,
  asyncHandler(async (req, res) => {
    const { employees: rawRows } = parse(bulkUploadBody, req.body)
    const db = getDb()

    const existingRows = await db('employees').select('employee_code', 'mobile', 'email')
    const existingMobiles = new Set(existingRows.map((r) => r.mobile?.toLowerCase()))
    const existingEmails = new Set(existingRows.filter((r) => r.email).map((r) => r.email?.toLowerCase()))
    const existingCodes = new Set(existingRows.map((r) => r.employee_code?.toLowerCase()))

    const batchMobiles = new Set<string>()
    const batchEmails = new Set<string>()
    const batchCodes = new Set<string>()

    const validToInsert: any[] = []
    const errors: Array<{ row: number; name?: string; error: string }> = []

    let maxCodeNum = 1000
    for (const r of existingRows) {
      const m = /^(?:ACC|GEPL|EMP)?(\d+)$/i.exec(r.employee_code)
      if (m) maxCodeNum = Math.max(maxCodeNum, Number(m[1]))
    }

    const now = nowIso()

    for (let i = 0; i < rawRows.length; i++) {
      const rowIdx = i + 1
      const normalizedRow = normalizeEmployeeKeys(rawRows[i])
      const parseResult = bulkUploadEmployeeItem.safeParse(normalizedRow)

      if (!parseResult.success) {
        errors.push({
          row: rowIdx,
          name: typeof (rawRows[i] as any)?.name === 'string' ? (rawRows[i] as any).name : undefined,
          error: parseResult.error.issues.map((iss) => iss.message).join(', '),
        })
        continue
      }

      const item = parseResult.data

      // Validate corporate email domain strictly
      const domain = item.email.split('@')[1] ?? ''
      if (!config.auth.allowedEmailDomains.includes(domain)) {
        errors.push({
          row: rowIdx,
          name: item.name,
          error: `Corporate email @${domain} not allowed. Must be @${config.auth.allowedEmailDomains.join(', @')}`,
        })
        continue
      }

      // Normalize phone to E.164
      const normalizedMobile = normalizePhone(item.mobile)
      if (!/^\+[1-9]\d{7,14}$/.test(normalizedMobile)) {
        errors.push({
          row: rowIdx,
          name: item.name,
          error: `Invalid phone format: ${item.mobile}. Must be valid phone number (e.g. +919876543210 or 10 digits).`,
        })
        continue
      }

      // Check duplicate mobile
      if (existingMobiles.has(normalizedMobile.toLowerCase()) || batchMobiles.has(normalizedMobile.toLowerCase())) {
        errors.push({
          row: rowIdx,
          name: item.name,
          error: `Duplicate mobile number: ${normalizedMobile}`,
        })
        continue
      }

      // Check duplicate email
      if (existingEmails.has(item.email.toLowerCase()) || batchEmails.has(item.email.toLowerCase())) {
        errors.push({
          row: rowIdx,
          name: item.name,
          error: `Duplicate corporate email: ${item.email}`,
        })
        continue
      }

      // Employee code
      let code = item.employee_code?.trim()
      if (!code) {
        maxCodeNum++
        code = `ACC${maxCodeNum}`
      }

      if (existingCodes.has(code.toLowerCase()) || batchCodes.has(code.toLowerCase())) {
        errors.push({
          row: rowIdx,
          name: item.name,
          error: `Duplicate employee code: ${code}`,
        })
        continue
      }

      // Mark in batch sets
      batchMobiles.add(normalizedMobile.toLowerCase())
      batchEmails.add(item.email.toLowerCase())
      batchCodes.add(code.toLowerCase())

      validToInsert.push({
        employee_code: code,
        name: item.name,
        function: item.function,
        sub_team: item.sub_team ?? null,
        shift: item.shift ?? 'General',
        site: item.site,
        mobile: normalizedMobile,
        email: item.email,
        employment_type: item.employment_type ?? 'permanent',
        level_grade: item.level_grade ?? 'L2',
        manager_id: null,
        active: 1,
        language: item.language ?? 'en',
        consent_recorded: item.consent_recorded !== undefined ? (item.consent_recorded ? 1 : 0) : 1,
        created_at: now,
        updated_at: now,
      })
    }

    if (validToInsert.length > 0) {
      await db.transaction(async (trx) => {
        const chunkSize = 50
        for (let i = 0; i < validToInsert.length; i += chunkSize) {
          await trx('employees').insert(validToInsert.slice(i, i + chunkSize))
        }
      })

      await logAudit(req.user!.email, 'bulk_upload_employees', 'employee', undefined, {
        totalRows: rawRows.length,
        insertedCount: validToInsert.length,
        failedCount: errors.length,
      })
    }

    res.json({
      ok: true,
      insertedCount: validToInsert.length,
      failedCount: errors.length,
      errors,
    })
  }),
)

// ── Admin Users & Roles (FR-22 — admin only) ───────────────────────────────

const adminUserBody = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  role: z.enum(['admin', 'committee']),
})

router.get(
  '/users',
  adminOnly,
  asyncHandler(async (_req, res) => {
    const db = getDb()
    const rows = (await db('admin_users')
      .leftJoin('employees', db.raw('lower(admin_users.email) = lower(employees.email)'))
      .select(
        'admin_users.email as email',
        'admin_users.role as role',
        'admin_users.created_at as createdAt',
        'employees.name as employeeName',
        'employees.site as employeeSite',
        'employees.function as employeeFunction',
      )
      .orderBy('admin_users.created_at', 'desc')) as Array<{
      email: string
      role: 'admin' | 'committee'
      createdAt: string
      employeeName?: string
      employeeSite?: string
      employeeFunction?: string
    }>

    res.json({ users: rows })
  }),
)

router.post(
  '/users',
  adminOnly,
  asyncHandler(async (req, res) => {
    const { email, role } = parse(adminUserBody, req.body)
    const domain = email.split('@')[1] ?? ''
    if (!config.auth.allowedEmailDomains.includes(domain)) {
      throw apiError(
        400,
        'DOMAIN_NOT_ALLOWED',
        `Admin email must belong to @${config.auth.allowedEmailDomains.join(', @')}`,
      )
    }

    const db = getDb()
    const existing = await db('admin_users').whereRaw('lower(email) = ?', [email]).first()
    const now = nowIso()

    if (existing) {
      await db('admin_users').whereRaw('lower(email) = ?', [email]).update({ role })
      await logAudit(req.user!.email, 'update_admin_user_role', 'admin_user', email, { role, previousRole: existing.role })
    } else {
      await db('admin_users').insert({ email, role, created_at: now })
      await logAudit(req.user!.email, 'create_admin_user', 'admin_user', email, { role })
    }

    const employee = await db('employees').whereRaw('lower(email) = ?', [email]).first()

    res.json({
      ok: true,
      user: {
        email,
        role,
        createdAt: existing?.created_at ?? now,
        employeeName: employee?.name,
      },
    })
  }),
)

router.patch(
  '/users/:email',
  adminOnly,
  asyncHandler(async (req, res) => {
    const email = req.params.email.trim().toLowerCase()
    const { role } = parse(z.object({ role: z.enum(['admin', 'committee']) }), req.body)
    const db = getDb()

    const existing = await db('admin_users').whereRaw('lower(email) = ?', [email]).first()
    if (!existing) throw apiError(404, 'NOT_FOUND', 'Admin user not found')

    if (existing.role === 'admin' && role !== 'admin') {
      const adminCount = (await db('admin_users').where({ role: 'admin' }).count({ count: '*' })) as unknown as [{ count: number | string }]
      if (Number(adminCount[0].count) <= 1) {
        throw apiError(400, 'CANNOT_DEMOTE_LAST_ADMIN', 'Cannot change role of the only remaining administrator')
      }
    }

    await db('admin_users').whereRaw('lower(email) = ?', [email]).update({ role })
    await logAudit(req.user!.email, 'update_admin_user_role', 'admin_user', email, { role, previousRole: existing.role })

    res.json({ ok: true })
  }),
)

router.delete(
  '/users/:email',
  adminOnly,
  asyncHandler(async (req, res) => {
    const email = req.params.email.trim().toLowerCase()
    const db = getDb()

    const existing = await db('admin_users').whereRaw('lower(email) = ?', [email]).first()
    if (!existing) throw apiError(404, 'NOT_FOUND', 'Admin user not found')

    if (existing.role === 'admin') {
      const adminCount = (await db('admin_users').where({ role: 'admin' }).count({ count: '*' })) as unknown as [{ count: number | string }]
      if (Number(adminCount[0].count) <= 1) {
        throw apiError(400, 'CANNOT_DELETE_LAST_ADMIN', 'Cannot remove the only remaining administrator')
      }
    }

    await db('admin_users').whereRaw('lower(email) = ?', [email]).del()
    await logAudit(req.user!.email, 'remove_admin_user', 'admin_user', email, { role: existing.role })

    res.json({ ok: true })
  }),
)

// ── DarwinBox directory sync (FR-1, FR-24 — admin only) ──────────────────────

router.post(
  '/sync-darwinbox',
  adminOnly,
  asyncHandler(async (req, res) => {
    const result = await runDirectorySync()
    await logAudit(req.user!.email, 'sync_darwinbox', 'directory', undefined, result)
    res.json(result)
  }),
)

// ── export (FR-25 — committee) ───────────────────────────────────────────────

const exportQuery = z.object({
  from: istDate.optional(),
  to: istDate.optional(),
  function: z.string().trim().optional(),
  site: z.string().trim().optional(),
  behaviourId: z.coerce.number().int().positive().optional(),
  status: z.enum(['active', 'flagged', 'removed']).optional(),
  format: z.enum(['csv', 'xlsx']).default('csv'),
})

router.get(
  '/export',
  asyncHandler(async (req, res) => {
    const q = parse(exportQuery, cleanQuery(req.query as Record<string, unknown>))
    const { format, ...filters } = q
    const file = await exportRecognitions(filters, format)
    await logAudit(req.user!.email, 'export_recognitions', 'recognition', undefined, { ...filters, format })
    res.setHeader('Content-Type', file.contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    res.send(file.body)
  }),
)

// ── audit log (FRD §7 — committee) ───────────────────────────────────────────

const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
})

router.get(
  '/audit',
  asyncHandler(async (req, res) => {
    const q = parse(auditQuery, cleanQuery(req.query as Record<string, unknown>))
    const db = getDb()
    const base = db('audit_log')
    const total = await countRows(base)
    const rows = (await base
      .clone()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize)) as {
      id: number
      actor: string
      action: string
      entity_type: string | null
      entity_id: string | null
      details: string | null
      created_at: string
    }[]
    res.json({
      items: rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        details: parseJson(r.details),
        createdAt: r.created_at,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    })
  }),
)

// ── weekly digest preview (FR-20 — committee) ────────────────────────────────

router.get(
  '/digest-preview',
  asyncHandler(async (_req, res) => {
    res.json(await buildWeeklyDigest())
  }),
)

export default router
