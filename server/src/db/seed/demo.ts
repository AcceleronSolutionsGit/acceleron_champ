/**
 * Demo data seed — a software company.
 *
 * Locally this stands in for the DarwinBox directory sync (which is disabled
 * without credentials — see modules/sync/darwinbox.ts): ~60 people across two
 * offices, on the real DarwinBox grade ladder (M2 → G1 → SRG1 → … → G5), plus
 * ~90 days of recognition history shaped so every analytics view has something
 * true to show:
 *
 *   · participation — most people give at least once, a long tail never does
 *   · office and function equity — Bengaluru slightly quieter than Kolkata
 *   · a dark spot — the IT Support squad, zero activity either way
 *   · concentration — three heavy givers carry a visible share
 *   · GRADE FLOW — deliberately lopsided: leads recognise their reports far
 *     more often than juniors recognise upward, which is the pattern the
 *     grade matrix exists to surface
 *   · open loop/burst flags and two moderated removals
 *
 * There is no shift rotation here; everyone is on 'General'. The analytics
 * split on office instead, which is the dimension a software org has.
 *
 * Deterministic PRNG ⇒ the same data every reseed.
 */
import { Knex } from 'knex'
import { config } from '../../config'
import { Grade, gradeRank } from '../../modules/grades'
import { DEFAULT_SETTINGS } from '../../modules/settings'
import { nowIso } from '../time'

// ── deterministic randomness ─────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── demo vocabulary ──────────────────────────────────────────────────────────

const FIRST_NAMES = [
  'Arjun', 'Priya', 'Rahul', 'Sneha', 'Amit', 'Kavita', 'Suman', 'Debashish',
  'Ananya', 'Ravi', 'Meena', 'Sourav', 'Tanmoy', 'Ritika', 'Vikram', 'Pooja',
  'Sandip', 'Moumita', 'Nilesh', 'Farhan', 'Gurpreet', 'Lakshmi', 'Ajay',
  'Swati', 'Biplab', 'Rekha', 'Harish', 'Nandini', 'Imran', 'Shreya',
  'Prakash', 'Anjali', 'Koushik', 'Deepa', 'Manoj', 'Payel', 'Rajesh',
  'Sunita', 'Abhijit', 'Tulika', 'Sk Salim', 'Joydeep', 'Madhumita', 'Pranab',
]

const LAST_NAMES = [
  'Sharma', 'Banerjee', 'Ghosh', 'Das', 'Mukherjee', 'Patel', 'Singh',
  'Chatterjee', 'Roy', 'Kumar', 'Dutta', 'Sen', 'Bose', 'Mandal', 'Nair',
  'Iyer', 'Verma', 'Mishra', 'Khan', 'Sarkar', 'Chakraborty', 'Pal', 'Naskar',
  'Hazra', 'Middya', 'Oraon',
]

/**
 * Demo/dev seed only. The AUTHORITATIVE set and order for a real database is
 * migration 008_set_champ_behaviours.ts, which runs on every deploy — keep the
 * two in step so a fresh local database matches production.
 */
export const BEHAVIOUR_SEED = [
  { name: 'IMPACT', description: 'Outcomes that outlast the project.', colour: '#19559c', sort_order: 1 },
  { name: 'INNOVATION', description: 'Think ahead. Build what\'s next.', colour: '#752d81', sort_order: 2 },
  { name: 'INTEGRITY', description: 'Do right. Always.', colour: '#5a623e', sort_order: 3 },
  { name: 'CARING', description: 'People first in every decision.', colour: '#619c77', sort_order: 4 },
  { name: 'CUSTOMER CENTRICITY', description: 'Your outcomes. Our responsibility.', colour: '#e58f00', sort_order: 5 },
  { name: 'ENTREPRENEURSHIP', description: 'Own it. Drive it. Deliver it.', colour: '#ba232b', sort_order: 6 },
]

