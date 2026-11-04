# Swarm Telemetry — Round 10 / 10
**Skill:** Cosmic UX Silicon Singularity Core · Agents 9 & 10
**Date:** 2026-11-04

## Agent 9 — CSS Containment & Paint Optimization Purifier
- 2 `will-change-transform` already in place on cursor elements (`recording-player.tsx:451`, `live-tab.tsx:274`) — correct GPU layer promotion for transform-only animations
- `transition-transform` used on cursors (not `transition-all`) — minimal paint work, no layout thrash
- Tailwind's `divide-y` and `gap-*` patterns used everywhere — no manual margins that cause reflow
- **Gap found:** `live-tab.tsx:219` cursor overlay container did not declare CSS `contain`, so every cursor transform (every 100ms from cursor-snapshot interval) invalidated layout for the whole parent. Added `contain: layout style paint` to scope the invalidation.

## Agent 10 — Edge Caching & Stale-While-Revalidate Strategist
- SDK script already cached via `Cache-Control: public, max-age=300, stale-while-revalidate=3600` (`next.config.ts:132` + `/api/track/script/route.ts:259`) — correct SWR pattern
- API routes uniformly `Cache-Control: no-store, no-cache, must-revalidate` + `X-Robots-Tag: noindex, nofollow` — correct for sensitive JSON
- **Gap found:** files under `public/` (`logo.svg`, `robots.txt`, `og-image.png`) are served from the site root and do NOT inherit Next.js's automatic long-lived caching that `/_next/static/*` files get. Without explicit headers the browser re-validates them on every navigation.

## Phase 2 — Surgical patches
1. `next.config.ts`: add `publicAssetHeaders` (`Cache-Control: public, max-age=31536000, immutable`) and apply it to `/logo.svg`, `/robots.txt`, `/og-image.png` via three new `headers()` matcher entries. Eliminates the conditional-revalidation round trip for returning visitors.
2. `src/components/app/live-tab.tsx`: add `contain: layout style paint` to the cursor overlay container style. Scopes cursor-transform invalidation to the overlay subtree so the surrounding layout is not invalidated on every 100ms cursor-snapshot tick.

No behaviour change for first-time visitors.

Telemetry: docs/swarm/round-10-telemetry.md
