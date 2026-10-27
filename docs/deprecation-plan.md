# Insight Replay — Deprecation & Migration Plan

This is the roadmap for paying down the technical debt catalogued in
[`docs/tech-debt.md`](./tech-debt.md). It is the **when** and **how** to
that doc's **what** and **why**.

The plan is organised in four phases. Each phase has a goal, a list of
what gets deprecated, the migration strategy, the backwards-compatibility
contract, the timeline, and the success criteria. Phases are sequenced —
later phases depend on earlier ones — but items inside a phase are
parallelisable.

---

## Code-as-liability mindset (read this first)

> Every line of code is a liability. It must be read, understood, tested,
> secured, and updated when the world around it changes. The most
> maintainable line of code is the one we never wrote; the second most
> maintainable is the one we deleted.

The debt in `tech-debt.md` was not created by bad engineering — it was
created by *accumulation*. Each item was, at the time it was written, a
reasonable trade-off: SQLite for zero-config demo, raw events for accurate
replay, ad-hoc API shapes for speed. The debt is the *interest* on those
decisions, compounded by time and usage.

The operating rules for this plan:

1. **Prefer deletion over accumulation.** When migrating, the question is
   not "what new code do we add?" but "what old code can we delete?". A
   migration that ships +500 LOC and −0 LOC is not a migration, it's a
   rewrite with extra steps.
2. **One migration at a time.** Each phase has one acceptance gate. We do
   not start Phase 2 until Phase 1's success criteria are met and
   verified. This is how we avoid the "90% done, 90% to go" trap.
3. **Backwards compat is a timer, not a virtue.** We keep old code paths
   alive only as long as the deprecation window requires, then we delete
   them. A backwards-compat shim that lives forever is just debt with a
   polite name.
4. **Deprecation must be noisy.** Deprecation is announced via
   `Deprecation` / `Sunset` HTTP headers, console warnings, and
   changelog entries. Silent deprecation is removal by another name.
