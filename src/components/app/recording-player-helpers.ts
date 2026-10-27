/**
 * Pure helpers extracted from recording-player.tsx.
 *
 * These functions contain no React and no side effects (except
 * `findProjectForSession`, which makes network calls). They are extracted
 * so the player component can focus on wiring state to the DOM rather than
 * on replay-state arithmetic.
 */

import { api } from "@/lib/api"

export interface EventRow {
  id: string
  type: string
  t: number
  x: number
  y: number
  scrollX: number
  scrollY: number
  viewportWidth: number
  viewportHeight: number
  pageUrl: string
  data: Record<string, unknown>
}

export interface SessionRow {
  id: string
  visitorId: string
  country: string
  city: string
  device: string
  browser: string
  os: string
  screenWidth: number
  screenHeight: number
  startedAt: string
  duration: number
  totalClicks: number
  pageViewsCount: number
  isActive: boolean
  hasRageClick: boolean
  hasDeadClick: boolean
  language: string
}

export interface InsightRow {
  id: string
  type: string
  severity: string
  data: Record<string, unknown>
  timestamp: string
}

export interface Ripple {
  x: number
  y: number
  age: number
  rage?: boolean
  dead?: boolean
}

export interface PageInfo {
  url: string
  t: number
}

export interface ReplayState {
  pageUrl: string
  scrollY: number
  x: number
  y: number
  ripples: Ripple[]
  pages: PageInfo[]
}

export const EMPTY_REPLAY_STATE: ReplayState = {
  pageUrl: "/",
  scrollY: 0,
  x: 0,
  y: 0,
  ripples: [],
  pages: [],
}

/**
 * Click ripples: any click event whose age (currentTime - event.t) is in
 * [0, 600] ms. Rage/dead-click flags are forwarded from the event payload.
 */
export function computeRipples(events: EventRow[], currentTime: number): Ripple[] {
  const ripples: Ripple[] = []
  for (const e of events) {
    if (e.type !== "click") continue
    const age = currentTime - e.t
    if (age >= 0 && age <= 600) {
      ripples.push({
        x: e.x,
        y: e.y,
        age,
        rage: !!(e.data as { rage?: boolean }).rage,
        dead: !!(e.data as { dead?: boolean }).dead,
      })
    }
  }
  return ripples
}

/**
 * Distinct page-view sequence up to `currentTime`, preserving first-seen order.
 * Used by the Info tab's "Pages visited" list.
 */
export function extractPages(events: EventRow[], currentTime: number): PageInfo[] {
  const seen = new Set<string>()
  const unique: PageInfo[] = []
  for (const e of events) {
    if (e.t > currentTime) break
    if (e.type !== "pageview") continue
    if (seen.has(e.pageUrl)) continue
    seen.add(e.pageUrl)
    unique.push({ url: e.pageUrl, t: e.t })
  }
  return unique
}

/**
 * Compute the full replay state for a given playback position.
 *
 * Walks the event stream once to derive the current page URL, scroll offset
 * and cursor position (with linear interpolation between the last mousemove
 * before `currentTime` and the next one after it), then layers on ripples and
 * the page sequence via the dedicated helpers.
 */
export function computeReplayState(events: EventRow[], currentTime: number): ReplayState {
  if (!events.length) return EMPTY_REPLAY_STATE

  let pageUrl = "/"
  let scrollY = 0
  let x = 0
  let y = 0
  let lastMove: EventRow | null = null
  let nextMove: EventRow | null = null

  // Pre-collect mousemove events so we can fall back to the first one when
  // no move has happened yet at currentTime = 0.
  const moves: EventRow[] = []
  for (const e of events) {
    if (e.type === "mousemove") moves.push(e)
  }

  // Linear scan up to currentTime.
  for (const e of events) {
    if (e.t > currentTime) {
      if (e.type === "mousemove" && !nextMove) nextMove = e
      break
    }
    if (e.type === "pageview") pageUrl = e.pageUrl
    if (e.type === "scroll") scrollY = e.scrollY
    if (e.type === "mousemove") {
      lastMove = e
      x = e.x
      y = e.y
    }
  }

  // Interpolate between lastMove and nextMove for smooth cursor motion.
  if (lastMove && nextMove) {
    const span = nextMove.t - lastMove.t
    const f = span > 0 ? (currentTime - lastMove.t) / span : 0
    const c = Math.max(0, Math.min(1, f))
    x = Math.round(lastMove.x + (nextMove.x - lastMove.x) * c)
    y = Math.round(lastMove.y + (nextMove.y - lastMove.y) * c)
  } else if (lastMove) {
    x = lastMove.x
    y = lastMove.y
  } else if (moves.length) {
    x = moves[0].x
    y = moves[0].y
  }

  return {
    pageUrl,
    scrollY,
    x,
    y,
    ripples: computeRipples(events, currentTime),
    pages: extractPages(events, currentTime),
  }
}

/**
 * Scale factor that fits the session's screen into a container while
 * preserving aspect ratio. Falls back to 0.5 when the container is
 * collapsed (e.g. during initial layout).
 */
export function computeScale(
  containerW: number,
  containerH: number,
  sessionW: number,
  sessionH: number
): number {
  const s = Math.min(containerW / sessionW, containerH / sessionH)
  return s > 0 ? s : 0.5
}

/**
 * Find which project owns a session by probing each project's session
 * endpoint. Returns the project id, or null if no project has the session.
 *
 * The recording player is opened with only a sessionId (the recordings list
 * is flat across projects), so this lookup is unavoidable on first access.
 * Callers should cache the result so it only runs once per session.
 */
export async function findProjectForSession(sessionId: string): Promise<string | null> {
  const { projects } = await api<{ projects: { id: string }[] }>("/api/projects")
  for (const p of projects) {
    try {
      await api(`/api/projects/${p.id}/sessions/${sessionId}`)
      return p.id
    } catch {
      // session not in this project — try the next
    }
  }
  return null
}
