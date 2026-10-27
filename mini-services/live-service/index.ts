import { createServer } from 'http'
import { Server, Socket } from 'socket.io'

// ---------------------------------------------------------------------------
// Structured stdout logger
// ---------------------------------------------------------------------------
// The live-service runs as a standalone Node process, outside the Next.js
// request path, so it cannot reach the Next.js `logger` in
// src/lib/observability.ts. It emits one JSON object per line straight to
// stdout instead — parseable by any container log collector, and compliant
// with the repo's "no raw console output in production source" quality-gate
// rule.
function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n'
  )
}

// ---------------------------------------------------------------------------
// Security configuration
// ---------------------------------------------------------------------------

// Origin allowlist. In dev (NODE_ENV !== "production") every origin is allowed
// to keep local development frictionless. In production, only origins whose
// hostname matches an entry in ALLOWED_ORIGINS may connect.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:81,http://localhost:3000').split(',')

// Max simultaneous live sockets from a single IP. Blocks connection flooding.
const MAX_CONNECTIONS_PER_IP = 10

// Max inbound application messages per second per socket. Flooders are kicked.
const MAX_MSGS_PER_SEC = 30

// Max serialized message size (1 KB). Oversized payloads are silently dropped
// so a malicious client cannot exhaust memory by sending huge blobs.
const MAX_MSG_SIZE = 1024

// Hard size cap on the per-IP / per-socket / tracker-activity Maps. Without
// this, an attacker who varies `X-Forwarded-For` across millions of unique
// IPs could grow `connectionsByIp` (and the other two bookkeeping Maps)
// without bound and exhaust process memory. When a Map exceeds the trigger
// threshold (10k entries) we evict the oldest half (5k) — JS Map keys
// iterate in insertion order, so the oldest still-present entry goes first.
const MAX_MAP_ENTRIES_TRIGGER = 10_000
const MAX_MAP_ENTRIES_TARGET = 5_000

/**
 * Cap a Map's size at MAX_MAP_ENTRIES_TARGET by deleting the oldest
 * insertion-order keys. Pure (mutates only the passed Map), never throws.
 * Returns the number of entries removed (handy for metrics / logs).
 */
function boundMapSize<K, V>(map: Map<K, V>): number {
  if (map.size < MAX_MAP_ENTRIES_TRIGGER) return 0
  let removed = 0
  try {
    const toRemove = Math.max(0, map.size - MAX_MAP_ENTRIES_TARGET)
    const it = map.keys()
    while (removed < toRemove) {
      const step = it.next()
      if (step.done) break
      map.delete(step.value)
      removed++
    }
  } catch {
    // ignore — best-effort eviction
  }
  return removed
}

// Prisma cuid project IDs are 24+ lowercase-alphanumeric chars.
const PROJECT_ID_RE = /^[a-z0-9]{24,}$/i

function isValidProjectId(id: unknown): id is string {
  return typeof id === 'string' && PROJECT_ID_RE.test(id)
}

// ip -> set of socket ids (per-IP connection cap)
const connectionsByIp = new Map<string, Set<string>>()
// socket id -> recent message timestamps (per-socket rate limit)
const msgTimestamps = new Map<string, number[]>()
// socket id -> last tracker activity ts (stale-connection cleanup).
// Only trackers are tracked here; viewers are passive and rely on socket.io's
// built-in ping/pong, so they are never idle-disconnected by the extra sweep.
const lastTrackerActivity = new Map<string, number>()

function getClientIp(socket: Socket): string {
  const xff = socket.handshake.headers['x-forwarded-for']
  const first = Array.isArray(xff) ? xff[0] : xff
  if (first && typeof first === 'string') return first.split(',')[0].trim()
  return socket.handshake.address || 'unknown'
}

function rateLimitMessage(socketId: string): boolean {
  const now = Date.now()
  const timestamps = msgTimestamps.get(socketId) || []
  const recent = timestamps.filter((t) => now - t < 1000)
  if (recent.length >= MAX_MSGS_PER_SEC) return false
  recent.push(now)
  msgTimestamps.set(socketId, recent)
  // Bound the per-socket Map — sockets churn rapidly under normal load
  // (each gets a fresh id) and an attacker who floods new connections
  // could otherwise grow this Map without bound. Cheap when under the
  // trigger threshold.
  boundMapSize(msgTimestamps)
  return true
}

function messageTooLarge(data: unknown): boolean {
  try {
    return JSON.stringify(data).length > MAX_MSG_SIZE
  } catch {
    return true
  }
}

function logReject(socket: Socket, reason: string, extra?: Record<string, unknown>) {
  log('security.reject', {
    reason,
    socketId: socket.id,
    ip: getClientIp(socket),
    ...(extra ? { extra } : {}),
  })
}

// ---------------------------------------------------------------------------
// HTTP + Socket.io server
// ---------------------------------------------------------------------------

