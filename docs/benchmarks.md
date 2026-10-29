# Benchmarks — Insight Replay

This document is the **placeholder registry** for the quantitative performance
benchmarks of Insight Replay. The numbers measured during the v0.5.0
performance-optimization pass live in [`docs/performance.md`](./performance.md)
— this file is the canonical home for the **follow-up benchmark tables** that
will (a) extend those measurements to steady-state scenarios the original
pass didn't cover, and (b) establish regression baselines for CI.

Every table below is marked **TBD — Pending Measurement** until the benchmark
harness described in "How these will be measured" is run and the cells are
filled in. Once a cell is filled, change its row's status from `DRAFT` to
`MEASURED` and add a one-line note linking to the run that produced the number
(commit SHA or task ID).

> **Companion doc:** [`docs/performance.md`](./performance.md) holds the
> narrative explanation of *what* was optimized and *why*, plus the
> verification commands. This file holds the *numbers* — past, present, and
> pending — in tabular form so a regression can be spotted at a glance.

---

## 1. Stats API cache hit/miss

**Target endpoint:** `GET /api/projects/[id]/stats?range=<N>`
**Implementation:** [`src/lib/cache.ts`](../src/lib/cache.ts) (TTL = 60 s,
project-scoped key `stats:${projectId}:${range}`).
**Already measured (v0.5.0):** see [`docs/performance.md`](./performance.md)
§ "Expected impact" — cache-hit speedup ~22× on range=28, ~4.5× on range=7.

The table below extends that measurement to multiple range values and to the
steady-state hit-rate seen under the 8 s dashboard poll cadence.

| Range (days) | Cache miss p50 (ms) | Cache miss p95 (ms) | Cache hit p50 (ms) | Cache hit p95 (ms) | Speedup (p50, miss→hit) | DB queries on hit | Status |
|--------------|---------------------|----------------------|--------------------|--------------------|-------------------------|-------------------|--------|
| 1            | TBD                  | TBD                  | TBD                | TBD                | TBD                     | TBD (expected: 0)  | DRAFT  |
| 7            | ~95 (per v0.5.0)    | TBD                  | ~21 (per v0.5.0)  | TBD                | ~4.5×                   | TBD (expected: 0)  | PARTIAL — needs p95 + DB query counter re-verified |
| 14           | TBD                  | TBD                  | TBD                | TBD                | TBD                     | TBD (expected: 0)  | DRAFT  |
| 28           | ~240 (per v0.5.0)   | TBD                  | ~11 (per v0.5.0)  | TBD                | ~22×                    | TBD (expected: 0)  | PARTIAL — needs p95 + DB query counter re-verified |
| 90           | TBD                  | TBD                  | TBD                | TBD                | TBD                     | TBD (expected: 0)  | DRAFT  |

**Steady-state cache hit-rate** (single dashboard viewer, 8 s poll, 60 s TTL,
project with seed dataset):

| Sessions in window | Polls per minute | Expected hits per 8-poll window | Expected miss rate | Measured hit rate (1000 polls) | Status |
|---------------------|------------------|-----------------------------------|--------------------|--------------------------------|--------|
| ~556 (seed)         | 7.5              | 7 of 8                            | 12.5 %             | TBD                            | DRAFT  |
| ~5 000 (synthetic)  | 7.5              | 7 of 8                            | 12.5 %             | TBD                            | DRAFT  |
| ~50 000 (synthetic) | 7.5              | 7 of 8                            | 12.5 %             | TBD                            | DRAFT  |

> The expected 87.5 % steady-state hit rate is a consequence of the
> poll-interval / TTL ratio alone (`60 s / 8 s = 7.5`), independent of dataset
> size; the dataset-size column exists to confirm the *miss* latency scales
> and the hit rate doesn't degrade as the DB grows.

---

## 2. Ingestion throughput

**Target endpoint:** `POST /api/track/events`
**Implementation:** [`src/app/api/track/events/route.ts`](../src/app/api/track/events/route.ts)
via [`src/lib/track.ts`](../src/lib/track.ts) (ingest + rage-click / dead-click
/ goal-conversion detection + Prisma `createMany`).

