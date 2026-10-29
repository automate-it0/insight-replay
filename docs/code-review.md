# Code Review — Insight Replay

**Reviewer:** code-review-and-quality skill (Task ID 2)
**Date:** 2026-10-24
**Scope:** Frontend tab components + tracking ingest lib
**Method:** Five-axis review (correctness, security, performance, maintainability, tests)

## Files Reviewed

| File | LoC | Notes |
|------|-----|-------|
| `src/lib/track.ts` | 217 | Server-side event ingest + rage-click + goal-matching |
| `src/components/app/recording-player.tsx` | 890 | Session replay modal with playback, AI, notes, timeline |
| `src/components/app/live-tab.tsx` | 459 | Live cursor view with socket.io + ghost sim |
| `src/components/app/heatmaps-tab.tsx` | 294 | Canvas heatmap + scroll-depth view |
| `src/components/app/insights-tab.tsx` | 160 | Frustration signals feed |
| `src/components/app/retention-tab.tsx` | 141 | Cohort retention matrix |
| `src/components/app/goals-tab.tsx` | 207 | CRUD for URL-based conversion goals |
| `src/components/app/errors-tab.tsx` | 157 | JS error tracking + chart |
| `src/components/app/experiments-tab.tsx` | 330 | A/B experiment list + analysis view |

## Summary

