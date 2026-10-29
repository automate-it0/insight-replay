# Insight Replay — API Reference

This is the complete reference for every HTTP route under `src/app/api/`. Routes are
grouped by domain. Within each group, routes are listed in the order they appear in the
file tree (collection handlers before dynamic-segment handlers).

**Conventions** shared by all routes:

- All routes are Next.js 16 App Router handlers under `src/app/api/`.
- Dynamic params use the async `ctx: { params: Promise<{…}> }` signature; handlers
  `await ctx.params` to read them.
- Errors return `{ error: string }` with the appropriate HTTP status (typically `400`
  for bad input, `404` for not-found, `500` for server error).
- The `range` query param is days (integer); default `7`. The cutoff is
  `now - range * 86_400_000` ms applied to `startedAt` (or `timestamp` for events).
- **Auth** (v0.7.0+ — four overlapping layers; the v0.6.0 docs' "wired only into one
  route" claim is stale):
  - **Session cookie** (`ir_session`, HMAC-signed + IP/device-fp bound; see
    `src/lib/session.ts`): minted by `POST /api/auth/login` and
    `POST /api/auth/setup`, validated server-side by `getSession()`. Every route
    under `/api/projects/[id]/*` runs `verifyProjectAccess(id)` (401 if no session,
    404 if project unknown — IDOR block, ADR-0004 layer 17). Top-level
    `GET /api/projects`, `GET /api/audit`, and `GET /api/projects/[id]/apikeys`
    also call `getSession()` directly.
  - **CSRF double-submit** (`ir_csrf` cookie + `x-csrf-token` header,
    middleware-enforced on POST/PUT/PATCH/DELETE). Minted by
    `GET /api/csrf-token`. Exempt: `/api/track/*`, `/api/auth/login`,
    `/api/auth/setup`, `/api/csrf-token` (pre-auth or SDK-driven).
  - **API key** (`Authorization: Bearer ir_…` or `?apikey=ir_…`):
    `validateApiKey()` on `/api/projects/[id]/protected-test` (always) and
    `/api/projects/[id]/visitors/[vid]/erase` (production only — dev is open so the
    dashboard can exercise erasure locally). `/api/projects/[id]/apikeys` is itself
    API-key gated in production.
  - **Admin token** (`x-admin-token` vs `ADMIN_TOKEN` env, constant-time compare,
    fail-closed if env unset): `/api/download`, `/api/admin/retention-purge`,
    `/api/admin/retention-stats`, `/api/security/health`, `/api/observability`,
    `/api/seed`.
  - The tracking ingest endpoint (`/api/track/events`, `/api/track/script`) uses
    Origin/CORS validation in production (ADR-0004 layer 3) instead of any of the
    above, because the SDK cannot negotiate credentials.
- All mutating endpoints (`POST`/`PATCH`/`PUT`/`DELETE`) should call `auditLog()` from
  `src/lib/audit.ts`; see ADR-0004 layer 5.

A single page-level table of contents:

- [Tracking](#tracking)
- [Projects](#projects)
- [Sessions](#sessions)
- [Analytics (stats, funnels, journeys, retention, compare, realtime, heatmap)](#analytics)
- [Visitors](#visitors)
- [Goals, Alerts, Experiments](#goals-alerts-experiments)
- [Dashboards](#dashboards)
- [AI](#ai)
- [Auth & CSRF](#auth--csrf)
- [Security & Auth](#security--auth)
- [Observability](#observability)
- [Admin (seed, audit, export, retention, download)](#admin-seed-audit-export-retention-download)
- [Top-level](#top-level)

---

## Tracking

### `POST /api/track/events`
Ingest tracking events from a tracked site. **Open** (origin-validated in production,
rate-limited by edge middleware).

- **Auth**: none (origin-validated in production; see ADR-0004 layer 3)
- **Rate limit**: 100 req/min/IP (`INGEST_LIMIT`); 429 + `Retry-After: 60` on overflow
- **Body**:
  ```jsonc
  {
    "projectId": "abc123",                 // project.id OR project.trackingId
    "visitorId": "v_xxxxxxxx",
    "sessionId": "s_xxxxxxxx",
    "userAgent": "Mozilla/5.0 …",
    "language": "en-US",
    "referrer": "https://google.com",
    "utmSource": "google",
    "utmMedium": "organic",
    "utmCampaign": "",
    "entryUrl": "/landing",
    "screenWidth": 1440,
    "screenHeight": 900,
    "startedAt": 1700000000000,
    "end": false,                          // optional, set on unload
    "events": [
      { "type": "pageview", "t": 0, "x": 0, "y": 0, "scrollX": 0, "scrollY": 0,
        "viewportWidth": 1440, "viewportHeight": 900, "pageUrl": "/",
        "data": { "title": "Home", "url": "/" } },
      { "type": "mousemove", "t": 120, "x": 320, "y": 410, /* … */, "data": {} },
      { "type": "click", "t": 800, "x": 720, "y": 540, /* … */,
        "data": { "tag": "A", "text": "Start free trial", "href": "/signup" } }
    ],
    "errors": [
      { "message": "TypeError: …", "stack": "…", "url": "/", "line": 42, "t": 5000 }
    ]
  }
  ```
- **Response `200`**: `{ ok: true, sessionId: string, projectId: string }`
- **Response `400`**: `{ ok: false, error: "missing projectId" }`
- **Response `403`** (prod only): `{ error: "Origin not allowed" }` — Origin/Referer
  did not match the project's `siteUrl`, the dashboard's own origin, or localhost
- **Response `404`**: `{ ok: false, error: "unknown project" }` — no project matched
  `id` or `trackingId`
- **CORS**: dev → `Access-Control-Allow-Origin: *`; prod → reflects the allowed
  Origin with `Vary: Origin`
- **curl**:
  ```bash
  curl -X POST http://localhost:3000/api/track/events \
    -H "Content-Type: application/json" \
    -d '{"projectId":"<id>","visitorId":"v_test","sessionId":"s_test",
         "events":[{"type":"pageview","t":0,"x":0,"y":0,"scrollX":0,"scrollY":0,
         "viewportWidth":1440,"viewportHeight":900,"pageUrl":"/","data":{}}]}'
  ```

### `OPTIONS /api/track/events`
Preflight handler. Dev → `Access-Control-Allow-Origin: *`. Prod → reflects the
dashboard's own origin only (OPTIONS has no body so we cannot resolve a `projectId`
to look up `siteUrl`). Always emits `Access-Control-Allow-Methods: POST, OPTIONS` and
`Access-Control-Allow-Headers: Content-Type`.

### `GET /api/track/script`
Serve the standalone tracking SDK as JavaScript. The SDK self-initialises on load —
captures mouse moves, clicks, scrolls, keypresses, errors, UTM params, referrer; opens
a WebSocket to the dashboard host for live cursor streaming; flushes events to
`/api/track/events` every 4s or 40 events.

- **Auth**: none (origin-validated in production)
- **Query params**:
  - `pid` (required) — project `id` or `trackingId`
  - `port` (optional, default `3004`) — the live-service port to send `XTransformPort`
- **Response `200`**: `Content-Type: application/javascript; charset=utf-8`,
  `Cache-Control: no-store`. Body is the SDK source.
- **CORS**: same as `/api/track/events` — dev → `*`; prod → reflects allowed Origin
- **curl**:
  ```bash
  curl "http://localhost:3000/api/track/script?pid=<id>" -o insight-replay.js
  ```

---

## Projects

### `GET /api/projects`
List all projects, newest first, with session counts.

- **Auth**: none
- **Response**: `{ projects: Array<Project & { _count: { sessions: number } }> }`

### `POST /api/projects`
Create a project. `trackingId` is auto-generated (cuid).

- **Auth**: none
- **Body**: `{ name: string, siteUrl?: string }` — `name` required
- **Response `200`**: `{ project: Project }`
- **Response `400`**: `{ error: "name required" }`

### `GET /api/projects/[id]`
Get a single project + aggregate session counts.

- **Auth**: none
- **Response `200`**: `{ project: Project, counts: { _count: number, _sum: { totalClicks: number, pageViewsCount: number } } }`
- **Response `404`**: `{ error: "not found" }`

### `DELETE /api/projects/[id]`
Delete a project. Cascades to all related rows (sessions, events, insights, funnels,
goals, segments, alerts, dashboards, experiments, annotations, apiKeys).

- **Auth**: none (intentionally — only the demo can call this without an API key)
- **Response `200`**: `{ ok: true }`

---

## Sessions

### `GET /api/projects/[id]/sessions`
List sessions for a project in the date range, with optional filtering.

- **Auth**: none
- **Query params**:
  - `range` (default `7`) — days
  - `q` (optional) — substring search across `country`, `city`, `browser`, `os`,
    `device`, `visitorId`
  - `filter` (optional, default `all`) — one of `all` | `rage` | `dead` | `active`
- **Response**: `{ sessions: Session[] }` (max 100, ordered by `startedAt desc`)

### `GET /api/projects/[id]/sessions/[sid]`
Get a single session with all its events (parsed `data` JSON) and insights.

- **Auth**: none
- **Response `200`**:
  ```jsonc
  {
    "session": Session,
    "events": Array<Event & { data: object }>,   // up to 5000, ordered by t asc
    "insights": Insight[]                        // ordered by timestamp asc
  }
  ```
- **Response `404`**: `{ error: "not found" }`

### `GET /api/projects/[id]/sessions/[sid]/bookmark`
Check whether a session is bookmarked.

- **Response**: `{ bookmarked: boolean, bookmark: Bookmark | null }`

### `POST /api/projects/[id]/sessions/[sid]/bookmark`
Toggle the bookmark on a session (delete if exists, otherwise create with `projectId`).

- **Response**: `{ bookmarked: false }` or `{ bookmarked: true, bookmark: Bookmark }`

### `GET /api/projects/[id]/sessions/[sid]/notes`
List notes for a session, ordered by `t` asc.

- **Response**: `{ notes: Note[] }`

### `POST /api/projects/[id]/sessions/[sid]/notes`
Create a note pinned to a timestamp `t`.

- **Body**: `{ text: string, t?: number, author?: string }` — `text` required;
  `t` defaults to `0`; `author` defaults to `"analyst"`
- **Response `200`**: `{ note: Note }`
- **Response `400`**: `{ error: "text required" }`

### `GET /api/projects/[id]/sessions/[sid]/tags`
List tags for a session, ordered by `createdAt` asc.

- **Response**: `{ tags: Tag[] }`

### `POST /api/projects/[id]/sessions/[sid]/tags`
Create a tag (upsert on `[sessionId, label]`). Idempotent — re-posting the same label
returns the existing tag.

- **Body**: `{ label: string, color?: string }` — `label` required; `color` defaults to
  `"primary"`
- **Response `200`**: `{ tag: Tag }`
- **Response `400`**: `{ error: "label required" }`

### `DELETE /api/projects/[id]/sessions/[sid]/tags/[tid]`
Delete a single tag by id.

- **Response `200`**: `{ ok: true }`

---

## Analytics

### `GET /api/projects/[id]/stats`
Aggregate stats for a project in the date range. **This is the most expensive endpoint
in the app** — see ADR-0005 for the caching layer applied to it.

- **Auth**: none
- **Query params**: `range` (default `7`)
- **Response `200`**:
  ```jsonc
  {
    "range": 7,
    "totals": {
      "totalSessions": 80, "activeNow": 2, "totalClicks": 412, "totalPages": 187,
      "avgDuration": 47, "rageClicks": 12, "deadClicks": 14, "errors": 6,
      "uniqueVisitors": 53, "newVisitors": 21, "returningVisitors": 59,
      "conversions": 8, "conversionRate": 10, "bounceRate": 41
    },
    "daily": [ { "date": "2025-01-15", "sessions": 12, "clicks": 60, "pages": 30 }, /* … */ ],
    "device":  [ { "name": "desktop", "value": 56 }, /* … */ ],
    "browser": [ { "name": "Chrome",  "value": 48 }, /* … */ ],
    "os":      [ { "name": "Windows", "value": 30 }, /* … */ ],
    "country": [ { "name": "US",      "value": 25 }, /* … (top 8) */ ],
    "referrer":[ { "name": "google.com", "value": 26 }, /* … (top 8) */ ],
    "utmSource":[ { "name": "google", "value": 26 }, /* … (top 8) */ ],
    "entryPages":[ { "name": "/", "value": 30 }, /* … (top 6) */ ],
    "exitPages": [ { "name": "/pricing", "value": 18 }, /* … (top 6) */ ],
    "topPages": [ { "url": "/", "views": 64 }, /* … (top 8) */ ]
  }
  ```

### `GET /api/projects/[id]/heatmap`
Heatmap points (click / move / scroll-depth) for a single page URL.

- **Query params**:
  - `url` (default `/`) — page path
  - `range` (default `7`)
  - `kind` (default `click`) — one of `click` | `move` | `scroll`
- **Response for `kind=click|move`**:
  ```jsonc
  { "kind": "click", "url": "/", "points": [ { "x": 720, "y": 540, "sy": 0 }, /* … */ ], "count": 312 }
  ```
  (`y` is `event.y + event.scrollY` so points are in absolute page coordinates)
- **Response for `kind=scroll`**:
  ```jsonc
  { "kind": "scroll", "url": "/", "max": 2400, "buckets": [0,5,12,/* 20 buckets */], "count": 218 }
  ```

### `GET /api/projects/[id]/journeys`
Build a Sankey-style flow graph of page transitions across sessions.

- **Query params**:
  - `range` (default `7`)
  - `source` (optional) — filter to sessions whose first page equals this URL
  - `maxNodes` (default `12`) — cap on number of URL nodes
- **Response `200`**:
  ```jsonc
  {
    "range": 7, "source": null, "maxNodes": 12, "totalSessions": 80,
    "nodes": [ { "id": "__start__", "name": "Start", "virtual": true },
               { "id": "__exit__",  "name": "Exit",  "virtual": true },
               { "id": "/", "name": "/", "virtual": false } /* … */ ],
    "links": [ { "source": "__start__", "target": "/", "value": 30 },
               { "source": "/", "target": "/pricing", "value": 12 },
               { "source": "/pricing", "target": "__exit__", "value": 8 } /* … */ ],
    "starts": [ { "url": "/", "count": 30 }, /* … */ ],
    "ends":   [ { "url": "/pricing", "count": 18 }, /* … */ ],
    "topPaths":[ { "path": "/ > /pricing > /signup", "count": 3 }, /* … (top 8) */ ]
  }
  ```

### `GET /api/projects/[id]/retention`
Cohort retention matrix.

- **Query params**:
  - `range` (default `30`) — total window in days
  - `cohortSize` (default `7`) — cohort bucket size in days
- **Response `200`**:
  ```jsonc
  {
    "range": 30, "cohortSize": 7, "totalVisitors": 65,
    "newVisitors": 24, "returningVisitors": 41, "avgRetention": 0.18, "cohortCount": 5,
    "cohorts": [
      {
        "cohortIndex": 0, "cohortStart": "2025-01-01", "size": 12,
        "periods": [
          { "periodIndex": 0, "retained": 12, "rate": 1 },
          { "periodIndex": 1, "retained": 3,  "rate": 0.25 },
          /* … */
        ]
      }
      /* … */
    ]
  }
  ```
  (Period 0 is always 100% by construction.)

### `GET /api/projects/[id]/compare`
Compare two consecutive date ranges of equal length.

- **Query params**: `range` (default `7`) — length of each period in days. Period A
  = last `range` days; Period B = the `range` days before Period A.
- **Response `200`**:
  ```jsonc
  {
    "range": 7,
    "current":  { /* Stats + daily: totalSessions, totalClicks, totalPages,
                     uniqueVisitors, avgDuration, bounceRate, rageClicks,
                     deadClicks, errors, conversions, daily[] */ },
    "previous": { /* Stats only (no daily) */ },
    "deltas":   { /* per-metric { abs: number, pct: number } */ }
  }
  ```
  (Pct guards divide-by-zero: returns `100` when previous=0 and current≠0, `0` when
  both are 0.)

### `GET /api/projects/[id]/realtime`
Per-minute active-user series for the last 60 minutes. **Not cached** — this endpoint
is intentionally always fresh (see ADR-0005).

- **Auth**: none
- **Response `200`**:
  ```jsonc
  {
    "activeNow": 3,
    "visitorsLast5Min": 7,
    "pagesViewedLast5Min": 4,
    "topActivePages": [ { "url": "/", "views": 12 }, /* … (top 5) */ ],
    "series": [ { "minute": "09:01", "users": 2 }, /* … 60 buckets oldest→newest */ ]
  }
  ```

### `GET /api/projects/[id]/insights`
List frustration signals (rage_click, dead_click, excessive_scroll, quick_back) for a
project.

- **Query params**: `range` (default `7`)
- **Response `200`**:
  ```jsonc
  {
    "insights": Array<Insight & { data: object, session: { id, country, city, browser, device, startedAt } }>,
    "counts": { "rage_click": 12, "dead_click": 14, "excessive_scroll": 6, "quick_back": 4 }
  }
  ```
  (max 200, ordered by `timestamp desc`; `data` JSON parsed for convenience)

### `GET /api/projects/[id]/errors`
List JS errors for a project + aggregates.

- **Query params**:
  - `range` (default `7`)
  - `sessionId` (optional) — filter to a single session
- **Response `200`**:
  ```jsonc
  {
    "errors": Array<ErrorEvent & { session: { id, visitorId, country, city, browser, device, startedAt } }>,
    "aggregate": {
      "total": 6,
      "byType": { "js": 6 },
      "byUrl": [ { "url": "/pricing", "count": 3 }, /* … (top 8) */ ],
      "affectedSessions": 5,
      "daily": [ { "date": "2025-01-15", "count": 2 }, /* … */ ]
    }
  }
  ```
  (max 200 errors, ordered by `timestamp desc`)

---

## Visitors

### `GET /api/projects/[id]/visitors`
List unique visitors in the date range with aggregated stats.

- **Query params**:
  - `range` (default `7`)
  - `q` (optional) — substring search on `visitorId`
- **Response `200`**: `{ visitors: VisitorSummary[] }` (max 100, ordered by
  `lastSeen desc`)
  - Each `VisitorSummary` includes: `visitorId`, `sessionCount`, `firstSeen`,
    `lastSeen`, `totalClicks`, `totalPages`, `totalDuration`, `avgDuration`,
    `device` (most common), `browser`, `os`, `country`, `city`,
    `isNewVisitor` (true only if 1 session AND session's flag is true),
    `convertedGoal` (first non-empty), `tags` (distinct labels across all sessions).

### `GET /api/projects/[id]/visitors/[vid]`
Get a single visitor's profile (all sessions in this project).

- **Response `200`**:
  ```jsonc
  {
    "visitorId": "v_xxxxxxxx",
    "totalSessions": 4, "totalClicks": 28, "totalPages": 12,
    "totalDuration": 320, "avgDuration": 80,
    "firstSeen": "2025-01-10T…", "lastSeen": "2025-01-20T…",
    "conversionCount": 1,
    "devices": ["desktop"], "browsers": ["Chrome"], "oses": ["Windows"],
    "countries": ["US"], "cities": ["Unknown"],
    "tags": ["rage-monkey", "high-value"],
    "sessions": [ /* full session summaries incl. UTM, referrer, entry/exit,
                     frustration flags, tags, notes */ ]
  }
  ```
- **Response `404`**: `{ error: "visitor not found", visitor: null }` — visitor has no
  sessions in this project

### `DELETE /api/projects/[id]/visitors/[vid]/erase`
GDPR Article 17 — Right to Erasure ("Right to be Forgotten"). Deletes ALL sessions
belonging to visitor `[vid]` in project `[id]`, cascading to events, insights,
errors, notes, tags, bookmarks via Prisma's `onDelete: Cascade` relations on Session.
After this call returns, no analytics data remains for that visitor within the
project.

- **Auth**: **session cookie required** (via `verifyProjectAccess(id)` — 401 if no
  session, 404 if project unknown) AND, in production, a valid API key for the
  project (`Authorization: Bearer ir_…` or `?apikey=ir_…`). Dev: API key not required
  so the dashboard can exercise erasure locally.
- **Body**: none
- **Response `200`**: `{ ok: true, deletedSessions: number, visitorId: string }`
- **Response `400`**: `{ ok: false, error: { code: "BAD_REQUEST", message: "Invalid project id" | "Invalid visitor id" } }`
  (cuid-shaped IDs only, ≤ 64 / 200 chars)
- **Response `401`** (no session): `{ error: "Unauthorized" }`
- **Response `404`** (project not found): `{ error: "Not found" }`
- **Audit**: writes a `gdpr_erasure` entry to `logs/audit.jsonl` capturing the
  project, masked visitor id (`<first 8 chars>...` — the full visitor id is itself
  personal data, so we don't re-persist it in the audit trail), count of deleted
  sessions, and caller IP
- **curl**:
  ```bash
  # Dev (no API key):
  curl -X DELETE http://localhost:3000/api/projects/<id>/visitors/v_xxxxxxxx/erase \
       --cookie "ir_session=<cookie>"
  # Production (API key):
  curl -X DELETE -H "Authorization: Bearer ir_xxxxxxxxxxxx" \
       http://localhost:3000/api/projects/<id>/visitors/v_xxxxxxxx/erase \
       --cookie "ir_session=<cookie>"
  ```

---

## Goals, Alerts, Experiments

### Goals

#### `GET /api/projects/[id]/goals`
List goals with per-goal conversion stats computed in-range.

- **Query params**: `range` (default `7`)
- **Response `200`**:
  ```jsonc
  {
    "goals": Array<Goal & {
      conversions: number,        // count of sessions with convertedGoal===name OR (url-type) entry/exit match
      conversionRate: number,     // % to 1 decimal place
      value: number               // conversions * goal.value, rounded to 2 decimals
    }>,
    "totalSessions": number
  }
  ```

#### `POST /api/projects/[id]/goals`
Create a goal.

- **Body**: `{ name: string, type?: "url"|"event", match?: "equals"|"startsWith"|"contains", url?: string, eventName?: string, value?: number }`
  - `name` required. Defaults: `type="url"`, `match="contains"`, `value=0`.
- **Response `200`**: `{ goal: Goal }`
- **Response `400`**: `{ error: "name required" }`

#### `DELETE /api/projects/[id]/goals/[gid]`
Delete a goal (scoped to `id` + `gid` for safety).

- **Response `200`**: `{ ok: true }`

### Segments

#### `GET /api/projects/[id]/segments`
List saved segments (filters JSON parsed on read).

- **Response `200`**: `{ segments: Array<Segment & { filters: object }> }`

#### `POST /api/projects/[id]/segments`
Create a segment.

- **Body**: `{ name: string, filters?: object }` — `name` required; `filters` defaults
  to `{}`
- **Response `200`**: `{ segment: Segment & { filters: object } }`
- **Response `400`**: `{ error: "name required" }`

#### `DELETE /api/projects/[id]/segments/[gid]`
Delete a segment.

- **Response `200`**: `{ ok: true }`

### Funnels

#### `GET /api/projects/[id]/funnels`
List funnels (steps JSON parsed on read).

- **Response `200`**: `{ funnels: Array<Funnel & { steps: Array<{url, name}> }> }`

#### `POST /api/projects/[id]/funnels`
Create a funnel.

- **Body**: `{ name: string, steps?: Array<{ url: string, name: string }> }` — `name`
  required; `steps` defaults to `[]`
- **Response `200`**: `{ funnel: Funnel & { steps: Array<{url, name}> } }`
- **Response `400`**: `{ error: "name required" }`

#### `GET /api/projects/[id]/funnels/[fid]`
Get a single funnel.

- **Response `200`**: `{ funnel: Funnel & { steps: Array<{url, name}> } }`
- **Response `404`**: `{ error: "not found" }`

#### `DELETE /api/projects/[id]/funnels/[fid]`
Delete a funnel (scoped to `id` + `fid`).

- **Response `200`**: `{ ok: true }`

#### `GET /api/projects/[id]/funnels/[fid]/analyze`
Sequential funnel conversion analysis. Algorithm: fetch all `pageview` events in range
ordered by `[sessionId asc, t asc]`; per session, dedupe consecutive duplicate URLs;
sequentially match each step (step 0 anywhere; step i at a position strictly after step
i-1's matched position). Compute per-step counts, dropoff, completion rate, and median
time between consecutive steps from fully-completed sessions.

- **Query params**: `range` (default `7`)
- **Response `200`**:
  ```jsonc
  {
    "funnel": Funnel & { steps: Array<{url, name}> },
    "steps": [
      { "name": "Homepage", "url": "/", "count": 80, "rate": 1.00, "dropoff": 0, "dropoffPct": 0 },
      { "name": "Pricing",  "url": "/pricing", "count": 23, "rate": 0.2875, "dropoff": 57, "dropoffPct": 71.25 },
      { "name": "Signup",   "url": "/signup", "count": 3, "rate": 0.0375, "dropoff": 20, "dropoffPct": 86.96 }
    ],
    "totalSessions": 80,
    "completionRate": 0.0375,
    "medianStepTimes": [ null, 8200, 14300 ]   // ms between consecutive steps; null when no completions
  }
  ```
- **Response `404`**: `{ error: "not found" }` — funnel not found OR has zero steps
  returns the success shape with empty arrays

### Alerts

#### `GET /api/projects/[id]/alerts`
List alerts, newest first, with the count of history entries per alert.

- **Response `200`**: `{ alerts: Array<Alert & { _count: { history: number } }> }`

#### `POST /api/projects/[id]/alerts`
Create an alert.

- **Body**: `{ name: string, metric?, condition?, threshold?, windowMin?, channel?, webhookUrl? }`
  - `name` required.
  - `metric` validated against `["sessions","rageClicks","errors","conversions","bounceRate","avgDuration"]` (default `"sessions"`)
  - `condition` validated against `["gt","lt","drops","spikes"]` (default `"gt"`)
  - `channel` validated against `["inapp","webhook"]` (default `"inapp"`)
  - `windowMin` defaults to `60`; `threshold` defaults to `0`
- **Response `200`**: `{ alert: Alert & { _count: { history: number } } }`
- **Response `400`**: `{ error: "name required" }`

#### `PATCH /api/projects/[id]/alerts/[aid]`
Partial update an alert. Only fields present in the body (and that pass enum
validation) are written; invalid enum values are silently ignored, never crash.

- **Body**: any subset of `{ name, metric, condition, threshold, windowMin, channel, webhookUrl, enabled }`
- **Response `200`**: `{ alert: Alert & { _count: { history: number } } }`
- **Response `404`**: `{ error: "alert not found" }`

#### `DELETE /api/projects/[id]/alerts/[aid]`
Delete an alert (cascades to its history).

- **Response `200`**: `{ ok: true }`

#### `GET /api/projects/[id]/alerts/[aid]/evaluate`
Run the alert's threshold / spike / drop algorithm against the last `windowMin` minutes
of sessions and write an `AlertHistory` row if triggered.

- **Response `200` (not triggered)**: `{ triggered: false, value: number }`
- **Response `200` (triggered)**:
  ```jsonc
  {
    "triggered": true,
    "value": 130,
    "message": "sessions spiked from 77 to 130 (+68.8%) in the last 1440m",
    "historyId": "ch_xxxxxxxx"
  }
  ```
- **Response `404`**: `{ error: "alert not found" }`

  Logic:
  - `gt` — `currentValue > threshold`
  - `lt` — `currentValue < threshold`
  - `spikes` — compares current window to previous equal window; triggers if
    `current > prev * (1 + threshold/100)`
  - `drops` — triggers if `current < prev * (1 - threshold/100)`
  - Metric computation: `sessions`=count, `rageClicks`=count(hasRageClick),
    `errors`=count(hasError), `conversions`=count(convertedGoal≠""), `bounceRate`=pct
    (pageViewsCount≤1, 2 decimals), `avgDuration`=avg(duration).

#### `GET /api/projects/[id]/alerts/history`
List alert history entries for the project (any alert), newest first.

- **Response `200`**: `{ history: Array<AlertHistory & { alert: { id, name, metric, condition } }> }`
  (max 50)

#### `PATCH /api/projects/[id]/alerts/history/[hid]`
Acknowledge a history entry.

- **Response `200`**: `{ history: AlertHistory }` (with `acknowledged: true`)
- **Response `404`**: `{ error: "history entry not found" }`

### Annotations

#### `GET /api/projects/[id]/annotations`
List annotations for a project, ordered by `date desc`.

- **Response `200`**: `{ annotations: Annotation[] }`

#### `POST /api/projects/[id]/annotations`
Create an annotation.

- **Body**: `{ date: string (ISO), text: string, color?: string, author?: string }`
  - `text` and `date` required. `date` must parse to a valid Date.
  - Defaults: `color="primary"`, `author="analyst"`
- **Response `200`**: `{ annotation: Annotation }`
- **Response `400`**: `{ error: "text required" }` | `{ error: "date required" }` | `{ error: "invalid date" }`

#### `DELETE /api/projects/[id]/annotations/[anid]`
Delete an annotation (scoped to `id` + `anid`).

- **Response `200`**: `{ ok: true }`

### Experiments

#### `GET /api/projects/[id]/experiments`
List experiments (variants JSON parsed on read).

- **Response `200`**: `{ experiments: Array<Experiment & { variants: VariantDef[] }> }`

#### `POST /api/projects/[id]/experiments`
Create an experiment.

- **Body**: `{ name: string, hypothesis?: string, variants?: VariantDef[], goalName?: string, status?: "draft"|"running"|"completed" }`
  - `name` required. `variants` defaults to `[]`. `status` validated against the enum
    (default `"draft"`).
- **Response `200`**: `{ experiment: Experiment & { variants: VariantDef[] } }`
- **Response `400`**: `{ error: "name required" }`

  Where `VariantDef = { name: string, weight: number, description?: string }`.

#### `GET /api/projects/[id]/experiments/[eid]`
Get a single experiment.

- **Response `200`**: `{ experiment: Experiment & { variants: VariantDef[] } }`
- **Response `404`**: `{ error: "not found" }`

#### `PATCH /api/projects/[id]/experiments/[eid]`
Partial update an experiment.

- **Body**: any subset of `{ name, hypothesis, variants, goalName, status, endDate }`
  - `status` validated against `["draft","running","completed"]`
  - `endDate` accepts an ISO string OR `null` to clear it
- **Response `200`**: `{ experiment: Experiment & { variants: VariantDef[] } }`
- **Response `404`**: `{ error: "not found" }`

#### `DELETE /api/projects/[id]/experiments/[eid]`
Delete an experiment.

- **Response `200`**: `{ ok: true }`

#### `GET /api/projects/[id]/experiments/[eid]/analyze`
A/B test analyzer with two-proportion z-test.

- **Response `200`**:
  ```jsonc
  {
    "experiment": Experiment & { variants: VariantDef[] },
    "variants": [
      { "name": "control", "description": "Green CTA", "sessions": 30,
        "conversions": 1, "conversionRate": 3.33, "avgDuration": 47000, "avgClicks": 4.2,
        "z": null, "pValue": null, "significant": false, "lift": null },
      { "name": "variant_a", "description": "Orange CTA", "sessions": 30,
        "conversions": 3, "conversionRate": 10.00, "avgDuration": 52000, "avgClicks": 5.1,
        "z": 1.05, "pValue": 0.294, "significant": false, "lift": 200.0 }
    ],
    "winner": null,                  // variant name if a significant winner exists
    "isSignificant": false,          // any variant significant
    "totalSessions": 60
  }
  ```
  (`z`/`pValue`/`lift` are `null` for the control variant; significance threshold
  `p < 0.05`; lift = `(p2-p1)/p1*100`, guarded for `p1=0`.)
- **Response `404`**: `{ error: "not found" }`

---

## Dashboards

### `GET /api/projects/[id]/dashboards`
List custom dashboards, newest-updated first.

- **Response `200`**: `{ dashboards: Array<Dashboard & { layout: Widget[] }> }`

### `POST /api/projects/[id]/dashboards`
Create a custom dashboard.

- **Body**: `{ name: string, layout?: Widget[] }` — `name` required; `layout` defaults
  to `[]`
- **Response `200`**: `{ dashboard: Dashboard & { layout: Widget[] } }`
- **Response `400`**: `{ error: "name required" }`

  Where `Widget = { id, type: "metric"|"chart"|"table", title?, metric?, chart?: "area"|"pie"|"bar", table?: "topPages"|"referrer"|"country", w?, h?, x?, y? }`.

### `GET /api/projects/[id]/dashboards/[did]`
Get a single dashboard.

- **Response `200`**: `{ dashboard: Dashboard & { layout: Widget[] } }`
- **Response `404`**: `{ error: "not found" }`

### `PUT /api/projects/[id]/dashboards/[did]`
Update a dashboard's name and/or layout (only fields present in the body are written).

- **Body**: `{ name?: string, layout?: Widget[] }`
- **Response `200`**: `{ dashboard: Dashboard & { layout: Widget[] } }`
- **Response `404`**: `{ error: "not found" }`

### `DELETE /api/projects/[id]/dashboards/[did]`
Delete a dashboard.

- **Response `200`**: `{ ok: true }`

### `GET /api/projects/[id]/dashboards/[did]/data`
One-shot widget data aggregator — computes the payload for every widget in the layout
in a single call (1 session query + 1 conditional pageview groupBy for `topPages`
widgets).

- **Query params**: `range` (default `7`)
- **Response `200`**:
  ```jsonc
  {
    "dashboard": Dashboard & { layout: Widget[] },
    "widgets": {
      "<widgetId>": {
        "data": {
          // type="metric": { value: number, label: string }
          // type="chart" chart="area": Array<{ date, sessions, errors }>
          // type="chart" chart="pie":  Array<{ name, value }> (device breakdown)
          // type="chart" chart="bar":  Array<{ date, count }> (daily errors) OR
          //                            Array<{ name, value }> (browser when widget.metric==="browser")
          // type="table" table="topPages": Array<{ url, views }>
          // type="table" table="referrer": Array<{ name, value }>
          // type="table" table="country":  Array<{ name, value }>
        }
      }
      // …one entry per widget in layout
    }
  }
  ```
  Also exposes a top-level `metricValues` map (totalSessions, conversions, rageClicks,
  errors, avgDuration, bounceRate, activeNow, uniqueVisitors) for quick reference.
- **Response `404`**: `{ error: "not found" }`

---

## AI

All three AI routes use `z-ai-web-dev-sdk` lazily imported server-side. They return
HTTP `200` with an `error` field on any failure so the UI can show a fallback without
crashing. See ADR-0003 for the full design.

### `GET /api/projects/[id]/ai`
Project-level AI analysis. Compiles totals, top pages, breakdowns, daily series, and
recent frustration signals into a description, then asks the LLM for a markdown
analysis with sections `## Overview`, `## Key trends`, `## Frustration signals`,
`## Top opportunities`, `## Recommended actions`.

- **Auth**: none
- **Query params**: `range` (default `7`)
- **Response `200` (success)**: `{ analysis: string }` — markdown
- **Response `200` (failure)**: `{ analysis: null, error: string }` — LLM/network
  error swallowed; UI shows fallback copy
- **curl**:
  ```bash
  curl "http://localhost:3000/api/projects/<id>/ai?range=7"
  ```

### `POST /api/projects/[id]/ai/session`
Per-session AI analysis. Compiles visitor info, environment, page flow, click targets,
scroll depth, frustration signals, and JS errors into a compact description, then asks
the LLM for a markdown analysis with sections `## Summary`, `## What happened`,
`## Pain points`, `## Recommendations`.

- **Auth**: none
- **Body**: `{ sessionId: string }`
- **Response `200` (success)**: `{ analysis: string }` — markdown
- **Response `200` (failure)**: `{ analysis: null, error: string }` — possible errors:
  `"invalid body"`, `"sessionId required"`, `"session not found"`,
  `"session does not belong to project"`, or the LLM error message
- **curl**:
  ```bash
  curl -X POST http://localhost:3000/api/projects/<id>/ai/session \
    -H "Content-Type: application/json" \
    -d '{"sessionId":"s_xxxxxxxx"}'
  ```

### `POST /api/projects/[id]/ai-search`
Natural-language session search. Sends the query + the available filter fields to the
LLM with a strict "JSON only" system prompt; strips markdown fences; parses the result
into a Prisma `where` clause; returns the matching sessions.

- **Auth**: none
- **Body**: `{ query: string, range?: number }` — `range` default `7`
- **Response `200` (success)**:
  ```jsonc
  {
    "filters": {                          // parsed by the LLM
      "device": "mobile",
      "hasRageClick": true,
      "rangeDays": 7
    },
    "sessions": SessionSummary[],         // up to 200, ordered by startedAt desc
    "count": 3
  }
  ```
  Each `SessionSummary` has 21 fields: id, visitorId, startedAt, lastActiveAt,
  duration, isActive, totalClicks, pageViewsCount, hasRageClick, hasDeadClick,
  hasError, convertedGoal, entryUrl, exitUrl, isNewVisitor, device, browser, os,
  country, city, utmSource, referrer.
- **Response `200` (failure)**: `{ filters: null | ParsedFilters, sessions: [], count: 0, error: string }`
- **curl**:
  ```bash
  curl -X POST http://localhost:3000/api/projects/<id>/ai-search \
    -H "Content-Type: application/json" \
    -d '{"query":"mobile users who raged on pricing last week"}'
  ```

---

## Auth & CSRF

These are the unauthenticated (or pre-auth) endpoints that mint, verify, and clear
the dashboard's session cookie and CSRF token. The middleware's session-cookie gate
(Layer 4 in `src/middleware.ts`) exempts `/api/auth/*` and `/api/csrf-token` so they
can run before any session exists; everything else under `/api/*` requires the
`ir_session` cookie to be present and structurally well-formed (the cryptographic
HMAC verify still happens server-side in `getSession()`).

### Authentication

#### `POST /api/auth/login`
Verify email + password and mint a signed `ir_session` cookie. Three layered
defenses on top of the credential check itself:

1. **Per-IP rate limit** (5 req/min, `LOGIN_LIMIT`) — caps throughput.
2. **Proof-of-Work** (single-use challenge, 60s TTL) — adds per-request CPU cost so
   an attacker rotating IPs must dedicate real compute to each guess.
3. **Per-email+IP lockout** (5 consecutive fails → 15-min cool-down,
   `LOCKOUT_POLICY`) — caps accumulated failures across minutes.

The PoW is checked BEFORE body parsing / lockout because it doesn't depend on the
body, rejects unauthenticated brute-force at the cheapest possible point, and a PoW
failure does NOT increment the per-email lockout counter (we don't have an email yet,
and a PoW failure isn't a credential guess — it's "this client didn't even solve the
puzzle").

- **Auth**: none (this IS the auth endpoint)
- **Rate limit**: 5 req/min/IP; 429 + `Retry-After: 60`
- **PoW headers**: `x-pow-challenge` (32-char hex, from `GET /api/auth/login/pow` or
  piggy-backed on `GET /api/csrf-token`) + `x-pow-nonce` (the value the client found
  such that `SHA-256(challenge + nonce)` starts with `difficulty` zero hex chars).
  Header names are exported as `POW_CHALLENGE_HEADER` / `POW_NONCE_HEADER`
  constants.
- **Body**: `{ email: string, password: string }` — both required; `email` is
  trimmed
- **Response `200`**: `{ ok: true, user: { id, email, name, role } }` — sets
  `ir_session` cookie (httpOnly, secure in prod, sameSite=strict, path=/, 7d maxAge,
  IP + optional device-fp bound via the `x-device-fp` header)
- **Response `400`**: `{ ok: false, error: "Invalid request body" | "Email and password are required" }`
- **Response `401`**: `{ ok: false, error: "Invalid credentials", pow: { challenge, difficulty, timestamp } }`
  — same shape regardless of whether the email exists (no user enumeration; a dummy
  hash is verified when the user is missing to keep response time roughly constant)
- **Response `403`**: `{ ok: false, error: "Proof of work required", pow: { challenge, difficulty, timestamp } }`
  — challenge was missing/invalid/expired/reused; the fresh challenge in the body
  lets the client solve + retry without a separate round-trip
- **Response `429`**: `{ ok: false, error: "Too many login attempts…" | "Account locked. Try again in Ns." }`
  + `Retry-After: <sec>`
- **curl**:
  ```bash
  curl -X POST http://localhost:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -H "x-pow-challenge: <challenge>" \
    -H "x-pow-nonce: <nonce>" \
    -d '{"email":"admin@example.com","password":"correct-horse"}'
  ```

#### `GET /api/auth/login/pow`
Mint a fresh single-use Proof-of-Work challenge for the login flow. Stored in the
in-memory cache (`src/lib/pow.ts`, 60s TTL). Piggy-backed on `GET /api/csrf-token`
so a client that already fetched the CSRF token can skip this round-trip — the
dedicated endpoint exists so the login form can mint a challenge on-demand only when
the user is about to submit (avoids minting challenges on every dashboard refresh).

- **Auth**: none
- **Rate limit**: 30 req/min/IP (`POW_MINT_LIMIT`); 429 + `Retry-After: 60`
- **Response `200`**: `{ ok: true, challenge: string, difficulty: number, timestamp: number, expiresIn: 60 }`
- **curl**:
  ```bash
  curl http://localhost:3000/api/auth/login/pow
  ```

#### `POST /api/auth/logout`
Delete the session cookie. Idempotent — calling when already logged out returns 200.
Session-clearing is layered for defense-in-depth: `clearSession()` (the canonical
`next/headers` `cookies()` mutation) AND an explicit `res.cookies.delete + set` with
hardened options (httpOnly/sameSite=strict/secure/path) so the EXPIRED cookie the
browser stores carries the same security flags as the live one (a cookie cleared via
`.delete()` without httpOnly could be re-written by an XSS and survive as a fixation
vector).

- **Auth**: none (the middleware does NOT require a session cookie for `/api/auth/*`)
- **Body**: none
- **Response `200`**: `{ ok: true }` — sets `ir_session=` with `Max-Age=0` + the
  hardened cookie options above. Even on the error path, the cookie is cleared — a
  half-failed logout MUST NOT leave a valid session cookie on the client.
- **curl**:
  ```bash
  curl -X POST http://localhost:3000/api/auth/logout
  ```

#### `GET /api/auth/me`
Return the currently-logged-in user's public profile, or 401 if no session (or the
session is invalid/expired). The frontend uses this on dashboard mount to decide
whether to redirect to `/login`. Fetches the user from the DB (not just the cookie
payload) so a deleted user or a changed email/role surfaces immediately.

- **Auth**: session cookie (HMAC-verified server-side by `getSession()`)
- **Response `200`**: `{ ok: true, user: { id, email, name, role } }` — `email` is
  decrypted from AES-256-GCM ciphertext stored in the DB (`decryptField`)
- **Response `401`**: `{ ok: false, error: "Unauthorized" }` — also returned if the
  user was deleted after the session was issued
- **curl**:
  ```bash
  curl http://localhost:3000/api/auth/me --cookie "ir_session=<cookie>"
  ```

#### `GET /api/auth/setup`
Probe whether first-admin bootstrap is still available (i.e. zero users exist in the
DB). Does NOT create anything; safe to call repeatedly. The login page uses this to
decide whether to render the "Create admin account" link.

- **Auth**: none
- **Response `200`**: `{ ok: true, setupAvailable: boolean }` — `true` iff
  `db.user.count() === 0`
- **curl**:
  ```bash
  curl http://localhost:3000/api/auth/setup
  ```

#### `POST /api/auth/setup`
One-time first-admin bootstrap. Succeeds ONLY when zero users exist; once any user
exists, this endpoint always returns 409 (cannot be used to create additional admins).
Auto-issues a session cookie on success so the freshly-provisioned admin lands on the
dashboard without a separate login step.

Race-safety: count-then-create is wrapped in a Prisma interactive transaction, AND
the `User` table carries a `bootstrapLock @unique` constraint (see
`prisma/schema.prisma`). The first request that commits sets
`bootstrapLock = "TAKEN"`; any concurrent setup that also passed the count === 0
check before the first one committed will then fail its `user.create` with Prisma
error code P2002 (unique constraint violation), translated into a clean 409.

- **Auth**: none (this IS the bootstrap endpoint)
- **Rate limit**: 5 req/min/IP (`SETUP_LIMIT`); 429 + `Retry-After: 60`
- **Body**: `{ email: string, password: string, name?: string }`
  - `email` + `password` required; `email` shape validated
    (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`); `password` ≥ 8 chars
  - `name` optional (stored as `null` if absent)
- **Response `201`**: `{ ok: true, user: { id, name, role: "admin", email } }` —
  sets `ir_session` cookie (same hardened options as login). The `email` and
  `passwordHash` are AES-256-GCM encrypted before being written to the DB, so a raw
  filesystem read of `custom.db` reveals neither.
- **Response `400`**: `{ ok: false, error: "Invalid request body" | "Email and password are required" | "Invalid email format" | "Password must be at least 8 characters" }`
- **Response `409`**: `{ ok: false, error: "Setup is disabled — an admin account already exists. Use /api/auth/login instead." }`
- **curl**:
  ```bash
  curl -X POST http://localhost:3000/api/auth/setup \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@example.com","password":"correct-horse","name":"Ada"}'
  ```

### CSRF

#### `GET /api/csrf-token`
Mint a fresh CSRF token and set it as a `SameSite=strict` cookie (1h TTL). The
frontend echoes the token in the `x-csrf-token` header on every
POST/PUT/PATCH/DELETE; the middleware validates header-token == cookie-token
(double-submit pattern). Also piggy-backs a Proof-of-Work challenge
(`pow: { challenge, difficulty, timestamp, expiresIn }`) so the login form can skip
the `/api/auth/login/pow` round-trip.

- **Auth**: none (must be reachable pre-auth)
- **Response `200`**: `{ token: string, header: "x-csrf-token", cookie: "ir_csrf", pow: { challenge, difficulty, timestamp, expiresIn: 60 } }`
- **Cookie**: `ir_csrf=<token>; HttpOnly=false; SameSite=Strict; Secure=(prod only); Max-Age=3600; Path=/`
  (JS-readable so the client can echo the value in the header; security comes from
  `SameSite=strict` preventing cross-site cookie attachment, not from hiding the
  token from JS — an XSS already wins by reading both the cookie and the page DOM)
- **curl**:
  ```bash
  curl -c cookies.txt http://localhost:3000/api/csrf-token
  # Subsequent mutating requests echo the token from the cookie in the header:
  curl -b cookies.txt -H "x-csrf-token: <token>" -X POST \
       http://localhost:3000/api/projects -d '{"name":"x"}'
  ```

---

## Security & Auth

### `GET /api/projects/[id]/protected-test`
Demo endpoint proving the API-key auth middleware works. Returns 401 without/with a
bad key, 200 with a valid project-scoped key.

- **Auth**: **required** — `Authorization: Bearer ir_…` header OR `?apikey=ir_…` query
  param. The key is validated against the `ApiKey` Prisma model scoped to the project.
  `lastUsed` is updated fire-and-forget on success.
- **Response `200`**: `{ ok: true, message: "Authenticated", keyId: string }`
- **Response `401`**: `{ error: "Unauthorized: valid API key required" }`
- **curl**:
  ```bash
  # Header form:
  curl -H "Authorization: Bearer ir_xxxxxxxxxxxx" \
       http://localhost:3000/api/projects/<id>/protected-test
  # Query form:
  curl "http://localhost:3000/api/projects/<id>/protected-test?apikey=ir_xxxxxxxxxxxx"
  ```

### `GET /api/projects/[id]/apikeys`
List API keys for a project. **Never returns the full key** — only the masked form
`ir_••••XXXX` (last 4 chars visible).

- **Response `200`**: `{ apiKeys: Array<{ id, projectId, name, keyMasked, createdAt, lastUsed }> }`

### `POST /api/projects/[id]/apikeys`
Create an API key. The full key is returned **only once** on creation so the client can
display/copy it; subsequent reads via `GET` only show the masked form.

- **Body**: `{ name: string }` — `name` required
- **Response `200`**: `{ apiKey: { id, projectId, name, key, keyMasked, createdAt, lastUsed } }`
  (key format: `ir_<32 hex chars>`)
- **Response `400`**: `{ error: "name required" }`

### `DELETE /api/projects/[id]/apikeys/[kid]`
Revoke (delete) an API key (scoped to `id` + `kid`).

- **Response `200`**: `{ ok: true }`

### `GET /api/projects/[id]/audit`
Project-scoped audit log viewer. Reads a wider window of 500 entries from the file then
filters in memory by `projectId`.

- **Query params**: `limit` (default `100`, max `500`)
- **Response `200`**: `{ entries: AuditEntry[] }`
  Where `AuditEntry = { timestamp, action, projectId?, actor, ip, details }`.
  Canonical actions: `project_created`, `project_deleted`, `apikey_created`,
  `apikey_revoked`, `alert_created`, `alert_deleted`, `alert_triggered`,
  `data_exported`, `session_bookmarked`, `session_tagged`.

### Honeypot

#### `GET/POST/PUT/DELETE /api/trap/[...path]`
Honeypot trap. Any request to `/api/trap/*` auto-bans the requesting IP with an
escalating duration (1h → 24h → 7d → permanent) based on how many times this IP has
hit a trap before. These endpoints are NEVER linked from the UI — only automated
scanners/probes hit them. The four method handlers all funnel to the same logic
(the GET handler does the ban; POST/PUT/DELETE delegate to GET).

- **Auth**: none (intentionally — the goal is to draw in probes)
- **Path param**: `[...path]` — any trailing path (catch-all). The path content is
  ignored; only the IP ban matters.
- **Response `404`**: `{ error: "Not found" }` — looks like an ordinary 404 so the
  trap is indistinguishable from a missing route
- **Side effect**: `banIP(ip, "honeypot_trap")` — populates
  `globalThis.__ipBanMap` with an entry whose `bannedUntil` is computed from the
  IP's ban count (`src/lib/ip-ban.ts` escalation ladder)
- **curl**:
  ```bash
  # DON'T — this bans your IP. Documented for completeness only.
  curl http://localhost:3000/api/trap/anything
  ```

### Security posture

#### `GET /api/security/health`
Returns the current security posture of the running system in a single JSON
payload: which hardening modules are wired up, what their configured parameters
are, live counters from the in-memory security Maps, and the timestamps of the most
recent radar / integrity scans. Every field is sourced from the actual security
module that backs it (no hard-coded "we're secure, trust me" claims).

- **Auth**: **admin token required** — `x-admin-token` header must match
  `ADMIN_TOKEN` env var. Fails CLOSED (401) on missing env var or wrong/missing
  token. The response reveals the security posture, which is reconnaissance data an
  attacker would want before launching an exploit.
- **Response `200`**:
  ```jsonc
  {
    "status": "healthy" | "degraded",
    "checks": {
      "passwordHashing": "scrypt",
      "sessionBinding": "ip+fingerprint",
      "rateLimiter": "per-ip + per-user",
      "csrfProtection": "double-submit + nonce",
      "csp": "nonce-based",
      "bodyLimit": "15kb",
      "loginLockout": "5 attempts / 15min",
      "honeypotActive": true,
      "auditChain": "sha256",
      "ssrfGuard": true,                  // ssrf-guard.ts probe
      "fileIntegrity": "monitored" | "broken",
      "adminRadar": "running" | "missing",
      "requestSigning": true,
      "banEscalation": true,
      "radarLastScan": "<iso>" | null,
      "integrityLastCheck": "<iso>" | null
    },
    "stats": {
      "bannedIPs": number,        // non-expired entries in __ipBanMap
      "rateLimitedIPs": number,  // non-expired entries in __rateLimitMap
      "lockedAccounts": number,  // lockouts whose lockedUntil > now
      "failedLogins": number,    // sum of failCount across all entries
      "auditEntries": number     // lines in logs/audit.jsonl
    },
    "degraded": ["…"],          // present iff status === "degraded"
    "timestamp": "<iso>"
  }
  ```
- **Response `401`**: `{ ok: false, error: { code: "UNAUTHORIZED", message: "Admin token required" } }`
- **Side effects**: runs `scanForUnauthorizedAdmins()` (on-demand admin-radar scan)
  and `verifyAuditIntegrity()` (audit-chain hash check) on every call; stashes the
  timestamps on `globalThis.__adminRadarLastScan` /
  `globalThis.__integrityLastCheck`.
- **Runtime**: Node.js (explicit; uses `fs/promises` for audit + Prisma for radar)
- **curl**:
  ```bash
  curl -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3000/api/security/health
  ```

---

## Observability

The middleware stamps `x-request-id` on all API routes and
records edge metrics for 429s.

### `GET /api/health`
Lightweight health check for load balancers / uptime monitors. Runs three checks:
database (Prisma query), log_writable (can append to `logs/app.jsonl`), memory
(`process.memoryUsage().rss` under threshold).

- **Response `200` (ok)**:
  ```jsonc
  { "status": "ok", "uptime": 123456,
    "checks": [ { "name": "database", "ok": true }, { "name": "log_writable", "ok": true }, { "name": "memory", "ok": true } ] }
  ```
- **Response `503` (degraded/down)**: same shape with `status: "degraded" | "down"` and
  per-check `ok: false`.

### `GET /api/observability`
Snapshot of in-memory RED metrics + recent structured logs + health. Should be
auth-gated in production (currently open for the demo).

- **Response `200`**:
  ```jsonc
  {
    "status": "ok", "uptime": 123456,
    "health": [ /* check results */ ],
    "metrics": {
      "http": { "requests": 1024, "errors": 3, "totalMs": 45210,
                "byRoute": { "/api/track/events": { "requests": 800, "errors": 1, "totalMs": 32000 } } }
      // …plus counters and histograms
    },
    "recentLogs": [ /* last 50 entries from logs/app.jsonl */ ],
    "timestamp": "2025-01-20T…"
  }
  ```

---

## Admin (seed, audit, export, retention, download)

### `POST /api/seed`
Generate realistic demo data: a project + N sessions (default 80, max 200) with mouse
paths, clicks, scrolls, rage clicks, dead clicks, page flows, UTM/referrer, JS errors,
insights, funnels, goals, segments, alerts (with history), dashboards, an experiment,
and annotations. Idempotent per project name (finds-or-creates the project; only seeds
the secondary entities if none exist yet).

- **Auth**: none
- **Body**: `{ name?: string, siteUrl?: string, count?: number }` — all optional
- **Response `200`**:
  ```jsonc
  { "ok": true, "projectId": "cl_xxxxxxxx", "project": Project, "created": 80 }
  ```
- **curl**:
  ```bash
  curl -X POST http://localhost:3000/api/seed \
    -H "Content-Type: application/json" \
    -d '{"name":"Acme Inc. — Marketing Site","siteUrl":"https://acme.example.com","count":90}'
  ```

### `GET /api/audit`
Global audit log viewer (across all projects). Same shape as the project-scoped
endpoint.

- **Query params**: `limit` (default `100`, max `500`)
- **Response `200`**: `{ entries: AuditEntry[] }`

### `GET /api/projects/[id]/export`
Export sessions as CSV.

- **Query params**:
  - `range` (default `7`)
  - `filter` (default `all`) — one of `all` | `rage` | `dead` | `active` | `error`
- **Response `200`**:
  - `Content-Type: text/csv`
  - `Content-Disposition: attachment; filename="sessions.csv"`
  - Body: 19-column CSV (`sessionId, visitorId, startedAt, duration, device, browser,
    os, country, city, pageViews, clicks, entryUrl, exitUrl, hasRageClick,
    hasDeadClick, hasError, convertedGoal, referrer, utmSource`). Cells with commas,
    quotes, or newlines are wrapped in double quotes with internal quotes doubled.
  - Capped at 5000 sessions, ordered by `startedAt desc`.
- **curl**:
  ```bash
  curl "http://localhost:3000/api/projects/<id>/export?range=7&filter=rage" -o rage.csv
  ```

### `POST /api/admin/retention-purge?days=90`
Trigger a purge of all sessions older than `days` (default 90, clamped to
`[1, 3650]`). Cascades to events, insights, errors, notes, tags, bookmarks via
Prisma relations. Intended to be called by `scripts/cron-purge.sh` on a daily
schedule.

- **Auth**: **admin token required** — `x-admin-token` header must match
  `ADMIN_TOKEN` env var. Fails closed (401) on missing env var or wrong/missing
  token. An unauthorized probe fires `reportUnauthorizedAdmin()` (security
  alert).
- **Query params**: `days` (default `90`, clamped to `[1, 3650]`)
- **Response `200`**: `{ ok: true, purged: number, cutoff: "<iso>", days: number }`
- **Response `401`**: `{ ok: false, error: { code: "UNAUTHORIZED", message: "Admin token required" } }`
- **Audit**: writes a `retention_purge` entry to `logs/audit.jsonl` with `days`,
  `cutoff`, `purgedSessions`, caller IP
- **curl**:
  ```bash
  curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
       "http://localhost:3000/api/admin/retention-purge?days=90"
  ```

### `GET /api/admin/retention-stats?days=90`
Preview what a purge would remove BEFORE running it.

- **Auth**: **admin token required** (same `x-admin-token` vs `ADMIN_TOKEN`
  pattern as `retention-purge`); fails closed (401) on missing env var
- **Query params**: `days` (default `90`, clamped to `[1, 3650]`)
- **Response `200`**:
  ```jsonc
  {
    "ok": true,
    "oldestSession": "2024-01-01T..." | null,
    "totalSessions": 12345,
    "sessionsToPurge": 1234,
    "retentionDays": 90,
    "cutoffDate": "2024-..."
  }
  ```
- **Response `401`**: `{ ok: false, error: { code: "UNAUTHORIZED", message: "Admin token required" } }`
- **curl**:
  ```bash
  curl -H "x-admin-token: $ADMIN_TOKEN" \
       "http://localhost:3000/api/admin/retention-stats?days=90"
  ```

### `GET /api/download`
Download the full project source as a zip. Serves
`<process.cwd()>/insight-replay.zip` — a HARDCODED path (no query param or path
param can change the served file; `basename()` collapses any future user-supplied
filename and the resolved path is asserted to stay inside `process.cwd()`).

- **Auth**: **admin token required** — `x-admin-token` header must match
  `ADMIN_TOKEN` env var. Fails closed (403) on missing env var or wrong/missing
  token. Unauthorized probes fire `reportUnauthorizedAdmin()` and return 403 (this
  endpoint serves the full source tree — exfiltration is a critical-signal event).
- **Query string**: rejected outright — any `?` in the URL returns `400`
  (`{ ok: false, error: { code: "BAD_REQUEST", message: "Query string not allowed" } }`)
- **Response `200`**: zip file —
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename="insight-replay.zip"`
  - `Content-Length: <bytes>`
  - `Cache-Control: no-store`
  - `X-Content-Type-Options: nosniff` (MIME-confusion defense)
  - `Access-Control-Allow-Origin: null`, `Vary: Origin`
- **Response `403`** (no/invalid token): `{ ok: false, error: { code: "FORBIDDEN", message: "Admin token required" } }`
- **Response `404`** (zip not yet built): `{ error: "Zip file not found. Run the build first." }`
- **CORS**: deliberately hostile to cross-origin callers — the preflight
  (`OPTIONS`) refuses to advertise `x-admin-token` in
  `Access-Control-Allow-Headers`, so cross-origin callers can never complete the
  preflight and the actual GET never fires from another origin. Same-origin
  dashboard requests are not preflighted.
- **curl**:
  ```bash
  curl -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3000/api/download -o insight-replay.zip
  ```

### `OPTIONS /api/download`
CORS preflight handler. Deliberately omits `x-admin-token` from
`Access-Control-Allow-Headers` so cross-origin callers can never complete the
preflight.

- **Response `204`**: no body. Headers:
  - `Access-Control-Allow-Origin: null`
  - `Vary: Origin`
  - `Access-Control-Allow-Methods: GET, OPTIONS`
  - `Access-Control-Max-Age: 600`
  - (deliberately NO `Access-Control-Allow-Headers: x-admin-token`)

---

## Top-level

### `GET /api`
Smoke-test route.

- **Response `200`**: `{ message: "Hello, world!" }`

---

## Cross-cutting behaviour

- **Middleware** (`src/middleware.ts`, matcher `/api/:path*`): stamps `x-request-id`
  on every API response; rate-limits `/api/track/events` only (returns `429` + JSON
  `{ error: "Rate limit exceeded" }` + `Retry-After: 60` on overflow).
- **Security headers** (`next.config.ts → headers()`): applied to every route via
  `source: "/(.*)"` — `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`,
  `X-DNS-Prefetch-Control: off`. See ADR-0004 layer 6.
- **CORS** (`/api/track/events` and `/api/track/script` only): dev mode →
  `Access-Control-Allow-Origin: *`; production → reflects the allowed Origin with
  `Vary: Origin` (no ACAO header emitted for blocked origins). See ADR-0004 layer 3.
- **Error envelope**: every route's `catch` block returns `{ error: string }` with
  status `500` (or `400` for input validation, `404` for not-found).
- **Param signature**: all dynamic-segment routes use `ctx: { params: Promise<{…}> }`
  and `await ctx.params` — this is the Next.js 16 async-params pattern.
- **Cascade deletes**: every relation from `Session` to its children (`Event`,
  `Insight`, `ErrorEvent`, `Note`, `Tag`, `Bookmark`) and from `Project` to its
  children uses `onDelete: Cascade`, so deleting a project or session automatically
    cleans up all its descendants.
