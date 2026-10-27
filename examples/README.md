# Examples — Insight Replay

This directory holds runnable code samples that complement the prose in
[`docs/architecture.md`](../docs/architecture.md). The architecture doc tells
you *what* each process does and *why*; the snippets here show the *how* in
the smallest possible standalone form.

> **Demo screenshots + GIFs are coming soon.** This README currently documents
> the source examples. A `screenshots/` sub-folder (full-dashboard.png,
> live-tab.gif, recording-player.gif, heatmaps.gif) and a `gifs/` sub-folder
> will be added in a follow-up pass — see the "To be added later" section
> below. When they land, each entry will be illustrated inline next to the
> matching snippet.

## What is here now

| Path | What it is | Read this alongside |
|------|------------|---------------------|
| [`websocket/server.ts`](./websocket/server.ts) | Minimal Socket.io server (one room, `register`/`subscribe`/`live` events, 1 s cursor snapshot). The same shape used by `mini-services/live-service` but stripped of project-scoped pruning so the protocol is the only thing on the page. | [`docs/architecture.md`](../docs/architecture.md) § "Realtime flow: live cursors" |
| [`websocket/frontend.tsx`](./websocket/frontend.tsx) | Minimal React component that connects to the server above and renders a single live cursor. No tracking SDK, no dashboard chrome — just the wire-up. | [`docs/architecture.md`](../docs/architecture.md) § "Realtime flow: live cursors" |

These two files together are roughly 1/10 the size of the production
equivalents (`mini-services/live-service/index.ts` +
`src/components/app/live-tab.tsx`) but reproduce the same end-to-end
behaviour: open the page, move the mouse, see the cursor appear on a second
client. Use them to prototype against the realtime protocol without spinning
up the full Next.js + Prisma + Caddy stack.

## How to run the websocket example

```bash
# Terminal 1 — server on :3004
bun install
bun examples/websocket/server.ts

# Terminal 2 — frontend dev server (any static host, e.g. bun's built-in)
bunx serve examples/websocket   # then open the printed URL in two browser windows
```

The two clients will share a single project room; cursors from one window
appear in the other within ~1 s (the snapshot interval).

## To be added later

These are placeholders for media that will illustrate the prose in the
architecture doc. Each will be linked inline from the matching section of
[`docs/architecture.md`](../docs/architecture.md) once produced.

| Planned path | What it shows | Linked from architecture.md § |
|--------------|---------------|-------------------------------|
| `screenshots/dashboard-overview.png` | Full Overview tab — 8 KPI cards, sessions area chart, AI Insights card, device/new-vs-returning pies, top-pages + entry/exit + countries + UTM lists. | "Dashboard tabs (15)" #1 |
| `screenshots/recordings-player.png` | Recording Player modal mid-replay — interpolated cursor, click ripple, seek bar with event markers, side panel on "Timeline" tab. | "Dashboard tabs (15)" #4 |
| `screenshots/heatmaps.png` | Heatmaps tab — rainbow canvas overlay (clicks) + scroll-depth bars. | "Dashboard tabs (15)" #5 |
| `screenshots/funnel-journeys.png` | Funnels + Journeys tabs side by side — funnel-viz with dropoff %, Sankey flow graph. | "Dashboard tabs (15)" #7, #8 |
| `gifs/live-tab.gif` | Live tab — real cursors moving in real time, click ripples, active-sessions list updating. | "Realtime flow: live cursors" |
| `gifs/recording-player.gif` | Recording Player — cursor interpolating across a 90 s session at 2× speed, click ripples firing, seek bar scrubbing. | "Dashboard tabs (15)" #4 |
| `gifs/ai-search.gif` | AI natural-language search — typing "mobile users who raged last week" → filter chips appear → matching sessions list loads. | "AI flow" |
| `gifs/ingest-end-to-end.gif` | Demo Site → live cursor → Recording Player. The reviewer's minimum-viable demo loop in one GIF. | "Build & run" § reviewer's loop |

Until those land, the best way to see the system in motion is the manual
demo loop documented at the end of
[`docs/architecture.md`](../docs/architecture.md) § "Build & run".

## Related docs

- [`docs/architecture.md`](../docs/architecture.md) — process topology, data
  flow, realtime flow, AI flow, security layers, dashboard tabs.
- [`docs/api-reference.md`](../docs/api-reference.md) — every HTTP endpoint.
- [`docs/performance.md`](../docs/performance.md) — the stats API cache and
  React memoization work (see [`docs/benchmarks.md`](../docs/benchmarks.md)
  for the placeholder benchmark tables that will measure it).
- [`docs/benchmarks.md`](../docs/benchmarks.md) — placeholder perf tables
  (cache hit/miss, ingest throughput, recording-replay latency) to be
  filled in by a follow-up benchmarking pass.
