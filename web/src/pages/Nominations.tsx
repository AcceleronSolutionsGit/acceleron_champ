/**
 * /nominations — quarterly self-nomination for the signed-in employee.
 *
 * One nomination per person per quarter, so this page is an editor for a single
 * record rather than a "create another" form: pick a quarter, and you are
 * either writing the one you have not filed yet or editing the one you have.
 * A rejected nomination is editable and resubmitting puts it back in front of
 * the manager, which is why the form does not disappear once a decision lands.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { api, ApiError } from '../api'
import { useApi } from '../hooks'
import type { NominationItem, NominationStatus } from '../types'
import { formatIstDateTime } from '../format'
import { Button, Card, EmptyState, ErrorState, Field, Loading } from '../components/ui'

/** Status → the sentence the employee actually needs, in their own terms. */
const STATUS_COPY: Record<NominationStatus, { label: string; tone: string; hint: string }> = {
  pending: {
    label: 'Awaiting your manager',
    tone: 'pending',
    hint: 'Your manager can see this now. You can keep editing until they decide.',
  },
  approved: {
    label: 'Approved',
    tone: 'approved',
    hint: 'Your manager has backed this. It now sits with the R&R committee and can no longer be edited.',
  },
  rejected: {
    label: 'Not approved',
    tone: 'rejected',
    hint: 'Read your manager’s note, rework the evidence and submit again — it goes straight back to them.',
  },
  withdrawn: {
    label: 'Withdrawn',
    tone: 'withdrawn',
    hint: 'You pulled this back. Edit and submit whenever you are ready.',
  },
  removed: {
    label: 'Removed',
    tone: 'removed',
    hint: 'The R&R committee removed this from the pool. The reason is below. This quarter is now closed to you — speak to HR if you think that is wrong.',
  },
}

/**
 * "Pending" means something different depending on who is reading it — the
 * employee is waiting on their manager, the manager IS the wait, and the
 * committee is watching someone else's queue. Only the pending label changes;
 * a decision reads the same to everyone.
 */
type Audience = 'self' | 'manager' | 'committee'

const PENDING_LABEL: Record<Audience, string> = {
  self: 'Awaiting your manager',
  manager: 'Awaiting you',
  committee: 'Awaiting manager',
}

export function NominationStatusBadge({
  status,
  audience = 'self',
}: {
  status: NominationStatus
  audience?: Audience
}): React.ReactElement {
  const { tone, label } = STATUS_COPY[status]
  return (
    <span className={`badge badge-nom-${tone}`}>{status === 'pending' ? PENDING_LABEL[audience] : label}</span>
  )
}

