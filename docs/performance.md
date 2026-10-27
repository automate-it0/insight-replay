# Performance Optimization — Task ID 3

Measure-first optimization of the Insight Replay analytics tool, focused on the
three highest-leverage wins identified for this app: caching expensive DB
aggregations in the stats API, memoizing heavy React components, and reducing
re-render cost on the overview/dashboard tabs.

Applied skill: `.agent-skills/skills/performance-optimization/SKILL.md`
(process: MEASURE → IDENTIFY → FIX → VERIFY → GUARD).

## What was optimized

### 1. In-memory TTL cache for stats API (`src/lib/cache.ts` + `stats/route.ts`)

The `/api/projects/[id]/stats` route runs two expensive Prisma queries on every
call:

- `db.session.findMany(...)` — full session rows for the project + range
- `db.event.groupBy(...)` — top-page aggregation joining `Event` ↔ `Session`

The overview tab polls this endpoint every 8s, so a single dashboard viewer
generates ~7.5 stats requests/minute — all hitting the DB with the same
aggregation. Stats don't need to be real-time (a 60s staleness window is well
within user expectations for a dashboard), so this is a textbook
cache-aside candidate.

**Fix:**

- Created `src/lib/cache.ts` — a process-local in-memory TTL cache backed by
  `globalThis.__appCache` (survives Next.js dev hot reloads, shared across
  route handler invocations in the same Node.js process). Exposes:
  - `cacheGet<T>(key)` — returns cached value if unexpired, else null.
    Auto-prunes expired entries on read.
  - `cacheSet<T>(key, value, ttlMs)` — stores entry with TTL.
  - `cacheDelete(prefix)` — bulk invalidation by key prefix.
  - `cacheStats()` — observability (size + key list).
  - All ops wrapped in try/catch — cache failures degrade to miss / no-op,
    never break the app.
- Wrapped the GET handler in `stats/route.ts` with a cache lookup:
  - Cache key: `stats:${projectId}:${range}` — includes every input the
    response varies on (project-scoped, not viewer-scoped, so safe).
  - TTL: **60 seconds** (stated explicitly — stats are accepted to be ≤60s
    stale; the dashboard polls every 8s, so up to 7 polls get a cache hit
    before one miss recomputes).
  - Cache hit → return `{...body, cached: true, cachedAt}` immediately,
    skipping all DB queries.
  - Cache miss → compute as before, store in cache, return
    `{...body, cached: false, cachedAt}`.
  - Existing response shape preserved verbatim; only two new fields
    (`cached`, `cachedAt`) added — frontend keeps working unchanged.

### 2. Memoization in `overview-tab.tsx`

The overview tab renders 8 KPI cards + 4 Recharts visualizations
(AreaChart, two PieCharts, BarChart) + 6 breakdown lists. Every render
recomputed all the `.slice()` + `.map()` breakdowns inline in JSX, creating
fresh array references that defeated Recharts' internal prop diffing and
re-walked the data structures.

**Fix:**

- Added `useMemo` for: `dailyData`, `deviceData`, `browserData`,
  `newVsReturningData`, `topReferrers`, `topPages`, `topEntryPages`,
  `topExitPages`, `topCountries`, `topUtmSources` (10 memoized values).
- Deps are the source arrays from `stats` — when a poll produces new data,
  these all recompute as expected; on parent re-renders that don't change
  `stats` (e.g. sidebar toggles), the memoized values keep stable references.
- Reordered the hooks to run unconditionally BEFORE the loading-state early
  return — the original code only had `useEffect` before the early return,
  but adding `useMemo` after it would have violated the Rules of Hooks and
  thrown "rendered more hooks than during the previous render" when
  transitioning loading → loaded.
- UI is byte-for-byte identical.

### 3. Memoization in `dashboards-tab.tsx`

The dashboards tab renders a sidebar list of dashboards + a 12-column widget
grid (`WidgetRenderer` per widget, each potentially a Recharts chart). When
the user typed in the "New dashboard" dialog, `newName` state changes
re-rendered the entire component — re-walking the widget layout and
re-rendering every `WidgetRenderer` even though none of their props changed.

**Fix:**

- `useMemo` on `renderedWidgets` — the array of `<WidgetRenderer>` JSX
  elements. Deps are `[active, widgetData]`, both stable references while
  the user interacts with the create dialog.
- `useMemo` on `renderedDashboardList` — the sidebar buttons. Same idea.
- Wrapped `WidgetRenderer` in `React.memo` (`memo(function WidgetRenderer...)`)
  so even when the parent does re-render (e.g. after a poll), individual
  widgets skip re-render unless their `widget`/`data` props change.
