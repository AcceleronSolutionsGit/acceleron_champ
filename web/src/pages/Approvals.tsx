/**
 * /approvals — the reporting manager's queue.
 *
 * Who sees what here is decided by the directory, not by a role: the server
 * returns exactly the nominations filed by people whose `manager_id` is the
 * signed-in user. Nobody grants or revokes "manager" — the DarwinBox sync does
 * it every night by maintaining the reporting line.
 *
 * Evidence is shown in full, never truncated. A manager approving a paragraph
 * they only saw the first line of is the one failure mode this screen exists to
 * prevent.
 */
import React, { useState } from 'react'
import { api, ApiError } from '../api'
import { useApi } from '../hooks'
import type { NominationItem, NominationStatus } from '../types'
import { formatIstDateTime, timeAgo } from '../format'
import { Button, Card, EmptyState, ErrorState, Field, Loading, Modal } from '../components/ui'
import { NominationStatusBadge } from './Nominations'

type Filter = 'pending' | 'approved' | 'rejected' | 'all'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'pending', label: 'Awaiting you' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Not approved' },
  { id: 'all', label: 'Everything' },
]

export default function Approvals(): React.ReactElement {
  const [filter, setFilter] = useState<Filter>('pending')
  const queue = useApi(() => api.approvalQueue(filter), [filter])
  const [deciding, setDeciding] = useState<{ item: NominationItem; decision: 'approved' | 'rejected' } | null>(
    null,
  )

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Nomination approvals</h1>
          <div className="page-sub">
            Quarterly self-nominations from your direct reports. Your decision is final — approved
            nominations go straight to the R&amp;R committee.
          </div>
        </div>
      </div>

      <div className="tab-bar" role="tablist" style={{ marginBottom: 16 }}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            role="tab"
            aria-selected={f.id === filter}
            className={`tab-btn ${f.id === filter ? 'active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
            {f.id === 'pending' && queue.data && filter === 'pending' && queue.data.length > 0 && (
              <span className="nom-tab-count">{queue.data.length}</span>
            )}
          </button>
        ))}
      </div>

      {queue.loading && !queue.data ? (
        <Loading label="Loading your queue…" />
      ) : queue.error ? (
        <ErrorState error={queue.error} retry={queue.reload} />
      ) : !queue.data || queue.data.length === 0 ? (
        <EmptyState
          icon={filter === 'pending' ? '✅' : '🗂️'}
          title={filter === 'pending' ? 'Nothing waiting on you' : 'Nothing here yet'}
          hint={
            filter === 'pending'
              ? 'When one of your reports files a quarterly nomination, it lands here.'
              : 'Nominations you have decided on will show up under these tabs.'
          }
        />
      ) : (
        <div className={queue.refreshing ? 'refetch-dim' : ''}>
          {queue.data.map((item) => (
            <NominationCard
              key={item.id}
              item={item}
              onDecide={(decision) => setDeciding({ item, decision })}
            />
          ))}
        </div>
      )}

      {deciding && (
        <DecisionModal
          item={deciding.item}
          decision={deciding.decision}
          onClose={() => setDeciding(null)}
          onDone={() => {
            setDeciding(null)
            queue.reload()
            // Refresh the nav badge without a full page reload.
            window.dispatchEvent(new CustomEvent('champ:approvals-changed'))
          }}
        />
      )}
    </>
  )
}

function NominationCard({
  item,
  onDecide,
}: {
  item: NominationItem
  onDecide: (decision: 'approved' | 'rejected') => void
}): React.ReactElement {
  const pending = item.status === 'pending'
  return (
    <Card className="nom-card">
      <div className="nom-card-head">
        <div className="nom-card-who">
          <div className="user-avatar-small">{item.employee.name.charAt(0).toUpperCase()}</div>
          <div>
            <div className="nom-card-name">
              {item.employee.name}
              {item.employee.employeeCode && <span className="mono"> · {item.employee.employeeCode}</span>}
            </div>
            <div className="feed-meta">
              {item.employee.function} · {item.employee.site}
              {item.employee.levelGrade ? ` · ${item.employee.levelGrade}` : ''}
            </div>
          </div>
        </div>
        <div className="nom-card-meta">
          <span className="chip">{item.quarter.label}</span>
          <NominationStatusBadge status={item.status} audience="manager" />
        </div>
      </div>

      <h3 className="nom-card-title">{item.title}</h3>
      {/* Full text, deliberately. Deciding on a summary is not deciding. */}
      <div className="nom-evidence">{item.evidence}</div>

      <div className="nom-card-foot">
        <span className="feed-meta">
          Submitted {timeAgo(item.createdAt)}
          {item.updatedAt !== item.createdAt && ` · last edited ${timeAgo(item.updatedAt)}`}
          {' · covering '}
          {item.quarter.months}
        </span>
        {pending ? (
          <div className="flag-actions">
            <Button variant="danger" small onClick={() => onDecide('rejected')}>
              Decline
            </Button>
            {/* Approve must not look like Decline. The theme's primary IS the
                brand red, which is also the danger colour, so approve gets its
                own navy treatment rather than reusing a variant. */}
            <Button variant="primary" small className="btn-approve" onClick={() => onDecide('approved')}>
              Approve
            </Button>
          </div>
        ) : (
          item.decision && (
            <span className="feed-meta">
              {item.status === 'approved' ? 'Approved' : 'Declined'} by {item.decision.by} ·{' '}
              {item.decision.at ? formatIstDateTime(item.decision.at) : ''}
            </span>
          )
        )}
      </div>

      {item.decision?.note && (
        <div className={`nom-decision-note nom-decision-${item.status}`}>
          <strong>Your note</strong>
          <p>{item.decision.note}</p>
        </div>
      )}
    </Card>
  )
}

function DecisionModal({
  item,
  decision,
  onClose,
  onDone,
}: {
  item: NominationItem
  decision: 'approved' | 'rejected'
  onClose: () => void
  onDone: () => void
}): React.ReactElement {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rejecting = decision === 'rejected'

  const confirm = async () => {
    // A rejection without a reason leaves the employee nothing to rework, and
    // they can resubmit — so the note is required on this branch only.
    if (rejecting && note.trim().length < 10) {
      setError('Please say why, in a sentence — they can rework it and send it back to you.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.decideNomination(item.id, decision, note)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record your decision')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={rejecting ? `Decline ${item.employee.name}'s nomination` : `Approve ${item.employee.name}'s nomination`}
      onClose={onClose}
    >
      <p className="feed-meta" style={{ marginTop: 0 }}>
        {item.quarter.label} · {item.title}
      </p>
      <Field label={rejecting ? 'Why not? (required — they will see this)' : 'Note for the record (optional)'}>
        <textarea
          className="textarea nom-note-textarea"
          rows={5}
          autoFocus
          maxLength={1000}
          placeholder={
            rejecting
              ? 'What is missing, and what would make this land? Be specific enough that they can fix it.'
              : 'Anything the committee should know when they read this.'
          }
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant={rejecting ? 'danger' : 'primary'}
          className={rejecting ? undefined : 'btn-approve'}
          busy={busy}
          onClick={() => void confirm()}
        >
          {rejecting ? 'Decline nomination' : 'Approve nomination'}
        </Button>
      </div>
    </Modal>
  )
}

/** Exported so the nav badge and this page agree on what "waiting" means. */
export type ApprovalFilter = NominationStatus | 'all'
