/**
 * Client-side mirrors of the server API shapes (SPEC.md §5).
 * Keep these in sync with server/src/types.ts and the route contracts —
 * the server is the source of truth; nothing here invents new fields.
 */

export type Role = 'employee' | 'committee' | 'admin'

export interface SessionUser {
  email: string
  employeeId: number | null
  name: string
  role: Role
}

export type RecognitionStatus = 'active' | 'flagged' | 'removed'

export interface PersonLite {
  id: number
  name: string
  function: string
  site: string
  shift?: string
}

export interface BehaviourRef {
  id: number
  name: string
  colour: string
}

export interface FeedItem {
  id: number
  createdAt: string
  reason: string
  giver: PersonLite
  recipient: PersonLite
  behaviour: BehaviourRef
  status?: RecognitionStatus
  channel?: string
}

export interface Paged<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

/** GET /api/feed/filters */
export interface FeedFilterOptions {
  functions: string[]
  sites: string[]
  behaviours: BehaviourRef[]
  /** Admin-configurable recognition rules, so no screen has to hardcode them. */
  rules?: { reasonMinLength: number; capPerPairPerMonth: number }
}

/** Full behaviour row (admin console). DB booleans are 0/1 integers. */
export interface Behaviour {
  id: number
  name: string
  description: string
  colour: string
  active: number
  sort_order: number
}

/** Full employee row — admin endpoints only expose mobile/email/consent. */
export interface EmployeeRow {
  id: number
  employee_code: string
  name: string
  function: string
  sub_team: string | null
  shift: string
  site: string
  mobile?: string
  email?: string | null
  employment_type?: 'permanent' | 'contractual'
  level_grade?: string
  active: number
  language?: 'en' | 'hi' | 'bn'
  consent_recorded?: number
  hrms_updated_on?: string | null
}

/** GET /api/employees — directory row with activity counts (camelCase payload). */
export interface DirectoryPerson {
  id: number
  name: string
  function: string
  site: string
  shift?: string
  subTeam?: string | null
  employeeCode?: string
  givenCount: number
  receivedCount: number
}

/** GET /api/employees/:id/profile (FR-16) — camelCase payload, boolean active. */
export interface ProfileResponse {
  employee: {
    id: number
    name: string
    function: string
    subTeam?: string | null
    shift?: string
    site: string
    employeeCode?: string
    levelGrade?: string
    active?: boolean
  }
  received: {
    total: number
    byBehaviour: { behaviourId: number; name: string; colour: string; count: number }[]
  }
  given: { total: number }
  recent: FeedItem[]
}

/** GET /api/employees/search (camelCase payload) */
export interface EmployeeSearchHit {
  id: number
  name: string
  employeeCode?: string
  function: string
  site: string
  shift?: string
}

// ── Analytics (FR-26…31) ──────────────────────────────────────────────────────

export interface AnalyticsSummary {
  recognitions: number
  activeEmployees: number
  givers: number
  receivers: number
  pctGivers: number
  pctReceivers: number
  weekly: { weekStartIst: string; count: number }[]
}

export interface FunctionShiftRow {
  name: string
  headcount: number
  given: number
  received: number
  giverParticipationPct: number
}

export interface FunctionShiftSplit {
  functions: FunctionShiftRow[]
  shifts: FunctionShiftRow[]
}

export interface BehaviourBreakdownRow {
  behaviourId: number
  name: string
  colour: string
  count: number
  pct: number
}

export interface DirectionMix {
  total: number
  juniorToSenior: number
  seniorToJunior: number
  peer: number
  crossFunction: number
  sameFunction: number
}

export interface DarkSpotRow {
  dimension: 'sub_team' | 'shift' | 'site'
  name: string
  site?: string
  headcount: number
  given: number
  received: number
}

export interface ConcentrationPerson {
  id: number
  name: string
  function: string
  site: string
  count: number
  pctOfTotal: number
}

export interface Concentration {
  uniqueGivers: number
  uniqueRecipients: number
  top10PctGiverShare: number
  topGivers: ConcentrationPerson[]
  topRecipients: ConcentrationPerson[]
}

// ── Admin / moderation ───────────────────────────────────────────────────────

export interface AdminRecognition extends FeedItem {
  status: RecognitionStatus
  channel?: string
  removalReason?: string | null
  removedBy?: string | null
  removedAt?: string | null
  /** Open flag summary when the row is flagged. */
  openFlag?: { id: number; type: string } | null
}

