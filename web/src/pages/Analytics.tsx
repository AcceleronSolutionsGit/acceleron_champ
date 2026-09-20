/**
 * /analytics — committee dashboard (FR-26…FR-31) plus the grade view.
 *
 * One IST date-range filter row scopes every widget below it. Brand navy is
 * the single hue for magnitude; brand red is reserved for attention (dark
 * spots, over-concentration, samples too thin to act on). Behaviour colours
 * appear only on the behaviour breakdown, with names printed beside the bars.
 *
 * The grade section is the one that answers "does recognition travel up, down
 * or sideways" — the matrix shows the shape, the per-grade table shows it
 * per head so a four-person leadership rung can be compared with a forty-
 * person engineering one without the raw counts doing the talking.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { useApi } from '../hooks'
import {
  BehaviourBars,
  ChartCard,
  GIVEN_RECEIVED_LEGEND,
  GivenReceivedBars,
  GradeMatrix,
  MatrixSelection,
  SampleNote,
  SingleHueBars,
  StatTile,
  TrendLine,
  withPctLabels,
} from '../components/charts'
import { Button, Card, EmptyState, ErrorState, Field, Loading, Pager } from '../components/ui'
import { formatIstShortDate, formatNum, formatPct, istDaysAgo, istToday } from '../format'
import { PersonPicker } from './Feed'
import type { DirectionMix, EmployeeSearchHit, GradeAnalysis } from '../types'

const PRESETS = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 7 days', days: 7 },
]

export default function Analytics(): React.ReactElement {
  const [from, setFrom] = useState(istDaysAgo(90))
  const [to, setTo] = useState(istToday())
  const range = useMemo(() => ({ from, to }), [from, to])

  const summary = useApi(() => api.analyticsSummary(range), [range])
  const split = useApi(() => api.analyticsFunctionSite(range), [range])
  const behaviours = useApi(() => api.analyticsBehaviours(range), [range])
  const direction = useApi(() => api.analyticsDirection(range), [range])
  const grades = useApi(() => api.analyticsGrades(range), [range])
  const darkSpots = useApi(() => api.analyticsDarkSpots(range), [range])
  const concentration = useApi(() => api.analyticsConcentration(range), [range])

  const activePresetDays = useMemo(() => {
    if (to !== istToday()) return null
    return PRESETS.find((p) => istDaysAgo(p.days) === from)?.days ?? null
  }, [from, to])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <div className="page-sub">Programme health across offices, functions and grades (IST calendar)</div>
        </div>
      </div>

      {/* One filter row scopes everything below — all widgets share the slice. */}
      <div className="filter-bar">
        {PRESETS.map((p) => (
          <Button
            key={p.days}
            small
            variant={activePresetDays === p.days ? 'primary' : 'ghost'}
            onClick={() => {
              setFrom(istDaysAgo(p.days))
              setTo(istToday())
            }}
          >
            {p.label}
          </Button>
        ))}
        <Field label="From">
          <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </Field>
      </div>

      {/* KPI tiles */}
      {summary.error ? (
        <ErrorState error={summary.error} retry={summary.reload} />
      ) : summary.loading || !summary.data ? (
        <Loading label="Crunching the numbers…" />
      ) : (
        <div className={summary.refreshing ? 'refetch-dim' : ''}>
          <div className="tile-row">
            <StatTile label="Recognitions" value={summary.data.recognitions} />
            <StatTile label="Active employees" value={summary.data.activeEmployees} />
            <StatTile
              label="Gave recognition"
              value={formatPct(summary.data.pctGivers)}
              sub={`${formatNum(summary.data.givers)} people`}
            />
            <StatTile
              label="Received recognition"
              value={formatPct(summary.data.pctReceivers)}
              sub={`${formatNum(summary.data.receivers)} people`}
            />
          </div>

          <div className="chart-grid" style={{ marginBottom: 16 }}>
            <ChartCard
              className="span-2"
              title="Weekly trend"
              sub="Recognitions per IST week (Monday start)"
              table={{
                headers: ['Week starting', 'Recognitions'],
                rows: summary.data.weekly.map((w) => [formatIstShortDate(w.weekStartIst), w.count]),
              }}
            >
              {summary.data.weekly.length === 0 ? (
                <EmptyState title="No activity in this range" />
              ) : (
                <TrendLine
                  data={summary.data.weekly.map((w) => ({ label: formatIstShortDate(w.weekStartIst), count: w.count }))}
                />
              )}
            </ChartCard>
          </div>
        </div>
      )}

      {/* Function & shift split (FR-27 — floor vs office equity) */}
      <div className="chart-grid" style={{ marginBottom: 16 }}>
        {split.error ? (
          <ErrorState error={split.error} retry={split.reload} />
        ) : split.data ? (
          <>
            <ChartCard
              title="By function"
              sub="Given vs received, with giver participation"
              legend={GIVEN_RECEIVED_LEGEND}
              table={{
                headers: ['Function', 'Headcount', 'Given', 'Received', 'Giver participation'],
                rows: split.data.functions.map((f) => [
                  f.name,
                  f.headcount,
                  f.given,
                  f.received,
                  formatPct(f.giverParticipationPct),
                ]),
              }}
            >
              <GivenReceivedBars data={split.data.functions} />
            </ChartCard>
            <ChartCard
              title="By office"
              sub="Is every office getting the same attention, or just the one leadership sits in?"
              legend={GIVEN_RECEIVED_LEGEND}
              table={{
                headers: ['Office', 'Headcount', 'Given', 'Received', 'Giver participation'],
                rows: split.data.sites.map((s) => [
                  s.name,
                  s.headcount,
                  s.given,
                  s.received,
                  formatPct(s.giverParticipationPct),
                ]),
              }}
            >
              <GivenReceivedBars data={split.data.sites} />
            </ChartCard>
          </>
        ) : split.loading ? (
          <Loading />
        ) : null}
      </div>

      {/* Behaviour breakdown (FR-28) + direction mix (FR-29) */}
      <div className="chart-grid" style={{ marginBottom: 16 }}>
        {behaviours.error ? (
          <ErrorState error={behaviours.error} retry={behaviours.reload} />
        ) : behaviours.data ? (
          <ChartCard
            title="Behaviour breakdown"
            sub="Share of recognitions per CHAMP behaviour"
            table={{
              headers: ['Behaviour', 'Count', 'Share'],
              rows: behaviours.data.map((b) => [b.name, b.count, formatPct(b.pct)]),
            }}
          >
            {behaviours.data.length === 0 ? (
              <EmptyState title="No recognitions in this range" />
            ) : (
              <BehaviourBars
                data={withPctLabels(
                  behaviours.data.map((b) => ({ name: b.name, colour: b.colour, count: b.count, pct: b.pct })),
                )}
                showPct
              />
            )}
          </ChartCard>
        ) : behaviours.loading ? (
          <Loading />
        ) : null}

        {direction.error ? (
          <ErrorState error={direction.error} retry={direction.reload} />
        ) : direction.data ? (
          <DirectionCard mix={direction.data} />
        ) : direction.loading ? (
          <Loading />
        ) : null}
      </div>

      {/* Grade flow — the junior/senior picture */}
      {grades.error ? (
        <ErrorState error={grades.error} retry={grades.reload} />
      ) : grades.data ? (
        <GradeSection data={grades.data} range={range} />
      ) : grades.loading ? (
        <Loading label="Reading the grade ladder…" />
      ) : null}

      {/* Dark spots (FR-30) */}
      <div style={{ marginBottom: 16 }}>
        {darkSpots.error ? (
          <ErrorState error={darkSpots.error} retry={darkSpots.reload} />
        ) : darkSpots.data ? (
          <Card
            title="Dark spots"
            sub="Squads and offices the programme isn't reaching — zero-activity groups highlighted"
          >
            {darkSpots.data.length === 0 ? (
              <EmptyState icon="✅" title="No dark spots" hint="Every group shows recognition activity in this range." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Group</th>
                      <th>Type</th>
                      <th>Site</th>
                      <th className="num">Headcount</th>
                      <th className="num">Given</th>
                      <th className="num">Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {darkSpots.data.map((row, i) => (
                      <tr key={`${row.dimension}-${row.name}-${i}`} className={row.given + row.received === 0 ? 'row-zero' : ''}>
                        <td>
                          <strong>{row.name}</strong>
                        </td>
                        <td>
                          <span className="badge badge-neutral">{row.dimension.replace('_', ' ')}</span>
                        </td>
                        <td>{row.site ?? '—'}</td>
                        <td className="num">{row.headcount}</td>
                        <td className="num">{row.given}</td>
                        <td className="num">{row.received}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ) : darkSpots.loading ? (
          <Loading />
        ) : null}
      </div>

      {/* Concentration (FR-31) */}
      {concentration.error ? (
        <ErrorState error={concentration.error} retry={concentration.reload} />
      ) : concentration.data ? (
        <>
          <div className="tile-row">
            <StatTile label="Unique givers" value={concentration.data.uniqueGivers} />
            <StatTile label="Unique recipients" value={concentration.data.uniqueRecipients} />
            <StatTile
              label="Top 10% giver share"
              value={formatPct(concentration.data.top10PctGiverShare)}
              sub="Share of all recognitions given by the most active tenth of givers"
            />
          </div>
          <div className="chart-grid">
            <ConcentrationTable title="Top givers" rows={concentration.data.topGivers} />
            <ConcentrationTable title="Top recipients" rows={concentration.data.topRecipients} />
          </div>
        </>
      ) : concentration.loading ? (
        <Loading />
      ) : null}
    </>
  )
}

/**
 * Direction of recognition (FR-29).
 *
 * The seniority split is computed on rows where BOTH grades are on the
 * DarwinBox ladder, and says so — recognitions involving an unmapped grade
 * are counted separately rather than folded into "peer to peer", which is how
 * this number used to read 100% peer on live data.
 */
function DirectionCard({ mix }: { mix: DirectionMix }): React.ReactElement {
  const seniority = [
    { name: 'Peer to peer', count: mix.peer },
    { name: 'Junior → senior', count: mix.juniorToSenior },
    { name: 'Senior → junior', count: mix.seniorToJunior },
  ]
  const fn = [
    { name: 'Same function', count: mix.sameFunction },
    { name: 'Cross-function', count: mix.crossFunction },
  ]
  const share = (n: number, whole: number) => (whole > 0 ? ` (${formatPct((n / whole) * 100)})` : '')
  return (
    <ChartCard
      title="Direction of recognition"
      sub="Which way it travels — by seniority, and across function boundaries"
      table={{
        headers: ['Direction', 'Count'],
        rows: [
          ...seniority.map((r) => [r.name, r.count] as (string | number)[]),
          ['Grade not mapped', mix.unknownGrade],
          ...fn.map((r) => [r.name, r.count] as (string | number)[]),
        ],
      }}
    >
      <SingleHueBars
        data={seniority.map((r) => ({
          ...r,
          label: `${formatNum(r.count)}${share(r.count, mix.ranked)}`,
        }))}
      />
      <SampleNote n={mix.ranked} what="graded recognitions" />
      {mix.unknownGrade > 0 && (
        <div className="sample-note thin" style={{ marginTop: 6 }}>
          <strong>{formatNum(mix.unknownGrade)}</strong> of {formatNum(mix.total)} recognitions are
          excluded from the split because a grade is not on the ladder
          {mix.unmappedGrades.length > 0 && <> ({mix.unmappedGrades.join(', ')})</>}. Fix the grade
          in DarwinBox, or add the rung in <code>server/src/modules/grades.ts</code>.
        </div>
      )}
      <div className="card-sub" style={{ margin: '14px 0 2px' }}>
        Function boundaries
      </div>
      <SingleHueBars
        data={fn.map((r) => ({ ...r, label: `${formatNum(r.count)}${share(r.count, mix.total)}` }))}
      />
    </ChartCard>
  )
}

/**
 * The grade section.
 *
 * Two halves that answer different questions. The matrix answers "what shape
 * is the flow" — mass below the diagonal is recognition travelling down the
 * organisation. The table answers "is that just because there are more of
 * them", which is why it leads on per-head rates rather than counts.
 */
function GradeSection({
  data,
  range,
}: {
  data: GradeAnalysis
  range: { from: string; to: string }
}): React.ReactElement {
  const [selection, setSelection] = useState<MatrixSelection>({})
  // Only rungs that are on the ladder can be placed in seniority order, so
  // only those form the matrix axes. Unmapped grades still appear in the
  // table below, where they are a directory problem to go and fix.
  const ladder = data.grades.filter((g) => g.tier !== null).map((g) => g.grade)
  const unmapped = data.grades.filter((g) => g.tier === null)

  return (
    <>
      <div className="chart-grid" style={{ marginBottom: 16 }}>
        <ChartCard
          className="span-2"
          title="Who recognises whom, by grade"
          sub="Rows are the giver's grade, columns the recipient's, both junior → senior. Below the diagonal is downward recognition; above it is upward."
          table={{
            headers: ['Giver grade', 'Recipient grade', 'Count', "Share of giver's row"],
            rows: data.matrix.map((c) => [
              c.giverGrade,
              c.recipientGrade,
              c.count,
              formatPct(c.pctOfGiverRow),
            ]),
          }}
        >
          <GradeMatrix
            grades={ladder}
            cells={data.matrix}
            selection={selection}
            onSelect={setSelection}
          />
          <SampleNote n={data.ranked} what="recognitions between mapped grades" />
        </ChartCard>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Card
          title="Participation by grade"
          sub="Per-head rates, not raw counts — a four-person leadership rung and a forty-person engineering one are otherwise not comparable"
        >
          {data.grades.length === 0 ? (
            <EmptyState title="No employees in the directory" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Grade</th>
                    <th className="num">Tier</th>
                    <th className="num">Headcount</th>
                    <th className="num">Given</th>
                    <th className="num">Given / head</th>
                    <th className="num">Received</th>
                    <th className="num">Received / head</th>
                    <th className="num">Gave at least once</th>
                    <th className="num">Received at least once</th>
                  </tr>
                </thead>
                <tbody>
                  {data.grades.map((g) => (
                    <tr key={g.grade} className={g.tier === null ? 'row-zero' : undefined}>
                      <td>
                        <strong>{g.grade}</strong>
                        {g.tier === null && (
                          <span className="badge badge-neutral" style={{ marginLeft: 8 }}>
                            not on ladder
                          </span>
                        )}
                      </td>
                      <td className="num">{g.tier ?? '—'}</td>
                      <td className="num">{g.headcount}</td>
                      <td className="num">{g.given}</td>
                      <td className="num">{g.givenPerHead}</td>
                      <td className="num">{g.received}</td>
                      <td className="num">{g.receivedPerHead}</td>
                      <td className="num">{formatPct(g.giverParticipationPct)}</td>
                      <td className="num">{formatPct(g.receiverCoveragePct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {unmapped.length > 0 && (
            <div className="sample-note thin" style={{ marginTop: 10 }}>
              <strong>{unmapped.length}</strong>{' '}
              {unmapped.length === 1 ? 'grade is' : 'grades are'} not on the seniority ladder
              ({unmapped.map((g) => g.grade).join(', ')}), so the people on{' '}
              {unmapped.length === 1 ? 'it' : 'them'} are left out of the matrix and the
              junior/senior split.
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginBottom: 16 }}>
        <GradeFlowPanel
          range={range}
          selection={selection}
          onSelectionChange={setSelection}
          ladder={ladder}
        />
      </div>
    </>
  )
}

function ConcentrationTable({
  title,
  rows,
}: {
  title: string
  rows: { id: number; name: string; function: string; site: string; count: number; pctOfTotal: number }[]
}): React.ReactElement {
  return (
    <Card title={title} sub="Top 10 in the selected range">
      {rows.length === 0 ? (
        <EmptyState title="No data in this range" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Function · site</th>
                <th className="num">Count</th>
                <th className="num">Share</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/people/${r.id}`}>{r.name}</Link>
                  </td>
                  <td>
                    {r.function} · {r.site}
                  </td>
                  <td className="num">{r.count}</td>
                  <td className="num">{formatPct(r.pctOfTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

/**
 * Who → whom, behind the matrix.
 *
 * Opens on a matrix click and can also be driven from its own filter row, so
 * "everything this one person gave, upward" is reachable without going
 * through the grid. Two tables rather than one: the pair roll-up says whether
 * a cell is a pattern or a single relationship, and the recognitions
 * underneath are the evidence for it.
 */
function GradeFlowPanel({
  range,
  selection,
  onSelectionChange,
  ladder,
}: {
  range: { from: string; to: string }
  selection: MatrixSelection
  onSelectionChange: (sel: MatrixSelection) => void
  ladder: string[]
}): React.ReactElement {
  const [direction, setDirection] = useState<'' | 'upward' | 'downward' | 'peer'>('')
  const [person, setPerson] = useState<EmployeeSearchHit | null>(null)
  const [page, setPage] = useState(1)

  // Any change to what is being asked for starts again at page 1 — otherwise
  // a narrower filter lands the reader on an empty page 3.
  useEffect(() => {
    setPage(1)
  }, [selection.giverGrade, selection.recipientGrade, direction, person, range])

  const query = useMemo(
    () => ({
      ...range,
      giverGrade: selection.giverGrade || undefined,
      recipientGrade: selection.recipientGrade || undefined,
      direction: direction || undefined,
      personId: person?.id,
      page,
      pageSize: 15,
    }),
    [range, selection.giverGrade, selection.recipientGrade, direction, person, page],
  )
  const flow = useApi(() => api.analyticsGradeFlow(query), [query])

  const filtered =
    selection.giverGrade !== undefined ||
    selection.recipientGrade !== undefined ||
    direction !== '' ||
    person !== null

  const what = (): string => {
    const g = selection.giverGrade
    const r = selection.recipientGrade
    if (g && r) return `${g} → ${r}`
    if (g) return `Everything ${g} gave`
    if (r) return `Everything ${r} received`
    if (direction === 'upward') return 'Junior → senior'
    if (direction === 'downward') return 'Senior → junior'
    if (direction === 'peer') return 'Peer to peer'
    return 'Everyone'
  }

  const clearAll = () => {
    onSelectionChange({})
    setDirection('')
    setPerson(null)
  }

  return (
    <Card
      title="Who recognised whom"
      sub="The people behind the grades — click a cell, row or column above, or filter here"
    >
      <div className="filter-bar" style={{ marginBottom: 14 }}>
        <Field label="Giver grade">
          <select
            className="select"
            value={selection.giverGrade ?? ''}
            onChange={(e) =>
              onSelectionChange({ ...selection, giverGrade: e.target.value || undefined })
            }
          >
            <option value="">Any grade</option>
            {ladder.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Recipient grade">
          <select
            className="select"
            value={selection.recipientGrade ?? ''}
            onChange={(e) =>
              onSelectionChange({ ...selection, recipientGrade: e.target.value || undefined })
            }
          >
            <option value="">Any grade</option>
            {ladder.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Direction">
          <select
            className="select"
            value={direction}
            onChange={(e) => setDirection(e.target.value as typeof direction)}
          >
            <option value="">Any direction</option>
            <option value="upward">Junior → senior</option>
            <option value="downward">Senior → junior</option>
            <option value="peer">Peer to peer</option>
          </select>
        </Field>
        <Field label="Person (either side)" grow>
          <PersonPicker value={person} onChange={setPerson} />
        </Field>
        {filtered && (
          <Button small variant="ghost" onClick={clearAll}>
            Clear
          </Button>
        )}
      </div>

      {flow.error ? (
        <ErrorState error={flow.error} retry={flow.reload} />
      ) : flow.loading || !flow.data ? (
        <Loading />
      ) : flow.data.total === 0 ? (
        <EmptyState
          title="Nothing matches this slice"
          hint="Try a wider date range, or clear one of the filters."
        />
      ) : (
        <div className={flow.refreshing ? 'refetch-dim' : ''}>
          <div className="flow-head">
            <span className="flow-what">{what()}</span>
            <span className="flow-count">
              {formatNum(flow.data.total)}{' '}
              {flow.data.total === 1 ? 'recognition' : 'recognitions'} &middot;{' '}
              {formatNum(flow.data.pairs.length)}{' '}
              {flow.data.pairs.length === 1 ? 'pair of people' : 'pairs of people'}
            </span>
          </div>

          <div className="card-sub" style={{ margin: '14px 0 6px' }}>
            Most frequent pairs
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Giver</th>
                  <th>Recipient</th>
                  <th className="num">Times</th>
                </tr>
              </thead>
              <tbody>
                {flow.data.pairs.slice(0, 10).map((p) => (
                  <tr key={`${p.giver.id}-${p.recipient.id}`}>
                    <td>
                      <Link to={`/people/${p.giver.id}`}>{p.giver.name}</Link>
                      <span className="flow-meta">
                        {p.giver.grade} &middot; {p.giver.function}
                      </span>
                    </td>
                    <td>
                      <Link to={`/people/${p.recipient.id}`}>{p.recipient.name}</Link>
                      <span className="flow-meta">
                        {p.recipient.grade} &middot; {p.recipient.function}
                      </span>
                    </td>
                    <td className="num">{p.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card-sub" style={{ margin: '18px 0 6px' }}>
            The recognitions
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Giver</th>
                  <th>Recipient</th>
                  <th>Direction</th>
                  <th>Behaviour</th>
                  <th>What they did</th>
                </tr>
              </thead>
              <tbody>
                {flow.data.items.map((it) => (
                  <tr key={it.id}>
                    <td className="flow-when">{formatIstShortDate(it.createdAt)}</td>
                    <td>
                      <Link to={`/people/${it.giver.id}`}>{it.giver.name}</Link>
                      <span className="flow-meta">{it.giver.grade}</span>
                    </td>
                    <td>
                      <Link to={`/people/${it.recipient.id}`}>{it.recipient.name}</Link>
                      <span className="flow-meta">{it.recipient.grade}</span>
                    </td>
                    {/* Direction is a property of the PAIR, not of the recipient.
                        Sitting under the recipient's grade it read as "this
                        person's grade is unmapped", which blamed the wrong half
                        of a row where both sides were equally unmapped. */}
                    <td>
                      <span className={`flow-dir ${it.direction}`}>
                        {it.direction === 'upward'
                          ? '↑ junior → senior'
                          : it.direction === 'downward'
                            ? '↓ senior → junior'
                            : it.direction === 'peer'
                              ? '→ peer'
                              : '? grades not mapped'}
                      </span>
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          borderColor: it.behaviour.colour,
                          color: it.behaviour.colour,
                          background: '#fff',
                        }}
                      >
                        {it.behaviour.name}
                      </span>
                    </td>
                    <td className="flow-reason">{it.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            page={flow.data.page}
            pageSize={flow.data.pageSize}
            total={flow.data.total}
            onPage={setPage}
          />
        </div>
      )}
    </Card>
  )
}
