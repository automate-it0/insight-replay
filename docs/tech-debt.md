# Insight Replay — Technical Debt Inventory

This is the running inventory of technical debt in the codebase. Each item
has been verified against the current source. Items are ordered by priority
within each tier, not by discovery date.

Debt is **not** a sin — it's a contract with the future. The cost of every
item here is paid either in engineering time (refactor) or in incidents
(outage, breach, perf regression). The goal of this doc is to make that
cost visible so it can be paid down on purpose, not by accident.

For the migration roadmap that schedules these pay-downs, see
[`docs/deprecation-plan.md`](./deprecation-plan.md).

---

## Priority legend

| Tier   | Meaning                                                                   |
|--------|---------------------------------------------------------------------------|
| High   | Security, privacy, or production-blocker. Pays down before SaaS launch.   |
| Medium | Limits scale or maintainability. Pays down before 10× current load.       |
| Low    | Nuisance or demo-acceptable. Pays down opportunistically.                 |

Counts: **12 items** — 3 High, 7 Medium, 2 Low.

---

## 1. SQLite — single-writer, no encryption, no replication  (Medium)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `prisma/schema.prisma` (`datasource db { provider = "sqlite" }`); ADR 0001 |
| Impact       | Cannot scale beyond a single instance. SQLite serialises all writes through a single file lock — concurrent ingest from N tracker SDKs will hit `SQLITE_BUSY`. No encryption at rest (the `.db` file is plaintext on disk). No read replicas, no failover. |
| Priority     | Medium (demo-acceptable; High the moment we deploy >1 web process)       |
| Effort       | ~3 days (swap provider, run prisma migrate, update `DATABASE_URL`, test)  |
| Action       | Migrate to PostgreSQL. ADR 0001 already names this as the planned exit. Use Prisma's `migrate` to manage the cutover; keep SQLite as the dev/test default via a separate `datasource`-by-env pattern. See Phase 3 of `deprecation-plan.md`. |

## 2. No authentication on the dashboard  (High)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `src/middleware.ts` (only rate-limits `/api/track/events`, no auth check); `src/lib/auth.ts` defines `validateApiKey` but it is only wired into `/api/projects/[id]/protected-test/route.ts` |
| Impact       | Anyone who can reach the dashboard URL can view all analytics for every project, create/delete projects, regenerate API keys, and read the audit log. This is a security gap for any non-localhost deployment. The Caddy gateway on `:81` is open in this dev environment. |
| Priority     | High                                                                     |
| Effort       | ~2 days (auth layer + session middleware + role checks + UI for login)    |
| Action       | Add an authentication layer (magic link, OIDC, or password) and a session cookie. Extend `src/middleware.ts` to require a valid session for all `/api/projects/*` routes except the ingest endpoint. Per-project ACLs come in Phase 4 (multi-tenancy). |

## 3. O(N) project scan in `findProjectForSession`  (Medium)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `src/components/app/recording-player-helpers.ts:212-223`                 |
| Impact       | The recording player is opened with only a `sessionId`. To find the owning project it fetches `/api/projects` (all projects) and then issues one HTTP GET per project until it finds a match. With N projects this is N+1 sequential network round-trips on every cold-open of a recording. The `projectIdRef` cache mitigates repeat opens, but the first open of any session is O(N) in wall-clock time. |
| Priority     | Medium                                                                   |
| Effort       | ~2 hours                                                                 |
| Action       | Either (a) pass `projectId` through the recordings list so the player never needs to look it up, or (b) add a `GET /api/sessions/:sid/project` endpoint that does a single `db.session.findUnique({ select: { project: true } })`. Option (a) is strictly better — the recordings list already has the project id. |

## 4. Raw mouse-event storage  (High)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `prisma/schema.prisma` (`model Event`); `src/lib/track.ts:107-124` (bulk `createMany`); `src/components/app/use-tracker.ts:61-67` (throttle = 70ms, every surviving event is stored) |
| Impact       | Every `mousemove` that survives the 70ms client throttle is persisted as a full row in the `Event` table. A 5-minute active session at ~14 events/sec produces ~4,200 mousemove rows. The seeder's 90 sessions already produce >1M events. This dominates DB size, slows every `findMany` on `Event`, and bloats the heatmap query path. |
| Priority     | High                                                                     |
| Effort       | ~3 days (schema for aggregates + ingest compaction + heatmap query path + replay path) |
| Action       | Two-tier storage: keep raw events only for the most recent N sessions (e.g. last 7 days, configurable); older sessions get compacted into per-(session,page,t-minute-bucket) aggregates (sum/count of points in a grid cell). The heatmap query path then reads aggregates for old data and raw events for recent data. The recording replay path falls back to a representative sample when raw events have been compacted. See Phase 3 of `deprecation-plan.md`. |

