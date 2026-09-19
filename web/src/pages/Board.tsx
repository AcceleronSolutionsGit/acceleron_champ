/**
 * / — login-free plant kiosk (FR-18), the CHAMP Wall of Recognition.
 *
 * Laid out as an EDITORIAL MARQUEE: three recognitions side by side, turning
 * over every 15 s, each panel flapping into place the way a departure board
 * resolves a row.
 *
 * No cards — panels are full-height fields separated by a hairline, so the
 * eye lands on a hard edge rather than a soft shadow. That, rather than point
 * size, is what carries the board across a room.
 *
 * The flap is not decoration. On a screen nobody watches continuously, the
 * turnover is what tells a passer-by the board is live and that the names just
 * changed; a silent crossfade reads as a static poster.

 *
 * Two things a kiosk has to survive, which most of the code below is about:
 *
 *   · the feed reloading underneath the show. Every 20 s the poll returns a
 *     fresh list, and if the page index were left alone a new arrival would
 *     shunt everyone one place along mid-slide. Slides are therefore keyed by
 *     the id of their first tile, and after a reload the index is moved to
 *     wherever that key landed — the viewer keeps reading the same three.
 *   · nobody being there to fix it. No buttons are required: the board turns
 *     over on its own, and the arrow keys, space and a click are there only
 *     for the person who walks up to it.
 *
 * The old twelve-up card grid is still one query string away (?view=grid), so
 * a kiosk already pointed at this URL can be put back without a deploy.
 *
 * Honours ?site= and (when the server has BOARD_TOKEN set) passes ?token=
 * straight through to the API.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useApi, useNow } from '../hooks'
import { formatIstClock, timeAgo } from '../format'
import type { FeedItem } from '../types'

const REFRESH_MS = 20_000
/** Tiles to a slide. Three is what keeps the type big enough to read from the
 *  far side of a floor; twelve items then make four slides. */
const PER_SLIDE = 3
/** How long a slide holds before it turns over. */
const SLIDE_MS = 15_000
/** How long the board pauses after somebody touches it. */
const RESUME_MS = 30_000
/** Gap between one panel flapping and the next — the cascade across the board. */
const FLAP_STAGGER_MS = 130
const LIMIT = 12

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** One shared answer for the whole page, read once per mount. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export default function Board(): React.ReactElement {
  const [params] = useSearchParams()
  const site = params.get('site') ?? undefined
  const token = params.get('token') ?? undefined
  const gridView = params.get('view') === 'grid'

  const feed = useApi(
    () => api.boardFeed({ site, token, limit: LIMIT }),
    [site, token],
    { pollMs: REFRESH_MS },
  )
  const now = useNow(1000)

  const items = useMemo(() => feed.data ?? [], [feed.data])
  const pages = useMemo(() => chunk(items, PER_SLIDE), [items])

  const dateLabel = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now)

  const header = (
    <header className="board-header">
      <div className="board-brand" style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <img
          src={`${import.meta.env.BASE_URL}Acceleron_Short_Logo.png`}
          alt="Acceleron Logo"
          style={{ height: '36px', width: 'auto', objectFit: 'contain' }}
          onError={(e) => {
            ;(e.currentTarget as HTMLImageElement).src = `${import.meta.env.BASE_URL}logo.png`
          }}
        />
        <div>
          <div>
            <span className="board-brand-accent">CHAMP</span> Wall of Recognition
          </div>
          <span className="board-brand-sub">Acceleron Solutions{site ? ` · ${site}` : ''}</span>
        </div>
      </div>
      <div className="board-clock">
        <div className="board-time">{formatIstClock(now)}</div>
        <div className="board-date">{dateLabel} · IST</div>
      </div>
    </header>
  )

  const footer = (
    <footer className="board-footer">
      <div className="board-cta">
        Give recognition on WhatsApp — message <span className="wa">Acceleron Champ</span>
      </div>
      <div>Spot great work. Say it in one line. It lands here.</div>
    </footer>
  )

  const empty = feed.error ? (
    <div className="board-empty">Can't reach the CHAMP feed right now — retrying…</div>
  ) : items.length === 0 && !feed.loading ? (
    <div className="board-empty">
      No recognitions yet — be the first! Message Acceleron Champ on WhatsApp.
    </div>
  ) : null

  if (gridView) {
    return (
      <div className="board">
        {header}
        <main className="board-main">
          {empty ?? items.map((item) => <BoardCard key={item.id} item={item} />)}
        </main>
        {footer}
      </div>
    )
  }

  if (empty) {
    return (
      <div className="board board-show">
        {header}
        <main className="board-main">{empty}</main>
        {footer}
      </div>
    )
  }

  return (
    <div className="board board-show">
      {header}
      <DepartureBoard pages={pages} />
    </div>
  )
}