- UI is byte-for-byte identical.

## Expected impact

### Stats API (the biggest win)

Measured on the local dev server with the seeded dataset (~556 sessions,
range=28 day window — the worst case for the aggregation):

| Scenario                            | Before | After (cache hit) | Speedup |
|-------------------------------------|--------|-------------------|---------|
| Stats API, range=28, cache miss     | ~240ms | ~240ms (unchanged)| 1x      |
| Stats API, range=28, cache hit      | ~240ms | ~11ms             | **~22x**|
| Stats API, range=7, cache hit       | ~95ms  | ~21ms             | **~4.5x**|
| DB queries per cache hit            | 2      | 0                 | -100%   |

With the overview tab polling every 8s and a 60s TTL, ~7 of every 8 polls
hit the cache. Steady-state DB load drops by ~87.5% for the stats endpoint.

**Cache hit signature:** the response includes `"cached": true` and a
`cachedAt` epoch-millis timestamp; cache misses include `"cached": false`
and a fresh `cachedAt`. Cache hits do NOT execute Prisma queries (verified
in dev.log — no `prisma:query` lines on hit, only on miss).

### Overview / Dashboards tabs

Per-render cost reductions:

- Overview tab: 10 inline `.slice().map()` chains → 10 `useMemo` calls
  that short-circuit when `stats` is unchanged. Recharts subtrees receive
  referentially-stable `data` props.
- Dashboards tab: typing in the "New dashboard" dialog no longer re-renders
  the widget grid or sidebar list (was: every keystroke re-walked
  `active.layout.map(...)` and rendered every `WidgetRenderer`). The
  `WidgetRenderer` is also `React.memo`'d so it skips re-render when its
  `widget`/`data` props are stable.

## How to verify

### Lint

```bash
cd /home/z/my-project && bun run lint 2>&1 | tail -5
# Expected: "$ eslint ."  (exit 0, no warnings/errors)
```

### Stats API cache (cold → warm)

The dev server must be running on port 3000.

```bash
PID=cmvlo90zm08jhrtv0l9lk2u7t   # replace with any valid project id

# Cold call — should report cached: false
curl -s "http://localhost:3000/api/projects/$PID/stats?range=7" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('cached:', d.get('cached'), 'cachedAt:', d.get('cachedAt'))"
# Expected: cached: False cachedAt: <epoch-ms>

# Warm call — should report cached: true with the SAME cachedAt
curl -s "http://localhost:3000/api/projects/$PID/stats?range=7" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('cached:', d.get('cached'), 'cachedAt:', d.get('cachedAt'))"
# Expected: cached: True cachedAt: <same epoch-ms as above>
```

### Stats API timing comparison

```bash
# Cold miss timing (worst case, large range):
curl -s -o /dev/null -w "miss: %{time_total}s\n" \
  "http://localhost:3000/api/projects/$PID/stats?range=28"
# Expected: ~200-250ms (includes DB aggregation)

# Warm hit timing (same range):
curl -s -o /dev/null -w "hit:  %{time_total}s\n" \
  "http://localhost:3000/api/projects/$PID/stats?range=28"
# Expected: ~10-30ms (no DB queries — verify in dev.log: no prisma:query lines)
```

### Response shape preserved

```bash
curl -s "http://localhost:3000/api/projects/$PID/stats?range=7" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('keys:', sorted(d.keys()));print('totals keys:', sorted(d['totals'].keys()))"
# Expected: all original keys (range, totals, daily, device, browser, os,
# country, referrer, utmSource, entryPages, exitPages, topPages) PLUS the
# new cached + cachedAt fields.
```

### Dev server compile (after editing overview-tab.tsx / dashboards-tab.tsx)

```bash
tail -20 dev.log | grep -E "⨯|error|Compiled"
# Expected: only "✓ Compiled in Nms" lines, no "⨯" error markers.
```

## Cache invalidation strategy

- **TTL**: 60 seconds, stated explicitly at the cache-write call site.
  Stats are accepted to be ≤60s stale; the dashboard polls every 8s, so
  up to 7 polls hit the cache before one miss recomputes.
- **Prefix invalidation** (`cacheDelete("stats:${projectId}:")`) is
  available for future use — e.g. call it from `track/events` ingest if
  we ever want stats to refresh immediately after a session is recorded.
  Currently not wired up because (a) ingest happens on a different
  request path and (b) 60s staleness is acceptable for a dashboard.
- **No per-user data** is cached under a key that doesn't identify the
  viewer — stats are project-scoped, not viewer-scoped, so this is safe.
