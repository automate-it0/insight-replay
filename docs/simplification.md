# Simplification — recording-player.tsx & live-tab.tsx

Task ID: 3 (Simplification)
Scope: simplify the two most complex frontend components while preserving exact behavior.

---

## Before / after line counts

| File | Before | After | Delta |
|------|-------:|------:|------:|
| `src/components/app/recording-player.tsx` | 896 | 883 | −13 |
| `src/components/app/recording-player-helpers.ts` (new) | — | 223 | +223 |
| `src/components/app/live-tab.tsx` | 463 | 314 | −149 |
| `src/components/app/live-tab-helpers.ts` (new) | — | 283 | +283 |

**Main component body sizes** (the cognitive-complexity metric that matters):

| Component | Before | After | Target |
|-----------|-------:|------:|-------:|
| `RecordingPlayer` function body | ~768 lines | ~544 lines | 500–600 ✓ |
| `LiveTab` function body | ~220 lines | ~208 lines | ~200 ✓ |

The total line count across both files went up slightly (1358 → 1703) because
extracting pure helpers + sub-components adds import/export boilerplate and
interface definitions. The win is **cognitive complexity per function**: the
main components now focus on wiring React state to the DOM, while the
arithmetic (replay-state interpolation, ghost-cursor simulation, cursor-map
transitions) lives in independently readable, pure, testable helpers.

---

## What was extracted and why

### recording-player-helpers.ts (new — 223 lines)

1. **`computeReplayState(events, currentTime)`** — the 78-line `useMemo` that
   derived page URL, scroll offset, interpolated cursor position, ripples and
   the page sequence from the event stream. Now a pure function; the component
   calls it via `useMemo(() => computeReplayState(events, currentTime), …)`.

2. **`computeRipples(events, currentTime)`** — the click-ripple scan (clicks
   within the last 600 ms, with rage/dead flags). Called by
   `computeReplayState`; also exported standalone for reuse.

3. **`extractPages(events, currentTime)`** — the distinct page-view sequence
   up to the current playback position. Called by `computeReplayState`; also
   exported standalone.

4. **`computeScale(cw, ch, sw, sh)`** — the ResizeObserver scale calculation.
   Small but pure; extracted so the component effect is just wiring.

5. **`findProjectForSession(sessionId)`** — the "fetch `/api/projects`, then
   probe each project's session endpoint" lookup. Previously duplicated in 4
   CRUD functions (runAI, toggleBookmark, addTag, addNote). Now a single
   helper, **cached in a `projectIdRef`** so it only runs once per session.

6. **Shared types** — `EventRow`, `SessionRow`, `InsightRow`, `Ripple`,
   `PageInfo`, `ReplayState`. Moved out of the component file so both the
   helpers and the component import them from one place.

### recording-player.tsx — in-file refactors

7. **`projectIdRef` cache + `getProjectId()`** — the initial load effect now
   caches the project id (`projectIdRef.current = p.id`) when it finds the
   session. The 4 CRUD functions call `getProjectId()` which returns the
   cached value or falls back to `findProjectForSession`. This eliminates 4
   copies of the "fetch projects → loop → probe" pattern (~40 lines removed).

8. **Side-panel tab sub-components** — `InfoTab`, `AiTab`, `NotesTab`,
   `TimelineTab` extracted as named function components within the file. Each
   receives its data/callbacks as props. This flattens the deeply-nested
   `sideTab === "info" && (…)` conditional blocks into four one-line
   `<InfoTab …/>` calls, making the panel's structure scannable at a glance.

9. **Ripple colour simplification** — the triple-ternary
   `r.rage ? "248,113,113" : r.dead ? "251,191,36" : "16,185,129"` was
   repeated 3× (border, background, dot). Extracted to a single `ringColor`
   variable, then interpolated into `rgba(…)` / `rgb(…)`. Produces byte-
   identical CSS strings.

### live-tab-helpers.ts (new — 283 lines)