const REASONS: Record<string, string[]> = {
  'IMPACT': [
    'Rewrote the nightly reconciliation job that had been timing out for a month — it now finishes in four minutes instead of failing at ninety',
    'Tracked the checkout drop-off to a race condition in the payment callback and shipped the fix before the weekend peak',
    'Cut the API p95 from 1.8s to 320ms by fixing the N+1 in the order history query nobody had profiled',
    'Cleared the two-year-old flaky test suite so the pipeline is trustworthy again and nobody re-runs builds on a hunch',
    'Migrated the last service off the deprecated auth library, which closed out the whole security finding',
  ],
  'INTEGRITY': [
    'Flagged that our load test was hitting a cached path and the real numbers were nowhere near what the deck claimed',
    'Owned up to the bad migration within minutes and had the rollback out before anyone noticed downstream',
    'Pushed back on shipping the feature with the consent flow half-built rather than letting it go out quietly',
    'Rewrote the estimate upward when the spike showed the integration was harder, instead of protecting the original date',
    'Caught that the exported report included personal data the client had not asked for and stopped the send',
  ],
  'ENTREPRENEURSHIP': [
    'Picked up the stalled vendor SSO integration nobody owned and had it through UAT in nine days',
    'Set up the on-call rota and the runbook without being asked, so the first production page had an answer waiting',
    'Ran the client demo solo when the account lead was ill, and closed the follow-up questions the same day',
    'Took the unglamorous logging cleanup to done, which is why last week\'s incident took twenty minutes to diagnose',
    'Prototyped the usage dashboard over a slow week and it is now what the account reviews run on',
  ],
  'INNOVATION': [
    'Replaced the hand-written CSV parser with a streaming one, so the 400MB client imports stopped eating the container',
    'Built the preview-environment-per-PR setup that has ended the "works on my branch" argument',
    'Suggested caching the permission tree at the edge — one change took a third of the load off the identity service',
    'Wrote the codemod that migrated 200 components in an afternoon instead of the sprint we had planned',
    'Put together the small anomaly alert on signup volume that caught the bot traffic before billing did',
  ],
  'CARING': [
    'Sat with the two new joiners through their first deploy instead of doing it for them',
    'Rebalanced the sprint when a teammate had a family emergency, without anyone needing to ask',
    'Reviewed every PR on the QA team\'s backlog over two days so their release was not blocked on us',
    'Stayed on the call past midnight with the client\'s ops team and made sure our own engineer went to bed',
    'Wrote the onboarding doc they wished they had had, and it is now the first thing new hires are sent',
  ],
  'CUSTOMER CENTRICITY': [
    'Rebuilt the despatch report after the client flagged the wrong line totals, and had it with them before their Monday review',
    'Called out that the new export format would break the client\'s downstream macro, and shipped both formats',
    'Turned around the integration clarification the same evening to protect the go-live date',
    'Sat in on the client\'s own user testing and brought back three fixes nobody in the team had thought of',
    'Rewrote the error messages in the client portal so their support desk stopped raising tickets to ask what they meant',
  ],
}

// ── org structure ────────────────────────────────────────────────────────────

interface TeamSpec {
  site: string
  fn: string
  squad: string
  /** Includes the lead, who is the first member. */
  size: number
  leadGrade: Grade
  /** The rest are drawn from here; repeat a grade to weight it. */
  grades: Grade[]
  langs: Array<'en' | 'hi' | 'bn'>
}

/**
 * Two offices. Kolkata is the delivery centre and where leadership sits;
 * Bengaluru is the newer platform office — which is why it reads slightly
 * quieter in the office-equity chart, the kind of gap the programme is
 * supposed to catch early.
 */
