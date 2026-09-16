/**
 * Admin › Nominations — the committee's view of every quarterly
 * self-nomination, the CSV they shortlist from, and the one thing they can
 * change: striking a nomination from the pool.
 *
 * Removal is the ONLY mutation here. The committee does not overturn a manager
 * who knows the work — approve/decline stays with the reporting line. What the
 * committee owns is the integrity of the pool they shortlist from, so they can
 * remove an entry (duplicate, wrong quarter, plagiarised, inappropriate) with a
 * written reason the employee sees. Removal is terminal for that quarter; there
 * is no restore, and a mistaken one is corrected by HR, not by re-filing.
 */
import React, { useMemo, useState } from 'react'
import { api, ApiError, nominationExportUrl } from '../../api'
import { useApi } from '../../hooks'
import type { NominationItem, NominationStatus } from '../../types'
import { formatIstDateTime } from '../../format'
import {
  BehaviourChip,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Loading,
  Modal,
  Pager,
} from '../../components/ui'
import { NominationStatusBadge } from '../Nominations'

const PAGE_SIZE = 15

/** Mirrors the server's REMOVAL_REASON_MIN_LENGTH — the server is the gate. */
const REASON_MIN = 15

const STATUS_TABS: { id: '' | NominationStatus; label: string }[] = [
  { id: 'approved', label: 'Approved' },
  { id: 'pending', label: 'Awaiting manager' },
  { id: 'rejected', label: 'Not approved' },
  { id: 'withdrawn', label: 'Withdrawn' },
  { id: 'removed', label: 'Removed' },
  { id: '', label: 'All' },
]