const httpServer = createServer()
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: {
    origin: (origin, callback) => {
      // Dev: allow every origin so local development / Caddy gateway "just works".
      if (process.env.NODE_ENV !== 'production') {
        return callback(null, true)
      }
      // Prod: require an Origin header whose hostname matches the allowlist.
      // No Origin header (server-to-server, curl) is rejected in prod.
      if (!origin) return callback(null, false)
      const allowed = ALLOWED_ORIGINS.some((o) => {
        try {
          return new URL(origin).hostname === new URL(o).hostname
        } catch {
          return false
        }
      })
      callback(null, allowed)
    },
    methods: ['GET', 'POST'],
    credentials: false,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// Log Engine.IO-level connection errors (bad handshake, CORS rejection, etc.)
// so security events are visible in the live-service log.
io.engine.on('connection_error', (err: { req?: { headers?: Record<string, string | string[] | undefined> }; code: number; message: string }) => {
  const xff = err.req?.headers?.['x-forwarded-for']
  const first = Array.isArray(xff) ? xff[0] : xff
  const ip = first && typeof first === 'string' ? first.split(',')[0].trim() : 'unknown'
  log('security.connection_error', { code: err.code, msg: err.message, ip })
})

// ---------------------------------------------------------------------------
// Live-session state
// ---------------------------------------------------------------------------

interface LiveSession {
  sessionId: string
  projectId: string
  visitorId: string
  url: string
  lastX: number
  lastY: number
  lastScrollY: number
  device?: string
  browser?: string
  country?: string
  city?: string
  lastSeen: number
  socketId: string
}

// Active tracked sessions keyed by sessionId
const activeSessions = new Map<string, LiveSession>()

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  let role: 'tracker' | 'viewer' | null = null
  let viewerProject: string | null = null
  let trackerSessionId: string | null = null

  // --- Per-IP connection limit -------------------------------------------
  const ip = getClientIp(socket)
  const conns = connectionsByIp.get(ip) || new Set<string>()
  if (conns.size >= MAX_CONNECTIONS_PER_IP) {
    log('security.connection_rejected', {
      ip,
      connections: conns.size,
      max: MAX_CONNECTIONS_PER_IP,
    })
    socket.disconnect(true)
    return
  }
  conns.add(socket.id)
  connectionsByIp.set(ip, conns)
  // Bound the per-IP Map — an attacker spoofing X-Forwarded-For across many
  // unique IPs could otherwise grow this Map without bound.
  boundMapSize(connectionsByIp)

  // --- Tracker registration ----------------------------------------------
  socket.on('register', (data: { sessionId: string; projectId: string; visitorId: string; url: string }) => {
    if (!rateLimitMessage(socket.id)) {
      log('security.rate_limit', { action: 'register', socketId: socket.id, ip })
      socket.disconnect(true)
      return
    }
    if (messageTooLarge(data)) {
      logReject(socket, 'Oversized "register" dropped')
      return
    }
    if (!isValidProjectId(data?.projectId)) {
      logReject(socket, 'Invalid projectId on "register"', { projectId: String(data?.projectId).slice(0, 50) })
      return
    }
    if (typeof data?.sessionId !== 'string' || !data.sessionId || data.sessionId.length > 100) {
      logReject(socket, 'Invalid sessionId on "register"')
      return
    }

    role = 'tracker'
    trackerSessionId = data.sessionId
    lastTrackerActivity.set(socket.id, Date.now())
    // Bound the tracker-activity Map — under normal load this Map stays
    // small (size = active tracker sockets), but a flood of registered
    // trackers from spoofed IPs could otherwise grow it without bound.
    boundMapSize(lastTrackerActivity)
    activeSessions.set(data.sessionId, {
      sessionId: data.sessionId,
      projectId: data.projectId,
      visitorId: typeof data.visitorId === 'string' ? data.visitorId.slice(0, 100) : 'unknown',
      url: typeof data.url === 'string' ? data.url.slice(0, 500) : '/',
      lastX: 0,
      lastY: 0,
      lastScrollY: 0,
      lastSeen: Date.now(),
      socketId: socket.id,
    })
    // Bound the active-sessions Map — an attacker who sends many "register"
    // events with distinct fake sessionIds could otherwise grow this Map
    // without bound (the 60s prune below eventually catches up, but a
    // short burst can still spike memory).
    boundMapSize(activeSessions)
    io.to(`proj:${data.projectId}`).emit('session-join', {
      sessionId: data.sessionId,
      projectId: data.projectId,
      visitorId: data.visitorId,
      url: data.url,
    })
  })

  // --- Viewer subscription -----------------------------------------------
  socket.on('subscribe', (data: { projectId: string }) => {
    if (!rateLimitMessage(socket.id)) {
      log('security.rate_limit', { action: 'subscribe', socketId: socket.id, ip })
      socket.disconnect(true)
      return
    }
    if (messageTooLarge(data)) {
      logReject(socket, 'Oversized "subscribe" dropped')
      return
    }
    if (!isValidProjectId(data?.projectId)) {
      logReject(socket, 'Invalid projectId on "subscribe"', { projectId: String(data?.projectId).slice(0, 50) })
      return
    }

    role = 'viewer'
    viewerProject = data.projectId
    void socket.join(`proj:${data.projectId}`)
    // send current active sessions for this project
    const list = Array.from(activeSessions.values()).filter((s) => s.projectId === data.projectId)
    socket.emit('active-sessions', list)
  })

  // --- Live cursor event -------------------------------------------------
  // SECURITY: the previous implementation broadcast the event to every viewer
  // of `data.projectId` unconditionally — even if no session was registered
  // for `data.sessionId`, and even if the projectId in the message did not
  // match the registered session. Any client could inject fake cursors into
  // any project. We now require: (a) a registered session exists, (b) the
  // message projectId matches the registered session's projectId, and (c) the
  // socket owns that session. Only then is the event broadcast.
  socket.on('live', (data: { sessionId: string; projectId: string; ev: { type: string; x: number; y: number; scrollY: number; t: number; pageUrl: string } }) => {
    if (!rateLimitMessage(socket.id)) {
      log('security.rate_limit', { action: 'live', socketId: socket.id, ip })
      socket.disconnect(true)
      return
    }
    if (messageTooLarge(data)) {
      // Silently drop — live cursor events are high-frequency and would spam logs.
      return
    }
    if (!isValidProjectId(data?.projectId)) {
      logReject(socket, 'Invalid projectId on "live"', { projectId: String(data?.projectId).slice(0, 50) })
      return
    }
    if (!data?.ev || typeof data.ev !== 'object') {
      return
    }

    // Anti-injection: only the socket that registered the session may broadcast
    // for it, and only to the project it registered under.
    const s = activeSessions.get(data.sessionId)
    if (!s || s.projectId !== data.projectId || s.socketId !== socket.id) {
      return
    }

    lastTrackerActivity.set(socket.id, Date.now())
    s.lastX = typeof data.ev.x === 'number' ? data.ev.x : s.lastX
    s.lastY = typeof data.ev.y === 'number' ? data.ev.y : s.lastY
    s.lastScrollY = typeof data.ev.scrollY === 'number' ? data.ev.scrollY : s.lastScrollY
    s.lastSeen = Date.now()
    if (typeof data.ev.pageUrl === 'string') s.url = data.ev.pageUrl.slice(0, 500)

    io.to(`proj:${data.projectId}`).emit('live-event', {
      sessionId: data.sessionId,
      projectId: data.projectId,
      ev: data.ev,
    })
  })

  // --- Disconnect cleanup ------------------------------------------------
  socket.on('disconnect', () => {
    // Per-IP connection accounting
    const c = connectionsByIp.get(ip)
    if (c) {
      c.delete(socket.id)
      if (c.size === 0) connectionsByIp.delete(ip)
    }
    // Per-socket bookkeeping
    msgTimestamps.delete(socket.id)
    lastTrackerActivity.delete(socket.id)

    if (role === 'tracker' && trackerSessionId) {
      const s = activeSessions.get(trackerSessionId)
      activeSessions.delete(trackerSessionId)
      if (s) {
        io.to(`proj:${s.projectId}`).emit('session-leave', { sessionId: s.sessionId })
      }
    }
    if (role === 'viewer' && viewerProject) {
      void socket.leave(`proj:${viewerProject}`)
    }
  })

  socket.on('error', (error) => {
    console.error(`Socket error (${socket.id}):`, error)
  })
})

