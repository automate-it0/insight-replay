# Swarm Telemetry — Round 06 / 10
**Skill:** Cosmic UX Silicon Singularity Core · Agents 1 & 2
**Date:** 2026-11-04

## Agent 1 — Predictive LCP & Neural-Vitals Exterminator
- 0 raw `<img>` tags in the codebase — every image is SVG (logo.svg) or lucide-react icon
- Fonts are self-hosted via `next/font/google` (Geist + Geist Mono); Geist Mono already has `preload: false` (smart — mono first renders deep in the authed dashboard, not on /login)
- `meProbe` prefetch pattern in `src/app/page.tsx:34` kicks off `/api/auth/me` at script-parse time so the round trip overlaps JS parse + hydration — already an LCP optimization win
- Loading skeleton in `src/app/page.tsx:80-97` is already a `role="status"` + `aria-live="polite"` block — good a11y + perceived performance
- `Cache-Control: public, max-age=300, stale-while-revalidate=3600` on `/api/track/script` SDK is correct (immutable per pid+port URL)

## Agent 2 — Zero-Blocking Main-Thread & Web Worker Offloader
- Heavy client-side work (Recharts rendering, recording playback) is async/deferred via `setTimeout(load, 250)` debounce pattern in recordings-tab.tsx
- `use-tracker.ts` uses `{ passive: true }` on every addEventListener for mousemove/click/scroll/keydown/resize — already non-blocking
- Live cursor updates batched via `bufRef` (>=30 events → flush) — microtask-friendly
- No `JSON.parse` on critical-path main-thread work in client components (server-side only)

## Phase 2 — Surgical patches
1. **`src/app/loading.tsx` (new):** App Router per-route loading boundary. Without it Next shows a blank frame during route transitions; this file mirrors the dashboard shell layout so the LCP element (the Loader2 spinner) is stable when the real content hydrates. Zero CLS contribution.
2. **`src/app/layout.tsx`:** add `<link rel="preconnect">` to `fonts.googleapis.com` + `fonts.gstatic.com` so next/font's metadata handshake completes one RTT sooner on cold visits.

No behaviour change for cached sessions.