## 5. In-memory cache with no LRU bound  (Medium)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `src/lib/cache.ts` (`cacheGet`/`cacheSet`/`cacheDelete`); ADR 0005       |
| Impact       | The cache is a plain `Map<string, CacheEntry>` on `globalThis`. Expired entries are pruned lazily on read (`cacheGet` deletes the entry it just discovered to be expired) and via `cacheDelete(prefix)` on writes. There is **no upper bound on the number of live entries** — if write rate exceeds TTL-expiry rate (e.g. high cardinality of `projectId` × `range` combinations on `/stats`), the map grows without limit. In a long-running process this is a slow memory leak. |
| Priority     | Medium                                                                   |
| Effort       | ~4 hours                                                                 |
| Action       | Add an LRU cap (e.g. 1,000 entries) using a doubly-linked-list + Map, or pull in `lru-cache` (zero-dep, ~150 lines). When the cap is hit, evict the least-recently-read entry. Surface the cap and current size via `cacheStats()`. See Phase 3. |

## 6. No downsampling for heatmaps  (Medium)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `src/app/api/projects/[id]/heatmap/route.ts:35-46` (`take: 12000`)        |
| Impact       | The heatmap endpoint fetches up to 12,000 raw `click` or `move` events per page and ships them all to the client as JSON. For a popular page over a 30-day window, this is a multi-MB response on every heatmap render. The `kind: "scroll"` branch (`take: 8000`) has the same problem. |
| Priority     | Medium                                                                   |
| Effort       | ~1 day                                                                   |
| Action       | Server-side bucketing: for `click` heatmaps, return a grid of 64×64 (or viewport-scaled) cells with counts. For `move`, downsample to N points per cell using a density estimate. The client renders the buckets as the existing rainbow canvas. This also pairs naturally with debt #4 (aggregates) — once aggregates exist, the heatmap reads them directly. |

## 7. API response-shape inconsistency  (Medium)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | All 53 `route.ts` files under `src/app/api/`. The standard envelope lives in `src/lib/api-response.ts` (shipped). The migration plan lives in `docs/api-style-guide.md` (Phase 1 done, Phases 2-4 pending). |
| Impact       | Some routes return `{ ok, data, requestId }`, some return raw objects (`{ project, counts }`), some return `{ error: "..." }` with no code. The dashboard's `api()` helper in `src/lib/api.ts` has to guess which shape it's getting. Client error handling is brittle because there's no stable `error.code` to branch on. |
| Priority     | Medium (migration plan already exists; this is the execution debt)       |
| Effort       | ~3 days (route-by-route per the api-style-guide Phase 3 checklist)       |
| Action       | Execute the migration plan in `docs/api-style-guide.md`: Phase 2 (update `api()` helper to unwrap both shapes — ~2 hours), Phase 3 (migrate routes in priority order — ~3 days), Phase 4 (deprecate old shapes — ~1 day). This is a hard dependency for any external client work. |

## 8. No session data retention policy  (High)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `src/lib/ua.ts:166` exports `retentionCutoff(days)` — but nothing calls it. ADR 0004 notes it is "exported but not yet scheduled". |
| Impact       | Sessions (and their events, insights, errors, notes, tags, bookmarks) accumulate forever. This is both a storage cost (the DB grows monotonically) and a privacy/GDPR exposure (PII — IP-anonymized but visitorId + behavior is still personal data under GDPR). There is no cron, no manual purge endpoint, no settings tab to configure retention. |
| Priority     | High                                                                     |
| Effort       | ~1 day                                                                   |
| Action       | Add a daily cron (or a `GET /api/admin/retention-purge?dryRun=true` endpoint run on a schedule) that calls `db.session.deleteMany({ where: { lastActiveAt: { lt: retentionCutoff(90) } } })`. Cascade deletes (already in the schema) handle child rows. Surface the retention window in Settings. See Phase 1 of `deprecation-plan.md`. |

## 9. Socket.io reconnection not resilient  (Low)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `src/components/app/live-tab.tsx:71-75` — `io("/?XTransformPort=3004", { transports: ["websocket","polling"], forceNew: true, reconnection: true })`. `src/components/app/use-tracker.ts:139` — same call, but does not even set `reconnection: true` (it's the default, but not explicit). |
| Impact       | Socket.io's defaults (`reconnectionDelay: 1000`, `reconnectionDelayMax: 5000`, `reconnectionAttempts: Infinity`) are used. There is no exponential backoff tuning, no max-retry cap, and no visible "reconnecting…" state in the UI — the user just sees the green dot go grey with no explanation. For live tracking under flaky networks this manifests as "Live tab is broken" reports. |
| Priority     | Low (live tracking is a demo-grade feature; recordings are not affected)  |
| Effort       | ~3 hours                                                                 |
| Action       | (a) Make reconnection options explicit and tuned: `reconnectionAttempts: 10`, `reconnectionDelay: 1000`, `reconnectionDelayMax: 10_000`. (b) Add a `reconnect_attempt` / `reconnect_failed` handler that surfaces a toast or badge in the Live tab. (c) Mirror these settings in `use-tracker.ts` so the demo-site tracker behaves the same. |