Throughput is measured as **requests per second** sustained against a single
dev-server process (`bun run dev` on :3000, no Caddy in front), with each
request carrying a realistic 40-event payload matching the SDK flush
threshold. Three scenarios:

| Scenario                                        | Concurrency | rps sustained | p50 latency (ms) | p95 latency (ms) | Error rate | Status |
|-------------------------------------------------|-------------|---------------|-------------------|--------------------|-----------|--------|
| Single project, cold cache, single viewer      | 1           | TBD           | TBD                | TBD               | TBD       | DRAFT  |
| Single project, warm cache, single viewer      | 1           | TBD           | TBD                | TBD               | TBD       | DRAFT  |
| 10 projects in parallel, 10 concurrent viewers  | 10          | TBD           | TBD                | TBD               | TBD       | DRAFT  |
| Rate-limit boundary (100/min/IP)                | 10          | TBD (expected ≤ 100/min before 429) | TBD | TBD | TBD | DRAFT  |
| Edge rate-limit engagement (429 + Retry-After)  | 100         | TBD           | TBD                | TBD               | TBD       | DRAFT  |

**Per-event cost** (subtract Prisma `createMany` overhead from the request
latency above, divide by the event count in the payload):

| Payload size (events per request) | Wall-clock per event (ms) | DB rows written per event | Status |
|------------------------------------|---------------------------|----------------------------|--------|
| 1                                  | TBD                       | TBD (expected: 1 Event + ≤1 Insight) | DRAFT  |
| 10                                 | TBD                       | TBD                        | DRAFT  |
| 40 (SDK flush threshold)           | TBD                       | TBD                        | DRAFT  |
| 100 (sanitizer cap)                | TBD                       | TBD                        | DRAFT  |

---

## 3. Recording replay latency

**Target component:** `src/components/app/recording-player.tsx`
(refactored in v0.6.0 — see [`docs/simplification.md`](./simplification.md) —
768 → 544 lines, helpers extracted to `recording-player-helpers.ts`).

The recording player runs a `requestAnimationFrame` loop that interpolates
the cursor between sampled mouse events. The three numbers that matter for
"does it feel live" are: time-to-first-frame (open → first cursor paint),
steady-state frame rate, and seek latency (click on the scrubber → cursor
snaps to the new position).

| Session length (s) | Event count | Time to first frame (ms) | Steady-state FPS (rAF) | Seek latency p50 (ms) | Seek latency p95 (ms) | Status |
|---------------------|-------------|--------------------------|------------------------|------------------------|------------------------|--------|
| 15                  | ~150        | TBD                      | TBD (expected ≥ 55)   | TBD                    | TBD                    | DRAFT  |
| 60                  | ~600        | TBD                      | TBD (expected ≥ 55)   | TBD                    | TBD                    | DRAFT  |
| 180                 | ~1 800      | TBD                      | TBD (expected ≥ 55)   | TBD                    | TBD                    | DRAFT  |
| 600                 | ~6 000      | TBD                      | TBD (expected ≥ 30)   | TBD                    | TBD                    | DRAFT  |

**Side-panel AI session-analysis** (modal "Ask AI" button →
`POST /api/projects/[id]/ai/session`):

| Session length (s) | Event count | Time to first response token (ms) | Total response time (ms) | Markdown sections returned | Status |
|---------------------|-------------|-------------------------------------|---------------------------|------------------------------|--------|
| 15                  | ~150        | TBD                                 | TBD                       | TBD (expected: 4 — Summary / What happened / Pain points / Recommendations) | DRAFT  |
| 60                  | ~600        | TBD                                 | TBD                       | TBD                          | DRAFT  |
| 180                 | ~1 800      | TBD                                 | TBD                       | TBD                          | DRAFT  |

> The AI latency row depends on the upstream LLM (z-ai-web-dev-sdk), so the
> measured values are an SLA on Insight Replay's *prompt compilation* + *LLM
> round-trip* combined — not a pure-insight-Replay number. When filled in,
> note which LLM endpoint was used.

---

## 4. Realtime cursor broadcast latency (live tab)

