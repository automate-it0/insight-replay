# ADR-0002: Socket.io Mini-Service for Realtime Cursor Tracking

## Status
Accepted (2025-01-01)

## Context
Insight Replay has a **Live** dashboard tab that needs to show real visitor cursors
moving across the tracked site in real time, plus per-project "active sessions" counts
and live click ripples. The tracking SDK already pushes events over HTTP to
`POST /api/track/events` for durable session storage, but the dashboard cannot poll fast
enough to feel live — a 1s polling interval on every active cursor would generate
thousands of requests per minute on a busy site, and the latency would still be at best
1–2 seconds.

We therefore need a **push** channel from tracked-site SDK → dashboard viewer.

Forces:

- **Bidirectional, low-latency.** Cursors move at 60fps on the client; we throttle to
  ~12 events/sec, but the dashboard still needs to see them within ~1s.
- **Project-scoped fan-out.** A dashboard viewer subscribes to one project; only
  sessions from that project should be broadcast to that viewer.
- **Same origin as the dashboard (for the SDK).** The tracked site is on a different
  origin from the dashboard, so the SDK opening a `WebSocket` to the dashboard host is
  a cross-origin connection — fine for `WebSocket` (no CORS preflight) but requires the
  server to accept the connection.
- **Next.js App Router is not a long-lived process.** Next.js route handlers are
  request/response. There is no first-class "WebSocket route" in the App Router, and
  the platform discourages holding connections open inside a route handler.
- **Demo simplicity.** The whole stack must run on one box behind the existing Caddy
  gateway on `:81`.

## Decision
Run a **separate Node.js mini-service** using Socket.io on **port 3004**
(`mini-services/live-service/index.ts`). The dashboard's Caddy gateway already supports
a `?XTransformPort=<port>` query param that reverse-proxies to a different localhost
port, so the SDK can open a WebSocket to the dashboard origin with that query param and
Caddy will route it to the mini-service.

The mini-service:

- Listens on port 3004, path `/`.
- Maintains an in-memory `Map<sessionId, LiveSession>` of active tracked sessions.
- Handles two socket roles:
  - **tracker** — the SDK on a tracked site calls `socket.emit("register", {...})` then
    `socket.emit("live", { sessionId, projectId, ev })` on every mousemove/click/scroll.
  - **viewer** — the dashboard calls `socket.emit("subscribe", { projectId })` and joins
    a Socket.io room `proj:<projectId>`.
- Broadcasts `live-event`, `session-join`, `session-leave`, and a periodic
  `cursor-snapshot` (emitted every 1s) to the project room.
- Prunes sessions with no activity for 60s.
- Has no persistence: if the service restarts, all live sessions are lost (intentional —
  durable data goes through the HTTP ingest path).

The SDK uses the URL `(ws|wss)://<dashboard-host>/?XTransformPort=3004` so the WebSocket
upgrade goes through Caddy on `:81` and is forwarded to `localhost:3004`.

## Consequences

**Positive**

- The dashboard feels live — cursors stream in near real time (sub-second thanks to the
  1s snapshot + per-event broadcasts).
- Next.js stays stateless: it serves HTTP request/response handlers and does not have to
  hold WebSocket connections. Hot reload does not kick off live viewers.
- The mini-service is a tiny standalone file (≈130 lines) with its own `package.json`,
  so it can be restarted, scaled, or replaced without touching the Next.js app.
- Project-scoped rooms mean a viewer only ever receives events for the project they are
  watching — no cross-project data leakage, no wasted bandwidth.
- The gateway already knew how to forward to non-3000 ports via `XTransformPort`, so no
  Caddy config change was required — we just used port 3004.

**Negative**

- **One more process to run.** Local dev now requires both `bun run dev` (Next on :3000)
  and a separate `bun run mini-services/live-service/index.ts` for :3004. Forgetting the
  second process silently breaks the Live tab.
- **Port management.** The mini-service is hardcoded to port 3004 (and the SDK is
  hardcoded to pass `?XTransformPort=3004`). Running multiple instances on the same box
  would require parameterising the port.
- **Gateway dependency.** In production with no Caddy, the dashboard would need its own
  reverse proxy that routes `/ws` (or a similar path) to port 3004. This is documented in
  `mini-services/live-service/` but not enforced.
- **In-memory only.** A restart loses the active-session map. Acceptable because durable
  session data is written through the HTTP ingest path; only the live cursor stream is
  ephemeral.
- **CORS is wide open (`origin: '*'`).** The service accepts any origin. In production
  this should be tightened to the dashboard's origin + the project's `siteUrl`, mirroring
  the CORS validation already done on the HTTP ingest endpoint (see ADR-0004).

## Alternatives Considered

### Server-Sent Events (SSE)
- **Pros:** HTTP-based, no separate process, no special Caddy routing, no Socket.io
  dependency. Server can push to the dashboard viewer over a normal Next.js route
  handler using a `ReadableStream`.
- **Cons:** One-way only (server → viewer). The dashboard viewer doesn't need to send
  much (just `subscribe { projectId }` once) but the tracked-site SDK does need to push
  cursor events up to the server, which would still require a separate POST endpoint or
  a second SSE channel. SSE also has a 6-connection-per-browser limit on HTTP/1.1, which
  becomes painful when a developer has multiple dashboard tabs open.
- **Rejected:** the bidirectional use case fits WebSocket/Socket.io more naturally, and
  we already had Socket.io in the dependency tree.

### HTTP long-polling on `/api/track/events`
- **Pros:** No new process, no new port, no new dependency.
- **Cons:** Latency floor of one round-trip per poll; the dashboard would need to poll
  at <1s intervals to feel live, which would generate thousands of requests per minute
  on a busy site. Re-implementing what Socket.io already gives us for free (rooms,
  broadcasting, reconnection, ping/pong) is wasted effort.
- **Rejected.**

### WebSocket inside the Next.js App Router (in-process)
- **Pros:** Single process. No port 3004.
- **Cons:** App Router route handlers are designed for request/response, not for holding
  long-lived WebSocket connections. The Next.js team explicitly does not support this
  pattern in the App Router. Custom Next.js servers (`createServer` + `next()`) would
  work but throw away `next dev`'s hot reload, which is the main reason to use Next.js
  in the first place.
- **Rejected.**

### Cloudflare Durable Objects / Ably / Pusher
- **Pros:** Managed, scalable, no process to run.
- **Cons:** Vendor lock-in + cost for what is essentially a 130-line broadcast
  service. Rejects the "self-hosted, no external services" brief.
- **Rejected.**
