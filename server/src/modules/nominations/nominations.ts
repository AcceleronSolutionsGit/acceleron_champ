/**
 * Quarterly self-nomination — the service layer.
 *
 * The flow is deliberately two-party and nothing more: an employee writes up
 * one achievement per quarter with evidence, and their reporting manager either
 * stands behind it or does not. Manager approval is final; the approved set is
 * what the R&R committee shortlists from.
 *
 * Reporting line comes from `employees.manager_id`, which the DarwinBox sync
 * maintains (modules/sync/darwinbox.ts resolves manager codes to ids in its
 * second pass). It is read LIVE on every query and every permission check —
 * see the migration comment for why the stored snapshot is not the authority.
 *
 * Errors are returned as typed results, not thrown, so routes can map each code
 * to the right HTTP status and the right sentence for the user.
 */
import { Knex } from 'knex'
import { getDb } from '../../db/knex'
import { nowIso } from '../../db/time'
import {
  Behaviour,
  Employee,
  Nomination,
  NominationErrorCode,
  NominationItem,
  NominationStatus,
  PersonLite,
} from '../../types'
import { getSettings } from '../settings'
import { isQuarterOpen, openQuarters, parseQuarterCode, Quarter } from './quarter'

export type NominationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: NominationErrorCode; message: string; params?: Record<string, unknown> } }

function fail(
  code: NominationErrorCode,
  message: string,
  params?: Record<string, unknown>,
): NominationResult<never> {
  return { ok: false, error: { code, message, params } }
}

// ── row → API shape ───────────────────────────────────────────────────────────

/** The employee columns every nomination payload needs. */
const PERSON_COLUMNS = ['id', 'name', 'function', 'site', 'shift', 'employee_code', 'level_grade'] as const

type PersonRow = Pick<Employee, 'id' | 'name' | 'function' | 'site' | 'shift' | 'employee_code' | 'level_grade'>

function toPersonLite(row: PersonRow | undefined): PersonLite | null {
  if (!row) return null
  return { id: row.id, name: row.name, function: row.function, site: row.site, shift: row.shift }
}

function quarterSummary(code: string): NominationItem['quarter'] {
  const q = parseQuarterCode(code)
  // An unparseable code can only come from a hand-edited row; show it raw
  // rather than crashing the whole list.
  return q ? { code: q.code, label: q.label, months: q.months } : { code, label: code, months: '' }
}

interface JoinedRow extends Nomination {
  emp_name: string
  emp_function: string
  emp_site: string
  emp_shift: string
  emp_code: string
  emp_level: string
  /** Live reporting manager, not the submitted snapshot. */
  mgr_id: number | null
  mgr_name: string | null
  mgr_function: string | null
  mgr_site: string | null
  mgr_shift: string | null
  /** Name of whoever decided, so the UI never has to show a raw email. */
  decider_name: string | null
  beh_id: number | null
  beh_name: string | null
  beh_colour: string | null
}

/**
 * One query shape for every listing, joining the nominator and their CURRENT
 * manager. Written once because three callers (mine / approvals / committee)
 * must agree on what a nomination looks like.
 */
function baseQuery(db: Knex) {
  return db('nominations as n')
    .join('employees as e', 'e.id', 'n.employee_id')
    .leftJoin('employees as m', 'm.id', 'e.manager_id')
    // Resolves the decider's NAME. Without it the employee reads
    // "Note from meera.joshi@acceleronsolutions.io", which is their manager
    // rendered as a database column.
    .leftJoin('employees as d', 'd.id', 'n.decided_by_employee_id')
    // Left, not inner: a nomination filed before behaviours were required, or
    // one whose behaviour an admin later deleted outright, must still appear.
    .leftJoin('behaviours as b', 'b.id', 'n.behaviour_id')
    .select(
      'n.*',
      'e.name as emp_name',
      'e.function as emp_function',
      'e.site as emp_site',
      'e.shift as emp_shift',
      'e.employee_code as emp_code',
      'e.level_grade as emp_level',
      'm.id as mgr_id',
      'm.name as mgr_name',
      'm.function as mgr_function',
      'm.site as mgr_site',
      'm.shift as mgr_shift',
      'd.name as decider_name',
      'b.id as beh_id',
      'b.name as beh_name',
      'b.colour as beh_colour',
    )
}

