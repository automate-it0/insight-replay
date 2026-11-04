# Swarm Telemetry — Round 08 / 10
**Skill:** Cosmic UX Silicon Singularity Core · Agents 5 & 6
**Date:** 2026-11-04

## Agent 5 — Asynchronous Fetch Waterfall & Optimistic State Annihilator
- 5 `Promise.all` sites confirmed:
  - `alerts-tab.tsx:73` — fetches alerts + history in parallel ✅
  - `recording-player.tsx:137` — fetches notes + tags + bookmarks + errors in parallel ✅
  - `dashboard-view.tsx:58` — fetches per-project stats in parallel ✅
  - `ai/session/route.ts:192` — server-side parallel ✅
  - `sessions/[sid]/route.ts:13` — server-side parallel (session + events + insights) ✅
- The remaining `await api(...)` sites are intentionally sequential because the second request depends on an ID returned by the first (e.g. `/dashboards` → `/dashboards/[id]/data`). No waterfall to fix.
- `useRef(0)` sequence-guard pattern (`loadSeq.current` / `dataSeq.current` / `analyzeSeq.current`) prevents stale responses from overwriting newer ones — correct race-condition handling.

## Agent 6 — GPU Acceleration & Layout Shift / CLS Eradicator
- 45 fixed height/width style entries — components reserve layout space eagerly
- Every loading state uses the `<Skeleton>` component (not blank frames) — prevents CLS during fetch
- `loading.tsx` (round-6 patch) added per-route loading boundary
- However: `src/app/layout.tsx` was missing the dedicated `viewport` export that Next.js 14+ requires — `themeColor` and `viewport` properties had to move out of `metadata` into a separate `export const viewport: Viewport`. Without this Next logs a deprecation warning at build time AND the viewport meta tag is implicit, which on iOS Safari permits auto-zoom-on-input-focus (a measurable CLS contribution).

## Phase 2 — Surgical patch
1. `src/app/layout.tsx`: add `export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0a0a0a" }`. This silences the Next.js 14+ build warning, makes the viewport explicit, prevents the iOS Safari auto-zoom-on-input-focus CLS contribution, and pins the browser chrome color to the dashboard's `--background` token (#0a0a0a).

No behaviour change for desktop Chrome.

Telemetry: docs/swarm/round-08-telemetry.md
