/**
 * Shared chart pieces (recharts) following the dataviz design brief (SPEC §6),
 * on the Acceleron brand palette:
 *
 *  - magnitude is a single hue — the brand navy #212f60 — with a validated
 *    lighter step #6478ad joining it for two-series given/received bars (one
 *    hue, two shades, so the pair reads as one measure split in two);
 *  - the brand red #de1e24 is NOT a series colour. It is reserved for
 *    attention: a zero-activity dark spot, an over-concentrated giver share,
 *    a sample too small to draw a conclusion from. Using it for an ordinary
 *    bar would spend the one colour the eye has been trained to stop at;
 *  - behaviour colours appear ONLY on behaviour charts, and identity is never
 *    colour-alone there: the behaviour NAME is always printed on the axis and
 *    counts ride the bar ends (the seeded DB palette's adjacent-CVD spread is
 *    below the standalone-categorical floor, so labels are the identity channel);
 *  - light solid hairline grid, thin marks with rounded data-ends, no legends
 *    where direct labels do the work, plain number formatting;
 *  - every chart card can carry a "View data" table twin so no value is
 *    gated behind hover.
 */
import React from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatNum, formatPct } from '../format'

/** Brand navy — the single hue every magnitude chart is drawn in. */
export const CHART_NAVY = '#212f60'
/** One step lighter, for the second series in a two-series pair. */
export const CHART_NAVY_LIGHT = '#6478ad'
/** Brand red. Attention only — never an ordinary series. */
export const CHART_ALERT = '#de1e24'
export const CHART_GRID = '#e5e8f0'
export const CHART_TEXT = '#64748b'
export const CHART_INK = '#0f172a'

/**
 * Sequential navy ramp for the grade matrix, lightest to darkest.
 *
 * A heatmap needs ordered steps rather than distinct colours — the question a
 * reader asks of a cell is "more or less than its neighbour", which is a
 * magnitude question. Five steps is as many as stays distinguishable on a
 * projector.
 */
export const NAVY_RAMP = ['#eef1f8', '#c9d2e7', '#94a4cd', '#5c6fa8', '#212f60'] as const

/** @deprecated brand palette — kept so older imports keep compiling. */
export const CHART_GREEN = CHART_NAVY
/** @deprecated brand palette — kept so older imports keep compiling. */
export const CHART_GREEN_LIGHT = CHART_NAVY_LIGHT

const AXIS_TICK = { fill: CHART_TEXT, fontSize: 12 }
const AXIS_LINE = { stroke: CHART_GRID }

// ── Card wrapper with optional legend + table twin ──────────────────────────