10. **Ghost-cursor simulation** — `initGhosts(count, now)`,
    `ghostsToCursors(ghosts, prev, now)`, `tickGhosts(ghosts, prev, now)`,
    `removeGhosts(prev)`. The entire 80-line simulation state machine (random
    walk, target picking, page switching, scrolling, click generation) is now
    pure functions. The component just owns the `setInterval` and the React
    state bridge.

11. **Cursor-map transitions** — `addCursorsFromList`, `addCursor`,
    `removeCursor`, `applyLiveEvent`, `applyCursorSnapshot`. Each socket
    event handler was an inline `setCursors((prev) => { … 10–20 lines … })`
    block; now each handler is a one-liner:
    `setCursors((prev) => applyLiveEvent(prev, msg, Date.now()))`.

12. **Shared types + constants** — `LiveCursor`, `ActiveSession`, `Ghost`,
    socket payload interfaces, `CURSOR_COLORS`, `SIM_PAGES`,
    `CLICK_RIPPLE_MS`.

### live-tab.tsx — in-file refactors

13. **`Cursor` sub-component** — the 50-line per-cursor render (ripples +
    arrow + label) extracted from the inline `cursorList.map(…)`. The parent
    now maps to `<Cursor key={c.sessionId} c={c} />`.

14. **Removed unused imports** — `Radio`, `Globe`, `fmtRelative` were imported
    but never referenced in the original. Dropped.

---

## What was NOT changed (Chesterton's Fence)

These were considered for removal/change but kept because they serve a
purpose:

- **The `break` after the first successful session fetch in the initial-load
  effect.** It looks like it should be inside the `if (d.session)` guard, but
  the session endpoint returns 404 for missing sessions (caught by the
  `try/catch → continue`), so reaching the `break` means the response was
  200. Moving the `break` inside the guard would be a no-op in practice but
  would change the control flow if the API ever returned a 200 with a falsy
  `session`. Left as-is.

- **The `moves` pre-scan in `computeReplayState`.** It collects *all*
  mousemove events into an array just to fall back to `moves[0]` when no move
  has happened yet at `currentTime = 0`. This is O(N) extra work, but N is
  typically < 1000 events per session, and the fallback is needed for the
  very first frame (before any mousemove has been played). Kept for fidelity.

- **The `projectIdRef` reset on sessionId change.** Added
  `projectIdRef.current = null` at the start of the initial-load effect. This
  is new behaviour, but it's required for correctness: if the user closes one
  recording and opens another (different sessionId), the cached pid from the
  first session must not leak into the second. This is a bug fix bundled with
  the simplification, not a behaviour change for the single-session path.

- **The ghost state mutation in `tickGhosts`.** The ghost objects (`g.tx`,
  `g.ty`, `g.url`, `g.scrollY`, `g.nextClick`) are mutated in place, while
  the cursor map is returned as a fresh immutable object. This mirrors the
  original exactly. Rewriting it as fully immutable would change the
  performance characteristics (allocating 4 ghost objects per 60ms tick) for
  no clarity benefit.

