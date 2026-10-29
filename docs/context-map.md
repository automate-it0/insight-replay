# Insight Replay — Context Map

This is the project map for **context engineering**: it tells any contributor
where things live, which files matter most, which files to touch
for common tasks, how modules depend on each other, and which docs to read
before working on a given area. It is the index over everything else.

Companion docs:
- [`architecture.md`](./architecture.md) — runtime topology + data flow.
- [`api-style-guide.md`](./api-style-guide.md) — HTTP API contract.
- [`onboarding.md`](./onboarding.md) — how to ramp up
  on this repo.
- [`../CHANGELOG.md`](../CHANGELOG.md) — chronological release history.

---

## 1. Directory structure

```
my-project/
├── AGENTS.md                       # Engineering workflow + verification bar. Read first.
├── worklog.md                      # Append-only chronological history of every task.
├── package.json                    # Bun scripts: dev / build / lint / db:push / db:migrate / db:reset / start.
├── next.config.ts                  # Next.js config: standalone output + 6 security response headers.
├── tsconfig.json                   # strict TS, path alias @/* → src/*
├── eslint.config.mjs               # Flat ESLint config (eslint-config-next).
├── tailwind.config.ts              # Tailwind 4 + animate plugin.
├── postcss.config.mjs              # @tailwindcss/postcss.
├── components.json                 # shadcn/ui config (style: default, baseColor: slate).
├── Caddyfile                       # Gateway on :81; @transform_port_query routes ?XTransformPort=*
├── prisma/
│   └── schema.prisma               # 16 models: Project, Session, Event, Insight, ErrorEvent,
│                                   #   Funnel, Goal, Segment, Note, Tag, Bookmark, Alert,
│                                   #   AlertHistory, Dashboard, Experiment, Annotation, ApiKey.
│
├── db/
│   └── custom.db                   # SQLite file (single, file-copy backup).
│
├── src/
│   ├── app/                        # Next.js App Router
│   │   ├── layout.tsx              # Root layout: <html>, Toaster, skip-link.
│   │   ├── page.tsx                # Root page: dashboard shell (id="main-content").
│   │   ├── globals.css             # Tailwind directives + HSL CSS vars (dark theme).
│   │   ├── api/                    # ~50 route handlers. See api-reference.md.
│   │   │   ├── route.ts            #   GET / — list projects (alias of /api/projects)
│   │   │   ├── health/route.ts     #   GET /api/health — liveness probe.
│   │   │   ├── audit/route.ts      #   GET /api/audit — read logs/audit.jsonl.
│   │   │   ├── observability/route.ts
│   │   │   ├── seed/route.ts       #   POST /api/seed — generate demo data.
│   │   │   ├── track/
│   │   │   │   ├── events/route.ts #   POST /api/track/events — ingest (open, CORS+origin+rate-limit+sanitize).
│   │   │   │   └── script/route.ts #   GET  /api/track/script — standalone tracker SDK.
│   │   │   └── projects/[id]/...   #   ~40 nested routes: stats, sessions, heatmap, insights,
│   │   │                           #   funnels, goals, alerts, experiments, dashboards, visitors,
│   │   │                           #   retention, journeys, errors, segments, annotations, export,
│   │   │                           #   apikeys, ai, ai/session, ai-search, audit, protected-test,
│   │   │                           #   realtime, compare.
│   │   └── (no other app-router folders — single route tree)
│   │
│   ├── components/
│   │   ├── app/                    # Dashboard domain components (one per tab + shared).
│   │   │                           # See frontend.mdc for the full file list.
│   │   └── ui/                     # shadcn/ui primitives (Button, Dialog, Popover, …).
│   │
│   ├── lib/                        # Server-side utilities + shared pure functions.
│   │   ├── db.ts                   # Prisma client singleton (globalThis-stashed for dev HMR).
│   │   ├── api.ts                  # Client-side api() fetch helper + fmt* formatters.
│   │   ├── api-response.ts         # Standardized envelopes: apiSuccess / apiError / paginated + 8 shortcuts.
│   │   ├── validate.ts             # Pure validators: validateString/Number/Enum/UrlPath/Object/Pagination.
│   │   ├── auth.ts                 # validateApiKey (Bearer or ?apikey=), getApiKey, unauthorizedResponse.
│   │   ├── rate-limit.ts           # rateLimit (per-IP fixed window), getClientIP, INGEST_LIMIT/API_LIMIT.
│   │   ├── sanitize.ts             # sanitizePayload (HTML-escape, proto-pollution guard, caps).
│   │   ├── audit.ts                # auditLog → logs/audit.jsonl, AUDIT_ACTIONS constants.
│   │   ├── track.ts                # ingest() — anonymize IP, fakeGeo, parseUA, rage/dead-click detect, Prisma writes.
│   │   ├── ua.ts                   # parseUA, anonymizeIP, fakeGeo (deterministic from anon IP).
│   │   ├── cache.ts                # TTL cache (60s, globalThis) for stats aggregations (ADR-0005).
│   │   ├── observability.ts        # logger → logs/app.jsonl, recordHttpRequest, getRequestId.
│   │   └── utils.ts                # cn() (clsx + tailwind-merge).
│   │
│   ├── store/
│   │   └── app.ts                  # Zustand store: view, activeProjectId, tab, range, filters.
│   │
│   ├── hooks/
│   │   ├── use-mobile.ts           # useIsMobile() (shadcn helper).
│   │   └── use-toast.ts            # useToast() (shadcn helper).
│   │
│   └── middleware.ts               # Edge middleware: rate-limit /api/track/events + stamp x-request-id.
│
├── mini-services/
│   └── live-service/
│       ├── index.ts                # Socket.io server on :3004. In-memory Map of active sessions.
│       └── package.json            # socket.io, standalone (not in the main package.json).
│
├── tests/
│   ├── api-contracts.test.ts       # Integration tests hitting localhost:3000 (test.skipIf down).
│   ├── ua.test.ts                  # Unit tests for src/lib/ua.ts.
│   ├── sanitize.test.ts            # Unit tests for src/lib/sanitize.ts.
│   ├── rate-limit.test.ts          # Unit tests for src/lib/rate-limit.ts.
│   ├── observability.test.ts       # Unit tests for src/lib/observability.ts.
│   ├── database-runtime-build.sh   # DB runtime smoke test (shell).
│   ├── python-runtime-build.sh     # Python runtime smoke test (shell).
│   ├── python-runtime-container.sh # Python container smoke test (shell).
│   └── browser/                    # E2E browser scripts (agent-browser). May not exist yet.
│
├── docs/                           # This directory. Reference docs + ADRs + audits.
│   ├── README.md                   # Index of docs.
│   ├── architecture.md             # Process topology + data/realtime/AI flow diagrams.
│   ├── api-reference.md            # Every HTTP route with method, path, auth, body, response, curl.
│   ├── api-style-guide.md          # Authoritative API contract + error catalog + migration plan.
│   ├── accessibility-audit.md      # WCAG 2.1 AA audit + fixes.
│   ├── code-review.md              # Five-axis code review of frontend tabs + ingest.
│   ├── performance.md              # TTL cache + memoisation report.
│   ├── simplification.md           # recording-player + live-tab extraction report.
│   ├── ci-cd.md                    # GitHub Actions pipeline.
│   ├── context-map.md              # ← This file.
│   ├── onboarding.md               # Onboarding guide: how to ramp up on this repo.
│   └── adr/
│       ├── 0001-use-prisma-sqlite-over-postgres.md
│       ├── 0002-socketio-mini-service-for-realtime.md
│       ├── 0003-llm-powered-ai-features.md
│       ├── 0004-security-hardening-layers.md
│       ├── 0005-in-memory-cache-for-stats.md
│       └── 0006-unified-engineering-workflow.md
│
├── scripts/
│   └── check-quality.sh            # Local CI runner (lint + typecheck + test + build).
│
├── public/                         # Static assets (logo.svg, robots.txt).
├── logs/                           # Created at runtime. .gitignore'd.
│   ├── app.jsonl                   # Structured app logs (observability.ts).
│   ├── audit.jsonl                 # Audit entries (audit.ts).
│   └── dev.log                     # Next.js dev server stdout (tee'd by `bun run dev`).
├── tool-results/                   # Scratch space for tool outputs (not committed).
├── download/                       # Misc scratch (README only).
├── examples/
│   └── websocket/                  # Reference WS server + client (not used in production).
└── shot-*.png                      # Screenshot artifacts from browser verification runs.
```