function toItem(row: JoinedRow, opts: { editable?: boolean } = {}): NominationItem {
  return {
    id: row.id,
    quarter: quarterSummary(row.quarter),
    behaviour: row.beh_id
      ? { id: row.beh_id, name: row.beh_name ?? '', colour: row.beh_colour ?? '#64748b' }
      : null,
    title: row.title,
    evidence: row.evidence_text,
    status: row.status,
    employee: {
      id: row.employee_id,
      name: row.emp_name,
      function: row.emp_function,
      site: row.emp_site,
      shift: row.emp_shift,
      employeeCode: row.emp_code,
      levelGrade: row.emp_level,
    },
    manager: row.mgr_id
      ? {
          id: row.mgr_id,
          name: row.mgr_name ?? '',
          function: row.mgr_function ?? '',
          site: row.mgr_site ?? '',
          shift: row.mgr_shift ?? undefined,
        }
      : null,
    decision: row.decided_at
      ? {
          by: row.decider_name ?? row.decided_by_email,
          byEmail: row.decided_by_email,
          at: row.decided_at,
          note: row.decision_note,
        }
      : null,
    removal: row.removed_at
      ? { by: row.removed_by_email, at: row.removed_at, reason: row.removal_reason }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(opts.editable === undefined ? {} : { editable: opts.editable }),
  }
}

/**
 * Pending, rejected and withdrawn are still the employee's to change. Approved
 * is locked because the committee is already reading it; removed is locked
 * because the committee has struck it, and re-filing the same quarter would
 * undo their decision through the side door.
 */
function isEditable(status: NominationStatus): boolean {
  return status === 'pending' || status === 'rejected' || status === 'withdrawn'
}

// ── employee side ─────────────────────────────────────────────────────────────

export interface MyNominationsView {
  quartersOpen: Quarter[]
  items: NominationItem[]
  manager: PersonLite | null
  limits: { minLength: number; maxLength: number; enabled: boolean }
}

export async function getMyNominations(employeeId: number): Promise<MyNominationsView> {
  const db = getDb()
  const settings = await getSettings()
  const rows = (await baseQuery(db)
    .where('n.employee_id', employeeId)
    .orderBy('n.quarter', 'desc')) as JoinedRow[]

  const employee = (await db('employees').where({ id: employeeId }).first()) as Employee | undefined
  const manager = employee?.manager_id
    ? toPersonLite(
        (await db('employees').where({ id: employee.manager_id }).first(...PERSON_COLUMNS)) as
          | PersonRow
          | undefined,
      )
    : null

  return {
    quartersOpen: openQuarters(settings.nominationGraceDays),
    items: rows.map((r) => toItem(r, { editable: isEditable(r.status) })),
    manager,
    limits: {
      minLength: settings.nominationEvidenceMinLength,
      maxLength: settings.nominationEvidenceMaxLength,
      enabled: settings.nominationsEnabled,
    },
  }
}

export interface SubmitInput {
  employeeId: number
  quarterCode: string
  /** Which CHAMP behaviour the achievement is claimed against. */
  behaviourId: number
  title: string
  evidenceText: string
}

/**
 * Create the nomination for this quarter, or rewrite the existing one.
 *
 * Rewriting rather than inserting a second row is what keeps "one nomination
 * per person per quarter" true in the database and not just in the UI. A
 * rejected nomination that the employee reworks goes back to `pending` with the
 * old decision cleared — otherwise the manager would be looking at a fresh
 * submission still wearing last week's rejection.
 */