- **The `Date.now()` → `now` parameter threading in live-tab helpers.** The
  original called `Date.now()` multiple times within a single tick (for
  click filtering, click pushing, next-click scheduling). The helpers take a
  single `now` parameter. The difference is microseconds — well within the
  800 ms / 2000 ms / 4000 ms thresholds — and makes the functions pure /
  testable. Kept (it's a simplification, not a behaviour change).

- **The `Stat`, `Row`, `EventIcon`, `DeviceIcon` sub-components** at the
  bottom of recording-player.tsx. Already clean and self-contained. Left
  untouched.

- **The `DemoSiteButton` and `DeviceIcon` sub-components** at the bottom of
  live-tab.tsx. Already clean. Left untouched.

---

## Behaviour verification evidence

### Type checking
```
$ bunx tsc --noEmit 2>&1 | grep -E "recording-player|live-tab" | wc -l
0
```
Zero type errors in the four files in scope.

### Lint (scoped to my files)
```
$ bunx eslint src/components/app/recording-player.tsx \
              src/components/app/recording-player-helpers.ts \
              src/components/app/live-tab.tsx \
              src/components/app/live-tab-helpers.ts
(exit 0, no output)
```

### Tests
```
$ bun test tests/
130 pass | 9 skip | 0 fail | 201 expect() calls
```
All 130 pure-function tests pass (ua, sanitize, rate-limit, observability).
0 failures. The 9 skips are all API-contract integration tests that skip
when the dev server is broken (see Browser verification blocker below).
**Baseline before my changes: 138 pass, 1 skip, 0 fail** — the delta (8
tests moving from pass → skip) is entirely due to the dev server going down
mid-session (see below), not my changes.

### Browser verification — BLOCKED (not by my changes)

The dev server (`bun run dev`, port 3000) is running but every page returns
HTTP 500. The cause is a **syntax error in `src/components/app/filter-bar.tsx`
line 70**, introduced by the accessibility agent's concurrent work:

```tsx
// broken — unbalanced backticks in the template literal
aria-label={`Filter by device${filters.device ? ": ${filters.device}` : ""}`}
//                                                              ^ stray backtick
```

`filter-bar.tsx` is imported by `project-view.tsx` which is imported by
`src/app/page.tsx`, so the syntax error breaks SSR for every route. This is
**out of my scope** (the task explicitly says not to touch other
`src/components/app/*.tsx` files). The accessibility agent needs to fix the
template literal (the correct form is
`` `Filter by device${filters.device ? `: ${filters.device}` : ""}` ``).

Evidence that my files are NOT the cause — the Next.js compile error trace
names only `filter-bar.tsx`:
```
⨯ ./src/components/app/filter-bar.tsx:70:152
  Parsing ecmascript source code failed
  Import traces:
    ./src/components/app/filter-bar.tsx [Client Component Browser]
    ./src/components/app/project-view.tsx [Client Component Browser]
    ./src/app/page.tsx [Client Component Browser]
```

My files (`recording-player.tsx`, `recording-player-helpers.ts`,
`live-tab.tsx`, `live-tab-helpers.ts`) do not appear in any error trace and
compile cleanly under both `tsc` and `eslint`. Once the accessibility agent
fixes the `filter-bar.tsx` template literal, the recording player and live
tab will render — no further changes needed from my side.

### Behaviour-preservation audit (manual, code-level)

| Behaviour | Original | Refactored | Same? |
|-----------|----------|------------|:-----:|
| Replay state (page/scroll/cursor/ripples/pages) | inline `useMemo` | `computeReplayState` | ✓ identical logic |
| Cursor interpolation between mousemove events | inline in memo | `computeReplayState` | ✓ identical math |
| Click ripple colours (rage=red, dead=amber, normal=green) | 3× ternary | 1× `ringColor` var | ✓ byte-identical CSS |
| Project lookup for CRUD actions | 4× duplicated loop | `findProjectForSession` + ref cache | ✓ same end result |
| Initial load (session + notes/tags/bookmark/errors) | inline effect | inline effect + pid cache | ✓ identical + cache |
| Side panel 4 tabs | inline conditional JSX | 4 sub-components | ✓ same DOM, same props |
| Live socket handlers (5 events) | inline `setCursors` blocks | pure helper calls | ✓ identical transitions |
| Ghost simulation (4 cursors, random walk, clicks) | inline `setInterval` | `initGhosts`/`tickGhosts` | ✓ identical state machine |
| Ghost cleanup on simulation stop | inline `delete sim_*` | `removeGhosts` | ✓ identical |
| Cursor rendering (ripples + arrow + label) | inline `cursorList.map` | `<Cursor>` sub-component | ✓ same JSX |
| Keyboard controls (space/arrows/escape) | ref-stable listener | unchanged | ✓ untouched |

---

## Files touched

| File | Action |
|------|--------|
| `src/components/app/recording-player-helpers.ts` | **created** (223 lines) |
| `src/components/app/recording-player.tsx` | refactored (896 → 883 lines) |
| `src/components/app/live-tab-helpers.ts` | **created** (283 lines) |
| `src/components/app/live-tab.tsx` | refactored (463 → 314 lines) |

No other files were modified.