/** The board itself: a header strip, six rows, and the page controls. */
function DepartureBoard({ pages }: { pages: FeedItem[][] }): React.ReactElement {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const count = pages.length
  const reduced = useMemo(prefersReducedMotion, [])

  // What the viewer is currently reading, so a reload can find it again.
  const anchorRef = useRef<number | null>(null)
  useEffect(() => {
    anchorRef.current = pages[index]?.[0]?.id ?? null
  }, [pages, index])

  // A poll replaced the list: follow the anchor rather than the position.
  useEffect(() => {
    if (count === 0) return
    const anchor = anchorRef.current
    if (anchor !== null) {
      const moved = pages.findIndex((page) => page.some((item) => item.id === anchor))
      if (moved !== -1) {
        setIndex(moved)
        return
      }
    }
    setIndex((i) => (i >= count ? 0 : i))
    // Only the shape of the list matters here; `index` deliberately absent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, count])

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => (count === 0 ? 0 : (i + delta + count) % count))
    },
    [count],
  )

  // Turnover timer. Re-armed on every index change, so a manual step gets a
  // full dwell rather than whatever was left of the previous page's timer.
  useEffect(() => {
    if (paused || count <= 1) return
    const t = window.setTimeout(() => go(1), SLIDE_MS)
    return () => window.clearTimeout(t)
  }, [index, paused, count, go])

  // Somebody walked up and touched it: hold, then hand the screen back.
  const holdRef = useRef<number | null>(null)
  const hold = useCallback(() => {
    setPaused(true)
    if (holdRef.current) window.clearTimeout(holdRef.current)
    holdRef.current = window.setTimeout(() => setPaused(false), RESUME_MS)
  }, [])
  useEffect(() => () => { if (holdRef.current) window.clearTimeout(holdRef.current) }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { hold(); go(1) }
      else if (e.key === 'ArrowLeft') { hold(); go(-1) }
      else if (e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault()
        if (holdRef.current) window.clearTimeout(holdRef.current)
        setPaused((p) => !p)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go, hold])

  if (count === 0) return <main className="board-main" />

  const page = pages[Math.min(index, count - 1)] ?? []

  const slide = pages[Math.min(index, count - 1)] ?? []

  return (
    <main className="board-stage">
      {/* Re-keying on the slide index is what makes the board flap: every tile
          is a new node, so its entry animation runs again. */}
      <div className="board-slide">
        {slide.map((item, i) => (
          <BoardTile key={`${index}-${item.id}`} item={item} tile={i} reduced={reduced} />
        ))}
        {/* Holds the column open on a short final slide, so its tiles keep the
            width they had on every other one. */}
        {Array.from({ length: PER_SLIDE - slide.length }, (_, k) => (
          <div key={`pad-${k}`} className="board-tile-pad" aria-hidden />
        ))}
      </div>

      <footer className="board-bar">
        <div className="board-cta">
          Give recognition on WhatsApp — message <strong>Acceleron Champ</strong>
        </div>

        <div className="board-pager">
        <button
          type="button"
          className="board-nav"
          aria-label="Previous recognitions"
          onClick={() => { hold(); go(-1) }}
        >
          ‹
        </button>

        <div className="board-dots" role="tablist" aria-label="Slides">
          {pages.map((p, i) => (
            <button
              type="button"
              key={p[0]?.id ?? i}
              role="tab"
              aria-selected={i === index}
              aria-label={`Slide ${i + 1} of ${count}`}
              className={`board-dot${i === index ? ' active' : ''}`}
              onClick={() => { hold(); setIndex(i) }}
            >
              <span
                className="board-dot-fill"
                style={
                  i === index && !paused && !reduced
                    ? { animationDuration: `${SLIDE_MS}ms` }
                    : { animation: 'none', width: i === index ? '100%' : '0%' }
                }
              />
            </button>
          ))}
        </div>

        <button
          type="button"
          className="board-nav"
          aria-label="Next recognitions"
          onClick={() => { hold(); go(1) }}
        >
          ›
        </button>

        <span className={`board-show-state${paused ? ' paused' : ''}`}>
          {paused ? 'Paused · press space to resume' : `${index + 1} / ${count}`}
        </span>
        </div>
      </footer>
    </main>
  )
}