**Target service:** `mini-services/live-service/index.ts` (Socket.io on :3004).
Already discussed qualitatively in
[`docs/architecture.md`](./architecture.md) § "Realtime flow: live cursors"
("1 s cursor-snapshot interval makes the dashboard feel live"). The table
below quantifies it.

| Trackers | Viewers | Tracker→viewer p50 (ms) | Tracker→viewer p95 (ms) | Snapshot interval (ms) | CPU at steady state (%) | Status |
|----------|---------|--------------------------|--------------------------|--------------------------|---------------------------|--------|
| 1        | 1       | TBD                      | TBD                      | 1 000 (config)           | TBD                       | DRAFT  |
| 10       | 1       | TBD                      | TBD                      | 1 000 (config)           | TBD                       | DRAFT  |
| 100      | 10      | TBD                      | TBD                      | 1 000 (config)           | TBD                       | DRAFT  |
| 1 000    | 100     | TBD                      | TBD                      | 1 000 (config)           | TBD                       | DRAFT  |

---

## 5. Build / cold-start

| Command | Wall-clock (s) | Status |
|---------|----------------|--------|
| `bun install` (cold cache)             | TBD | DRAFT |
| `bun install` (warm cache)             | TBD | DRAFT |
| `bun run db:push` (8 tables, 27 @@index) | TBD | DRAFT |
| `bun run build` (Next.js standalone)    | TBD | DRAFT |
| `bun run start` cold start → first 200  | TBD | DRAFT |
| `bun mini-services/live-service/index.ts` cold start → socket.io ready | TBD | DRAFT |

---

## How these will be measured

The benchmarking pass that fills in the TBDs should follow this protocol so
the numbers are reproducible and can be re-run as a regression gate:

1. **Environment.** Single dev box, `bun run dev` on :3000, Socket.io
   service on :3004, SQLite at `db/custom.db` seeded via
   `curl -X POST localhost:3000/api/seed`. No Caddy in front (bypasses the
   :81 gateway to isolate app-layer performance from proxy overhead — the
   gateway's perf is its own benchmark).
2. **Load generator.** `k6` (or `autocannon`) scripts under
   `benchmarks/k6/` (to be created). Each script specifies rps, concurrency,
   payload, and duration; outputs a JSON summary that a small Node script
   folds into the table above.
3. **Frame-rate measurement.** Use `agent-browser`'s performance trace
   capability (or Puppeteer's `Tracing.start` with `"screenshots"` enabled)
   to capture the rAF cadence inside `recording-player.tsx`. Pull
   `requestAnimationFrame` intervals from the trace and compute p50/p95.
4. **DB-query counter.** Set `BUN_CONFIG_LOG_LEVEL=debug` and grep
   `dev.log` for `prisma:query` lines per stats-API call — confirmed already
   used in [`docs/performance.md`](./performance.md) § "How to verify" →
   "Stats API timing comparison".
5. **Steady-state hit-rate.** Drive 1 000 sequential polls at 8 s intervals
   (≈ 2.2 h wall-clock — or use time compression by varying the TTL down
   to 1 s for the test only) and count `cached: true` vs `cached: false`
   occurrences in the response bodies.
6. **Regression gate.** Once a baseline cell is filled, add the matching
   `k6` threshold to `scripts/check-quality.sh` so CI fails if a future
   commit regresses any p50/p95 by more than 20 %.

---

## Files touched

- **Created:** `docs/benchmarks.md` (this file).
- No source code touched. The numbers in
  [`docs/performance.md`](./performance.md) are referenced, not duplicated;
  once the TBDs above are filled in, the two should be cross-linked rather
  than merged (prose explanation stays in `performance.md`; tables stay
  here).

## Related docs

- [`docs/performance.md`](./performance.md) — the v0.5.0 optimization
  narrative (cache + `useMemo` + `React.memo`). The baseline numbers cited
  as "~95 ms → ~21 ms" and "~240 ms → ~11 ms" above come from that doc.
- [`docs/architecture.md`](./architecture.md) — process topology, data flow,
  realtime flow. Each table above references the architectural component it
  measures.
- [`docs/simplification.md`](./simplification.md) — recording-player and
  live-tab refactor (v0.6.0). The replay-latency table measures the
  *post-refactor* player.
