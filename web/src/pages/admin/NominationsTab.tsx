/**
 * Admin › Nominations — the committee's read-only view of every quarterly
 * self-nomination, and the CSV they shortlist from.
 *
 * Read-only on purpose. Manager approval is the decision; the committee's job
 * is to pick winners from the approved pool, not to overturn a manager who
 * knows the work. (An admin can still override a stuck decision through the
 * API, and that override is audited as one.)
 */
import React, { useMemo, useState } from 'react'
import { api, nominationExportUrl } from '../../api'
import { useApi } from '../../hooks'
import type { NominationStatus } from '../../types'
import { formatIstDateTime } from '../../format'
import { Button, Card, EmptyState, ErrorState, Field, Loading, Pager } from '../../components/ui'
import { NominationStatusBadge } from '../Nominations'

const PAGE_SIZE = 15

const STATUS_TABS: { id: '' | NominationStatus; label: string }[] = [
  { id: 'approved', label: 'Approved' },
  { id: 'pending', label: 'Awaiting manager' },
  { id: 'rejected', label: 'Not approved' },
  { id: 'withdrawn', label: 'Withdrawn' },
  { id: '', label: 'All' },
]

export default function NominationsTab(): React.ReactElement {
  // The committee's default view is the approved pool — that is the set they
  // actually work from; everything else is context.
  const [status, setStatus] = useState<'' | NominationStatus>('approved')
  const [quarter, setQuarter] = useState('')
  const [fn, setFn] = useState('')
  const [site, setSite] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)

  const quarters = useApi(() => api.nominationQuarters(), [])
  const filterOptions = useApi(() => api.feedFilters(), [])

  const filters = useMemo(
    () => ({
      status: status || undefined,
      quarter: quarter || undefined,
      function: fn || undefined,
      site: site || undefined,
      q: q || undefined,
    }),
    [status, quarter, fn, site, q],
  )
  const query = useMemo(() => ({ ...filters, page, pageSize: PAGE_SIZE }), [filters, page])
  const list = useApi(() => api.allNominations(query), [query])

  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => {
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
    <Card
      title="Quarterly self-nominations"
      sub="Filed by employees, approved by their reporting manager. Every export is audited."
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
        <EmptyState
          icon="🗳️"
          title="Nothing matches"
          hint="Try a different quarter or clear the filters."
        />
      ) : (
        list.data && (
          <div className={list.refreshing ? 'refetch-dim' : ''}>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Quarter</th>
                    <th>Employee</th>
                    <th>Headline</th>
                    <th>Manager</th>
                    <th>Status</th>
                    <th>Decided</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((n) => (
                    <React.Fragment key={n.id}>
                      <tr
                        className="nom-row"
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
                        <td>{n.title}</td>
                        <td>{n.manager?.name ?? <span className="feed-meta">—</span>}</td>
                        <td>
                          <NominationStatusBadge status={n.status} audience="committee" />
                        </td>
                        <td className="feed-meta">
                          {n.decision?.at ? formatIstDateTime(n.decision.at) : '—'}
                        </td>
                      </tr>
                      {expanded === n.id && (
                        <tr>
                          <td colSpan={6} className="nom-expand-cell">
                            <div className="nom-evidence">{n.evidence}</div>
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
  )
}