export default function NominationsTab(): React.ReactElement {
  // The committee's default view is the approved pool — that is the set they
  // actually work from; everything else is context.
  const [status, setStatus] = useState<'' | NominationStatus>('approved')
  const [quarter, setQuarter] = useState('')
  const [behaviourId, setBehaviourId] = useState('')
  const [fn, setFn] = useState('')
  const [site, setSite] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [removing, setRemoving] = useState<NominationItem | null>(null)

  const quarters = useApi(() => api.nominationQuarters(), [])
  const filterOptions = useApi(() => api.feedFilters(), [])

  const filters = useMemo(
    () => ({
      status: status || undefined,
      quarter: quarter || undefined,
      behaviourId: behaviourId || undefined,
      function: fn || undefined,
      site: site || undefined,
      q: q || undefined,
    }),
    [status, quarter, behaviourId, fn, site, q],
  )
  const query = useMemo(() => ({ ...filters, page, pageSize: PAGE_SIZE }), [filters, page])
  const list = useApi(() => api.allNominations(query), [query])

  const resetPage =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v)
      setPage(1)
    }

  const download = () => {
    const a = document.createElement('a')
    a.href = nominationExportUrl(filters)
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <>
      <Card
        title="Quarterly self-nominations"
        sub="Filed by employees against a CHAMP behaviour, approved by their reporting manager. Every removal and export is audited."
        actions={
          <Button small variant="primary" onClick={download}>
            📄 Export CSV
          </Button>
        }
      >
        <div className="tab-bar" role="tablist" style={{ marginBottom: 14 }}>
          {STATUS_TABS.map((t) => (
            <button
              key={t.id || 'all'}
              role="tab"
              aria-selected={t.id === status}
              className={`tab-btn ${t.id === status ? 'active' : ''}`}
              onClick={() => resetPage(setStatus)(t.id)}
            >
              {t.label}
              {t.id && list.data?.counts && (
                <span className="nom-tab-count">{list.data.counts[t.id as NominationStatus] ?? 0}</span>
              )}
            </button>
          ))}
        </div>

        <div className="filter-bar" style={{ boxShadow: 'none', marginBottom: 12 }}>
          <Field label="Search" grow>
            <input
              className="input"
              placeholder="Name, headline or evidence…"
              value={q}
              onChange={(e) => resetPage(setQ)(e.target.value)}
            />
          </Field>
          <Field label="Quarter">
            <select className="select" value={quarter} onChange={(e) => resetPage(setQuarter)(e.target.value)}>
              <option value="">All quarters</option>
              {quarters.data?.recent.map((qtr) => (
                <option key={qtr.code} value={qtr.code}>
                  {qtr.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Behaviour">
            <select
              className="select"
              value={behaviourId}
              onChange={(e) => resetPage(setBehaviourId)(e.target.value)}
            >
              <option value="">All</option>
              {filterOptions.data?.behaviours.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Function">
            <select className="select" value={fn} onChange={(e) => resetPage(setFn)(e.target.value)}>
              <option value="">All</option>
              {filterOptions.data?.functions.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Site">
            <select className="select" value={site} onChange={(e) => resetPage(setSite)(e.target.value)}>
              <option value="">All</option>
              {filterOptions.data?.sites.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {list.loading && !list.data ? (
          <Loading label="Loading nominations…" />
        ) : list.error ? (
          <ErrorState error={list.error} retry={list.reload} />
        ) : list.data && list.data.items.length === 0 ? (
          <EmptyState icon="🗳️" title="Nothing matches" hint="Try a different quarter or clear the filters." />
        ) : (
          list.data && (
            <div className={list.refreshing ? 'refetch-dim' : ''}>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Quarter</th>
                      <th>Employee</th>
                      <th>Behaviour</th>
                      <th>Headline</th>
                      <th>Manager</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((n) => (
                      <React.Fragment key={n.id}>
                        <tr
                          className={`nom-row${n.status === 'removed' ? ' row-dim' : ''}`}
                          onClick={() => setExpanded(expanded === n.id ? null : n.id)}
                          title="Click to read the evidence"
                        >
                          <td className="mono">{n.quarter.label}</td>
                          <td>
                            <strong>{n.employee.name}</strong>
                            <div className="feed-meta">
                              {n.employee.function} · {n.employee.site}
                            </div>
                          </td>
                          <td>
                            {n.behaviour ? (
                              <BehaviourChip name={n.behaviour.name} colour={n.behaviour.colour} />
                            ) : (
                              <span className="feed-meta">—</span>
                            )}
                          </td>
                          <td>{n.title}</td>
                          <td>{n.manager?.name ?? <span className="feed-meta">—</span>}</td>
                          <td>
                            <NominationStatusBadge status={n.status} audience="committee" />
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {n.status !== 'removed' && (
                              <Button variant="danger" small onClick={() => setRemoving(n)}>
                                Remove
                              </Button>
                            )}
                          </td>
                        </tr>
                        {expanded === n.id && (
                          <tr>
                            <td colSpan={7} className="nom-expand-cell">
                              <div className="nom-evidence">{n.evidence}</div>
                              {n.removal && (
                                <div className="nom-decision-note nom-decision-removed">
                                  <strong>
                                    Removed by {n.removal.by}
                                    {n.removal.at ? ` · ${formatIstDateTime(n.removal.at)}` : ''}
                                  </strong>
                                  <p>{n.removal.reason}</p>
                                </div>
                              )}
                              {n.decision?.note && (
                                <div className={`nom-decision-note nom-decision-${n.status}`}>
                                  <strong>Manager’s note — {n.decision.by}</strong>
                                  <p>{n.decision.note}</p>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                page={list.data.page}
                pageSize={list.data.pageSize}
                total={list.data.total}
                onPage={setPage}
              />
            </div>
          )
        )}
      </Card>

      {removing && (
        <RemoveModal
          item={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null)
            list.reload()
          }}
        />
      )}
    </>
  )
}

function RemoveModal({
  item,
  onClose,
  onDone,
}: {
  item: NominationItem
  onClose: () => void
  onDone: () => void
}): React.ReactElement {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const short = reason.trim().length < REASON_MIN

  const confirm = async () => {
    if (short) {
      setError(`Please give a reason of at least ${REASON_MIN} characters — ${item.employee.name} sees it.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.removeNomination(item.id, reason)
      onDone()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that nomination')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Remove ${item.employee.name}'s nomination`} onClose={onClose}>
      <p className="feed-meta" style={{ marginTop: 0 }}>
        {item.quarter.label}
        {item.behaviour ? ` · ${item.behaviour.name}` : ''} · {item.title}
      </p>

      {/* Say plainly what this does before they do it — there is no undo, and
          striking an approved nomination overrides a manager's judgement. */}
      <div className="notice notice-error" style={{ marginBottom: 14 }}>
        <strong>This cannot be undone.</strong> {item.employee.name} will see that it was removed, and will
        read the reason below word for word. {item.quarter.label} then closes to them — they cannot file
        again for that quarter.
        {item.status === 'approved' && ' Their manager has already approved this nomination.'}
      </div>

      <Field label={`Reason (required — ${item.employee.name} sees this)`}>
        <textarea
          className="textarea nom-note-textarea"
          rows={5}
          autoFocus
          maxLength={1000}
          placeholder="e.g. Duplicate of the Q1 nomination for the same project — kept the earlier one."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <div className="nom-counter">
        <span className={short ? 'nom-counter-bad' : 'nom-counter-ok'}>
          {reason.trim().length} characters
        </span>
        {short && <span className="feed-meta">at least {REASON_MIN}</span>}
      </div>

      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" busy={busy} disabled={short} onClick={() => void confirm()}>
          Remove from the pool
        </Button>
      </div>
    </Modal>
  )
}