export function ChartCard({
  title,
  sub,
  legend,
  table,
  children,
  className,
}: {
  title: string
  sub?: string
  legend?: { label: string; colour: string }[]
  /** Accessible twin of the plotted values — renders as a collapsed table. */
  table?: { headers: string[]; rows: (string | number)[][] }
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <section className={`card card-pad${className ? ` ${className}` : ''}`}>
      <div className="card-title">
        <div>
          <h2>{title}</h2>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
      </div>
      {legend && legend.length > 1 && (
        <div className="chart-legend">
          {legend.map((l) => (
            <span key={l.label}>
              <span className="legend-swatch" style={{ background: l.colour }} aria-hidden />
              {l.label}
            </span>
          ))}
        </div>
      )}
      {children}
      {table && (
        <details className="chart-data">
          <summary>View data</summary>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {table.headers.map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j} className={typeof cell === 'number' ? 'num' : undefined}>
                        {typeof cell === 'number' ? formatNum(cell) : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  )
}

// ── Tooltip ──────────────────────────────────────────────────────────────────

interface TipEntry {
  name?: string | number
  value?: string | number | (string | number)[]
  color?: string
}

/** Minimal tooltip: value leads, series key is a short colour stroke. */
export function ChartTip(props: {
  active?: boolean
  label?: string | number
  payload?: TipEntry[]
}): React.ReactElement | null {
  const { active, label, payload } = props
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="chart-tip">
      {label !== undefined && label !== '' && <div className="tip-label">{String(label)}</div>}
      {payload.map((entry, i) => (
        <div className="tip-row" key={i}>
          <span className="tip-key" style={{ background: entry.color ?? CHART_NAVY }} aria-hidden />
          <span className="tip-value">{formatNum(Number(entry.value ?? 0))}</span>
          {entry.name !== undefined && <span>{String(entry.name)}</span>}
        </div>
      ))}
    </div>
  )
}

const HOVER_CURSOR = { fill: 'rgba(33, 47, 96, 0.06)' }

// ── Weekly trend line ────────────────────────────────────────────────────────

export function TrendLine({
  data,
  name = 'Recognitions',
}: {
  data: { label: string; count: number }[]
  name?: string
}): React.ReactElement {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip content={<ChartTip />} cursor={{ stroke: CHART_GRID }} />
        {/* No mark animation anywhere: these charts refetch on a poll/filter
            cadence and animated marks re-draw with stale scales mid-flight. */}
        <Line
          type="monotone"
          dataKey="count"
          name={name}
          stroke={CHART_NAVY}
          strokeWidth={2}
          isAnimationActive={false}
          dot={{ r: 3, fill: CHART_NAVY, stroke: '#fff', strokeWidth: 2 }}
          activeDot={{ r: 5, fill: CHART_NAVY, stroke: '#fff', strokeWidth: 2 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}

// ── Grouped columns: given vs received (one hue, two shades) ─────────────────

export function GivenReceivedBars({
  data,
}: {
  data: { name: string; given: number; received: number }[]
}): React.ReactElement {
  return (
    <ResponsiveContainer width="100%" height={250}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }} barGap={2} barCategoryGap="28%">
        <CartesianGrid stroke={CHART_GRID} vertical={false} />
        <XAxis dataKey="name" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={false} interval={0} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip content={<ChartTip />} cursor={HOVER_CURSOR} />
        <Bar dataKey="given" name="Given" fill={CHART_NAVY_LIGHT} barSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="received" name="Received" fill={CHART_NAVY} barSize={16} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export const GIVEN_RECEIVED_LEGEND = [
  { label: 'Given', colour: CHART_NAVY_LIGHT },
  { label: 'Received', colour: CHART_NAVY },
]

// ── Horizontal bars in behaviour colours (names always on the axis) ─────────

export function BehaviourBars({
  data,
  showPct = false,
}: {
  data: { name: string; colour: string; count: number; pct?: number }[]
  showPct?: boolean
}): React.ReactElement {
  // Grow with the data so the axis band never gets crushed out of the card.
  const height = Math.max(120, data.length * 40 + 24)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={CHART_GRID} horizontal={false} />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          width={148}
          tick={{ ...AXIS_TICK, fill: CHART_INK }}
          axisLine={AXIS_LINE}
          tickLine={false}
          interval={0}
        />
        <Tooltip content={<ChartTip />} cursor={HOVER_CURSOR} />
        <Bar dataKey="count" name="Recognitions" barSize={18} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {data.map((row) => (
            <Cell key={row.name} fill={row.colour} />
          ))}
          <LabelList
            dataKey={showPct ? 'label' : 'count'}
            position="right"
            fill={CHART_TEXT}
            fontSize={12}
            formatter={(v: unknown) => (typeof v === 'number' ? formatNum(v) : String(v ?? ''))}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

/** Precompute "count · pct%" end-labels for BehaviourBars showPct mode. */
export function withPctLabels<T extends { count: number; pct?: number }>(
  rows: T[],
): (T & { label: string })[] {
  return rows.map((r) => ({
    ...r,
    label: r.pct !== undefined ? `${formatNum(r.count)} · ${formatPct(r.pct)}` : formatNum(r.count),
  }))
}

// ── Single-hue horizontal bars (direction mix etc.) ─────────────────────────

export function SingleHueBars({
  data,
  axisWidth = 148,
}: {
  data: { name: string; count: number; label?: string }[]
  axisWidth?: number
}): React.ReactElement {
  const height = Math.max(100, data.length * 40 + 24)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 72, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={CHART_GRID} horizontal={false} />
        <XAxis type="number" hide />
        <YAxis
          type="category"
          dataKey="name"
          width={axisWidth}
          tick={{ ...AXIS_TICK, fill: CHART_INK }}
          axisLine={AXIS_LINE}
          tickLine={false}
          interval={0}
        />
        <Tooltip content={<ChartTip />} cursor={HOVER_CURSOR} />
        <Bar dataKey="count" name="Count" fill={CHART_NAVY} barSize={18} radius={[0, 4, 4, 0]} isAnimationActive={false}>
          <LabelList
            dataKey={data.some((d) => d.label) ? 'label' : 'count'}
            position="right"
            fill={CHART_TEXT}
            fontSize={12}
            formatter={(v: unknown) => (typeof v === 'number' ? formatNum(v) : String(v ?? ''))}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// ── Stat tile ────────────────────────────────────────────────────────────────

export function StatTile({
  label,
  value,
  sub,
}: {
  label: string
  value: string | number
  sub?: string
}): React.ReactElement {
  return (
    <div className="stat-tile">
      <div className="stat-tile-value">{typeof value === 'number' ? formatNum(value) : value}</div>
      <div className="stat-tile-label">{label}</div>
      {sub && <div className="card-sub" style={{ marginTop: 4, fontSize: 11 }}>{sub}</div>}
    </div>
  )
}

// ── Thin-sample guard ────────────────────────────────────────────────────────

/**
 * Below this many rows a percentage is noise wearing a decimal point.
 *
 * Thirty is the conventional floor for treating a proportion as anything but
 * indicative, and on a committee dashboard the cost of the wrong call is a
 * real conversation with a real team — so the number is shown, and labelled
 * as too small to act on, rather than quietly dropped.
 */
export const MIN_SAMPLE = 30

export function SampleNote({
  n,
  what = 'recognitions',
}: {
  n: number
  what?: string
}): React.ReactElement {
  const thin = n < MIN_SAMPLE
  return (
    <div className={thin ? 'sample-note thin' : 'sample-note'}>
      {thin ? (
        <>
          <strong>Indicative only</strong> — {formatNum(n)} {what} in this range. Percentages on a
          sample this small move a lot with one more entry; widen the date range before drawing a
          conclusion.
        </>
      ) : (
        <>Based on {formatNum(n)} {what}.</>
      )}
    </div>
  )
}

// ── Grade matrix (giver grade × recipient grade) ─────────────────────────────

export interface MatrixCell {
  giverGrade: string
  recipientGrade: string
  count: number
  pctOfGiverRow: number
}

/**
 * Who recognises whom, by rung.
 *
 * Rows are the giver's grade and columns the recipient's, both in ladder
 * order, so the shape itself is the finding: mass below the diagonal means
 * recognition travels DOWN the organisation, mass above it means upward, and
 * a tight diagonal means people mostly recognise their own level.
 *
 * Shaded by share of the giver's own row rather than by raw count — otherwise
 * the largest grade's row is dark simply because it is the largest, and the
 * question "where does THIS rung send its recognition" cannot be read at all.
 */
export interface MatrixSelection {
  giverGrade?: string
  recipientGrade?: string
}

export function GradeMatrix({
  grades,
  cells,
  selection,
  onSelect,
  emptyLabel = 'No recognitions between mapped grades in this range',
}: {
  /** Ladder order, junior first. */
  grades: string[]
  cells: MatrixCell[]
  /** The cell, row or column currently drilled into. */
  selection?: MatrixSelection
  /**
   * Called with the slice to open. A row header sends only a giver grade, a
   * column header only a recipient grade, a cell both — so "everything G3
   * gave" and "everything SRG1 received" are one click each, not a trip
   * through the filter row.
   */
  onSelect?: (sel: MatrixSelection) => void
  emptyLabel?: string
}): React.ReactElement {
  if (grades.length === 0 || cells.length === 0) {
    return <div className="matrix-empty">{emptyLabel}</div>
  }
  const byKey = new Map(cells.map((c) => [`${c.giverGrade}>${c.recipientGrade}`, c]))
  const shade = (pct: number): string => {
    if (pct <= 0) return 'transparent'
    if (pct < 10) return NAVY_RAMP[0]
    if (pct < 25) return NAVY_RAMP[1]
    if (pct < 45) return NAVY_RAMP[2]
    if (pct < 70) return NAVY_RAMP[3]
    return NAVY_RAMP[4]
  }
  // White text only on the two darkest steps; anywhere lighter it fails.
  const ink = (pct: number): string => (pct >= 45 ? '#ffffff' : CHART_INK)

  const sel = selection ?? {}
  const rowSelected = (gr: string) => sel.giverGrade === gr && !sel.recipientGrade
  const colSelected = (rr: string) => sel.recipientGrade === rr && !sel.giverGrade
  const cellSelected = (gr: string, rr: string) =>
    sel.giverGrade === gr && sel.recipientGrade === rr
  // A cell in a selected row or column is dimmed rather than hidden, so the
  // shape of the whole matrix stays readable while one slice is open.
  const inSelection = (gr: string, rr: string) =>
    (sel.giverGrade === undefined || sel.giverGrade === gr) &&
    (sel.recipientGrade === undefined || sel.recipientGrade === rr)
  const anySelection = sel.giverGrade !== undefined || sel.recipientGrade !== undefined

  const pick = (next: MatrixSelection, isCurrent: boolean) => {
    if (!onSelect) return
    // Clicking the open slice again closes it — no separate "clear" to hunt for.
    onSelect(isCurrent ? {} : next)
  }

  return (
    <div className="matrix-wrap">
      <table className={`matrix${onSelect ? ' selectable' : ''}`} role="table">
        <thead>
          <tr>
            <th className="matrix-corner" scope="col">
              <span className="matrix-axis-giver">Giver ↓</span>
              <span className="matrix-axis-recipient">Recipient →</span>
            </th>
            {grades.map((g) => (
              <th
                key={g}
                scope="col"
                className={`matrix-head${colSelected(g) ? ' picked' : ''}`}
                onClick={onSelect ? () => pick({ recipientGrade: g }, colSelected(g)) : undefined}
                title={onSelect ? `Everything ${g} received` : undefined}
              >
                {g}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grades.map((gr) => (
            <tr key={gr}>
              <th
                scope="row"
                className={`matrix-head${rowSelected(gr) ? ' picked' : ''}`}
                onClick={onSelect ? () => pick({ giverGrade: gr }, rowSelected(gr)) : undefined}
                title={onSelect ? `Everything ${gr} gave` : undefined}
              >
                {gr}
              </th>
              {grades.map((rr) => {
                const cell = byKey.get(`${gr}>${rr}`)
                const count = cell?.count ?? 0
                const pct = cell?.pctOfGiverRow ?? 0
                const same = gr === rr
                const picked = cellSelected(gr, rr)
                const muted = anySelection && !inSelection(gr, rr)
                const label = `${gr} → ${rr}: ${formatNum(count)} (${formatPct(pct)} of ${gr}'s recognitions)`
                return (
                  <td
                    key={rr}
                    className={
                      `matrix-cell${same ? ' diag' : ''}${count === 0 ? ' zero' : ''}` +
                      `${picked ? ' picked' : ''}${muted ? ' muted' : ''}` +
                      `${onSelect && count > 0 ? ' clickable' : ''}`
                    }
                    style={count > 0 ? { background: shade(pct), color: ink(pct) } : undefined}
                    title={label}
                    aria-label={onSelect && count > 0 ? `${label}. Show these recognitions` : label}
                    role={onSelect && count > 0 ? 'button' : undefined}
                    tabIndex={onSelect && count > 0 ? 0 : undefined}
                    onClick={
                      onSelect && count > 0
                        ? () => pick({ giverGrade: gr, recipientGrade: rr }, picked)
                        : undefined
                    }
                    onKeyDown={
                      onSelect && count > 0
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              pick({ giverGrade: gr, recipientGrade: rr }, picked)
                            }
                          }
                        : undefined
                    }
                  >
                    {count > 0 ? formatNum(count) : '·'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="matrix-legend">
        <span>
          Share of the giver grade&rsquo;s own recognitions
          {onSelect && <> &middot; click a cell, row or column to see the people</>}
        </span>
        <span className="matrix-scale" aria-hidden>
          {NAVY_RAMP.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
        </span>
        <span>low → high</span>
      </div>
    </div>
  )
}