- **Cache failures degrade gracefully**: every `cacheGet`/`cacheSet` is
  wrapped in try/catch. A cache failure → cache miss → normal DB
  computation. The cache is an optimization, not a correctness dependency.
- **Memory ceiling**: in practice bounded by TTL expiry + lazy pruning on
  read (`cacheGet` deletes expired entries). For a multi-process production
  deployment, swap this for Redis (the API surface is identical —
  `cacheGet`/`cacheSet`/`cacheDelete` map 1:1 to Redis `GET`/`SET ex`/`SCAN
  + DEL`).

## Future optimization opportunities (deferred)

These were identified but not implemented in this task — kept here so the
next person reads them before re-running an analysis.

| Opportunity | Why defer | Expected impact |
|---|---|---|
| **Add Prisma indexes** on `Session(projectId, startedAt)` and `Event(sessionId, type, timestamp)` | The hot stats query filters by `projectId + startedAt >= since`. SQLite currently does a full table scan. EXPLAIN ANALYZE first to confirm. | Cache-miss latency drops further; matters when the cache is cold. |
| **Move the `db.event.groupBy` (top pages) to its own cached endpoint** | It's the slower of the two queries and has a different staleness tolerance than the session aggregates. | Independent TTLs per query type; smaller cache entries. |
| **Request coalescing on cache miss** | Currently, N concurrent cache-miss requests all hit the DB. Add an in-flight promise map (see `references/performance-checklist.md` → "Request coalescing"). | Prevents stampede at the 60s expiry boundary under concurrent dashboard viewers. |
| **Add `cacheDelete` calls from ingest / dashboard-write endpoints** | Currently the cache only goes stale via TTL. Wiring invalidation into `track/events` (when a new session arrives) and dashboard CRUD would let us drop the TTL to 5–10s without losing freshness. | Tighter staleness window; lower memory ceiling. |
| **`React.memo` the `Kpi`/`Legend` leaf components in overview-tab** | Skipped because their `icon` prop is a fresh React element on each render (`<Eye className="h-4 w-4" />`), which defeats memo unless the icons are hoisted to module scope. The `useMemo` on the arrays is the bigger win; revisit only if profiling shows the KPI cards are a hotspot. | Marginal — only worth it if a profile says so. |
| **Code-split Recharts behind `Suspense`** | Recharts is ~95KB minified. It's used on Overview, Dashboards, Heatmaps. Route-level lazy-loading would shrink the initial bundle for tabs that don't need charts. | Lower TTI on first dashboard load; LCP improvement. |
| **HTTP `Cache-Control` on the stats response** | Currently no browser cache. Adding `Cache-Control: private, max-age=8` (matching the poll interval) would let the browser serve the next poll from disk. | Eliminates 1 of every 2 network requests; reduces server CPU under load. |
| **Web Vitals RUM** (`onLCP`, `onINP`, `onCLS`) | No field data yet. Add the `web-vitals` library and log to `/api/observability` to validate the React.memo + useMemo changes against real users. | Validates the frontend wins; gives a regression signal. |

## Files touched

- **Created**: `src/lib/cache.ts`
- **Modified**: `src/app/api/projects/[id]/stats/route.ts`
- **Modified**: `src/components/app/overview-tab.tsx`
- **Modified**: `src/components/app/dashboards-tab.tsx`
- **Created**: `docs/performance.md` (this file)

## Verification log

- `bun run lint` → exit 0, no output (clean).
- `bunx tsc --noEmit` (filtered to my files) → no errors in
  `cache.ts`, `overview-tab.tsx`, `dashboards-tab.tsx`. The one error in
  `stats/route.ts:160` (`Property 'pageUrl' does not exist on type 'number'`)
  is pre-existing (present at line 144 before this task) — it's a Prisma
  type quirk on `p._count.pageUrl` unrelated to the cache change and was
  not introduced here.
- Dev server (`bun run dev`) compiles all four files cleanly — `dev.log`
  shows only `✓ Compiled in Nms` lines, no `⨯` markers.
- Stats API cache verified via curl:
  - First call: `cached: False`, `cachedAt: 1792863230864`
  - Second call: `cached: True`, `cachedAt: 1792863230864` (same — proving
    the cached entry was reused, not recomputed)
  - Third call: same `cachedAt`, response time dropped from 95ms → 21ms
    (cache hit returns in ~1/5 the time, no `prisma:query` lines in dev.log).
  - range=28 timing: 241ms (miss) → 11ms (hit) — **22x speedup**.
- Response shape preserved: all original top-level keys + `totals` keys
  present, plus the two new `cached` + `cachedAt` fields.
