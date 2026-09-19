/**
 * / — login-free plant kiosk (FR-18), the CHAMP Wall of Recognition.
 *
 * Runs as a SLIDESHOW: the newest recognitions are dealt into slides of three
 * and cycled every 8 s, so a TV on the shop floor shows a handful of names at
 * readable size rather than twelve cards nobody can read from ten feet away.
 *
 * Two things a kiosk has to survive, which the code below is mostly about:
 *
 *   · the feed reloading underneath the show. Every 20 s the poll returns a
 *     fresh list, and if the slide index were left alone a new arrival would
 *     shunt everyone one place along mid-slide. Slides are therefore keyed by
 *     the id of their first card, and after a reload the index is moved to
 *     wherever that key landed — the viewer keeps reading the same three.
 *   · nobody being there to fix it. No buttons are required: the show runs on
 *     its own, and the arrow keys, space and a click are there only for the
 *     person who walks up to it.
 *
 * The old twelve-up grid is still one query string away (?view=grid), so a
 * kiosk already pointed at this URL can be put back without a deploy.
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
/** Cards per slide. Three is what stays readable at kiosk distance. */
const PER_SLIDE = 3
/** How long a slide holds. Long enough for a two-line reason. */
const SLIDE_MS = 8_000
/** How long the show pauses after somebody touches it. */
const RESUME_MS = 30_000
const LIMIT = 12

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
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
  const slides = useMemo(() => chunk(items, PER_SLIDE), [items])

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
      {empty ? <main className="board-main">{empty}</main> : <Slideshow slides={slides} />}
      {footer}
    </div>
  )
}

/**
 * The show itself: one slide visible, the rest mounted but faded out so the
 * crossfade has something to fade to and the browser has already laid them
 * out (a kiosk browser reflowing three cards at the moment of transition is
 * exactly the stutter people notice on a big screen).
 */
function Slideshow({ slides }: { slides: FeedItem[][] }): React.ReactElement {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const count = slides.length

  // What the viewer is currently reading, so a reload can find it again.
  const anchorRef = useRef<number | null>(null)
  useEffect(() => {
    anchorRef.current = slides[index]?.[0]?.id ?? null
  }, [slides, index])

  // A poll replaced the list: follow the anchor rather than the position.
  useEffect(() => {
    if (count === 0) return
    const anchor = anchorRef.current
    if (anchor !== null) {
      const moved = slides.findIndex((slide) => slide.some((item) => item.id === anchor))
      if (moved !== -1) {
        setIndex(moved)
        return
      }
    }
    setIndex((i) => (i >= count ? 0 : i))
    // Only the shape of the list matters here; `index` deliberately absent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides, count])

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => (count === 0 ? 0 : (i + delta + count) % count))
    },
    [count],
  )

  // Auto-advance. Re-armed on every index change, so a manual step gets a full
  // dwell rather than whatever was left of the previous slide's timer.
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

  return (
    <main className="board-stage">
      <div className="board-slides">
        {slides.map((slide, i) => (
          <div
            key={slide[0]?.id ?? i}
            className={`board-slide${i === index ? ' current' : ''}`}
            aria-hidden={i !== index}
          >
            {slide.map((item) => (
              <BoardCard key={item.id} item={item} big />
            ))}
            {/* Keep a short final slide the same shape as a full one, so the
                cards do not grow when the last slide has one card on it. */}
            {Array.from({ length: PER_SLIDE - slide.length }, (_, k) => (
              <div key={`pad-${k}`} className="board-card-pad" aria-hidden />
            ))}
          </div>
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
          {slides.map((slide, i) => (
            <button
              type="button"
              key={slide[0]?.id ?? i}
              role="tab"
              aria-selected={i === index}
              aria-label={`Slide ${i + 1} of ${count}`}
              className={`board-dot${i === index ? ' active' : ''}`}
              onClick={() => { hold(); setIndex(i) }}
            >
              <span
                className="board-dot-fill"
                style={
                  i === index && !paused
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

function BoardCard({ item, big = false }: { item: FeedItem; big?: boolean }): React.ReactElement {
  return (
    <article
      className={big ? 'board-card board-card-big' : 'board-card'}
      style={{ borderLeftColor: item.behaviour.colour }}
    >
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
