# Insight Replay — System Architecture

This document describes the runtime architecture of Insight Replay: which processes
run, how they communicate, where data lives, and how requests flow through the system.
For the *why* behind individual decisions, see the [ADRs](./adr/). For the *what* of
each HTTP endpoint, see the [API reference](./api-reference.md).

## Process topology

Insight Replay is a single-box deployment with three long-lived processes plus a SQLite
file. Everything is fronted by a Caddy gateway.

```
                            ┌──────────────────────┐
                            │  Browser (dashboard) │
                            │  + tracked-site SDK  │
                            └──────────┬───────────┘
                                       │  HTTP (:81)  +  WebSocket (:81 + ?XTransformPort=3004)
                                       ▼
                  ┌────────────────────────────────────────────┐
                  │  Caddy gateway  —  :81                     │
                  │  (Caddyfile)                               │
                  │                                            │
                  │   @transform_port_query {                  │
                  │     query XTransformPort=*                 │
                  │   }                                        │
                  │                                            │
                  │   handle @transform_port_query  →  reverse │
                  │     proxy to localhost:{query.XTransformPort}
                  │                                            │
                  │   handle (default)             →  reverse │
                  │     proxy to localhost:3000                 │
                  └────────┬───────────────────┬───────────────┘
                           │                   │
              (default)    │                   │  (?XTransformPort=3004)
                           ▼                   ▼
        ┌──────────────────────────┐   ┌──────────────────────────┐
        │  Next.js App Router      │   │  Socket.io mini-service  │
        │  (bun run dev)           │   │  (mini-services/         │
        │                          │   │     live-service)        │
        │  :3000                   │   │                          │
        │                          │   │  :3004                   │
        │  • dashboard UI          │   │  • path "/"              │
        │  • /api/* route handlers │   │  • in-memory             │
        │  • edge middleware       │   │    Map<sessionId,        │
        │  • Prisma client         │   │      LiveSession>        │
        │                          │   │  • project-scoped rooms  │
        └────────┬─────────────────┘   │  • 1s cursor snapshots   │
                 │                      │  • 60s stale pruning    │
                 │                      └──────────────────────────┘
                 │  Prisma ({ provider: "sqlite" })
                 ▼
        ┌──────────────────────────┐
        │  SQLite file             │
        │  db/custom.db            │
        │                          │
        │  Tables:                 │
        │   Project, Session,      │
        │   Event, Insight,        │
        │   ErrorEvent, Funnel,    │
        │   Goal, Segment, Note,   │
        │   Tag, Bookmark,         │
        │   Alert, AlertHistory,   │
        │   Dashboard, Experiment, │
        │   Annotation, ApiKey     │
        └──────────────────────────┘
```

### Ports

| Process                | Port | Notes |
|------------------------|------|-------|
| Caddy gateway          | :81  | Single entry point. Routes via `?XTransformPort=<port>` query param to non-3000 services. |
| Next.js (App Router)   | :3000| `bun run dev` — serves dashboard UI + all `/api/*` HTTP routes + standalone SDK script. |
| Socket.io live-service | :3004| `bun mini-services/live-service/index.ts` — bidirectional push channel for live cursors. |
| SQLite file            | n/a  | `db/custom.db` — single-file DB; `DATABASE_URL=file:./db/custom.db`. |

The browser only ever talks to `:81`. The `?XTransformPort=3004` query param is what
lets the WebSocket upgrade reach the live-service despite the browser thinking it's
talking to the same origin as the dashboard. See ADR-0002 for the design.

## Data flow: tracking ingest → dashboard