## 10. AI prompts not versioned  (Low)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `src/app/api/projects/[id]/ai/route.ts:273-275` (system prompt inline); `src/app/api/projects/[id]/ai/session/route.ts` (same pattern); `src/app/api/projects/[id]/ai-search/route.ts` |
| Impact       | The system prompt is a string literal in the route handler. Editing the prompt changes every future response — including for users mid-analysis who may see a different "shape" of answer than they got five minutes ago. There is no audit trail of which prompt produced which stored analysis. |
| Priority     | Low (AI features are demo-grade; no persisted analyses yet)              |
| Effort       | ~4 hours                                                                 |
| Action       | Extract prompts into `src/lib/ai/prompts.ts` as a `Record<version, PromptSpec>`. Each call to the AI includes the prompt version in its response. If/when analyses get persisted, store the prompt version alongside. Bump the version on any material change to the prompt text. |

## 11. No rate limiting on dashboard API routes  (Medium)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `src/middleware.ts:12` only rate-limits `/api/track/events` (ingest). `src/lib/rate-limit.ts` exports `API_LIMIT` (60 req/min) but nothing calls it on dashboard routes. |
| Impact       | Dashboard API routes (`/api/projects/[id]/stats`, `/heatmap`, `/sessions`, etc.) can be called without limit. A malicious or buggy client can DoS the database by hammering expensive aggregations (e.g. `/stats` with `range=365`). Combined with debt #2 (no auth), the surface is wide open. |
| Priority     | Medium                                                                   |
| Effort       | ~4 hours                                                                 |
| Action       | Extend `src/middleware.ts` to apply `API_LIMIT` to all `/api/projects/*` routes (except the ingest endpoint, which keeps `INGEST_LIMIT`). Surface `X-RateLimit-Remaining` / `X-RateLimit-Reset` headers and a 429 with `Retry-After` on exceed. Pair with debt #2 so the limit is per-user, not just per-IP. |

## 12. No multi-tenancy  (Low)

| Field        | Value                                                                    |
|--------------|--------------------------------------------------------------------------|
| Location     | `prisma/schema.prisma` — `Project` has no `ownerId` / `tenantId` field. `src/lib/auth.ts:validateApiKey` checks key↔project match but not user↔project ownership. All projects are visible to everyone in the sidebar (`src/components/app/sidebar.tsx` calls `/api/projects` with no user filter). |
| Impact       | The product cannot be used as a SaaS — every user sees every project. Demo-acceptable; SaaS-blocking. |
| Priority     | Low (demo) → High (the day we charge for it)                             |
| Effort       | ~2 weeks (full stack: schema migration, auth, ACLs, UI for invites, billing boundary) |
| Action       | Add `User` and `Membership` models. `Membership` is the join table (user ↔ project) with a role. `validateApiKey` and the dashboard session middleware both check membership. The `/api/projects` list filters by the calling user's memberships. See Phase 4 of `deprecation-plan.md`. |

---

## Cross-cutting observations

These are not separate debt items but patterns that show up across multiple items above.

- **In-memory state on `globalThis`.** The cache (`cache.ts`), the rate-limit map (`rate-limit.ts`), and the edge-metrics aggregator (`middleware.ts`) all stash state on `globalThis`. This works for a single-process Node.js deployment but breaks the moment we run >1 web process — each process has its own `globalThis`, so rate limits are per-process and caches are per-process. The Phase 3 PostgreSQL migration is the natural moment to also introduce Redis for shared state.
- **`take: N` caps as a substitute for pagination.** Several routes (`heatmap`, `errors`, `export`, `visitors`, `sessions`) cap their `findMany` with a `take` between 200 and 12,000. This is a duct-tape fix that hides the underlying problem: there is no cursor pagination. The `api-response.ts` envelope includes a `pagination` shape; routes should adopt it.
- **`any` in tracker code.** `src/components/app/use-tracker.ts` uses `any[]` for the event buffer and `any` for the socket ref. This is fine for a 200-line client hook but blocks any type-checking on the tracker payload. A typed `TrackEvent` union (already exported from `src/lib/track.ts` as `TrackEventInput`) should be reused.
- **No retention policy for *any* table, not just `Session`.** Debt #8 calls out sessions, but `ApiKey.lastUsed`, `AlertHistory.triggeredAt`, `AuditLog.createdAt` (if/when it lands) all have the same problem. The Phase 1 purge job should be table-aware.

---

## How to update this doc

- **When you ship a fix:** move the item to a "Resolved" section at the bottom with the date, the PR/commit, and a one-line "what we did". Do NOT delete the item — the history is useful.
- **When you discover new debt:** add a new numbered item with all the fields above. Don't be shy — surfacing debt early is the point.
- **When priorities change:** update the Priority field and the priority legend counts. The counts (3/7/2) are referenced from `deprecation-plan.md`; keep them in sync.

## Resolved

(none yet)