---

## 2. Key files index — the 10 most important files

If you read only ten files to understand the project, read these:

| # | File                                   | Why it matters                                                                                              |
|---|----------------------------------------|-------------------------------------------------------------------------------------------------------------|
| 1 | `AGENTS.md`                            | The engineering workflow. Defines the task decision tree, the six core operating behaviors, the verification bar. Start here. |
| 2 | `docs/architecture.md`                 | The runtime topology: which processes run, on which ports, how requests flow, how data is persisted.       |
| 3 | `prisma/schema.prisma`                 | The data model. 16 models; cascade-delete rules; the indexes that drive query performance.                 |
| 4 | `src/app/api/track/events/route.ts`    | The ingest endpoint. The most security-sensitive route: origin validation, CORS, sanitization handoff, audit logging. Pattern to mirror for any new open endpoint. |
| 5 | `src/lib/track.ts`                     | `ingest()` — the core business logic of analytics: IP anon, fakeGeo, UA parse, rage/dead-click detection, goal matching, Prisma writes. |
| 6 | `src/lib/api-response.ts`              | The ONE success/error envelope. Every new route must use `apiSuccess` / `apiError` / `paginated` or document why it can't. |
| 7 | `src/components/app/project-view.tsx`  | The dashboard shell. Renders the 15-tab strip, the time-range selector, the live indicator, the alert bell, and dispatches to the active tab component. |
| 8 | `src/store/app.ts`                     | The Zustand store. The `Tab` union is the source of truth for the tab list; the `Filters` interface is the source of truth for the filter bar. |
| 9 | `src/middleware.ts`                    | Edge middleware: rate-limits `/api/track/events`, stamps `x-request-id`. The only code that runs before every `/api/*` handler. |
| 10 | `mini-services/live-service/index.ts`  | The Socket.io server. Defines the realtime contract: `register` / `subscribe` / `live` events, 1s cursor snapshots, 60s stale pruning. |