/**
 * One tile. The flap delay is handed to CSS as a custom property so the
 * cascade across the board is a single declaration rather than three
 * hand-written rules.
 */
function BoardTile({
  item,
  tile,
  reduced,
}: {
  item: FeedItem
  tile: number
  reduced: boolean
}): React.ReactElement {
  const delay = tile * FLAP_STAGGER_MS
  return (
    <article
      className={reduced ? 'board-tile' : 'board-tile board-tile-flap'}
      style={{
        ['--flap-delay' as string]: `${delay}ms`,
        ['--behaviour' as string]: forBoardGround(item.behaviour.colour),
      }}
    >
      <div className="bt-behaviour">{item.behaviour.name}</div>

      <h2 className="bt-name">{item.recipient.name}</h2>

      <div className="bt-by">
        recognised by <strong>{item.giver.name}</strong>
      </div>

      {/* Set as plain text, not a quotation: quote marks and italics are
          noise at this size and cost a character's width on every line. */}
      <p className={`bt-reason${reasonSizeClass(item.reason)}`}>{item.reason}</p>

      <div className="bt-meta">
        <span>{item.recipient.site}</span>
        <span>{timeAgo(item.createdAt)}</span>
      </div>
    </article>
  )
}

/**
 * Sit a behaviour colour on a white ground without it going pale.
 *
 * The six CHAMP colours were picked for a chip on a screen you are a foot
 * from: CUSTOMER CENTRICITY's amber (#e58f00) and CARING's green (#619c77)
 * are close enough to white that as a line of text on a wall they turn into
 * a smudge. Capping lightness keeps each colour itself — a deeper amber is
 * still read as the amber one — without hand-maintaining a second palette
 * that a behaviour rename in the admin console would silently break.
 */
function forBoardGround(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec((hex ?? '').trim())
  if (!m) return '#ffffff'
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
  }
  h *= 60
  if (h < 0) h += 360
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return `hsl(${Math.round(h)} ${Math.round(Math.max(sat, 0.45) * 100)}% ${Math.round(
    Math.min(l, 0.38) * 100,
  )}%)`
}

/**
 * Pick a type size for the reason from how long it is.
 *
 * The alternative — one size and a line clamp — trades away the end of the
 * longest reasons, which are usually the ones worth reading. Stepping the
 * size down instead means everything fits, and the tiles that CAN be huge
 * still are. The thresholds are in characters because that is what the
 * WhatsApp bot actually limits.
 */
function reasonSizeClass(reason: string): string {
  const n = reason.trim().length
  if (n <= 150) return ''
  if (n <= 260) return ' is-long'
  if (n <= 420) return ' is-longer'
  return ' is-longest'
}


function BoardCard({ item }: { item: FeedItem }): React.ReactElement {
  return (
    <article className="board-card" style={{ borderLeftColor: item.behaviour.colour }}>
      <div className="board-who">
        {item.giver.name}
        <span className="board-arrow" aria-label="recognised">
          →
        </span>
        {item.recipient.name}
      </div>
      <p className="board-reason">“{item.reason}”</p>
      <div className="board-meta">
        <span className="board-chip">
          <span className="chip-dot" style={{ background: item.behaviour.colour }} aria-hidden />
          {item.behaviour.name}
        </span>
        <span>{timeAgo(item.createdAt)}</span>
        <span>{item.recipient.site}</span>
      </div>
    </article>
  )
}