export default function Nominations(): React.ReactElement {
  const state = useApi(() => api.myNominations(), [])
  const data = state.data
  // The active CHAMP behaviours, from the same endpoint the feed filters use —
  // an admin retiring one (FR-23) removes it from this picker with no deploy.
  const behaviours = useApi(() => api.feedFilters(), [])

  const [quarterCode, setQuarterCode] = useState('')
  const [behaviourId, setBehaviourId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [evidence, setEvidence] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  /** Set once the user edits, so a background reload can't stomp their typing. */
  const [dirty, setDirty] = useState(false)

  // Default to the newest open quarter as soon as the page knows what is open.
  useEffect(() => {
    if (!quarterCode && data?.quartersOpen.length) setQuarterCode(data.quartersOpen[0].code)
  }, [data, quarterCode])

  const existing = useMemo(
    () => data?.items.find((n) => n.quarter.code === quarterCode) ?? null,
    [data, quarterCode],
  )

  // Load whatever is already filed for the selected quarter into the editor.
  useEffect(() => {
    if (dirty) return
    setTitle(existing?.title ?? '')
    setEvidence(existing?.evidence ?? '')
    setBehaviourId(existing?.behaviour?.id ?? null)
  }, [existing, dirty])

  if (state.loading && !data) return <Loading label="Loading your nominations…" />
  if (state.error) return <ErrorState error={state.error} retry={state.reload} />
  if (!data) return <Loading />

  const { limits, manager, quartersOpen } = data
  const selectedQuarter = quartersOpen.find((q) => q.code === quarterCode)
  const locked = existing?.status === 'approved' || existing?.status === 'removed'
  const evidenceLength = evidence.trim().length
  const tooShort = evidenceLength < limits.minLength
  const tooLong = evidenceLength > limits.maxLength
  const canSubmit =
    limits.enabled &&
    !!manager &&
    !locked &&
    !!quarterCode &&
    behaviourId !== null &&
    title.trim().length >= 8 &&
    !tooShort &&
    !tooLong

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setSaved(null)
    try {
      const res = await api.submitNomination({
        quarter: quarterCode,
        behaviourId: behaviourId!,
        title,
        evidence,
      })
      setSaved(`${res.item.quarter.label} sent to ${res.item.manager?.name ?? 'your manager'} for approval.`)
      setDirty(false)
      state.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not submit your nomination')
    } finally {
      setBusy(false)
    }
  }

  const withdraw = async (nomination: NominationItem) => {
    setBusy(true)
    setError(null)
    try {
      await api.withdrawNomination(nomination.id)
      setSaved(`${nomination.quarter.label} withdrawn.`)
      setDirty(false)
      state.reload()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not withdraw that nomination')
    } finally {
      setBusy(false)
    }
  }

  const history = data.items.filter((n) => n.quarter.code !== quarterCode)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Nominate yourself</h1>
          <div className="page-sub">
            Once a quarter, put forward your strongest piece of work with the evidence behind it. Your
            reporting manager approves it, and approved nominations go to the R&amp;R committee.
          </div>
        </div>
      </div>

      {!limits.enabled && (
        <div className="notice notice-error" style={{ marginBottom: 16 }}>
          Self-nomination is switched off for the programme right now. Your existing nominations are below.
        </div>
      )}

      {!manager && (
        <div className="notice notice-error" style={{ marginBottom: 16 }}>
          <strong>No reporting manager on file.</strong> Your DarwinBox record has no manager against it, so
          there is nobody to approve a nomination. Please ask HR to check your reporting line — everything
          else here will work the moment it is set.
        </div>
      )}

      <div className="nom-layout">
        <div>
          <Card
            title={selectedQuarter ? `Your ${selectedQuarter.label} nomination` : 'Your nomination'}
            sub={
              selectedQuarter
                ? `Covering ${selectedQuarter.months}. One nomination per quarter — editing replaces what you sent.`
                : 'Choose a quarter to begin.'
            }
          >
            <form onSubmit={(e) => void submit(e)}>
              <div className="nom-form-row">
                <Field label="Quarter">
                  <select
                    className="select"
                    value={quarterCode}
                    onChange={(e) => {
                      setQuarterCode(e.target.value)
                      setDirty(false)
                      setSaved(null)
                      setError(null)
                    }}
                  >
                    {quartersOpen.map((q) => (
                      <option key={q.code} value={q.code}>
                        {q.label} · {q.months}
                      </option>
                    ))}
                    {/* A quarter you already filed for that has since closed must
                        still be selectable, or its record would vanish from view. */}
                    {data.items
                      .filter((n) => !quartersOpen.some((q) => q.code === n.quarter.code))
                      .map((n) => (
                        <option key={n.quarter.code} value={n.quarter.code}>
                          {n.quarter.label} · closed
                        </option>
                      ))}
                  </select>
                </Field>
                {existing && (
                  <div className="nom-status-inline">
                    <NominationStatusBadge status={existing.status} />
                    <span className="feed-meta">{STATUS_COPY[existing.status].hint}</span>
                  </div>
                )}
              </div>

              {/* Removal is shown FIRST and in full. A nomination that quietly
                  disappears teaches nobody anything and invites a re-file. */}
              {existing?.removal && (
                <div className="nom-decision-note nom-decision-removed">
                  <strong>
                    Removed by the R&amp;R committee
                    {existing.removal.at ? ` · ${formatIstDateTime(existing.removal.at)}` : ''}
                  </strong>
                  <p>{existing.removal.reason}</p>
                </div>
              )}

              {existing?.decision?.note && (
                <div className={`nom-decision-note nom-decision-${existing.status}`}>
                  <strong>Note from {existing.decision.by ?? 'your manager'}</strong>
                  <p>{existing.decision.note}</p>
                </div>
              )}

              {/* The behaviour picker sits above the headline because choosing
                  it changes what you write: the evidence has to be evidence OF
                  that behaviour, not a general account of a good quarter. */}
              <div style={{ marginTop: 16 }}>
                <Field label="Which CHAMP behaviour is this an example of?">
                  <div className="nom-behaviours" role="radiogroup" aria-label="CHAMP behaviour">
                    {behaviours.data?.behaviours.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        role="radio"
                        aria-checked={behaviourId === b.id}
                        disabled={locked}
                        className={`nom-behaviour-option${behaviourId === b.id ? ' selected' : ''}`}
                        style={
                          behaviourId === b.id
                            ? { borderColor: b.colour, boxShadow: `inset 0 0 0 1px ${b.colour}` }
                            : undefined
                        }
                        onClick={() => {
                          setBehaviourId(b.id)
                          setDirty(true)
                          setSaved(null)
                        }}
                      >
                        <span className="nom-behaviour-dot" style={{ background: b.colour }} aria-hidden />
                        {b.name}
                      </button>
                    ))}
                  </div>
                </Field>
                {behaviours.data && behaviours.data.behaviours.length === 0 && (
                  <div className="feed-meta">
                    No CHAMP behaviours are active — an admin needs to enable at least one.
                  </div>
                )}
              </div>

              <div style={{ marginTop: 14 }}>
                <Field label="Headline — what did you do, in one line?">
                  <input
                    className="input"
                    maxLength={140}
                    disabled={locked}
                    placeholder="Cut changeover time on Line 3 from 42 to 18 minutes"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value)
                      setDirty(true)
                      setSaved(null)
                    }}
                  />
                </Field>
              </div>

              <div style={{ marginTop: 14 }}>
                <Field label="Evidence — what you did, what changed, and how you know">
                  <textarea
                    className="textarea"
                    rows={12}
                    disabled={locked}
                    placeholder={
                      'Be concrete and checkable. What was the situation, what did you actually do, ' +
                      'what changed as a result, and what number, document or person can back it up? ' +
                      'Your manager is signing their name to this.'
                    }
                    value={evidence}
                    onChange={(e) => {
                      setEvidence(e.target.value)
                      setDirty(true)
                      setSaved(null)
                    }}
                  />
                </Field>
                <div className="nom-counter">
                  <span className={tooShort || tooLong ? 'nom-counter-bad' : 'nom-counter-ok'}>
                    {evidenceLength.toLocaleString('en-IN')} characters
                  </span>
                  <span className="feed-meta">
                    {tooShort
                      ? `${(limits.minLength - evidenceLength).toLocaleString('en-IN')} more needed (minimum ${limits.minLength})`
                      : tooLong
                        ? `${(evidenceLength - limits.maxLength).toLocaleString('en-IN')} over the ${limits.maxLength} limit`
                        : `within ${limits.minLength}–${limits.maxLength}`}
                  </span>
                </div>
              </div>

              {error && <div className="form-error">{error}</div>}
              {saved && <div className="notice" style={{ marginTop: 12 }}>{saved}</div>}

              <div className="form-actions" style={{ alignItems: 'center' }}>
                {manager && !locked && (
                  <span className="feed-meta">
                    Goes to <strong>{manager.name}</strong> · {manager.function}
                  </span>
                )}
                {/* Only a nomination actually awaiting a decision can be pulled
                    back. A rejected one has nothing left to withdraw from, and
                    approved and removed are both terminal — the server refuses
                    all three, so showing the button would just be a trap. */}
                {existing?.status === 'pending' && (
                  <Button variant="ghost" busy={busy} onClick={() => void withdraw(existing)}>
                    Withdraw
                  </Button>
                )}
                <Button type="submit" variant="primary" busy={busy} disabled={!canSubmit}>
                  {existing && existing.status !== 'withdrawn' ? 'Update & resend' : 'Send for approval'}
                </Button>
              </div>
            </form>
          </Card>
        </div>

        <div>
          <Card title="What makes a nomination land" sub="Your manager has to be able to verify it">
            <ul className="nom-tips">
              <li>
                <strong>Name the change, not the effort.</strong> "Reduced rejections on Line 3 from 4.2% to
                1.1%" beats "worked very hard on quality".
              </li>
              <li>
                <strong>Give one number.</strong> Time saved, defects avoided, cost, tickets closed, uptime —
                whatever your work is actually measured by.
              </li>
              <li>
                <strong>Say who can confirm it.</strong> A colleague, a report, a ticket number. This is the
                part that turns a claim into evidence.
              </li>
              <li>
                <strong>Stay inside the quarter.</strong> Work from earlier quarters belongs to those
                quarters, not this one.
              </li>
              <li>
                <strong>Match the behaviour you picked.</strong> If you claimed INNOVATION, the evidence
                has to be about doing something new — not about working hard on something familiar.
              </li>
            </ul>
          </Card>

          <div style={{ height: 16 }} />

          <Card title="Your history" sub="Every quarter you have filed for">
            {history.length === 0 ? (
              <EmptyState
                icon="🗂️"
                title="Nothing else yet"
                hint="Nominations you file for other quarters will collect here."
              />
            ) : (
              <div className="nom-history">
                {history.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className="nom-history-row"
                    onClick={() => {
                      setQuarterCode(n.quarter.code)
                      setDirty(false)
                      setSaved(null)
                      setError(null)
                    }}
                  >
                    <div className="nom-history-main">
                      <div className="nom-history-quarter">
                        {n.quarter.label}
                        {n.behaviour && <> · {n.behaviour.name}</>}
                      </div>
                      <div className="nom-history-title">{n.title}</div>
                      <div className="feed-meta">Updated {formatIstDateTime(n.updatedAt)}</div>
                    </div>
                    <NominationStatusBadge status={n.status} />
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  )
}