export interface FlagItem {
  id: number
  type: 'loop' | 'burst'
  details: Record<string, unknown> | null
  status: 'open' | 'resolved'
  resolvedBy?: string | null
  resolvedAt?: string | null
  resolution?: string | null
  createdAt: string
  recognition: FeedItem & { status: RecognitionStatus }
}

/** Mirrors server modules/settings.ts AppSettings (FR-23). */
export interface AppSettings {
  capPerPairPerMonth: number
  reasonMinLength: number
  reasonBlocklist: string[]
  flagBurstCount: number
  flagBurstWindowMinutes: number
  flagLoopWindowHours: number
  flagLoopMinTotal: number
  weeklyDigestEnabled: boolean
  digestAudience: 'all' | 'leadership'
  nominationsEnabled: boolean
  nominationEvidenceMinLength: number
  nominationEvidenceMaxLength: number
  nominationGraceDays: number
}

// ── Quarterly self-nomination ────────────────────────────────────────────────

export type NominationStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'removed'

/** Indian financial-year quarter: Q1 = Apr–Jun. `code` looks like 'FY2026-Q2'. */
export interface Quarter {
  code: string
  index: 1 | 2 | 3 | 4
  fyStartYear: number
  label: string
  months: string
  startIso: string
  endIso: string
}

export interface NominationItem {
  id: number
  quarter: { code: string; label: string; months: string }
  /** CHAMP behaviour claimed. Null only on rows filed before 007. */
  behaviour: BehaviourRef | null
  title: string
  evidence: string
  status: NominationStatus
  employee: PersonLite & { employeeCode?: string; levelGrade?: string }
  manager: PersonLite | null
  decision: { by: string | null; byEmail: string | null; at: string | null; note: string | null } | null
  removal: { by: string | null; at: string | null; reason: string | null } | null
  createdAt: string
  updatedAt: string
  /** Present on /mine — whether the owner may still change it. */
  editable?: boolean
}

/** GET /api/nominations/mine */
export interface MyNominationsResponse {
  quartersOpen: Quarter[]
  items: NominationItem[]
  manager: PersonLite | null
  limits: { minLength: number; maxLength: number; enabled: boolean }
}

/** GET /api/nominations/quarters */
export interface QuarterOptions {
  open: Quarter[]
  recent: Quarter[]
  enabled: boolean
  minLength: number
  maxLength: number
  graceDays: number
}

/** GET /api/nominations/all */
export interface NominationsPage {
  items: NominationItem[]
  total: number
  page: number
  pageSize: number
  counts: Record<NominationStatus, number>
}

export interface AuditEntry {
  id: number
  actor: string
  action: string
  entityType?: string | null
  entityId?: string | null
  /** The server returns parsed JSON (object) for JSON details, or a raw string for legacy rows. */
  details?: unknown
  createdAt: string
}

export interface SyncResult {
  mode: 'demo' | 'live'
  upserts: number
  deactivated: number
  message: string
}

export interface DigestPreview {
  text: string
  stats: {
    total: number
    byBehaviour: { name: string; count: number }[]
    topSite: string | null
    participationPct: number
  }
}

// ── Board (kiosk, FR-18) ─────────────────────────────────────────────────────

export interface BoardWeekly {
  weekStartIst: string
  weekEndIst: string
  total: number
  byBehaviour: { name: string; colour: string; count: number }[]
  topRecipients: { name: string; site: string; count: number }[]
  items: FeedItem[]
}

// ── Simulator (dev WhatsApp phone) ───────────────────────────────────────────

export interface SimContact {
  id: number
  name: string
  mobile: string
  function: string
  site: string
  language: 'en' | 'hi' | 'bn'
  active: number
}

/** Mirrors server BotReply — rendered 1:1 by the simulator phone. */
export type BotReply =
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: { id: string; title: string }[] }
  | {
      type: 'list'
      text: string
      buttonLabel: string
      sections: { title: string; rows: { id: string; title: string; description?: string }[] }[]
    }

export interface SimEntry {
  dir: 'in' | 'out'
  at: string
  text?: string
  reply?: BotReply
  kind?: 'message' | 'notification'
}

// ── Admin Users & Bulk Upload ───────────────────────────────────────────────

export interface AdminUserRow {
  email: string
  role: 'admin' | 'committee'
  createdAt: string
  employeeName?: string
  employeeSite?: string
  employeeFunction?: string
}

export interface BulkUploadResult {
  ok: boolean
  insertedCount: number
  failedCount: number
  errors: Array<{ row: number; name?: string; error: string }>
}
