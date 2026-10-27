# ADR-0005: In-Memory TTL Cache for Stats Aggregations

## Status
Accepted (2025-01-01)

## Context
The Insight Replay dashboard polls `GET /api/projects/[id]/stats` every 8 seconds while
a project tab is open. The stats endpoint computes — on every request — the following
from sessions in the requested range:

- 14 totals (sessions, active, clicks, pages, avg duration, rage clicks, dead clicks,
  errors, unique visitors, new/returning, conversions, conversion rate, bounce rate)
- `daily[]` array with one entry per day in the range
- 7 breakdown arrays (device, browser, os, country, referrer, utmSource, entryPages,
  exitPages), each sorted + sliced to the top N
- `topPages[]` via a separate `db.event.groupBy`

Each call is one `db.session.findMany` over the full range (potentially thousands of
rows) plus one `db.event.groupBy`. At an 8s poll interval with a single dashboard tab
open, that is ~7.5 calls/minute/project. With multiple tabs, multiple projects, or
multiple dashboard viewers, the load multiplies. The aggregations are pure functions of
the range + project id + the underlying data, and the underlying data only grows
monotonically as new sessions arrive.

Forces:

- **Polling cadence is fixed by UX.** The dashboard needs to feel responsive; the 8s
  interval is already at the upper bound of "feels live". Reducing the cadence would
  hurt UX.
- **Aggregations are expensive but stable.** Two calls to `/stats?range=7` within the
  same minute will return nearly identical results — the new sessions that arrived in
  the gap are a tiny fraction of the 7-day total. Computing from scratch every time is
  wasteful.