```
┌──────────────────┐    1. <script src="/api/track/script?pid=<id>&port=3004">
│  Tracked site    │       → served by Next.js with origin validation (prod)
│  (acme.com)      │
│                  │    2. SDK self-initialises: localStorage visitorId,
│                  │       sessionStorage sessionId, UTM capture, error hooks,
│                  │       WebSocket open to same origin with ?XTransformPort=3004
│                  │       → Caddy forwards to live-service :3004
│  ┌────────────┐  │
│  │  SDK       │  │    3. Every mousemove/click/scroll:
│  │            │──┼──▶  (a) buffer locally, flush every 4s or 40 events
│  │            │  │       (b) ws.send({ kind:"live", sessionId, projectId, ev })
│  └────────────┘  │            → live-service broadcasts to project room
└──────────────────┘
        │
        │ 4. POST /api/track/events  (every 4s or 40 events, on unload, on error)
        │    Body: { projectId, visitorId, sessionId, events[], errors[], UTM, ... }
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  Caddy :81  →  Next.js :3000                                 │
│                                                              │
│  Edge middleware (src/middleware.ts):                        │
│    • rate-limit per IP (100/min, 429 + Retry-After:60)       │
│    • stamp x-request-id                                      │
│                                                              │
│  POST handler (src/app/api/track/events/route.ts):           │
│    1. parse body, validate projectId non-empty (400)         │
│    2. db.project.findFirst({OR:[{id},{trackingId}]}) → siteUrl (404 if missing)
│    3. origin check (prod only): Origin | Referer-derived     │
│       origin must match siteUrl, dashboard own origin,       │
│       or localhost — else 403                                │
│    4. ingest(payload, req):                                  │
│         • anonymizeIP(rawIp)  → 192.168.1.0  (last octet 0)  │
│         • fakeGeo(ip)         → { country, city } (deterministic)
│         • parseUA(userAgent)  → { device, browser, os }      │
│         • detect rage clicks (4+ rapid clicks same target)   │
│         • detect dead clicks (click on non-interactive el)   │
│         • match goal conversions against project.goals[]     │
│         • db.session.create({ ...visitor, env, UTM, flags }) │
│         • db.event.createMany({ data: events[] })            │
│         • db.errorEvent.createMany({ data: errors[] })       │
│         • db.insight.create({ type:"rage_click", ... })      │
│    5. logger.info("ingest_success", {requestId, projectId,   │
│         sessionId, eventCount, durationMs})                  │
│    6. recordHttpRequest("POST", "/api/track/events", 200, ms)│
│    7. respond { ok:true, sessionId, projectId } + CORS hdrs  │
└──────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────┐
│  SQLite          │   ←—— 5. All durable session/event/insight rows persisted
│  db/custom.db    │       Indexed by [projectId, startedAt], [sessionId, t], etc.
└──────────────────┘

        ┌──────────────────┐
        │  Dashboard UI    │   ←—— 6. Dashboard polls /api/projects/[id]/stats every 8s
        │  (browser, :81)  │       (cached 60s — see ADR-0005)
        └──────────────────┘
```

Key invariants:

- The ingest endpoint is **open** (no API key) but **origin-validated** in production
  and **rate-limited** at the edge. The dashboard's other endpoints are open for the
  demo but can be gated by API key (see `/protected-test`).
- IPs are anonymized *before* storage. `fakeGeo` (deterministic from the IP string)
  runs on the already-anonymized value, so each visitor still gets a stable
  country/city but the raw octet never reaches disk.
- Rage clicks, dead clicks, and goal conversions are detected at ingest time, not at
  query time — so the `Session` row's `hasRageClick`, `hasDeadClick`, `convertedGoal`
  fields are authoritative for queries.

## Realtime flow: live cursors