export async function submitNomination(input: SubmitInput): Promise<NominationResult<NominationItem>> {
  const db = getDb()
  const settings = await getSettings()

  if (!settings.nominationsEnabled) {
    return fail('NOMINATIONS_DISABLED', 'Self-nomination is currently switched off for this programme.')
  }

  const employee = (await db('employees').where({ id: input.employeeId }).first()) as Employee | undefined
  if (!employee || !employee.active) {
    return fail('EMPLOYEE_INACTIVE', 'Your directory record is not active — please contact HR.')
  }
  if (!employee.manager_id) {
    return fail(
      'NO_MANAGER',
      'No reporting manager is recorded against you in the directory, so there is nobody to approve this. Please ask HR to check your DarwinBox reporting line.',
    )
  }

  const quarter = parseQuarterCode(input.quarterCode)
  if (!quarter) return fail('UNKNOWN_QUARTER', 'That is not a quarter we recognise.')
  if (!isQuarterOpen(quarter.code, settings.nominationGraceDays)) {
    return fail(
      'QUARTER_CLOSED',
      `${quarter.label} is closed for nominations. Nominations stay open for ${settings.nominationGraceDays} days after a quarter ends.`,
      { quarter: quarter.label },
    )
  }

  const title = input.title.trim()
  const evidence = input.evidenceText.trim()
  if (evidence.length < settings.nominationEvidenceMinLength) {
    return fail(
      'EVIDENCE_TOO_SHORT',
      `Please describe what you did and what changed as a result — at least ${settings.nominationEvidenceMinLength} characters.`,
      { min: settings.nominationEvidenceMinLength, actual: evidence.length },
    )
  }
  if (evidence.length > settings.nominationEvidenceMaxLength) {
    return fail(
      'EVIDENCE_TOO_LONG',
      `That is longer than ${settings.nominationEvidenceMaxLength} characters — please tighten it.`,
      { max: settings.nominationEvidenceMaxLength, actual: evidence.length },
    )
  }

  // The behaviour is validated against the LIVE table, not a hardcoded list, so
  // an admin retiring one (FR-23) stops it being claimed from the next
  // submission onward without a deploy.
  const behaviour = Number.isInteger(input.behaviourId)
    ? ((await db('behaviours').where({ id: input.behaviourId, active: 1 }).first()) as
        | Behaviour
        | undefined)
    : undefined
  if (!behaviour) {
    return fail(
      'UNKNOWN_BEHAVIOUR',
      'Choose which CHAMP behaviour this is an example of — that is how the committee compares nominations across the business.',
    )
  }

  const existing = (await db('nominations')
    .where({ employee_id: input.employeeId, quarter: quarter.code })
    .first()) as Nomination | undefined

  if (existing && existing.status === 'approved') {
    return fail(
      'ALREADY_APPROVED',
      `Your ${quarter.label} nomination has already been approved and can no longer be edited.`,
    )
  }
  if (existing && existing.status === 'removed') {
    // Terminal by design. Letting someone re-file into a quarter the committee
    // has already struck would make removal decorative.
    return fail(
      'REMOVED',
      `Your ${quarter.label} nomination was removed by the R&R committee, so this quarter is closed to you. The reason is shown on your nomination page — please speak to HR if you think it was a mistake.`,
    )
  }

  const now = nowIso()
  if (existing) {
    await db('nominations')
      .where({ id: existing.id })
      .update({
        title,
        evidence_text: evidence,
        behaviour_id: behaviour.id,
        submitted_manager_id: employee.manager_id,
        status: 'pending',
        // Re-submission is a clean slate for the manager.
        decided_by_employee_id: null,
        decided_by_email: null,
        decided_at: null,
        decision_note: null,
        updated_at: now,
      })
  } else {
    await db('nominations').insert({
      employee_id: input.employeeId,
      submitted_manager_id: employee.manager_id,
      behaviour_id: behaviour.id,
      quarter: quarter.code,
      quarter_start: quarter.startIso,
      quarter_end: quarter.endIso,
      title,
      evidence_text: evidence,
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
  }

  const row = (await baseQuery(db)
    .where('n.employee_id', input.employeeId)
    .andWhere('n.quarter', quarter.code)
    .first()) as JoinedRow
  return { ok: true, value: toItem(row, { editable: true }) }
}

/** Pull a nomination back. Only the owner, only while undecided. */
export async function withdrawNomination(
  nominationId: number,
  employeeId: number,
): Promise<NominationResult<NominationItem>> {
  const db = getDb()
  const existing = (await db('nominations')
    .where({ id: nominationId, employee_id: employeeId })
    .first()) as Nomination | undefined
  if (!existing) return fail('NOT_FOUND', 'That nomination does not exist.')
  if (existing.status === 'approved') {
    return fail('ALREADY_APPROVED', 'An approved nomination cannot be withdrawn.')
  }
  if (existing.status === 'removed') {
    return fail('ALREADY_REMOVED', 'This nomination was removed by the R&R committee.')
  }

  await db('nominations').where({ id: nominationId }).update({ status: 'withdrawn', updated_at: nowIso() })
  const row = (await baseQuery(db).where('n.id', nominationId).first()) as JoinedRow
  return { ok: true, value: toItem(row, { editable: true }) }
}

// ── manager side ──────────────────────────────────────────────────────────────

/**
 * Everything filed by this manager's direct reports.
 *
 * The `e.manager_id = ?` join is the whole authorization model for reading: a
 * manager cannot construct a query that returns somebody else's report, because
 * the filter is on the join, not on a parameter the client supplies.
 */
export async function listForManager(
  managerEmployeeId: number,
  status?: NominationStatus | 'all',
): Promise<NominationItem[]> {
  const db = getDb()
  const q = baseQuery(db).where('e.manager_id', managerEmployeeId)
  if (status && status !== 'all') q.andWhere('n.status', status)
  else q.whereNot('n.status', 'withdrawn') // a pulled-back draft is not the manager's business
  const rows = (await q.orderByRaw(
    // Pending first (that is the queue), then most recently touched.
    "case when n.status = 'pending' then 0 else 1 end asc",
  ).orderBy('n.updated_at', 'desc')) as JoinedRow[]
  return rows.map((r) => toItem(r))
}

/**
 * What the nav shell needs to render the Approvals link: whether this person
 * manages anyone at all, and how many nominations are waiting on them.
 *
 * `isManager` is the reason the link can exist without a manager role — having
 * a direct report IS being a manager here. It also keeps the link visible once
 * the queue is empty, so a manager can still reach what they already decided.
 */
export async function managerNavState(
  managerEmployeeId: number,
): Promise<{ isManager: boolean; pending: number }> {
  const db = getDb()
  const [reportRow, pendingRow] = await Promise.all([
    db('employees').where({ manager_id: managerEmployeeId, active: 1 }).count({ c: '*' }).first(),
    db('nominations as n')
      .join('employees as e', 'e.id', 'n.employee_id')
      .where('e.manager_id', managerEmployeeId)
      .andWhere('n.status', 'pending')
      .count({ c: '*' })
      .first(),
  ])
  return {
    isManager: Number((reportRow as { c: number | string } | undefined)?.c ?? 0) > 0,
    pending: Number((pendingRow as { c: number | string } | undefined)?.c ?? 0),
  }
}

export interface DecideInput {
  nominationId: number
  /** The signed-in user's employee id — null for an admin with no directory row. */
  actorEmployeeId: number | null
  actorEmail: string
  /** Admins can act on any nomination; everyone else only on their reports. */
  actorIsAdmin: boolean
  decision: 'approved' | 'rejected'
  note?: string
}

export async function decideNomination(input: DecideInput): Promise<NominationResult<NominationItem>> {
  const db = getDb()
  const row = (await baseQuery(db).where('n.id', input.nominationId).first()) as JoinedRow | undefined
  if (!row) return fail('NOT_FOUND', 'That nomination does not exist.')

  // Authorization, checked against the LIVE reporting line rather than the
  // snapshot, so a re-org hands the decision to whoever holds the line now.
  const isTheirManager = input.actorEmployeeId !== null && row.mgr_id === input.actorEmployeeId
  if (!isTheirManager && !input.actorIsAdmin) {
    return fail('NOT_YOUR_REPORT', 'Only this person’s reporting manager can decide on their nomination.')
  }

  if (row.status !== 'pending') {
    return fail(
      'ALREADY_DECIDED',
      row.status === 'withdrawn'
        ? 'This nomination was withdrawn by the employee.'
        : row.status === 'removed'
          ? 'This nomination was removed by the R&R committee.'
          : `This nomination has already been ${row.status}.`,
      { status: row.status },
    )
  }

  const now = nowIso()
  await db('nominations')
    .where({ id: input.nominationId })
    .update({
      status: input.decision,
      decided_by_employee_id: input.actorEmployeeId,
      decided_by_email: input.actorEmail,
      decided_at: now,
      decision_note: input.note?.trim() || null,
      updated_at: now,
    })

  const updated = (await baseQuery(db).where('n.id', input.nominationId).first()) as JoinedRow
  return { ok: true, value: toItem(updated) }
}

// ── committee side ────────────────────────────────────────────────────────────

/** Shortest removal reason that is actually a reason rather than a shrug. */
export const REMOVAL_REASON_MIN_LENGTH = 15

export interface RemoveInput {
  nominationId: number
  actorEmail: string
  reason: string
}

/**
 * Strike a nomination from the pool, with the reason on the record.
 *
 * Deliberately NOT a delete. The row stays, the evidence stays readable, and
 * the employee is told it was removed and why — a nomination that silently
 * vanishes teaches nobody anything and invites them to file it again. It is
 * also why the reason is mandatory: this is the only text the employee ever
 * gets back from the committee.
 *
 * Terminal for that quarter. There is no restore and no re-filing; a removal
 * made in error is corrected by HR, not by the person it was made against.
 *
 * Authorization is the ROUTE's job (committee-or-admin) rather than this
 * function's: unlike manager approval, nothing about who may remove is
 * derivable from the data, so it stays a plain role check at the edge.
 */
export async function removeNomination(input: RemoveInput): Promise<NominationResult<NominationItem>> {
  const db = getDb()
  const reason = input.reason.trim()
  if (reason.length < REMOVAL_REASON_MIN_LENGTH) {
    return fail(
      'REASON_REQUIRED',
      `Please give a reason of at least ${REMOVAL_REASON_MIN_LENGTH} characters — the employee sees exactly this text.`,
      { min: REMOVAL_REASON_MIN_LENGTH },
    )
  }

  const row = (await baseQuery(db).where('n.id', input.nominationId).first()) as JoinedRow | undefined
  if (!row) return fail('NOT_FOUND', 'That nomination does not exist.')
  if (row.status === 'removed') {
    return fail('ALREADY_REMOVED', 'This nomination has already been removed.')
  }

  const now = nowIso()
  await db('nominations').where({ id: input.nominationId }).update({
    status: 'removed',
    removal_reason: reason,
    removed_by_email: input.actorEmail,
    removed_at: now,
    updated_at: now,
  })

  const updated = (await baseQuery(db).where('n.id', input.nominationId).first()) as JoinedRow
  return { ok: true, value: toItem(updated) }
}


export interface CommitteeFilters {
  quarter?: string
  status?: NominationStatus
  behaviourId?: number
  function?: string
  site?: string
  q?: string
  page: number
  pageSize: number
}

export interface CommitteeView {
  items: NominationItem[]
  total: number
  page: number
  pageSize: number
  counts: Record<NominationStatus, number>
}

function applyFilters(builder: Knex.QueryBuilder, f: CommitteeFilters): Knex.QueryBuilder {
  if (f.quarter) builder.where('n.quarter', f.quarter)
  if (f.status) builder.where('n.status', f.status)
  if (f.behaviourId) builder.where('n.behaviour_id', f.behaviourId)
  if (f.function) builder.where('e.function', f.function)
  if (f.site) builder.where('e.site', f.site)
  if (f.q) {
    const needle = `%${f.q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
    builder.where((b) => {
      b.whereRaw('LOWER(e.name) LIKE ? ESCAPE ?', [needle, '\\'])
        .orWhereRaw('LOWER(n.title) LIKE ? ESCAPE ?', [needle, '\\'])
        .orWhereRaw('LOWER(n.evidence_text) LIKE ? ESCAPE ?', [needle, '\\'])
    })
  }
  return builder
}

export async function listForCommittee(filters: CommitteeFilters): Promise<CommitteeView> {
  const db = getDb()

  const rows = (await applyFilters(baseQuery(db), filters)
    .orderBy('n.quarter', 'desc')
    .orderBy('n.updated_at', 'desc')
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize)) as JoinedRow[]

  const totalRow = (await applyFilters(
    db('nominations as n').join('employees as e', 'e.id', 'n.employee_id'),
    filters,
  )
    .count({ c: '*' })
    .first()) as { c: number | string } | undefined

  // Status tallies ignore the status filter itself — otherwise the tab counts
  // would collapse to the tab you are already looking at.
  const countRows = (await applyFilters(
    db('nominations as n').join('employees as e', 'e.id', 'n.employee_id'),
    { ...filters, status: undefined },
  )
    .groupBy('n.status')
    .select('n.status')
    .count({ c: '*' })) as unknown as { status: NominationStatus; c: number | string }[]

  const counts: Record<NominationStatus, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
    withdrawn: 0,
    removed: 0,
  }
  for (const r of countRows) counts[r.status] = Number(r.c)

  return {
    items: rows.map((r) => toItem(r)),
    total: Number(totalRow?.c ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
    counts,
  }
}

/** Every matching row, unpaginated, for the CSV the committee shortlists from. */
export async function listAllForExport(
  filters: Omit<CommitteeFilters, 'page' | 'pageSize'>,
): Promise<NominationItem[]> {
  const db = getDb()
  const rows = (await applyFilters(baseQuery(db), { ...filters, page: 1, pageSize: 0 })
    .orderBy('n.quarter', 'desc')
    .orderBy('e.name', 'asc')) as JoinedRow[]
  return rows.map((r) => toItem(r))
}