const TEAMS: TeamSpec[] = [
  // ── Kolkata ───────────────────────────────────────────────────────────────
  { site: 'Kolkata', fn: 'Engineering', squad: 'Payments Squad', size: 6,
    leadGrade: 'SRG3', grades: ['G1', 'SRG1', 'G2', 'SRG2', 'G2'], langs: ['en', 'bn'] },
  { site: 'Kolkata', fn: 'Engineering', squad: 'Identity Squad', size: 5,
    leadGrade: 'G3', grades: ['G1', 'SRG1', 'G2', 'SRG2'], langs: ['en', 'bn'] },
  { site: 'Kolkata', fn: 'Engineering', squad: 'Client Portal Squad', size: 5,
    leadGrade: 'G3', grades: ['M2', 'G1', 'SRG1', 'G2'], langs: ['en', 'bn', 'hi'] },
  { site: 'Kolkata', fn: 'Quality Engineering', squad: 'QA & Automation', size: 4,
    leadGrade: 'SRG2', grades: ['G1', 'SRG1', 'G2'], langs: ['en', 'bn'] },
  { site: 'Kolkata', fn: 'Product', squad: 'Product Management', size: 3,
    leadGrade: 'SRG3', grades: ['G2', 'SRG2'], langs: ['en'] },
  { site: 'Kolkata', fn: 'Design', squad: 'Product Design', size: 3,
    leadGrade: 'G3', grades: ['SRG1', 'G2'], langs: ['en'] },
  { site: 'Kolkata', fn: 'People', squad: 'People & Talent', size: 3,
    leadGrade: 'G3', grades: ['G1', 'SRG1'], langs: ['en', 'bn'] },
  { site: 'Kolkata', fn: 'Support', squad: 'IT Support', size: 3,
    leadGrade: 'SRG1', grades: ['M2', 'G1'], langs: ['en', 'hi'] }, // dark spot — zero activity
  // ── Bengaluru ─────────────────────────────────────────────────────────────
  { site: 'Bengaluru', fn: 'Engineering', squad: 'Platform Squad', size: 5,
    leadGrade: 'SRG3', grades: ['SRG1', 'G2', 'SRG2', 'G2'], langs: ['en'] },
  { site: 'Bengaluru', fn: 'Engineering', squad: 'Mobile Squad', size: 4,
    leadGrade: 'G3', grades: ['G1', 'SRG1', 'G2'], langs: ['en'] },
  { site: 'Bengaluru', fn: 'DevOps', squad: 'Infrastructure & SRE', size: 4,
    leadGrade: 'SRG2', grades: ['SRG1', 'G2', 'G2'], langs: ['en', 'hi'] },
  { site: 'Bengaluru', fn: 'Data', squad: 'Data & Analytics', size: 4,
    leadGrade: 'G3', grades: ['G1', 'SRG1', 'G2'], langs: ['en'] },
  { site: 'Bengaluru', fn: 'Sales', squad: 'Client Partnerships', size: 3,
    leadGrade: 'SRG3', grades: ['G2', 'SRG2'], langs: ['en', 'hi'] },
]

// ── helpers ──────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000

interface SeededEmployee {
  id: number
  name: string
  fn: string
  subTeam: string
  shift: string
  site: string
  level: string
  mobile: string
}

async function insertReturningId(db: Knex, table: string, row: Record<string, unknown>): Promise<number> {
  const res = await db(table).insert(row).returning('id')
  const first = Array.isArray(res) ? res[0] : res
  return typeof first === 'object' && first !== null ? (first as { id: number }).id : (first as number)
}

/** Random instant `daysBack..0` days ago, biased to weekdays and working hours IST. */
function randomWorkInstant(rnd: () => number, daysBack: number, notAfterMs?: number): string {
  for (let i = 0; i < 12; i++) {
    const t = Date.now() - rnd() * daysBack * DAY
    const d = new Date(t)
    const istHour = (d.getUTCHours() + 5.5 + 24) % 24
    const dow = d.getUTCDay()
    const isWeekend = dow === 0 || dow === 6
    if (isWeekend && rnd() < 0.7) continue
    if ((istHour < 7 || istHour > 20) && rnd() < 0.8) continue
    if (notAfterMs && t > notAfterMs) continue
    return new Date(t).toISOString()
  }
  return new Date(Date.now() - rnd() * daysBack * DAY).toISOString()
}