```
┌──────────────────┐                               ┌──────────────────┐
│ Tracked site SDK │                               │ Dashboard viewer │
│ (tracker role)   │                               │ (viewer role)    │
└────────┬─────────┘                               └────────┬─────────┘
         │                                                  │
         │ ws://dash-host/?XTransformPort=3004              │ ws://dash-host/?XTransformPort=3004
         │                                                  │
         ▼                                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Caddy :81  →  reverse_proxy localhost:3004                            │
│  (because of @transform_port_query match on ?XTransformPort=*)         │
└────────────────────────────────────────────────────────────────────────┘
         │                                                  │
         ▼                                                  ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Socket.io mini-service  :3004   (mini-services/live-service/index.ts)│
│                                                                        │
│  activeSessions: Map<sessionId, LiveSession>  (in-memory only)         │
│                                                                        │
│  socket.on("register",  { sessionId, projectId, visitorId, url })      │
│    → role = "tracker"; store in activeSessions                         │
│    → io.to("proj:"+projectId).emit("session-join", …)                  │
│                                                                        │
│  socket.on("subscribe", { projectId })                                 │
│    → role = "viewer"; socket.join("proj:"+projectId)                   │
│    → emit current active sessions for this project                     │
│                                                                        │
│  socket.on("live",      { sessionId, projectId, ev })                  │
│    → update lastX/lastY/lastScrollY/lastSeen                           │
│    → io.to("proj:"+projectId).emit("live-event", …)                    │
│                                                                        │
│  socket.on("disconnect", …)                                            │
│    → if tracker: delete from activeSessions, emit "session-leave"      │
│    → if viewer: leave room                                             │
│                                                                        │
│  setInterval(1000):                                                    │
│    • prune sessions with lastSeen > 60s ago (emit "session-leave")     │
│    • group active sessions by project                                  │
│    • emit "cursor-snapshot" to each project room                       │
└────────────────────────────────────────────────────────────────────────┘
```

Notes:

- The live-service holds **no durable state**. If it restarts, all live sessions are
  forgotten. Durable session data flows through the HTTP ingest path above.
- A dashboard viewer subscribes to exactly one project at a time. The dashboard's Live
  tab calls `socket.emit("subscribe", { projectId })` once on mount.
- The 1s `cursor-snapshot` interval is what makes the dashboard feel live even when no
  `live-event` is being emitted (e.g. a tracked user is reading without moving the
  mouse).
- Both the tracked-site SDK and the dashboard viewer connect to the *same* gateway
  host (`:81`) with the *same* `?XTransformPort=3004` query param — Caddy's reverse
  proxy rule handles the routing uniformly.

## AI flow

```
┌──────────────────┐
│ Dashboard UI     │
│                  │
│  • Overview tab  │──┐
│    "AI Insights" │  │  GET /api/projects/[id]/ai?range=7
│    card          │  │
│                  │  │  • compiles totals + top pages + breakdowns + daily
│  • Recording     │  │    + recent frustration signals into a description string
│    Player        │  │  • await import("z-ai-web-dev-sdk")  (lazy, server-only)
│    "Ask AI" btn  │  │  • zai.chat.completions.create({ messages, thinking:disabled })
│                  │  │  • returns markdown with sections ## Overview / ## Key trends
│  • Recordings    │  │    / ## Frustration signals / ## Top opportunities
│    "Ask AI"      │  │    / ## Recommended actions
│    search bar    │  │
│                  │  ├─▶ POST /api/projects/[id]/ai/session  body { sessionId }
│                  │  │    • compiles visitor + env + page flow + click targets
│                  │  │      + scroll depth + frustration signals + JS errors
│                  │  │    • returns markdown with sections ## Summary
│                  │  │      / ## What happened / ## Pain points / ## Recommendations
│                  │  │
│                  │  └─▶ POST /api/projects/[id]/ai-search  body { query, range? }
│                  │       • sends query + available filter fields to LLM with
│                  │         "respond with ONLY valid JSON" system prompt
│                  │       • strips markdown fences, JSON.parses
│                  │       • builds Prisma `where` from parsed filters
│                  │       • returns { filters, sessions[], count }
└──────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  Next.js route handler (server-side, Node runtime)      │
│                                                          │
│  try {                                                   │
│    const ZAIModule = await import("z-ai-web-dev-sdk")    │
│    const ZAI = ZAIModule.default ?? ZAIModule            │
│    const zai = await ZAI.create()                        │
│    const completion = await zai.chat.completions.create({│
│      messages: [ {role:"assistant",content:SYSTEM},      │
│                   {role:"user",content:description} ],   │
│      thinking: { type: "disabled" },                     │
│    })                                                    │
│    return { analysis: completion.choices[0].message.content }
│  } catch (e) {                                           │
│    return { analysis: null, error: String(e) }  // 200   │
│  }                                                       │
└─────────────────────────────────────────────────────────┘
```