---

## 3. Common tasks → files to touch

### Add a new dashboard tab

1. `src/store/app.ts` — add the new id to the `Tab` union.
2. `src/components/app/project-view.tsx` — add an entry to the `TABS` array (id, label, icon) and a render branch in the tabpanel `{tab === "newid" && <NewTab … />}`.
3. `src/components/app/new-tab.tsx` — create the component (mirror an existing tab's shape: `useEffect` to fetch, `Skeleton` while loading, `Card`-based layout).
4. (If filterable) `src/components/app/project-view.tsx` — add the id to `FILTERABLE_TABS` so the `FilterBar` shows; `src/components/app/filter-bar.tsx` may need new filter dimensions.
5. (If it has a new API) `src/app/api/projects/[id]/<resource>/route.ts` — follow the api-conventions rule.

### Add a new API route

1. `src/app/api/projects/[id]/<resource>/route.ts` — implement `GET` / `POST` / etc. using `apiSuccess` / `apiError` / `paginated`.
2. `src/lib/validate.ts` — add a validator if the input is non-trivial.
3. `tests/api-contracts.test.ts` — add a contract test (use `test.skipIf(!serverAvailable)`).
4. (If mutating) `src/lib/audit.ts` — call `auditLog({ action: AUDIT_ACTIONS.X, … })` and add the constant.
5. (If it should be API-key gated) `src/lib/auth.ts` — `validateApiKey(req, projectId)`; follow the pattern in `protected-test/route.ts`.
6. Update `docs/api-reference.md`.

### Change the data model

1. `prisma/schema.prisma` — edit the model.
2. `bun run db:push` — apply (destructive! `--accept-data-loss` is already in the script).
3. `bun run db:generate` — regenerate the Prisma client.
4. Touch every route that reads/writes the model. Grep for `db.<model>` to find them.
5. If the change is significant, write an ADR under `docs/adr/` (continue the numbering).
6. Update `docs/architecture.md` if the persistence layout table changes.

### Add a new security control

1. Add the control as a new disjoint file under `src/lib/` (defense-in-depth = disjoint files; never merge two controls).
2. Wire it in at the right layer:
   - Edge (runs on every `/api/*`) → `src/middleware.ts`.
   - Per-route (origin/CORS/sanitize) → the route handler.
   - Response headers → `next.config.ts` `headers()`.
3. Add unit tests under `tests/<control>.test.ts`.
4. Update [`docs/adr/0004-security-hardening-layers.md`](./adr/0004-security-hardening-layers.md) — bump the layer count, explain the new control, justify why it's disjoint.

### Add a new AI feature

1. Route handler in `src/app/api/projects/[id]/ai*/route.ts` — lazy-import `z-ai-web-dev-sdk`, call `zai.chat.completions.create({ messages, thinking: { type: "disabled" } })`, return `{ analysis }` (200 even on error — see ADR-0003).
2. Compile the prompt: pull aggregates from Prisma, format as a description string with `## Section` headings.
3. UI component under `src/components/app/ai-*.tsx` — fetch on mount, show `Skeleton` while loading, render markdown via `react-markdown`, expose a Refresh button with `aria-label`.
4. NEVER import `z-ai-web-dev-sdk` in client code — it's server-only and lazy-imported to keep it out of the browser bundle.

### Add a Realtime feature

1. `mini-services/live-service/index.ts` — add a new socket event handler (`socket.on("new_event", …)`) and a broadcast (`io.to(room).emit(...)`).
2. Client: `src/components/app/live-tab.tsx` (or wherever the subscriber lives) — `socket.on("new_event", handler)`. Use the pure helpers in `live-tab-helpers.ts` for state transitions.
3. Remember the live-service holds **no durable state** — anything that needs to persist must also flow through `/api/track/events`.

### Change an existing API response shape

**Don't** — without a migration plan. Per Hyrum's Law, every field a client
reads is now part of the API.

1. Read [`docs/api-style-guide.md#migration-plan`](./api-style-guide.md) (4-phase rollout).
2. Add the new field ADDITIVELY (keep the old field present).
3. Update every caller in `src/components/app/*.tsx`.
4. Once all callers use the new field, deprecate the old one in a follow-up.
5. Never change an HTTP status code without a migration plan.

---

## 4. Dependency graph (text-based)

### `src/lib/` (server-side, the foundation)

```
db.ts ──────────────────────────────────────────────── Prisma client (singleton)
  ▲
  │
  ├── auth.ts                  (validateApiKey → db.apiKey.findFirst)
  ├── cache.ts                 (cacheGet/cacheSet — globalThis Map, no DB)
  ├── track.ts ──┬─ ua.ts      (parseUA, fakeGeo, anonymizeIP — pure)
  │              └─ db.ts
  └── (every route handler under src/app/api/** imports db.ts)
```

### `src/app/api/track/events/route.ts` — the ingest pipeline

```
POST /api/track/events
  │
  ├── src/middleware.ts        (edge: rate-limit + x-request-id stamp)
  │     └── src/lib/rate-limit.ts
  │
  └── route handler:
        ├── src/lib/db.ts              (project lookup → siteUrl)
        ├── [inline] cors/origin fns   (buildAllowedOrigins, isOriginAllowed)
        ├── src/lib/track.ts
        │     ├── src/lib/ua.ts        (anonymizeIP, fakeGeo, parseUA)
        │     ├── src/lib/sanitize.ts  (sanitizePayload — runs INSIDE ingest)
        │     └── src/lib/db.ts        (session.create, event.createMany, insight.create)
        ├── src/lib/observability.ts   (logger.info, recordHttpRequest, getRequestId)
        └── NextResponse.json          (CORS headers from inline fns)
```

### `src/lib/api-response.ts` — the response contract

```
api-response.ts ──┬── apiSuccess(data, status?, opts?)       → { ok:true, data, requestId }
                  ├── apiError(code, msg, status, details?)  → { ok:false, error:{...}, requestId }
                  ├── paginated(items, total, page, size)    → { ok:true, data, pagination, requestId }
                  └── 8 typed shortcuts: badRequest, validationError,
                      unauthorized, forbidden, notFound, conflict,
                      tooManyRequests, serverError

validate.ts ─── pure validators ─── used by route handlers BEFORE Prisma
  ├── validateString / Number / Enum / UrlPath / Object / Pagination
  └── returns { ok:true, value } | { ok:false, error } — never throws
```

### `src/components/app/` — the dashboard

```
layout.tsx (root)
  └── page.tsx
        └── useApp (Zustand) decides:
              ├── view === "dashboard" → DashboardView (project list)
              │     ├── sidebar.tsx
              │     └── dashboard-view.tsx ── api() ── /api/projects
              │
              └── view === "project"   → ProjectView
                    ├── sidebar.tsx                     (persisted)
                    ├── project-view.tsx ── useApp ────┐
                    │     ├── FilterBar (if filterable)│
                    │     ├── AlertBell ───────────────┤
                    │     └── <ActiveTab />            │  tab from useApp()
                    │           ├── overview-tab.tsx   │
                    │           ├── dashboards-tab.tsx │
                    │           ├── recordings-tab.tsx │
                    │           │     └── recording-player.tsx
                    │           │           └── recording-player-helpers.ts
                    │           ├── heatmaps-tab.tsx   │
                    │           ├── live-tab.tsx       │
                    │           │     └── live-tab-helpers.ts
                    │           ├── funnels-tab.tsx    │
                    │           ├── journeys-tab.tsx   │
                    │           ├── experiments-tab.tsx│
                    │           ├── visitors-tab.tsx   │
                    │           ├── retention-tab.tsx  │
                    │           ├── goals-tab.tsx      │
                    │           ├── alerts-tab.tsx     │
                    │           ├── insights-tab.tsx   │
                    │           ├── errors-tab.tsx     │
                    │           └── settings-tab.tsx   │
                    │                                 ┌─┘
                    └── every tab ──── api() ──────── /api/projects/[id]/<resource>
                                      (src/lib/api.ts)   (src/app/api/projects/[id]/…)
```

### `mini-services/live-service/index.ts` — the realtime edge

```
tracked-site SDK (browser)
  │ ws://host/?XTransformPort=3004
  │ socket.emit("register", {sessionId, projectId, visitorId, url})
  │ socket.emit("live",     {sessionId, projectId, ev})
  ▼
Caddy :81 (reverse_proxy :3004 when ?XTransformPort=3004)
  ▼
Socket.io :3004
  ├── io.to("proj:"+projectId)
  │     .emit("session-join" | "session-leave" | "live-event" | "cursor-snapshot")
  ├── setInterval(1000)  — emit cursor-snapshot per project room
  └── setInterval(1000)  — prune sessions stale > 60s
  ▲
  │ ws://host/?XTransformPort=3004
  │ socket.emit("subscribe", {projectId})
  │
dashboard LiveTab (browser)
  └── src/components/app/live-tab.tsx
        ├── socket.io-client
        ├── live-tab-helpers.ts (pure: initGhosts, tickGhosts, addCursor, …)
        └── api() ── /api/projects/[id]/realtime  (initial active-session list)
```

---

## 5. "If you're working on X, read these files first"

### Tracking ingest (any change to `/api/track/events`)

1. `src/app/api/track/events/route.ts` — the handler.
2. `src/lib/track.ts` — `ingest()` business logic.
3. `src/lib/sanitize.ts` — `sanitizePayload` (runs inside `ingest`).
4. `src/lib/ua.ts` — `anonymizeIP`, `fakeGeo`, `parseUA`.
5. `src/middleware.ts` — edge rate-limit.
6. [`docs/adr/0004-security-hardening-layers.md`](./adr/0004-security-hardening-layers.md).

### API response shape / error handling

1. `src/lib/api-response.ts` — the helpers + types.
2. `src/lib/validate.ts` — input validation.
3. [`docs/api-style-guide.md`](./api-style-guide.md) — the authoritative contract.
4. `tests/api-contracts.test.ts` — existing contract tests to mirror.

### A dashboard tab (UI behaviour)

1. `src/components/app/project-view.tsx` — the shell; see how tabs are dispatched.
2. `src/store/app.ts` — the `Tab` union + `Filters` interface.
3. The specific tab component you're modifying (e.g. `recordings-tab.tsx`).
4. Its sibling helpers file if present (`recording-player-helpers.ts`, `live-tab-helpers.ts`).
5. `src/components/app/filter-bar.tsx` — if the tab is filterable.
6. The matching API route under `src/app/api/projects/[id]/<resource>/`.
7. [`docs/accessibility-audit.md`](./accessibility-audit.md) — WCAG 2.1 AA requirements.

### Realtime / live cursors

1. `mini-services/live-service/index.ts` — the socket.io server.
2. `src/components/app/live-tab.tsx` — the dashboard subscriber.
3. `src/components/app/live-tab-helpers.ts` — pure cursor/ghost logic.
4. `src/app/api/projects/[id]/realtime/route.ts` — initial active-session list.
5. [`docs/adr/0002-socketio-mini-service-for-realtime.md`](./adr/0002-socketio-mini-service-for-realtime.md).
6. `Caddyfile` — how `?XTransformPort=3004` is routed.

### Security (any change to auth / rate-limit / origin / sanitize / audit / headers)

1. `src/lib/auth.ts`, `src/lib/rate-limit.ts`, `src/lib/sanitize.ts`,
   `src/lib/audit.ts`, `src/lib/ua.ts` (IP anon).
2. `src/middleware.ts` (edge rate-limit).
3. `next.config.ts` (response headers).
4. `src/app/api/track/events/route.ts` (origin/CORS pattern).
5. `src/app/api/projects/[id]/protected-test/route.ts` (API-key pattern).
6. [`docs/adr/0004-security-hardening-layers.md`](./adr/0004-security-hardening-layers.md).

### Data model / Prisma

1. `prisma/schema.prisma` — the schema.
2. `src/lib/db.ts` — the client singleton.
3. Grep for `db.<ModelName>` across `src/app/api/` to find every route that touches the model.
4. [`docs/adr/0001-use-prisma-sqlite-over-postgres.md`](./adr/0001-use-prisma-sqlite-over-postgres.md).
5. [`docs/architecture.md`](./architecture.md) — the persistence layout table.

### AI features (LLM)

1. `src/app/api/projects/[id]/ai/route.ts` — project-level AI insights.
2. `src/app/api/projects/[id]/ai/session/route.ts` — per-session AI analysis.
3. `src/app/api/projects/[id]/ai-search/route.ts` — NL search → Prisma `where`.
4. `src/components/app/ai-insights-card.tsx`, `ai-search-bar.tsx` — the UI.
5. [`docs/adr/0003-llm-powered-ai-features.md`](./adr/0003-llm-powered-ai-features.md).

### Tests

1. `tests/api-contracts.test.ts` — integration pattern (`test.skipIf(!serverAvailable)`).
2. `tests/ua.test.ts`, `tests/sanitize.test.ts`, `tests/rate-limit.test.ts`,
   `tests/observability.test.ts` — unit-test patterns.
3. [`AGENTS.md`](../AGENTS.md) — the verification bar.

### CI / build / deploy

1. `.github/workflows/ci.yml`, `security.yml`, `quality-gate.yml` — Actions pipelines (if present).
2. `scripts/check-quality.sh` — local CI runner.
3. `package.json` — the `dev` / `build` / `start` / `lint` / `db:*` scripts.
4. `next.config.ts` — standalone output + headers.
5. `Caddyfile` — the gateway.
6. [`docs/ci-cd.md`](./ci-cd.md).