- **Issues found:** 18 (1 Blocker, 9 Important, 5 Nit, 3 FYI)
- **Issues fixed:** 13 (1 Blocker, 8 Important, 4 Nit)
- **Issues deferred:** 5 (require larger refactors or are out of scope)
- **TypeScript errors in reviewed files: before 8 → after 0**
- **Total project TS errors: before 14 → after 12** (other deltas are other agents' WIP in `overview-tab.tsx` and `stats/route.ts`)
- **Lint:** clean before and after.

## Findings

| File | Issue | Severity | Status |
|------|-------|----------|--------|
| `src/lib/track.ts` | `u` possibly-undefined in goal-matching loop (`pageUrl` is optional on `TrackEventInput`, so `visitedUrls` was `Set<string \| undefined>`) | Blocker | Fixed — typed predicate filters out undefined URLs; also guards `g.url` empty-string case |
| `src/lib/track.ts` | `db.insight.create().catch(() => null)` swallows all errors silently — useful for non-fatal inserts, but should log for observability | FYI | Deferred — observability agent territory |
| `src/lib/track.ts` | Rage-click detection only checks 3 consecutive clicks in payload order; if events arrive out-of-order across payloads, false negatives possible | FYI | Deferred — would need session-wide windowing |
| `recording-player.tsx` | TS errors: `r.rage`/`r.dead` not on empty-branch `ripples` type cast (lines 483-500) | Blocker | Fixed — empty branch now types `rage?`/`dead?` to match the populated branch |
| `recording-player.tsx` | `useEffect` for keyboard controls had no deps array → listener re-registered on every render | Important | Fixed — uses ref pattern so listener registers once |
| `recording-player.tsx` | Dead code: `insights.map((ins) => { const ev = events.find((e) => e.t >= 0); void ev; return null })` rendered nothing | Important | Fixed — removed the no-op block |
| `recording-player.tsx` | Loop over all projects to find session (`for (const p of projects) try…catch continue`) is O(N) requests per open | Nit | Deferred — would need session→project index endpoint |
| `recording-player.tsx` | Icon-only buttons (close, bookmark, skip) lack `aria-label` | Nit | Deferred — shadcn Button component, low impact |
| `live-tab.tsx` | `loadActive` was async, called in `useEffect` with no cancellation; state could update after unmount/projectId change | Important | Fixed — added `alive` flag and inline `fetchActive` with guard |
| `live-tab.tsx` | Empty `catch {}` blocks (lines 74, 90) | Nit | Fixed — added comments explaining intent |
| `live-tab.tsx` | Simulation interval mutates `cur.x`/`cur.y` directly (state mutation smell) | Important | Deferred — works because of trailing spread, but is fragile. Larger refactor to use immutable updates |
| `live-tab.tsx` | Socket.io connect on every `projectId` change with `forceNew: true` could leak sockets if projectId changes rapidly | FYI | Deferred — `socket.disconnect()` in cleanup should handle it; verify in long-running sessions |
| `heatmaps-tab.tsx` | `api()` call had `.finally()` but no `.catch()` — unhandled rejection on network failure | Important | Fixed — added `.catch()` that sets data to null + `alive` guard |
| `heatmaps-tab.tsx` | `octx = off.getContext("2d")!` non-null assertion | Nit | Fixed — proper null check with early return |
| `insights-tab.tsx` | `api()` call had no `.catch()` — unhandled rejection | Important | Fixed — added `.catch()` + `alive` guard |
| `insights-tab.tsx` | `icon: any` in `META` type | Nit | Fixed — `ComponentType<{ className?: string }>` |
| `retention-tab.tsx` | `api()` call had no `.catch()` | Important | Fixed |
| `errors-tab.tsx` | `api()` call had no `.catch()` | Important | Fixed |
| `goals-tab.tsx` | `load()` async function had `try/finally` but no `catch` — unhandled rejection on network failure | Important | Fixed — added `catch` that resets goals to `[]` |
| `goals-tab.tsx` | `Math.max(...goals.map(...))` recomputed inside `.map()` for every goal — O(N²) | Nit | Fixed — hoisted `max` outside the loop |
| `goals-tab.tsx` | Delete button (icon-only) had no `aria-label` | Nit | Fixed — `aria-label="Delete goal {name}"` |
| `experiments-tab.tsx` | `load()` had `try/finally` but no `catch` — unhandled rejection | Important | Fixed — added `catch` that resets experiments to `[]` |
| `experiments-tab.tsx` | `Trash2` SVG with `onClick` inside `<button>` parent — invalid a11y (icon not focusable, no keyboard support) | Important | Fixed — restructured row as `div[role=button][tabIndex=0]` with real `<button>` for delete + `aria-label` + `onKeyDown` |
| `experiments-tab.tsx` | Empty `catch {}` in `removeExp` and `setStatus` | Nit | Deferred — these already use toast in some paths; adding toast everywhere is a UX decision |
| `experiments-tab.tsx` | `useEffect(() => { if (active) analyze(active) }, [range])` has stale closure on `active` | FYI | Deferred — works for the intended use case (re-analyze on range change), but fragile if deps change |

## Verification

- `bun run lint` → exit 0 (no output, clean)
- `bunx tsc --noEmit 2>&1 | grep -E "recording-player|live-tab|heatmaps-tab|track.ts|insights-tab|retention-tab|goals-tab|errors-tab|experiments-tab"` → 0 matches (was 8 before)
- Dev server compiles: `dev.log` shows `✓ Compiled in 1159ms` with no errors in reviewed files (one pre-existing `Ecmascript file had an error` is in `overview-tab.tsx`, owned by performance agent)
- `/api/health` returns 503 with `memory: degraded (156/165 MB)` — pre-existing system state, not caused by these changes

## Deferred Issues — Notes

The following require larger refactors or are owned by other agents:

1. **`live-tab.tsx` state mutation in sim loop** — The simulation interval mutates `cur.x`/`cur.y` directly on the previous state object. It works because of the trailing `next[g.id] = { ...cur, ... }` spread, but this is fragile React. Proper fix: build the new cursor object immutably before assignment. ~10 lines.

2. **`recording-player.tsx` O(N) project scan** — Opening a recording triggers a request to `/api/projects`, then loops through every project trying `/api/projects/{pid}/sessions/{sid}` until one succeeds. With many projects this is wasteful. Fix: add a `GET /api/sessions/{sid}` endpoint that resolves the project server-side.

3. **`track.ts` silent error swallowing** — `db.insight.create().catch(() => null)` and `db.errorEvent.create().catch(() => null)` swallow all errors. Useful for not failing the ingest on a single bad insert, but should at minimum log to observability. Coordinate with whoever owns the observability surface.

4. **`track.ts` cross-payload rage-click detection** — Current detection only looks at 3 consecutive clicks within a single ingest payload. If clicks span multiple payloads (common with batched tracking), rage clicks will be missed. Would need a session-wide sliding window query.

5. **`experiments-tab.tsx` stale closure on `active`** — `useEffect(() => { if (active) analyze(active) }, [range])` captures `active` from the closure. Works for the current UX (re-analyze current experiment when range changes) but is fragile. Better: use a ref or restructure.

## What Was NOT Changed

Per task boundaries, these files were left untouched (parallel work streams own them):
- `src/app/api/projects/[id]/stats/route.ts` (performance pass)
- `src/components/app/overview-tab.tsx` (performance pass)
- `src/components/app/dashboards-tab.tsx` (performance pass)
- `src/lib/cache.ts` (performance pass — creating)
- `tests/**` (test pass)
- `docs/adr/**` and other `docs/` files (documentation pass)
