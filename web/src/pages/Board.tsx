/**
 * / — login-free plant kiosk (FR-18), the CHAMP Wall of Recognition.
 *
 * Laid out as TILES: three recognitions side by side, turning over every 15 s,
 * each one flapping into place the way a departure board resolves a row.
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
/** Gap between one tile flapping and the next — the cascade across the board. */
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

  return (
    <div className="board board-show">
      {header}
      {empty ? <main className="board-main">{empty}</main> : <DepartureBoard pages={pages} />}
      {footer}
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

      <div className="board-controls">
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
        ['--behaviour' as string]: item.behaviour.colour,
      }}
    >
      <span className="bt-chip">
        <span className="chip-dot" aria-hidden />
        <span className="chip-label">{item.behaviour.name}</span>
      </span>

      <h2 className="bt-name">
        <SplitFlapText text={item.recipient.name} startDelay={delay + 240} reduced={reduced} />
      </h2>

      <div className="bt-by">
        recognised by <strong>{item.giver.name}</strong>
      </div>

      <p className="bt-reason">“{item.reason}”</p>

      <div className="bt-meta">
        <span>{item.recipient.site}</span>
        <span>{timeAgo(item.createdAt)}</span>
      </div>
    </article>
  )
}

const FLAP_GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
/** Shuffles per character before it settles. Three is enough to read as motion
 *  without the name being illegible for long. */
const FLAP_CYCLES = 3
const FLAP_TICK_MS = 55
/** Blank flap filler — keeps the column width steady while a name lands. */
const NBSP = '\u00A0'

/**
 * The split-flap effect, on the one field worth it: the name of the person
 * being recognised. Letters riffle and settle left to right, the way a flap
 * board resolves a destination.
 *
 * Deliberately one timer for the whole string rather than one per character —
 * a kiosk box is usually the cheapest machine in the building, and six of
 * these are on screen at once.
 */
function SplitFlapText({
  text,
  startDelay,
  reduced,
}: {
  text: string
  startDelay: number
  reduced: boolean
}): React.ReactElement {
  const [frame, setFrame] = useState(-1)

  useEffect(() => {
    if (reduced) return
    setFrame(-1)
    const total = text.length * FLAP_CYCLES
    let tick = 0
    let interval = 0
    const start = window.setTimeout(() => {
      interval = window.setInterval(() => {
        tick += 1
        setFrame(tick)
        if (tick > total) window.clearInterval(interval)
      }, FLAP_TICK_MS)
    }, startDelay)
    return () => {
      window.clearTimeout(start)
      if (interval) window.clearInterval(interval)
    }
  }, [text, startDelay, reduced])

  if (reduced) return <>{text}</>

  const chars = text.split('')
  // Everything left of the cursor has landed, the character at it is
  // riffling, and everything right of it is still a blank flap.
  const cursor = frame < 0 ? -1 : Math.floor(frame / FLAP_CYCLES)
  if (cursor >= chars.length) return <>{text}</>

  return (
    <>
      <span aria-hidden>
        {chars.map((char, i) => {
          if (i < cursor) return <span key={i}>{char}</span>
          if (i === cursor && char !== ' ') {
            const glyph = FLAP_GLYPHS[(frame * 7 + i * 13) % FLAP_GLYPHS.length]
            return (
              <span key={i} className="flap-rolling">
                {glyph}
              </span>
            )
          }
          // Blank flap: a non-breaking space holds the column width steady so
          // the name does not visibly grow as it resolves.
          return (
            <span key={i} className="flap-blank">
              {NBSP}
            </span>
          )
        })}
      </span>
      {/* The real name stays in the accessibility tree while the flaps roll. */}
      <span className="sr-only">{text}</span>
    </>
  )
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
