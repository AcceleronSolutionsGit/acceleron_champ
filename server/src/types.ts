/**
 * Shared domain types. Database rows come back with ISO-8601 UTC string
 * timestamps and 0/1 integers for boolean-ish columns (see db/migrations) —
 * treat them with `!!row.active` style truthiness.
 */

export interface Employee {
  id: number
  employee_code: string
  name: string
  function: string // 'Engineering' | 'Manufacturing' | 'Support' in demo data
  sub_team: string | null
  shift: string // 'A' | 'B' | 'C' | 'General'
  site: string
  mobile: string // E.164, e.g. +919810000042
  email: string | null
  employment_type: 'permanent' | 'contractual'
  level_grade: string // 'L1'..'L5' — ordered, L5 most senior
  manager_id: number | null
  active: number // 0/1
  language: 'en' | 'hi' | 'bn'
  consent_recorded: number // 0/1 — DPDP consent for contractual personal numbers
  created_at: string
  updated_at: string
  hrms_updated_on?: string | null
  company_code?: string | null
}

export interface Behaviour {
  id: number
  name: string
  description: string
  colour: string
  active: number // 0/1
  sort_order: number
}

export type RecognitionStatus = 'active' | 'flagged' | 'removed'

export interface Recognition {
  id: number
  giver_id: number
  recipient_id: number
  behaviour_id: number
  reason_text: string
  channel: string // 'whatsapp' | 'simulator'
  status: RecognitionStatus
  removal_reason: string | null
  removed_by: string | null
  removed_at: string | null
  created_at: string
}

export interface Flag {
  id: number
  recognition_id: number
  type: 'loop' | 'burst'
  details: string | null // JSON blob with pattern specifics
  status: 'open' | 'resolved'
  resolved_by: string | null
  resolved_at: string | null
  resolution: string | null // 'dismissed' | 'removed'
  created_at: string
}

// ── Quarterly self-nomination ─────────────────────────────────────────────────

export type NominationStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'

/** Raw `nominations` row. Timestamps are ISO-8601 UTC strings. */
export interface Nomination {
  id: number
  employee_id: number
  submitted_manager_id: number | null
  quarter: string // 'FY2026-Q2'
  quarter_start: string
  quarter_end: string
  title: string
  evidence_text: string
  status: NominationStatus
  decided_by_employee_id: number | null
  decided_by_email: string | null
  decided_at: string | null
  decision_note: string | null
  created_at: string
  updated_at: string
}

/** API shape — camelCase, with the people and the quarter resolved. */
export interface NominationItem {
  id: number
  quarter: { code: string; label: string; months: string }
  title: string
  evidence: string
  status: NominationStatus
  employee: PersonLite & { employeeCode?: string; levelGrade?: string }
  /** The manager who must decide, resolved live from the directory. */
  manager: PersonLite | null
  decision: {
    /** Display name of whoever decided, falling back to their email. */
    by: string | null
    byEmail: string | null
    at: string | null
    note: string | null
  } | null
  createdAt: string
  updatedAt: string
  /** True when the signed-in employee may still edit or withdraw this. */
  editable?: boolean
}

export type NominationErrorCode =
  | 'NOMINATIONS_DISABLED'
  | 'NOT_LINKED'
  | 'EMPLOYEE_INACTIVE'
  | 'NO_MANAGER'
  | 'UNKNOWN_QUARTER'
  | 'QUARTER_CLOSED'
  | 'EVIDENCE_TOO_SHORT'
  | 'EVIDENCE_TOO_LONG'
  | 'ALREADY_APPROVED'
  | 'ALREADY_DECIDED'
  | 'NOT_YOUR_REPORT'
  | 'NOT_FOUND'

export type Role = 'employee' | 'committee' | 'admin'

export interface SessionUser {
  email: string
  employeeId: number | null
  name: string
  role: Role
}

// ── Rules engine ──────────────────────────────────────────────────────────────

export type RuleErrorCode =
  | 'SELF_RECOGNITION'
  | 'CAP_EXCEEDED'
  | 'REASON_TOO_SHORT'
  | 'REASON_GENERIC'
  | 'GIVER_INACTIVE'
  | 'RECIPIENT_INACTIVE'

export interface RuleError {
  code: RuleErrorCode
  params?: Record<string, string | number>
}

export type CreateRecognitionResult =
  | { ok: true; recognition: Recognition }
  | { ok: false; error: RuleError }

// ── WhatsApp / conversation engine ───────────────────────────────────────────

/** Canonical bot reply shape — maps 1:1 onto Meta Cloud API message types and
 *  is rendered as-is by the local simulator. */
export type BotReply =
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: { id: string; title: string }[] }
  | {
      type: 'list'
      text: string
      buttonLabel: string
      sections: { title: string; rows: { id: string; title: string; description?: string }[] }[]
    }

export interface InboundMessage {
  mobile: string // E.164 of the sender
  text?: string // free-text body, when the user typed
  interactiveReplyId?: string // row/button id, when the user tapped
  /** Meta's per-message id (wamid.*), used to ignore repeat deliveries. */
  providerMessageId?: string
}

// ── API shapes ────────────────────────────────────────────────────────────────

export interface PersonLite {
  id: number
  name: string
  function: string
  site: string
  shift?: string
}

export interface FeedItem {
  id: number
  createdAt: string
  reason: string
  giver: PersonLite
  recipient: PersonLite
  behaviour: { id: number; name: string; colour: string }
  status?: RecognitionStatus
  channel?: string
}