5. **Zombie code is the enemy.** Dead code (unused exports, unreachable
   branches, orphaned files) is not free — it's read by every new
   contributor, grepped by every search, and tested by every CI run. We
   hunt it on every phase boundary. See the [Zombie code audit](#zombie-code-audit).

---

## Phase 1 — Immediate: Session retention & GDPR baseline

**Goal:** Establish a data-retention floor so the product can be deployed
without accumulating PII indefinitely.

**Timeline:** 1 day.

**What gets deprecated:**

- The implicit "we keep everything forever" retention policy. After Phase 1,
  sessions older than the configured window are eligible for deletion.

**Migration strategy:**

1. Add `src/lib/retention.ts` — wraps the existing `retentionCutoff(days)`
   helper (already in `src/lib/ua.ts:166`) into a `purgeOldSessions(days)`
   function that calls
   `db.session.deleteMany({ where: { lastActiveAt: { lt: retentionCutoff(days) } } })`.
   Cascade deletes (already in `schema.prisma` for `Event`, `Insight`,
   `ErrorEvent`, `Note`, `Tag`, `Bookmark`) handle child rows.
2. Add `GET /api/admin/retention-purge` with `?dryRun=true` returning
   `{ wouldDelete: N, oldestKept: Date, oldestPurged: Date }`. The endpoint
   is admin-gated (Phase 2 adds auth; for now it's localhost-only via
   `127.0.0.1` check).
3. Add a daily cron entry — either a `cron`-style system job, or a
   self-scheduled `setInterval` in the Next.js process guarded by a
   leadership check (so we don't double-purge in a multi-process deploy).
   Default retention: 90 days, configurable via `RETENTION_DAYS` env var.
4. Surface the retention window in `src/components/app/settings-tab.tsx`
   (read-only display; editing comes in Phase 4 with multi-tenancy).

**Backwards compatibility:**

- No API shape changes. No client changes. The purge is a server-side
  background job; existing routes return the same shape, just for a
  smaller dataset over time.
- The first purge is `dryRun`-only by default. Operators flip a flag to
  enable destructive purges after reviewing the dry-run count.

**Success criteria:**

- [ ] `purgeOldSessions(90, dryRun: true)` runs without error on the seeded
      DB and reports a sensible `wouldDelete` count.
- [ ] A destructive purge on a test DB removes the expected rows and
      cascades correctly (no orphaned `Event`/`Insight`/etc. rows).
- [ ] Settings tab shows the configured retention window.
- [ ] `bun run lint` clean; `bun test` passes (138 tests); no new TS errors.

**Pays down:** tech-debt #8.

---

## Phase 2 — Short-term: API envelope migration + dashboard auth

**Goal:** Bring every API route under the standardised envelope from
`docs/api-style-guide.md`, and add authentication to the dashboard so the
two highest-priority security/correctness debts are closed.

**Timeline:** 3 days.

**What gets deprecated:**

- Ad-hoc API response shapes — `{ error: "..." }`, `{ project, counts }`,
  raw arrays, raw objects. These continue to work during the migration
  window; they are removed in Phase 2's final step.
- Anonymous dashboard access. After Phase 2, all `/api/projects/*` routes
  require a valid session cookie (the ingest endpoint `/api/track/events`
  remains API-key-authenticated and unauthenticated for the tracker SDK).

**Migration strategy (API envelope):**

This is the execution of Phases 2-4 of `docs/api-style-guide.md`'s
migration plan. Quoting the style guide:

1. **Update `src/lib/api.ts`** (the dashboard's `api()` helper) to accept
   BOTH the old ad-hoc shape AND the new envelope. The helper unwraps
   `data` from `{ ok: true, data }` if present, else returns the body
   as-is. This is the compatibility shim — it has a known sunset date
   (the end of Phase 2 step 3).
2. **Route-by-route migration.** Each `route.ts` file moves to the new
   helpers (`apiSuccess`, `badRequest`, `notFound`, etc. from
   `src/lib/api-response.ts`). Prioritise by the api-style-guide's order:
   (a) routes returning bare-string errors, (b) external-client routes
   (track, AI), (c) internal dashboard routes.
3. **Remove the compatibility shim.** Once every route returns the new
   envelope, simplify `api()` to expect only `{ ok, data, requestId }`
   and delete the old-shape fallback.

Each route migration is a separate commit — no big-bang rewrite. CI gates
on the existing 138 tests passing.

**Migration strategy (dashboard auth):**

1. Pick an auth provider: magic-link email (passwordless, low friction)
   or a single admin password in env (for solo deployments). The latter
   is the default; the former is opt-in.
2. Add `src/lib/session.ts` — issues and verifies a signed session cookie
   (`HttpOnly`, `Secure`, `SameSite=Lax`). Cookie name: `ir_session`.
3. Extend `src/middleware.ts` to check the session cookie on
   `/api/projects/*` (except `/api/track/events`). Missing/invalid
   cookie → 401 with the standard error envelope.
4. Add `/api/auth/login` (POST, sets cookie) and `/api/auth/logout`
   (POST, clears cookie). Add a minimal login page at `/login`.
5. Add per-IP rate limiting (tech-debt #11) to `/api/auth/login` to
   prevent brute-force.

**Backwards compatibility:**

- The API envelope migration is additive during the transition: routes
  can be migrated one at a time because `api()` handles both shapes. No
  client breaks until the shim is removed, and the shim is only removed
  after every route is migrated.
- Dashboard auth is a breaking change for any existing automation that
  calls `/api/projects/*` without a session. Mitigation: API keys
  (already supported via `validateApiKey`) continue to work for
  programmatic access — they bypass the session check. Document this in
  `docs/api-reference.md`.
- During the auth rollout, set a `AUTH_REQUIRED` env flag (default
  `false` in dev, `true` in prod). This gives operators a flag-day
  cutover rather than a surprise lockout.

**Success criteria:**

- [ ] `api()` helper handles both envelope and ad-hoc shapes; 138 tests
      still pass.
- [ ] All 53 `route.ts` files return the standard envelope. A grep for
      `NextResponse.json({ error:` returns zero matches in `src/app/api/`.
- [ ] `api()` shim simplified to envelope-only; old-shape branch deleted.
- [ ] Dashboard requires session cookie; `/login` flow works.
- [ ] API-key access (Bearer token) still works for programmatic clients.
- [ ] `bun run lint` clean; `bun test` passes.

**Pays down:** tech-debt #2, #7, #11 (partial — per-user rate limit lands in Phase 4).

---

## Phase 3 — Medium-term: PostgreSQL + downsampling + LRU cache

**Goal:** Remove the three scaling ceilings (SQLite single-writer, unbounded
cache, raw-event storage) so the product can handle 10× current load without
a re-architecture.

**Timeline:** 1 week.

**What gets deprecated:**

- SQLite as the production database. ADR 0001's "demo-grade" choice is
  formally retired; ADR 0001 is marked "Superseded by ADR 0007"
  (to be written).
- The full-fidelity raw-event storage model for sessions older than the
  hot window (default 7 days). Old sessions are replaced by aggregates.
- The unbounded `Map`-based cache in `src/lib/cache.ts`. The API surface
  (`cacheGet`/`cacheSet`/`cacheDelete`/`cacheStats`) is preserved; only
  the implementation changes.

**Migration strategy (PostgreSQL):**

1. Add `prisma/migrations/` — Prisma's migration tooling has been
   available since task 1 (`package.json` has `db:migrate`) but unused.
   Cut the first real migration against SQLite, then switch the
   `datasource` provider to `postgresql` and cut a second migration.
2. Add a `docker-compose.yml` for local Postgres; keep `DATABASE_URL`
   pointing at SQLite for `bun run dev` by default, opt-in to Postgres
   via `DATABASE_URL=postgresql://...`.
3. Re-run the seeder against Postgres; verify parity (90 sessions, ~1M
   events) and benchmark ingest throughput.
4. Update ADR 0001 to "Superseded"; write ADR 0007 ("Migrate to
   PostgreSQL") referencing it.
5. Optional but recommended: introduce Redis for the cache and rate-limit
   maps at this point. The `globalThis`-stashed state in `cache.ts`,
   `rate-limit.ts`, and `middleware.ts` (`__edgeMetrics`) all break under
   multi-process. Redis is a one-line swap for the cache (same API) and
   a small refactor for rate-limit (Lua-scripted token bucket).

**Migration strategy (downsampling):**

1. Add `EventAggregate` model to `schema.prisma`:
   `model EventAggregate { id, sessionId, pageUrl, bucketT (Int, ms), cellX (Int), cellY (Int), clickCount, moveCount, scrollMax }`. Composite index on `(sessionId, pageUrl, bucketT)`.
2. Ingest path (`src/lib/track.ts`): for sessions older than the hot
   window (last 7 days), a background job reads raw `Event` rows, folds
   them into `EventAggregate` rows, and deletes the originals. The
   rage-click detector runs *before* compaction (it needs raw clicks).
3. Heatmap route (`/api/projects/[id]/heatmap`): query `EventAggregate`
   for sessions older than the hot window; raw `Event` rows for the hot
   window. Merge in JS. Response shape unchanged, but `points` is now
   at most ~4K cells instead of up to 12K raw events.
4. Recording replay (`recording-player-helpers.ts`): for compacted
   sessions, replay from a representative sample (e.g. one mousemove
   per 250ms) reconstructed from the aggregates. The replay is
   visually equivalent; the seek bar shows a "compacted" badge.

**Migration strategy (LRU cache):**

1. Replace the `Map` in `src/lib/cache.ts` with `lru-cache` (zero-dep,
   ~150 lines) or an inline LRU. Cap: 1,000 entries (configurable).
2. `cacheStats()` returns `{ size, keys, maxSize, evictions }`.
3. No caller changes — the API surface is identical.

**Backwards compatibility:**

- The SQLite → Postgres migration is data-preserving: Prisma migrations
  carry the schema, and a one-shot `pgloader` (or a Prisma-based script)
  copies the data. Read-only during the cutover (a few minutes for the
  seeded DB; longer for production-scale, in which case schedule a
  maintenance window).
- Downsampling is **lossy** by design. The recording replay for old
  sessions changes from "exact" to "representative sample". This is
  documented in the UI (the "compacted" badge) and in
  `docs/architecture.md`. Sessions in the hot window are unaffected.
- The cache API is unchanged; the LRU is a pure implementation swap.

**Success criteria:**

- [ ] App runs against Postgres with `DATABASE_URL=postgresql://...`;
      feature parity verified against the SQLite baseline (agent-browser
      smoke test on every tab).
- [ ] Ingest benchmark: ≥100 events/sec sustained against Postgres with
      10 concurrent trackers (SQLite caps out much lower).
- [ ] Heatmap response for a 30-day window on a popular page is <50KB
      (was multi-MB).
- [ ] Cache size never exceeds `maxSize`; `cacheStats().size` is bounded.
- [ ] `bun run lint` clean; `bun test` passes (existing tests + new
      tests for `purgeOldSessions`, `EventAggregate` compaction, LRU).

**Pays down:** tech-debt #1, #4, #5, #6.

---

## Phase 4 — Long-term: Multi-tenancy + SaaS features

**Goal:** Transform Insight Replay from a single-tenant demo into a
multi-tenant SaaS where each user sees only their own projects.

**Timeline:** 2 weeks.

**What gets deprecated:**

- The "all projects visible to everyone" model. After Phase 4, project
  access is mediated by `Membership` rows.
- The single-admin auth model from Phase 2 (replaced by user accounts
  with roles: `owner`, `admin`, `viewer`).

**Migration strategy:**

1. **Schema.** Add `User` (id, email, createdAt, role) and `Membership`
   (userId, projectId, role) models. Add `ownerId` to `Project`. Add a
   migration that back-fills `ownerId` from the first known admin (or a
   configured bootstrap user).
2. **Auth.** Replace the env-password auth from Phase 2 with email-based
   auth (magic link or password). Sessions carry `userId`. The `ir_session`
   cookie format is unchanged; only its payload grows a `userId`.
3. **ACLs.** `validateApiKey` (in `src/lib/auth.ts`) gains a user-context
   sibling: `requireMembership(req, projectId, role)`. Every route under
   `/api/projects/[id]/*` calls it. The middleware can't do this (it
   doesn't know the project id from the path matcher alone), so it's a
   per-route guard — but the guard is a one-liner.
4. **Per-user rate limiting.** Replace the per-IP `API_LIMIT` from Phase 2
   with per-userId limits. Tighter for free tier, looser for paid.
5. **UI.** Sidebar filters by membership. Settings tab gains a "Members"
   section for inviting users and changing roles. Project creation
   auto-creates an `owner` membership.
6. **Billing boundary (optional).** If/when SaaS pricing lands, add a
   `Plan` model and enforce limits (projects per user, events per month,
   retention days) at the route layer. This is explicitly out of scope
   for the 2-week phase but the schema should leave room for it.

**Backwards compatibility:**

- The Phase 2 session cookie continues to work; Phase 4 just adds a
  `userId` claim. Existing sessions are migrated lazily (re-issued on
  next request).
- API keys continue to work for programmatic access; they now carry the
  project's owner identity for rate-limit purposes.
- The bootstrap migration must not lock anyone out: the first user is
  auto-created as `owner` of all existing projects. Document this in the
  migration script and in `docs/adr/`.

**Success criteria:**

- [ ] Two users in two separate tenants cannot see each other's projects
      (verified via agent-browser with two sessions).
- [ ] `requireMembership` is called by every route under
      `/api/projects/[id]/*` (grep-verified).
- [ ] Per-user rate limiting is enforced (a free-tier user hitting the
      limit gets a 429 with `Retry-After`).
- [ ] Settings tab shows project members and supports invite/role-change.
- [ ] `bun run lint` clean; `bun test` passes (existing + new membership
      tests).

**Pays down:** tech-debt #12; completes #11 (per-user limits).

---

## Deprecation headers (HTTP)

When an endpoint or response field is deprecated, the route MUST:

1. Set `Deprecation: true` (RFC-deprecated-but-simple form) on every
   response from the deprecated path.
2. Set `Sunset: <date>` (RFC 8594) with the planned removal date —
   typically 6 months from the deprecation announcement.
3. Log the deprecation hit to `logs/app.jsonl` with the caller's IP/user
   so we can identify long-tail clients before the Sunset date.
4. Update `docs/api-reference.md` to mark the endpoint/field as
   deprecated with the Sunset date and the migration path.

This applies to:

- Phase 2's old ad-hoc response shapes (Sunset = end of Phase 2 step 3).
- Phase 3's raw-event endpoint shape if we change it (Sunset = 6 months
  after the new aggregate-aware endpoint ships).
- Phase 4's "all projects visible" model (Sunset = end of Phase 4).

---

## Zombie code audit

Zombie code is code that is not reachable from any execution path: unused
exports, dead branches, orphaned files. It is not the same as "code we
don't like" — that goes in `tech-debt.md`. Zombie code is *objectively*
dead.

The audit below lists files to check and the specific suspects identified
during this deprecation review. Each phase boundary includes a re-audit;
items confirmed dead are deleted as part of that phase.

### Suspects identified in this review

| File / Symbol                                       | Suspect                                                                                                                    | Verification step                                                                  | Disposition                |
|-----------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------|----------------------------|
| `src/lib/ua.ts:166` `retentionCutoff`               | Exported, JSDoc shows intended usage, but `rg "retentionCutoff\("` matches only the definition site.                       | `rg "retentionCutoff\(" src/` — expect only the definition.                        | **Keep** (Phase 1 wires it up). If Phase 1 slips, delete. |
| `src/lib/rate-limit.ts:103` `cleanupRateLimit`      | Exported, never called from `src/` (only from `tests/rate-limit.test.ts`).                                                 | `rg "cleanupRateLimit\(" src/` — only the definition.                              | **Wire or delete.** Either call it from a periodic job, or delete it and the test. |
| `src/lib/cache.ts:102` `cacheStats`                 | Exported, used by `/api/observability` route per the docstring — verify the route actually calls it.                       | `rg "cacheStats\(" src/` — verify `/api/observability/route.ts` calls it.          | Verify; if unused, delete. |
| `examples/websocket/server.ts`                      | Standalone example server; the real server is `mini-services/live-service/index.ts`.                                       | Confirm no doc links to it; confirm no test imports it.                            | Likely delete (examples belong in docs or in a separate `examples/` repo). |
| `examples/websocket/frontend.tsx`                   | Standalone example client; the real client is `src/components/app/live-tab.tsx` + `use-tracker.ts`.                        | Same as above.                                                                     | Likely delete. |
| `download/README.md`                                | The `download/` directory contains only a README. Looks like a leftover from a feature that was never built.              | `rg "download/" src/ docs/` — confirm no references.                               | Likely delete. |
| `src/app/api/projects/[id]/protected-test/route.ts` | Test endpoint for the auth layer (`validateApiKey`). Useful during dev, questionable in prod.                              | Confirm whether any frontend calls it; if not, gate behind `NODE_ENV=development`. | Gate or delete after Phase 2 (auth is real then). |
| `src/lib/audit.ts` exports                          | Audit-logging helper; verify which exports are actually called from routes.                                                | `rg "from ['\"]@/lib/audit['\"]"` then check which named exports are used.         | Trim unused exports. |
| `src/lib/sanitize.ts` exports                       | Input sanitization helper; same check.                                                                                     | `rg "from ['\"]@/lib/sanitize['\"]"` then check named exports.                     | Trim unused exports. |
| `src/lib/observability.ts` exports                  | Observability helper; same check.                                                                                          | `rg "from ['\"]@/lib/observability['\"]"` then check named exports.                | Trim unused exports. |
| `tests/python-runtime-*.sh`, `tests/database-runtime-*.sh` | Test helper scripts; verify they're referenced by CI or by `scripts/check-quality.sh`.                                    | `rg "python-runtime\|database-runtime" .github/ scripts/`                          | Delete if unreferenced. |

### How to run the audit at each phase boundary

```bash
# 1. Unused exports (TS-aware, finds symbols nobody imports)
bunx ts-prune | grep -v "used in module"

# 2. Unreachable files (no inbound import or route registration)
#    Files in src/app/api/*/route.ts are auto-registered by Next.js;
#    everything else should have an inbound import.
rg --files src/ | xargs -I{} sh -c 'rg -l "$(basename {} .ts)\|$(basename {} .tsx)" src/ | grep -v "^{}$" | wc -l' | awk '$1==0'

# 3. Dead branches (manual review)
#    Look for: `if (false)`, `if (process.env.NODE_ENV === "test")` in
#    non-test files, early-return-then-dead-code, switch cases that
#    can't be reached given the union type.

# 4. Orphaned files
#    examples/, download/, scripts/ — anything outside src/ and tests/
#    that isn't referenced by package.json scripts or CI workflows.
```

The audit is not a one-time exercise. Every phase ends with a re-audit,
and the results are committed to this doc as a "Resolved" entry in
`tech-debt.md`.

---

## Summary table

| Phase | Timeline  | Pays down debt #     | New code added (est.) | Old code deleted (est.) | Risk  |
|-------|-----------|----------------------|------------------------|--------------------------|-------|
| 1     | 1 day     | 8                    | ~150 LOC               | 0 LOC                    | Low   |
| 2     | 3 days    | 2, 7, 11 (partial)   | ~600 LOC               | ~400 LOC (old shapes)    | Med   |
| 3     | 1 week    | 1, 4, 5, 6           | ~800 LOC               | ~300 LOC (raw-event path)| Med   |
| 4     | 2 weeks   | 12, 11 (complete)    | ~1500 LOC              | ~200 LOC (single-tenant) | High  |

Total: ~3,050 LOC added, ~900 LOC deleted over ~4 weeks of engineering
effort. The net is intentionally small — the goal is to *replace* debt
with sustainability, not to grow the codebase.