The lazy import is what keeps the SDK out of the browser bundle and out of cold-start
for non-AI routes. The 200-on-error contract is what lets the UI always show fallback
copy. See ADR-0003.

## Security layers

Six parallel layers, each shipped as disjoint files by a dedicated hardening task.
See ADR-0004 for the full rationale.

```
  Browser (tracked site SDK or dashboard viewer)
                    │
                    ▼
  ┌─────────────────────────────────────────────────────┐
  │  Layer 2: Edge middleware (src/middleware.ts)        │
  │    • rate-limit /api/track/events (100/min/IP)       │
  │    • stamp x-request-id                              │
  │    • matcher: /api/:path*                            │
  └─────────────────────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────────────┐
  │  Next.js route handler (Node runtime)                │
  │                                                      │
  │  For ingest (POST /api/track/events):                │
  │    • Layer 3: CORS + Origin validation               │
  │      (prod: reject unless Origin matches siteUrl,    │
  │       dashboard own origin, or localhost)            │
  │    • Layer 6: sanitizePayload(payload) — HTML-escape │
  │      strings, block javascript: URLs, prevent proto  │
  │      pollution, cap arrays/objects/events            │
  │    • Layer 4: anonymizeIP(rawIp) before storage      │
  │                                                      │
  │  For dashboard mutating endpoints:                   │
  │    • Layer 1: validateApiKey(req, projectId)         │
  │      (wired only into /protected-test so far)        │
  │    • Layer 5: auditLog({ action, projectId, actor,   │
  │      ip, details }) — fire-and-forget JSONL append   │
  │                                                      │
  │  For all endpoints:                                  │
  │    • try/catch → { error: string } on failure        │
  └─────────────────────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────────────┐
  │  Layer 6: next.config.ts headers()                   │
  │    • Content-Security-Policy                          │
  │    • X-Content-Type-Options: nosniff                 │
  │    • X-Frame-Options: DENY                           │
  │    • Referrer-Policy: strict-origin-when-cross-origin│
  │    • Permissions-Policy: camera=(), microphone=(),…  │
  │    • X-DNS-Prefetch-Control: off                     │
  │    (applied to source "/(.*)"  →  every route)       │
  └─────────────────────────────────────────────────────┘
                    │
                    ▼
                  SQLite (db/custom.db)
                  logs/audit.jsonl  (Layer 5 — decoupled from DB)
                  logs/app.jsonl    (observability structured logs)
```

## Dashboard tabs (15)

The dashboard's `ProjectView` component renders 15 tabs. Each is a separate component
under `src/components/app/`. One-line description of each:

| # | Tab           | Component           | Description |
|---|---------------|---------------------|-------------|
| 1 | Overview      | `overview-tab.tsx`  | 8 KPI cards + sessions area chart + AI Insights card (LLM) + new-vs-returning pie + device pie + referrers + browsers + top pages + entry/exit pages + countries + UTM campaigns. |
| 2 | Dashboards    | `dashboards-tab.tsx`| Custom dashboard switcher + widget grid (metric / chart / table renderer) backed by `/api/projects/[id]/dashboards/[did]/data`. |
| 3 | Recordings    | `recordings-tab.tsx`| Filterable session list (range, q, filter) + AI NL search bar + filter bar (multi-dimensional) + opens Recording Player. |
| 4 | (Player)      | `recording-player.tsx`| Modal session replay engine: rAF cursor interpolation, click ripples, page mock per URL, seek bar w/ event markers, speed control, side panel tabs (Info / AI / Notes / Timeline), bookmark toggle, tags. |
| 5 | Heatmaps      | `heatmaps-tab.tsx`  | Density-mapped rainbow canvas heatmap (click/move) + scroll-depth bars per page URL. |
| 6 | Live          | `live-tab.tsx`      | Socket.io subscribe to project room + real cursors + simulated ghost cursors + click ripples + active-sessions list. |
| 7 | Funnels       | `funnels-tab.tsx`   | Funnel CRUD + funnel-viz + dropoff % + median step times. |
| 8 | Journeys      | `journeys-tab.tsx`  | Sankey-style flow graph + top paths + entry/exit pages. |
| 9 | Experiments   | `experiments-tab.tsx`| A/B test CRUD + results visualization with significance banner, variant comparison, z-test / p-value / lift. |
| 10| Visitors      | `visitors-tab.tsx`  | Visitor list + profile drawer (per-visitor session history, tags, notes, conversion count). |
| 11| Retention     | `retention-tab.tsx` | Cohort retention matrix heatmap (period 0 = 100% by construction). |
| 12| Goals         | `goals-tab.tsx`     | Goal CRUD + per-goal conversion stats (count, rate, value) in range. |
| 13| Alerts        | `alerts-tab.tsx`    | Alert rules CRUD + Test button (calls `/evaluate`) + history feed with acknowledge button. Also surfaced in header via `alert-bell.tsx` (popover with unread count). |
| 14| Insights      | `insights-tab.tsx`  | Frustration signals (rage_click / dead_click / excessive_scroll / quick_back) with severity + summary cards + feed that opens the Recording Player. |
| 15| Errors        | `errors-tab.tsx`    | JS error chart + by-page breakdown + error log with session link. |
| 16| Settings      | `settings-tab.tsx`  | Tracking snippet with copy button + delete project + UTM builder + API keys management (create / reveal-once / masked list / revoke). |

(The sidebar lists 15 tabs; the file tree shows 16 tab components because the
Recording Player is a modal launched from Recordings, not a tab in the
sidebar.)

## Persistence layout

| Path                  | What lives here                                              | Backed up by |
|-----------------------|--------------------------------------------------------------|--------------|
| `db/custom.db`        | SQLite file — all Prisma tables (Project, Session, Event, …) | single file copy |
| `logs/audit.jsonl`    | Audit log entries (Layer 5) — decoupled from DB             | single file copy |
| `logs/app.jsonl`      | Structured app logs (`src/lib/observability.ts`)              | single file copy |
| `logs/dev.log`        | Next.js dev server stdout (tee'd by `bun run dev`)           | rotate / truncate |

All three log files are created at runtime (the `logs/` directory does not exist in
the repo). The audit logger creates the directory lazily via `mkdir({recursive:true})`.
`.gitignore` excludes `logs/` from version control.

## Build & run

| Command                                  | What it does |
|------------------------------------------|--------------|
| `bun install`                            | Install dependencies |
| `bun run db:push`                        | Apply schema to SQLite (destructive — `--accept-data-loss`) |
| `bun run dev`                            | Start Next.js on :3000 (hot reload via `--hot`) |
| `bun mini-services/live-service/index.ts`| Start the Socket.io service on :3004 |
| `caddy run --config Caddyfile`           | Start the gateway on :81 |
| `bun run lint`                           | ESLint (must exit 0 — enforced in CI) |
| `bun run build`                          | Next.js standalone build (output to `.next/standalone/`) |
| `bun run start`                          | Run the standalone production build (NODE_ENV=production) |
| `curl -X POST localhost:3000/api/seed`   | Generate demo data (project + 80 sessions + funnels/goals/segments/alerts/dashboards/experiment/annotations) |

A reviewer's minimum-viable demo loop:

1. `bun install && bun run db:push && bun run dev` (terminal 1)
2. `bun mini-services/live-service/index.ts` (terminal 2)
3. `caddy run --config Caddyfile` (terminal 3)
4. open `http://localhost:81` → click "Demo site" → move mouse → switch to "Live" tab
   → see live cursor → switch to "Recordings" tab → replay the session.

## Where to look next

- [ADRs](./adr/) — the *why* behind each major decision.
- [API reference](./api-reference.md) — the *what* of every HTTP endpoint.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — the engineering workflow that governs all changes.
- [worklog.md](../worklog.md) — chronological history of every task.