// ── main generator ───────────────────────────────────────────────────────────

async function generate(db: Knex): Promise<Record<string, number>> {
  const rnd = mulberry32(20260722)
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)]
  const now = nowIso()

  // Behaviours
  const behaviourIds: Record<string, number> = {}
  for (const b of BEHAVIOUR_SEED) {
    behaviourIds[b.name] = await insertReturningId(db, 'behaviours', { ...b, active: 1 })
  }

  // Settings
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await db('settings').insert({ key, value: JSON.stringify(value) })
  }

  // Employees
  const employees: SeededEmployee[] = []
  const usedNames = new Set<string>()
  const usedEmails = new Set<string>()
  let seq = 0

  const nextName = (): string => {
    for (let i = 0; i < 50; i++) {
      const n = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`
      if (!usedNames.has(n)) {
        usedNames.add(n)
        return n
      }
    }
    return `Employee ${seq}`
  }

  const defaultDomain = config.auth.allowedEmailDomains[0] ?? 'acceleronsolutions.io'
  const emailFor = (name: string): string => {
    let base = name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/ +/g, '.')
    let email = `${base}@${defaultDomain}`
    let n = 2
    while (usedEmails.has(email)) email = `${base}${n++}@${defaultDomain}`
    usedEmails.add(email)
    return email
  }

  const addEmployee = async (e: {
    name: string
    fn: string
    subTeam: string
    shift: string
    site: string
    level: string
    managerId: number | null
    email: string | null
    mobile?: string
    employmentType?: 'permanent' | 'contractual'
    language?: 'en' | 'hi' | 'bn'
    active?: number
  }): Promise<SeededEmployee> => {
    seq += 1
    const mobile = e.mobile ?? `+91${9810000000 + seq}`
    const contractual = e.employmentType === 'contractual'
    const id = await insertReturningId(db, 'employees', {
      employee_code: `ASPL${1000 + seq}`,
      name: e.name,
      function: e.fn,
      sub_team: e.subTeam,
      shift: e.shift,
      site: e.site,
      mobile,
      email: e.email,
      employment_type: e.employmentType ?? 'permanent',
      level_grade: e.level,
      manager_id: e.managerId,
      active: e.active ?? 1,
      language: e.language ?? 'en',
      consent_recorded: contractual ? 1 : 0, // consent captured for personal numbers (FR-3)
      created_at: now,
      updated_at: now,
    })
    const emp = { id, name: e.name, fn: e.fn, subTeam: e.subTeam, shift: e.shift, site: e.site, level: e.level, mobile }
    employees.push(emp)
    return emp
  }

  // Leadership — the top two rungs of the ladder.
  const cto = await addEmployee({
    name: nextName(), fn: 'Engineering', subTeam: 'Technology Leadership', shift: 'General',
    site: 'Kolkata', level: 'G5', managerId: null, email: emailFor('cto'), language: 'en',
  })
  const deliveryHead = await addEmployee({
    name: nextName(), fn: 'Engineering', subTeam: 'Delivery Leadership', shift: 'General',
    site: 'Bengaluru', level: 'SRG4', managerId: cto.id, email: emailFor('delivery.head'), language: 'en',
  })

  // Named console users (match default ADMIN_EMAILS / COMMITTEE_EMAILS)
  await addEmployee({
    name: 'Riya Sen', fn: 'People', subTeam: 'People & Talent', shift: 'General', site: 'Kolkata',
    level: 'G3', managerId: cto.id, email: `hr.admin@${defaultDomain}`, language: 'en',
  })
  await addEmployee({
    name: 'Arindam Bose', fn: 'People', subTeam: 'People & Talent', shift: 'General', site: 'Kolkata',
    level: 'G4', managerId: cto.id, email: `rnr.committee@${defaultDomain}`, language: 'en',
  })
  await addEmployee({
    name: 'Sabarnik Lahiri', fn: 'Management', subTeam: 'Executive', shift: 'General', site: 'Kolkata',
    level: 'G5', managerId: null, email: 'sabarnik.lahiri@acceleronsolutions.io', mobile: '+919875445704', language: 'en',
  })

  for (const team of TEAMS) {
    const head = team.site === 'Kolkata' ? cto : deliveryHead
    let lead: SeededEmployee | null = null
    for (let i = 0; i < team.size; i++) {
      const isLead = i === 0
      const level = isLead ? team.leadGrade : pick(team.grades)
      // Contractors sit on the same ladder but are a small minority, and a
      // few have no company mailbox — which is why the WhatsApp number, not
      // the email, is the identity this programme runs on (FR-2).
      const contractual = !isLead && rnd() < 0.12
      const hasEmail = !contractual || rnd() < 0.5
      const name = nextName()
      const emp = await addEmployee({
        name,
        fn: team.fn,
        subTeam: team.squad,
        shift: 'General',
        site: team.site,
        level,
        managerId: isLead ? head.id : lead!.id,
        email: hasEmail ? emailFor(name) : null,
        employmentType: contractual ? 'contractual' : 'permanent',
        language: pick(team.langs),
      })
      if (isLead) lead = emp
    }
  }

  // Two leavers with history (FR-4): deactivate after generating recognitions? —
  // simpler: mark inactive now; the generator below excludes them as new
  // givers/recipients but they may appear in crafted historical entries.
  const leavers = [employees[10], employees[25]]
  for (const l of leavers) {
    await db('employees').where({ id: l.id }).update({ active: 0, updated_at: now })
  }

  // Console roles
  await upsertAdminUsers(db)

  // ── Recognition history ────────────────────────────────────────────────────
  const behaviourNames = Object.keys(behaviourIds)
  const isDarkSpot = (e: SeededEmployee) => e.subTeam === 'IT Support'
  const leaverIds = new Set(leavers.map((l) => l.id))
  const pool = employees.filter((e) => !isDarkSpot(e) && !leaverIds.has(e.id))

  // concentration: three champions give a lot
  const champions = [pool[4], pool[12], pool[30]].filter(
    (e) => e && (gradeRank(e.level) ?? 0) <= 5,
  )
  const championIds = new Set(champions.map((c) => c.id))

  /**
   * How likely someone is to be picked as the GIVER.
   *
   * The grade term is the point of the demo: senior people recognise far more
   * often than juniors do, so the grade matrix comes out visibly lopsided
   * towards downward flow — which is the real-world pattern the committee is
   * meant to notice and act on, not an artefact.
   */
  const giverWeightOf = (e: SeededEmployee): number => {
    let w = 1
    if (championIds.has(e.id)) w *= 5
    const tier = gradeRank(e.level) ?? 3
    w *= 0.72 + tier * 0.12 // M2 ≈ 0.84 … G5 ≈ 1.92
    if (e.site === 'Bengaluru') w *= 0.75 // newer office, quieter so far
    return w
  }

  /** Recipients skew the other way — juniors receive more than they give. */
  const recipientWeightOf = (e: SeededEmployee): number => {
    let w = 1
    const tier = gradeRank(e.level) ?? 3
    w *= 1.55 - tier * 0.075 // M2 ≈ 1.48 … G5 ≈ 0.8
    if (e.site === 'Bengaluru') w *= 0.85
    return w
  }
  const weighted = (
    list: SeededEmployee[],
    weightOf: (e: SeededEmployee) => number = giverWeightOf,
  ): SeededEmployee => {
    const total = list.reduce((s, e) => s + weightOf(e), 0)
    let r = rnd() * total
    for (const e of list) {
      r -= weightOf(e)
      if (r <= 0) return e
    }
    return list[list.length - 1]
  }

  // Engineers reach for IMPACT and INNOVATION; the client-facing and people
  // functions reach for CARING and CUSTOMER CENTRICITY. Gives the behaviour
  // breakdown a shape that is worth reading rather than a flat six-way split.
  const behaviourWeights = (giver: SeededEmployee): [string, number][] =>
    giver.fn === 'Engineering' || giver.fn === 'DevOps' || giver.fn === 'Data'
      ? [['IMPACT', 0.28], ['INNOVATION', 0.22], ['INTEGRITY', 0.16], ['ENTREPRENEURSHIP', 0.14], ['CARING', 0.12], ['CUSTOMER CENTRICITY', 0.08]]
      : [['IMPACT', 0.10], ['INNOVATION', 0.10], ['INTEGRITY', 0.18], ['ENTREPRENEURSHIP', 0.18], ['CARING', 0.22], ['CUSTOMER CENTRICITY', 0.22]]

  const pickBehaviour = (giver: SeededEmployee): string => {
    const weights = behaviourWeights(giver)
    let r = rnd() * weights.reduce((s, [, w]) => s + w, 0)
    for (const [name, w] of weights) {
      r -= w
      if (r <= 0) return name
    }
    return behaviourNames[0]
  }

  const pairMonth = new Map<string, number>()
  const rows: {
    giver_id: number; recipient_id: number; behaviour_id: number; reason_text: string
    channel: string; status: string; created_at: string
    removal_reason?: string; removed_by?: string; removed_at?: string
  }[] = []

  const TARGET = 230
  let guard = 0
  while (rows.length < TARGET && guard++ < TARGET * 30) {
    const giver = weighted(pool)
    /**
     * People recognise who they work with. Picking uniformly across a 55-
     * person directory produced 80% cross-function recognition, which is not
     * a company — it is a random graph. Weighted the way a real week looks:
     * mostly your own squad, then your own function, then anyone.
     */
    const roll = rnd()
    const notSelf = (e: SeededEmployee) => e.id !== giver.id
    const sameSquad = pool.filter((e) => notSelf(e) && e.subTeam === giver.subTeam)
    const sameFn = pool.filter((e) => notSelf(e) && e.fn === giver.fn && e.subTeam !== giver.subTeam)
    const anyone = pool.filter(notSelf)
    const candidates =
      roll < 0.5 && sameSquad.length
        ? sameSquad
        : roll < 0.75 && sameFn.length
          ? sameFn
          : anyone
    if (!candidates.length) continue
    const recipient = weighted(candidates, recipientWeightOf)
    if (recipient.id === giver.id) continue
    const createdAt = randomWorkInstant(rnd, 90)
    const monthKey = `${giver.id}-${recipient.id}-${createdAt.slice(0, 7)}`
    if ((pairMonth.get(monthKey) ?? 0) >= DEFAULT_SETTINGS.capPerPairPerMonth) continue // respect BR-2
    pairMonth.set(monthKey, (pairMonth.get(monthKey) ?? 0) + 1)
    const behaviour = pickBehaviour(giver)
    rows.push({
      giver_id: giver.id,
      recipient_id: recipient.id,
      behaviour_id: behaviourIds[behaviour],
      reason_text: pick(REASONS[behaviour]),
      channel: 'whatsapp',
      status: 'active',
      created_at: createdAt,
    })
  }

  // Crafted moderation demos ---------------------------------------------------
  const loopSquad = pool.filter((e) => e.subTeam === 'Identity Squad')
  const burstSquad = pool.filter((e) => e.subTeam === 'Platform Squad')
  const adminEmail = config.auth.adminEmails[0] ?? `hr.admin@${defaultDomain}`

  // (a) open reciprocal loop: M1↔M2, 4 recognitions inside 36 hours, ~5 days ago
  const loopBase = Date.now() - 5 * DAY
  const [m1, m2] = [loopSquad[0], loopSquad[1]]
  const loopRows = [0, 1, 2, 3].map((i) => ({
    giver_id: i % 2 === 0 ? m1.id : m2.id,
    recipient_id: i % 2 === 0 ? m2.id : m1.id,
    behaviour_id: behaviourIds['CARING'],
    reason_text: pick(REASONS['CARING']),
    channel: 'whatsapp',
    status: i >= 2 ? 'flagged' : 'active',
    created_at: new Date(loopBase + i * 9 * 60 * 60 * 1000).toISOString(),
  }))
  rows.push(...loopRows)

  // (b) burst: one giver, 6 recognitions in ~45 minutes, ~8 days ago
  const burstGiver = burstSquad[0]
  const burstBase = Date.now() - 8 * DAY
  const burstTargets = pool.filter((e) => e.id !== burstGiver.id).slice(0, 6)
  const burstRows = burstTargets.map((t, i) => ({
    giver_id: burstGiver.id,
    recipient_id: t.id,
    behaviour_id: behaviourIds['ENTREPRENEURSHIP'],
    reason_text: pick(REASONS['ENTREPRENEURSHIP']),
    channel: 'whatsapp',
    status: i === 5 ? 'flagged' : 'active',
    created_at: new Date(burstBase + i * 8 * 60 * 1000).toISOString(),
  }))
  rows.push(...burstRows)

  // (c) two moderated removals, ~2–3 weeks ago (BR-6 soft delete)
  for (const daysBack of [14, 20]) {
    const giver = weighted(pool)
    const recipient = weighted(pool.filter((e) => e.id !== giver.id))
    const when = new Date(Date.now() - daysBack * DAY)
    rows.push({
      giver_id: giver.id,
      recipient_id: recipient.id,
      behaviour_id: behaviourIds['INTEGRITY'],
      reason_text: 'Duplicate of an earlier entry for the same release fix',
      channel: 'whatsapp',
      status: 'removed',
      removal_reason: 'Duplicate entry — same event recorded twice',
      removed_by: adminEmail,
      removed_at: new Date(when.getTime() + 2 * DAY).toISOString(),
      created_at: when.toISOString(),
    })
  }

  rows.sort((a, b) => a.created_at.localeCompare(b.created_at))
  const recognitionIds: number[] = []
  for (const row of rows) {
    recognitionIds.push(await insertReturningId(db, 'recognitions', row))
  }

  // Flags for the crafted patterns (find them back by status)
  const flagged: { id: number; giver_id: number; recipient_id: number; created_at: string }[] =
    await db('recognitions').where({ status: 'flagged' }).select('id', 'giver_id', 'recipient_id', 'created_at')
  for (const r of flagged) {
    const isLoop = (r.giver_id === m1.id && r.recipient_id === m2.id) || (r.giver_id === m2.id && r.recipient_id === m1.id)
    await db('flags').insert({
      recognition_id: r.id,
      type: isLoop ? 'loop' : 'burst',
      details: JSON.stringify(
        isLoop
          ? { pair: [m1.name, m2.name], countInWindow: 4, windowHours: DEFAULT_SETTINGS.flagLoopWindowHours }
          : { giver: burstGiver.name, countInWindow: 6, windowMinutes: DEFAULT_SETTINGS.flagBurstWindowMinutes },
      ),
      status: 'open',
      created_at: r.created_at,
    })
  }

  // One earlier, already-dismissed flag so the queue shows a resolved example
  const dismissedRec = recognitionIds[Math.floor(recognitionIds.length / 2)]
  await db('flags').insert({
    recognition_id: dismissedRec,
    type: 'burst',
    details: JSON.stringify({ note: 'Weekly town-hall day — several genuine recognitions in one hour' }),
    status: 'resolved',
    resolved_by: adminEmail,
    resolved_at: new Date(Date.now() - 10 * DAY).toISOString(),
    resolution: 'dismissed',
    created_at: new Date(Date.now() - 11 * DAY).toISOString(),
  })

  // Audit trail for the seeded removals
  const removed: { id: number }[] = await db('recognitions').where({ status: 'removed' }).select('id')
  for (const r of removed) {
    await db('audit_log').insert({
      actor: adminEmail,
      action: 'remove_recognition',
      entity_type: 'recognition',
      entity_id: String(r.id),
      details: JSON.stringify({ reason: 'Duplicate entry — same event recorded twice' }),
      created_at: nowIso(),
    })
  }
  await db('audit_log').insert({
    actor: 'system',
    action: 'seed_demo_data',
    entity_type: 'database',
    entity_id: 'seed',
    details: JSON.stringify({ employees: employees.length, recognitions: rows.length }),
    created_at: nowIso(),
  })

  return { employees: employees.length, recognitions: rows.length, flags: flagged.length + 1 }
}

/** Console roles come from env (ADMIN_EMAILS / COMMITTEE_EMAILS) — upserted every boot. */
export async function upsertAdminUsers(db: Knex): Promise<void> {
  const upsert = async (emailRaw: string, role: 'admin' | 'committee') => {
    const email = emailRaw.trim().toLowerCase()
    const existing = await db('admin_users').whereRaw('lower(email) = ?', [email]).first()
    if (existing) await db('admin_users').whereRaw('lower(email) = ?', [email]).update({ role })
    else await db('admin_users').insert({ email, role, created_at: nowIso() })
  }
  for (const email of config.auth.adminEmails) await upsert(email, 'admin')
  for (const email of config.auth.committeeEmails) await upsert(email, 'committee')
}

/** Seed metadata on first boot (empty database). Always refreshes console roles. */
export async function seedIfEmpty(db: Knex): Promise<void> {
  // Ensure default behaviours exist
  const [{ bc }] = (await db('behaviours').count({ bc: '*' })) as unknown as [{ bc: number | string }]
  if (Number(bc) === 0) {
    for (const b of BEHAVIOUR_SEED) {
      await db('behaviours').insert({ ...b, active: 1 })
    }
  }

  // Ensure default settings exist
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const exists = await db('settings').where({ key }).first()
    if (!exists) {
      await db('settings').insert({ key, value: JSON.stringify(value) })
    }
  }

  // Ensure admin users from config are upserted
  await upsertAdminUsers(db)

  const [{ c }] = (await db('employees').count({ c: '*' })) as unknown as [{ c: number | string }]
  if (Number(c) > 0) {
    return
  }

  if (config.darwinbox.enabled) {
    console.log('[seed] Empty database and Darwinbox sync enabled — running Darwinbox sync…')
    const { runDirectorySync } = await import('../../modules/sync/darwinbox')
    const syncRes = await runDirectorySync()
    console.log('[seed] Darwinbox sync completed on boot:', syncRes)
    return
  }

  // Only auto-generate demo employees if explicitly running on local SQLite
  if (config.db.client === 'better-sqlite3' && !config.isProd) {
    console.log('[seed] Empty local SQLite database — loading demo directory and recognition history…')
    const stats = await generate(db)
    console.log(`[seed] Done: ${stats.employees} employees, ${stats.recognitions} recognitions, ${stats.flags} flags.`)
  } else {
    console.log('[seed] Empty database initialized with default behaviours, settings, and admin users. Ready for bulk employee upload.')
  }
}

/** Wipe and reseed (npm run seed:reset). */
export async function resetAndSeed(db: Knex): Promise<void> {
  for (const table of ['audit_log', 'settings', 'admin_users', 'otp_codes', 'conversation_state', 'flags', 'recognitions', 'behaviours', 'employees']) {
    await db(table).del()
  }

  if (config.darwinbox.enabled) {
    console.log('[seed] Wiped database and Darwinbox sync enabled — re-seeding from Darwinbox…')
    for (const b of BEHAVIOUR_SEED) {
      await db('behaviours').insert({ ...b, active: 1 })
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await db('settings').insert({ key, value: JSON.stringify(value) })
    }
    await upsertAdminUsers(db)
    const { runDirectorySync } = await import('../../modules/sync/darwinbox')
    const syncRes = await runDirectorySync()
    console.log('[seed] Reseeded from Darwinbox on reset:', syncRes)
    return
  }

  const stats = await generate(db)
  console.log(`[seed] Reseeded: ${stats.employees} employees, ${stats.recognitions} recognitions.`)
}
