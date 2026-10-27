/**
 * Pure helpers extracted from live-tab.tsx.
 *
 * These cover (1) the ghost-cursor simulation state machine, (2) the pure
 * cursor-map transitions invoked by the socket.io event handlers, and (3)
 * the shared types/constants. Keeping them here lets the component focus on
 * wiring sockets and React state to the DOM.
 */

export interface LiveCursor {
  sessionId: string
  visitorId: string
  x: number
  y: number
  scrollY: number
  url: string
  color: string
  lastSeen: number
  clicks: { x: number; y: number; t: number }[]
}

export interface ActiveSession {
  id: string
  visitorId: string
  country: string
  city: string
  device: string
  browser: string
  os: string
  startedAt: string
  screenWidth: number
}

/** Cursor colours cycle through this palette by index. */
export const CURSOR_COLORS = [
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#8b5cf6",
  "#06b6d4",
  "#ef4444",
  "#84cc16",
] as const

/** Pages the simulated ghosts roam between. */
export const SIM_PAGES = ["/", "/pricing", "/features", "/blog", "/signup"] as const

/** Click ripple lifetime in ms. */
export const CLICK_RIPPLE_MS = 800

// ---------------------------------------------------------------------------
// Socket payload types
// ---------------------------------------------------------------------------

export interface SessionJoinMsg {
  sessionId: string
  visitorId: string
  url: string
}

export interface LiveEventMsg {
  sessionId: string
  ev: { type: string; x: number; y: number; scrollY: number; pageUrl: string }
}

export interface CursorSnapshotItem {
  sessionId: string
  lastX: number
  lastY: number
  lastScrollY: number
  url: string
  visitorId: string
}

// ---------------------------------------------------------------------------
// Cursor-map transitions (pure)
// ---------------------------------------------------------------------------

function nextColor(existingCount: number): string {
  return CURSOR_COLORS[existingCount % CURSOR_COLORS.length]
}

function makeCursor(s: { sessionId: string; visitorId: string; url?: string }, color: string, now: number): LiveCursor {
  return {
    sessionId: s.sessionId,
    visitorId: s.visitorId,
    x: 200,
    y: 200,
    scrollY: 0,
    url: s.url || "/",
    color,
    lastSeen: now,
    clicks: [],
  }
}

/** Add any not-yet-seen cursors from an `active-sessions` broadcast. */
export function addCursorsFromList(
  prev: Record<string, LiveCursor>,
  list: SessionJoinMsg[],
  now: number
): Record<string, LiveCursor> {
  const next = { ...prev }
  for (const s of list) {
    if (next[s.sessionId]) continue
    next[s.sessionId] = makeCursor(s, nextColor(Object.keys(next).length), now)
  }
  return next
}

/** Add a single cursor from a `session-join` event (no-op if already present). */
export function addCursor(
  prev: Record<string, LiveCursor>,
  s: SessionJoinMsg,
  now: number
): Record<string, LiveCursor> {
  if (prev[s.sessionId]) return prev
  return { ...prev, [s.sessionId]: makeCursor(s, nextColor(Object.keys(prev).length), now) }
}

/** Remove a cursor on `session-leave`. */
export function removeCursor(
  prev: Record<string, LiveCursor>,
  sessionId: string
): Record<string, LiveCursor> {
  const next = { ...prev }
  delete next[sessionId]
  return next
}

/** Apply a `live-event` (mousemove/scroll/click) to one cursor. */
export function applyLiveEvent(
  prev: Record<string, LiveCursor>,
  msg: LiveEventMsg,
  now: number
): Record<string, LiveCursor> {
  const c = prev[msg.sessionId]
  if (!c) return prev
  const clicks = [...c.clicks]
  if (msg.ev.type === "click") clicks.push({ x: msg.ev.x, y: msg.ev.y, t: now })
  return {
    ...prev,
    [msg.sessionId]: {
      ...c,
      x: msg.ev.x ?? c.x,
      y: msg.ev.y ?? c.y,
      scrollY: msg.ev.scrollY ?? c.scrollY,
      url: msg.ev.pageUrl || c.url,
      lastSeen: now,
      clicks: clicks.filter((ck) => now - ck.t < CLICK_RIPPLE_MS),
    },
  }
}