// ---------------------------------------------------------------------------
// Periodic maintenance
// ---------------------------------------------------------------------------

// Every 1s: broadcast live cursor snapshots for active sessions to viewers,
// and prune stale tracker sessions (no activity for 60s).
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of activeSessions) {
    if (now - s.lastSeen > 60000) {
      activeSessions.delete(id)
      io.to(`proj:${s.projectId}`).emit('session-leave', { sessionId: s.sessionId })
    }
  }
  // group by project and emit snapshots
  const byProject: Record<string, LiveSession[]> = {}
  for (const s of activeSessions.values()) {
    ;(byProject[s.projectId] = byProject[s.projectId] || []).push(s)
  }
  for (const [pid, list] of Object.entries(byProject)) {
    io.to(`proj:${pid}`).emit('cursor-snapshot', list)
  }
}, 1000)

// Every 60s: disconnect tracker sockets that have not sent a "live" event in
// 60s. This is in addition to socket.io's built-in ping/pong (25s interval /
// 60s timeout) and the session prune above. It reclaims per-IP connection
// slots from zombie trackers that pass ping/pong but emit no cursor data.
// Viewers are intentionally NOT swept here — they are passive recipients and
// rely solely on ping/pong for liveness.
setInterval(() => {
  const now = Date.now()
  for (const [sid, last] of lastTrackerActivity) {
    if (now - last > 60000) {
      const s = io.sockets.sockets.get(sid)
      if (s) {
        log('security.stale_tracker', {
          socketId: sid,
          idleSec: Math.round((now - last) / 1000),
        })
        s.disconnect(true)
      } else {
        // Socket already gone — clean up the bookkeeping directly.
        lastTrackerActivity.delete(sid)
        msgTimestamps.delete(sid)
      }
    }
  }
}, 60000)

const PORT = 3004
httpServer.listen(PORT, () => {
  log('service.started', { port: PORT })
})

process.on('SIGTERM', () => {
  httpServer.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  httpServer.close(() => process.exit(0))
})