- **No external services.** The project brief rejects Redis / Memcached / managed
  caches for the demo (see ADR-0001's "self-hosted, no external services" stance).
- **No persistence requirement.** The cache is purely a performance optimisation. If it
  is wiped, the next request just recomputes. Stale data is acceptable up to a point.
- **Bounded memory.** The cache must not grow unbounded.
- **Survives hot reload.** Next.js dev mode hot-reloads modules on every file change,
  which would reset a module-level `Map`. The cache must persist across reloads.

## Decision
Add an **in-memory TTL cache** keyed by request URL (project id + range + breakdown
slice), stored on `globalThis` so it survives Next.js dev hot reloads. TTL is **60
seconds** — long enough to amortise the cost across the 8s polling cadence (7–8 cache
hits per cache fill), short enough that new sessions appear in the dashboard within a
minute of arriving.

The cache is general-purpose: a `cacheGet<T>(key, ttlMs, producer)` function that
returns the cached value if fresh, otherwise calls `producer()`, stores the result, and
returns it. The stats endpoint wraps its whole computation in `cacheGet`.

Persistence across hot reloads is achieved by stashing the Map on `globalThis`:

```ts
const g = globalThis as unknown as { __statsCache?: Map<string, { value: unknown; expiresAt: number }> }
if (!g.__statsCache) g.__statsCache = new Map()
const cache = g.__statsCache
```

This mirrors the pattern already used by `src/lib/rate-limit.ts` (see ADR-0004 layer 2)
and `src/lib/observability.ts` for in-memory metrics.

## Consequences

**Positive**

- A single dashboard tab polling every 8s now hits the cache 7 times out of 8 — a ~7x
  reduction in DB load on the stats endpoint.
- Multiple viewers of the same project share the cache, multiplying the benefit.
- The 60s TTL is short enough that new sessions appear in the dashboard within a minute
  of arriving — acceptable for a demo and tunable per-endpoint.
- `globalThis` persistence means dev hot reloads do not reset the cache, so the dev
  experience stays consistent.
- The cache is general-purpose and can be applied to other expensive endpoints
  (`/retention`, `/journeys`, `/funnels/[fid]/analyze`) with one-line changes.
- Memory is bounded by key cardinality: at most `(# projects) × (# ranges) ×
  (# breakdown slices)` entries. For the demo (single project, ranges 1/7/30) this is
  a handful of entries.
- No external service, no new dependency, no operational overhead.

**Negative**

- **Stale data window of up to 60s.** A new session that arrives just after a cache
  fill will not appear in the dashboard for up to 60s. Acceptable for the Overview tab;
  would NOT be acceptable for the Live tab (which uses a separate realtime WebSocket
  channel — see ADR-0002 — and the `/realtime` HTTP endpoint, which is intentionally
  not cached).
- **Per-process cache.** Like the rate limiter, the cache lives on `globalThis` of a
  single Next.js process. A multi-instance deployment would have one cache per
  instance, doubling (or N-ing) the DB load. Fine for a single-box demo; would need
  Redis for a real deployment.
- **No cache invalidation on writes.** When a new session is ingested, the cache is not
  invalidated — the TTL handles it. This is intentional (invalidation would require the
  ingest path to know which caches exist), but it means the staleness window is fixed
  at 60s regardless of activity.
- **Memory growth is bounded by key cardinality, not by entry size.** Each cached value
  is the full stats response (totals + daily + 7 breakdowns). For a project with a
  large range (e.g. 90 days × thousands of sessions), the response can be tens of KB.
  At single-project demo scale this is fine; at hundreds of projects it would warrant
  an LRU eviction policy.
- **Cache key must include all request parameters that affect the response.** Forgetting
  one (e.g. a new `filter` query param) would cause incorrect cache hits. The stats
  endpoint currently uses `range` only; if filters are added later the cache key must
  be updated.
- **No observability into cache hit/miss ratio.** `cacheGet` does not currently log
  hits/misses. The `/api/observability` endpoint does not surface cache stats. A future
  enhancement would record a counter per cache key.

## Alternatives Considered

### Redis
- **Pros:** Shared across instances, supports TTL natively, supports LRU eviction, is
  the industry standard.
- **Cons:** External service. Adds operational overhead (a Redis server to run, a
  connection to manage, a failure mode to handle). Rejects the "self-hosted, no
  external services" brief.
- **Rejected for v1.** Track as the natural upgrade path if the project moves to
  multi-instance deployment.

### HTTP cache headers (`Cache-Control: max-age=60` on the response)
- **Pros:** Zero app code, leverages the browser's cache, no server memory.
- **Cons:** The dashboard's `fetch()` calls do not always respect cache headers (many
  are `cache: 'no-store'` or use `react-query`'s default `forceFetch` semantics). Even
  if they did, the cache would be per-browser, not shared across dashboard viewers.
  And the dashboard still pays the DB cost on the first request of every TTL window.
- **Rejected as the primary strategy.** Could be added as a secondary layer on top of
  the in-memory cache.

### SWR / stale-while-revalidate in `react-query`
- **Pros:** Offloads caching to the client. Already in the dependency tree.
- **Cons:** Does not reduce server-side DB load — `react-query`'s cache only avoids
  refetches the client would otherwise make. The 8s polling cadence is set by the
  `refetchInterval` config, which bypasses the cache. Tuning the cadence down would
  hurt UX.
- **Rejected as the primary strategy.** Already used incidentally on the client side.

### No cache (recompute every call)
- **Pros:** Always fresh. Zero implementation. Zero memory.
- **Cons:** Wastes DB time on identical computations. At 8s polling cadence the waste
  is ~7/8 of all stats queries. Does not scale to multiple viewers or multiple tabs.
- **Rejected.** The DB cost is real and the staleness window is acceptable.

### Pre-computed materialised view (refresh every N minutes via cron)
- **Pros:** O(1) reads.
- **Cons:** Requires a scheduler, a separate table, an invalidation strategy, and a
  write path that updates the view. Substantially more complex than a TTL cache.
  Overkill for a demo.
- **Rejected for v1.** Plausible for production where the read load is 100x higher.

### Cache only the expensive sub-queries (e.g. `topPages` groupBy), not the whole response
- **Pros:** Finer-grained, smaller stale windows per field.
- **Cons:** More cache keys to manage, more code, smaller win per cache hit. The whole
  response is the right granularity for a 60s TTL.
- **Rejected.** Coarse-grained caching is simpler and the win is large enough.