/** Merge a periodic `cursor-snapshot` broadcast (updates position only). */
export function applyCursorSnapshot(
  prev: Record<string, LiveCursor>,
  list: CursorSnapshotItem[],
  now: number
): Record<string, LiveCursor> {
  const next = { ...prev }
  for (const s of list) {
    const cur = next[s.sessionId]
    if (!cur) continue
    next[s.sessionId] = {
      ...cur,
      x: s.lastX ?? cur.x,
      y: s.lastY ?? cur.y,
      scrollY: s.lastScrollY ?? cur.scrollY,
      url: s.url || cur.url,
      lastSeen: now,
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// Ghost-cursor simulation
// ---------------------------------------------------------------------------

export interface Ghost {
  id: string
  x: number
  y: number
  tx: number
  ty: number
  url: string
  color: string
  scrollY: number
  nextClick: number
}

/** Create `count` ghost cursors with random start/target positions. */
export function initGhosts(count: number, now: number): Ghost[] {
  const ghosts: Ghost[] = []
  for (let i = 0; i < count; i++) {
    ghosts.push({
      id: "sim_" + i,
      x: Math.random() * 1100 + 100,
      y: Math.random() * 600 + 100,
      tx: Math.random() * 1100 + 100,
      ty: Math.random() * 700 + 100,
      url: SIM_PAGES[Math.floor(Math.random() * SIM_PAGES.length)],
      color: CURSOR_COLORS[i % CURSOR_COLORS.length],
      scrollY: 0,
      nextClick: now + Math.random() * 3000,
    })
  }
  return ghosts
}

/** Seed the cursor map with ghost cursors from `initGhosts`. */
export function ghostsToCursors(ghosts: Ghost[], prev: Record<string, LiveCursor>, now: number): Record<string, LiveCursor> {
  const next = { ...prev }
  for (const g of ghosts) {
    next[g.id] = {
      sessionId: g.id,
      visitorId: "sim-" + g.id,
      x: g.x,
      y: g.y,
      scrollY: 0,
      url: g.url,
      color: g.color,
      lastSeen: now,
      clicks: [],
    }
  }
  return next
}

/**
 * Advance every ghost one tick (~60ms). Each ghost walks toward its target;
 * on arrival it picks a new target, maybe changes page, maybe scrolls, and
 * occasionally clicks. The ghost state is mutated in place (target/scroll/
 * next-click bookkeeping); the returned cursor map is a fresh immutable copy.
 */
export function tickGhosts(
  ghosts: Ghost[],
  prev: Record<string, LiveCursor>,
  now: number
): Record<string, LiveCursor> {
  const next = { ...prev }
  for (const g of ghosts) {
    const cur = next[g.id]
    if (!cur) continue
    const dx = g.tx - cur.x
    const dy = g.ty - cur.y
    const dist = Math.hypot(dx, dy)
    if (dist < 20) {
      // arrived — pick a new target, maybe change page/scroll
      g.tx = Math.random() * 1100 + 100
      g.ty = Math.random() * 700 + 100
      if (Math.random() < 0.2) {
        g.url = SIM_PAGES[Math.floor(Math.random() * SIM_PAGES.length)]
      }
      if (Math.random() < 0.3) {
        g.scrollY = Math.min(1200, g.scrollY + Math.floor(Math.random() * 300))
      } else if (Math.random() < 0.15) {
        g.scrollY = Math.max(0, g.scrollY - 200)
      }
    } else {
      const sp = 6
      cur.x += (dx / dist) * sp
      cur.y += (dy / dist) * sp
    }
    const clicks = cur.clicks.filter((c) => now - c.t < CLICK_RIPPLE_MS)
    if (now > g.nextClick) {
      clicks.push({ x: cur.x, y: cur.y, t: now })
      g.nextClick = now + 2000 + Math.random() * 4000
    }
    next[g.id] = { ...cur, scrollY: g.scrollY, url: g.url, lastSeen: now, clicks }
  }
  return next
}

/** Strip all ghost cursors (id starts with "sim_") when simulation stops. */
export function removeGhosts(prev: Record<string, LiveCursor>): Record<string, LiveCursor> {
  const next = { ...prev }
  for (const k of Object.keys(next)) {
    if (k.startsWith("sim_")) delete next[k]
  }
  return next
}
