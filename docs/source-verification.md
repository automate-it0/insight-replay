# Source-Driven Verification — Framework Usage Audit

**Task ID:** 5 (Source Verification)
**Scope:** Verify that each framework in the Insight Replay stack is used correctly against its official documentation. Anti-patterns, deprecated APIs, and incorrect usage are documented. **No source files were modified** — this is an audit only.

**Stack audited:** Next.js 16, Prisma 6, Socket.io 4 (server + client), Recharts 2, z-ai-web-dev-sdk, Tailwind CSS 4.

**Methodology:**
1. Read every framework touch-point (`next.config.ts`, `src/middleware.ts`, `src/app/api/**/route.ts` sampled 5 routes, `src/app/layout.tsx`, `src/app/page.tsx`, `prisma/schema.prisma`, `src/lib/db.ts`, `src/lib/observability.ts`, `mini-services/live-service/index.ts`, `src/lib/track.ts`, `src/components/app/overview-tab.tsx`, `src/components/app/use-tracker.ts`, `src/components/app/live-tab.tsx`, `src/app/api/track/script/route.ts`, `src/app/api/projects/[id]/ai/route.ts`, `src/app/api/projects/[id]/ai/session/route.ts`, `src/app/api/projects/[id]/ai-search/route.ts`, `src/app/globals.css`, `postcss.config.mjs`, `tailwind.config.ts`, `package.json`, `Caddyfile`, `tsconfig.json`, `eslint.config.mjs`).
2. Compared each usage against current official docs (URLs cited per section below).
3. Recorded findings as ✅ correct / ⚠️ anti-pattern / ❌ incorrect.

---

## Summary Table

| # | Framework | Version (resolved) | Usage | Status | Notes |
|---|-----------|--------------------|------|--------|-------|
| 1 | Next.js | `^16.1.1` | App Router, route handlers, middleware, standalone build | ⚠️ Mostly correct; 2 anti-patterns | `ignoreBuildErrors: true` + `reactStrictMode: false` |
| 2 | Prisma | `^6.11.1` (`@prisma/client`) + `^6.11.1` (`prisma`) | Schema, client singleton, queries | ✅ Correct; 1 minor anti-pattern | No transactions around multi-step writes in `track.ts` |
| 3 | Socket.io (server) | `^4.8.1` | HTTP server + `Server`, room broadcast, periodic snapshot | ⚠️ Mostly correct; 1 anti-pattern | `cors: { origin: '*' }` in prod; `socket.on('error')` not in v4 server docs |
| 4 | Socket.io (client) | `^4.8.4` (`socket.io-client`) | `io()` connect, `emit`, `on`, `disconnect` | ✅ Correct; 1 minor anti-pattern | `forceNew: true` unnecessary inside a hook with cleanup |
| 5 | Recharts | `^2.15.4` | `AreaChart`, `PieChart`, `BarChart`, `ResponsiveContainer`, `Tooltip`, `Cell` | ✅ Correct | No deprecated props; a11y workaround via wrapper `<div role="img">` is sound |
| 6 | z-ai-web-dev-sdk | `^0.0.18` | Lazy `import()`, `ZAI.create()`, `chat.completions.create()` | ⚠️ Mostly correct; 1 anti-pattern | `role: "assistant"` used for system prompt instead of `role: "system"` |
| 7 | Tailwind CSS | `^4` (4.x) | `@import "tailwindcss"`, `@theme inline`, `@custom-variant`, `@layer base` | ⚠️ Mostly correct; 1 redundancy | `tailwind.config.ts` is a v3 artifact left alongside v4 CSS config |

**Counts:** 3 ✅ correct, 4 ⚠️ anti-pattern, 0 ❌ outright incorrect. **One functional cross-framework bug** found (standalone SDK uses raw `WebSocket` against a Socket.io server — see §3.3).

---

## 1. Next.js 16

**Version used:** `next: ^16.1.1`, `eslint-config-next: ^16.1.1`, React `^19.0.0`.
**Docs cited:**
- Next.js 16 — `next.config.ts` (TS config): https://nextjs.org/docs/app/api-reference/config/next-config-js
- Standalone output: https://nextjs.org/docs/app/api-reference/config/next-config-js/output
- Dynamic route params (Promise): https://nextjs.org/docs/app/api-reference/file-conventions/dynamic-routes#params-is-now-a-promise
- Middleware: https://nextjs.org/docs/app/api-reference/file-conventions/middleware
- `next/font/google`: https://nextjs.org/docs/app/api-reference/components/font

### 1.1 Findings

| File | Usage | Status | Notes |
|------|-------|--------|-------|
| `next.config.ts` (1) | TypeScript config file | ✅ | Supported since 15.5; default in 16. |
| `next.config.ts:20` | `output: "standalone"` | ✅ | Correct for self-hosted; the `build` script copies `.next/static` and `public/` into the standalone dir per docs. |
| `next.config.ts:22-24` | `typescript: { ignoreBuildErrors: true }` | ⚠️ **Anti-pattern** | Silently swallows type errors at build time. Defeats the type safety the project relies on. Should be `false` (default). Same applies to `eslint.ignoreDuringBuilds` if set — not set here. |
| `next.config.ts:25` | `reactStrictMode: false` | ⚠️ **Anti-pattern** | Next 16 defaults to `true`. Disabling hides double-effect bugs in dev. The comment is absent; if there is a reason (e.g. legacy effect double-firing) it should be documented. |
| `next.config.ts:26-33` | `async headers()` returning `source: "/(.*)"` | ✅ | Correct shape; applies security headers to every route. |
| `src/middleware.ts:7` | `export function middleware(req: NextRequest)` | ✅ | Correct signature. |
| `src/middleware.ts:59-61` | `export const config = { matcher: ["/api/:path*"] }` | ✅ | Correct matcher syntax; restricts middleware to API routes only (good for perf). |
| `src/middleware.ts:13` | `getClientIP(req as unknown as Request)` | ⚠️ Minor | `NextRequest` extends `Request`, so the cast is unnecessary — `getClientIP(req: Request)` accepts it directly. Code smell, not a bug. |
| `src/middleware.ts:19` | `new NextResponse(JSON.stringify(...), { status: 429, headers })` | ✅ | Valid; equivalent to `NextResponse.json(...)` but manual. |
| `src/app/api/projects/[id]/route.ts:4` | `ctx: { params: Promise<{ id: string }> }` + `const { id } = await ctx.params` | ✅ | **Correct for Next 15+/16.** Every dynamic route handler in the codebase uses this awaited-Promise pattern (verified across `[id]/route.ts`, `[id]/stats/route.ts`, `[id]/sessions/[sid]/route.ts`, `[id]/ai/route.ts`, `[id]/ai/session/route.ts`, `[id]/ai-search/route.ts`). |
| `src/app/layout.tsx:1-23` | Server component, `metadata` export, `next/font/google` | ✅ | All three are correct server-component-only features. |
| `src/app/layout.tsx:6,11` | `Geist({ variable, subsets })`, `Geist_Mono(...)` | ✅ | Correct `next/font/google` usage; CSS variable wiring via `--font-geist-sans` / `--font-geist-mono` consumed in `globals.css`. |
| `src/app/page.tsx:1` | `"use client"` directive on the dashboard entry | ✅ | Correct — uses the `useApp` Zustand hook, must be client. |
| `src/app/api/track/events/route.ts:210` | `export async function OPTIONS(req)` | ✅ | App Router supports `OPTIONS` export for CORS preflight. |

### 1.2 Next.js — Recommended Fixes (do not apply; documentation only)

1. **HIGH** — Remove `typescript.ignoreBuildErrors: true`. Make `bunx tsc --noEmit` part of CI (already done in `ci.yml` per the CI/CD audit) and let `next build` fail on type errors. This is the single biggest correctness risk in the project.
2. **MEDIUM** — Restore `reactStrictMode: true` (default). If double-effect behavior is breaking something, fix the effect rather than disabling StrictMode globally.
3. **LOW** — Drop the `as unknown as Request` cast in `src/middleware.ts:13` and have `getClientIP` accept `Request` (it already does — `NextRequest` is assignable).

---

## 2. Prisma 6

**Version used:** `@prisma/client: ^6.11.1`, `prisma: ^6.11.1`.
**Docs cited:**
- Schema syntax: https://www.prisma.io/docs/orm/prisma-schema/overview
- Client singleton (best practice): https://www.prisma.io/docs/guides/nextjs
- `createMany`: https://www.prisma.io/docs/orm/prisma-client/queries/insert#create-multiple-records
- `groupBy`: https://www.prisma.io/docs/orm/prisma-client/queries/aggregation-grouping-summarizing#group-by
- `aggregate`: https://www.prisma.io/docs/orm/prisma-client/queries/aggregation-grouping-summarizing#aggregate
- `findFirst` / `findUnique`: https://www.prisma.io/docs/orm/prisma-client/queries/find-records

### 2.1 Findings

| File | Usage | Status | Notes |
|------|-------|--------|-------|
| `prisma/schema.prisma:3-5` | `generator client { provider = "prisma-client-js" }` | ✅ | Correct generator block for v6. |
| `prisma/schema.prisma:7-10` | `datasource db { provider = "sqlite"; url = env("DATABASE_URL") }` | ✅ | Correct SQLite datasource. |
| `prisma/schema.prisma:13` | `id String @id @default(cuid())` | ✅ | Correct primary key pattern. |
| `prisma/schema.prisma:32,83,103,117,134,143,156,165,177,190,200,219,233,245,261,274` | `relation(fields: [...], references: [id], onDelete: Cascade)` | ✅ | Correct relation syntax; `onDelete: Cascade` is valid for SQLite (FK enforcement on by default since Prisma 4+). |
| `prisma/schema.prisma:72-77,96-97,110-111,127-128,171,183,194,213,227,239,255,268,280` | `@@index([...])` and `@@unique([...])` | ✅ | Compound index syntax correct; useful for analytics workloads. |
| `prisma/schema.prisma:237` | `updatedAt DateTime @updatedAt` | ✅ | `@updatedAt` auto-managed; correct. |
| `src/lib/db.ts:3-13` | Client singleton via `globalThis` | ✅ | Matches the official Next.js best practice for avoiding multiple PrismaClient instances in dev hot-reload. |
| `src/lib/db.ts:10` | `log: ['query']` | ⚠️ Minor | Always-on query logging in dev is noisy and has perf cost. Consider `process.env.NODE_ENV !== 'production' ? ['query'] : ['error']`, or move to env-gated `?log=info` query param. Not incorrect — just taste. |
| `src/lib/track.ts:44-46` | `db.project.findFirst({ where: { OR: [{ id }, { trackingId }] } })` | ✅ | Correct `findFirst` with `OR`. |
| `src/lib/track.ts:59` | `db.session.findUnique({ where: { id: payload.sessionId } })` | ✅ | Correct — `id` is `@unique`. |
| `src/lib/track.ts:122-124` | `db.event.createMany({ data: events.slice(i, i+200) })` in a chunk loop | ✅ | Correct `createMany` usage. Chunking by 200 is sensible (SQLite variable limit is 32766; 200 rows × ~10 fields = well under). |
| `src/lib/track.ts:131-141` | `db.session.update({ data: { totalClicks: { increment: clicks }, ... } })` | ✅ | Correct atomic update with `increment`. |
| `src/app/api/projects/[id]/route.ts:8-12` | `db.session.aggregate({ where, _count: true, _sum: { totalClicks: true, pageViewsCount: true } })` | ✅ | Correct `aggregate` syntax — `_count: true` returns total count; `_sum` with field list is valid. |
| `src/app/api/projects/[id]/stats/route.ts:71-77` | `db.event.groupBy({ where, by: ["pageUrl"], _count: true, orderBy: { _count: { pageUrl: "desc" } }, take: 8 })` | ✅ | Correct `groupBy` syntax in Prisma 6. |
| `src/app/api/projects/[id]/ai/route.ts:173-179` | `db.event.groupBy({ ..., _count: { pageUrl: true }, orderBy: { _count: { pageUrl: "desc" } } })` | ✅ | Per-field `_count` form; also valid. |
| `src/lib/track.ts:43-218` (whole `ingest`) | 1 `findFirst` + 1 `findUnique`/`create` + 1 `update` + many `createMany`/`create` + multiple `update`s + possible `goal.findMany` + `session.update` | ⚠️ **Anti-pattern** | Multi-step write sequence with no `db.$transaction([...])` wrapping. A failure between `createMany` and `session.update({ hasRageClick: true })` leaves the session row inconsistent with the events. Recommended: wrap the post-session-create writes in `db.$transaction([...])` (sequential form supports `async` callbacks since Prisma 4.16). |

### 2.2 Prisma — Recommended Fixes

1. **MEDIUM** — Wrap the post-session-create writes in `src/lib/track.ts:107-215` in `db.$transaction(async (tx) => { ... })` so partial failures roll back. Use the sequential-interaction form, not the array form (which doesn't support `createMany` + conditional `create` mixed).
2. **LOW** — Gate `log: ['query']` in `src/lib/db.ts:10` behind `NODE_ENV` to cut dev noise.
3. **LOW** — `JSON.stringify` for `Event.data` and `Insight.data` is forced by SQLite (no native `Json` type). The migration to Postgres should switch those columns to `Json` for type-safe access. (Already captured in `docs/adr/0001-use-prisma-sqlite-over-postgres.md`.)

---

## 3. Socket.io 4

**Version used:** Server `socket.io: ^4.8.1` (in `mini-services/live-service`), Client `socket.io-client: ^4.8.4` (in main app).
**Docs cited:**
- Server setup: https://socket.io/docs/v4/server-initialization/
- Rooms: https://socket.io/docs/v4/rooms/
- `pingTimeout` / `pingInterval`: https://socket.io/docs/v4/server-options/#pinginterval
- Server `path` option: https://socket.io/docs/v4/server-options/#path
- Client `io()` options: https://socket.io/docs/v4/client-initialization/
- Client `forceNew`: https://socket.io/docs/v4/client-options/#forcenew
- Migration notes on `error` event: https://socket.io/docs/v4/migrating-from-3-x-to-4-0/#error-event

### 3.1 Server-side findings (`mini-services/live-service/index.ts`)

| Line | Usage | Status | Notes |
|------|-------|--------|-------|
| `index.ts:1-2` | `import { createServer } from 'http'` + `import { Server } from 'socket.io'` | ✅ | Canonical v4 setup. |
| `index.ts:5` | `new Server(httpServer, { ... })` | ✅ | Correct v4 constructor. |
| `index.ts:7` | `path: '/'` | ⚠️ Unusual but documented | Default is `/socket.io/`. Setting `path: '/'` is **valid** but unusual; comment explains it's required by the Caddy gateway (`Caddyfile` reverses `:81` → `:3000` for the main app, with `XTransformPort` query override for other ports). Because the live-service runs on a separate port (`:3004`) proxied via `?XTransformPort=3004`, the root path is consumed entirely by socket.io — no conflict with HTTP routes on that port. **Caveat:** this means the Socket.io polling fallback (`/socket.io/?EIO=4&transport=polling`) is unavailable — every request to `/` is treated as a socket.io handshake. With `transports: ["websocket", "polling"]` on the client, polling will fail until it upgrades. Acceptable for the controlled Caddy path; **documented** in the file. |
| `index.ts:8-11` | `cors: { origin: '*', methods: ['GET', 'POST'] }` | ⚠️ **Anti-pattern for prod** | Wide-open CORS in production. Comment does not justify it. Should be `origin: (origin, cb) => { ... allowlist check ... }` matching the per-project origin logic in `src/app/api/track/events/route.ts`. |
| `index.ts:12-13` | `pingTimeout: 60000, pingInterval: 25000` | ✅ | Both are valid v4 server options. Values are reasonable (defaults are 20s / 25s; 60s is more forgiving for spotty mobile). |
| `index.ts:35` | `io.on('connection', (socket) => { ... })` | ✅ | Correct v4 connection handler. |
| `index.ts:54,63,66,81,93,113,122` | `socket.join(room)`, `socket.leave(room)`, `io.to(room).emit(event, payload)`, `socket.emit(event, payload)` | ✅ | All correct v4 Room + broadcast patterns. |
| `index.ts:40,63,72` | `socket.on('register' | 'subscribe' | 'live', handler)` with typed `data` | ✅ | Custom events are first-class strings; payloads typed inline. |
| `index.ts:88` | `socket.on('disconnect', () => { ... })` | ✅ | Correct v4 disconnect handler; cleanup of `activeSessions` and room leave. |
| `index.ts:101-103` | `socket.on('error', (error) => { ... })` | ⚠️ Minor | The `error` event was **removed from the v4 client**, but on the server side it remains as a Node.js `EventEmitter` 'error' (without a listener, errors would crash the process). The pattern works but is undocumented in v4 server docs; the documented way is `io.engine.on('connection_error', ...)` for low-level transport errors. **Recommendation:** keep `socket.on('error', ...)` to prevent uncaught-exception crashes, but also add `io.engine.on('connection_error', ...)` for transport-level visibility. |
| `index.ts:108-124` | `setInterval(..., 1000)` for cursor snapshots + stale-pruning | ✅ | Correct pattern; uses `Date.now()` for staleness threshold. |
| `index.ts:131-136` | `process.on('SIGTERM' | 'SIGINT', () => httpServer.close(...))` | ✅ | Graceful shutdown closes the underlying HTTP server (which closes all socket.io connections). |

### 3.2 Client-side findings (`src/components/app/use-tracker.ts`, `src/components/app/live-tab.tsx`)

| File:line | Usage | Status | Notes |
|-----------|-------|--------|-------|
| `use-tracker.ts:4` | `import { io, Socket } from "socket.io-client"` | ✅ | Correct named imports for v4 client. |
| `use-tracker.ts:139` | `io("/?XTransformPort=3004", { transports: ["websocket", "polling"], forceNew: true })` | ✅ + ⚠️ | `io(path, opts)` is correct. `transports` array is valid. **`forceNew: true` is an anti-pattern in a React hook**: it forces a new Manager instance on every mount, bypassing socket.io-client's built-in multiplexing. The hook's cleanup (`ws.disconnect()`) already prevents Manager leaks, so `forceNew` is unnecessary. Removing it lets multiple tabs of the dashboard share one Manager. |
| `use-tracker.ts:142` | `ws.emit("register", { sessionId, projectId, visitorId, url })` | ✅ | Correct client-side `emit`. |
| `use-tracker.ts:189` | `ws.disconnect()` in cleanup | ✅ | Correct; `disconnect()` is the v4 method (was `.close()` in v2). |
| `live-tab.tsx:71-74` | `io("/?XTransformPort=3004", { transports, forceNew, reconnection })` | ⚠️ Same as above | Same `forceNew: true` anti-pattern. |
| `live-tab.tsx` (per worklog) | `socket.on("session-join" | "session-leave" | "live-event" | "cursor-snapshot" | "active-sessions", ...)` | ✅ | All match server-emitted event names exactly. |

### 3.3 ❌ Cross-framework incompatibility — Standalone SDK vs. Socket.io server

**File:** `src/app/api/track/script/route.ts:238-245`

```js
function connectWS(){
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/?XTransformPort=" + WS_PORT);
  ws.onopen = function(){ wsReady = true; try{ ws.send(JSON.stringify({ kind: "register", sessionId, projectId, visitorId, url: pageUrl() })); }catch(e){} };
  ...
}
```

**Problem:** The standalone SDK uses the **raw browser WebSocket API** to talk to the Socket.io server at `:3004`. Socket.io uses its own protocol (Engine.IO + packet framing like `42["event",payload]`) on top of WebSocket — **raw `ws.send(JSON.stringify(...))` is not understood by the Socket.io server**, which will silently ignore the message and never emit a `register` event. The server's `socket.on('register', ...)` handler (line 40 of `live-service/index.ts`) will never fire for tracking data sent via the standalone SDK.

**Evidence the codebase knows the right pattern:** `src/components/app/use-tracker.ts:139` correctly uses `io("/?XTransformPort=3004", ...)` from `socket.io-client` for the in-app demo-site tracker, and emits via `ws.emit("register", ...)` — which the Socket.io server does understand.

**Impact:** Any third-party site embedding the standalone `<script src="/api/track/script?pid=...">` tag gets HTTP event ingestion (`POST /api/track/events`) but **no live cursor updates** in the Live tab. The dashboard's own demo-site tracker (which uses the React hook) works fine.

**Recommended fix (documentation only):** Either (a) bundle a UMD build of `socket.io-client` into the standalone SDK string so it can use the proper protocol, or (b) expose a second lightweight WebSocket-only endpoint on `:3004` (e.g. `/raw-ws`) that the standalone SDK can talk to, with the live-service forwarding those messages into the socket.io rooms. Option (a) is the simpler fix.

---

## 4. Recharts 2

**Version used:** `recharts: ^2.15.4`.
**Docs cited:**
- Components API: https://recharts.org/en-US/api/
- `ResponsiveContainer`: https://recharts.org/en-US/api/responsiveContainer
- `Pie` / `Cell`: https://recharts.org/en-US/api/pie
- `AreaChart` / `Area`: https://recharts.org/en-US/api/area
- `BarChart` / `Bar`: https://recharts.org/en-US/api/bar
- Migration notes for v2 → v3: https://recharts.org/en-US/guide/migration

### 4.1 Findings (`src/components/app/overview-tab.tsx`)

| Line | Usage | Status | Notes |
|------|-------|--------|-------|
| `overview-tab.tsx:7-20` | Named imports from `recharts` | ✅ | All ten component imports (`ResponsiveContainer`, `AreaChart`, `Area`, `XAxis`, `YAxis`, `Tooltip`, `CartesianGrid`, `PieChart`, `Pie`, `Cell`, `BarChart`, `Bar`) are valid v2 named exports. |
| `overview-tab.tsx:152` | `<ResponsiveContainer width="100%" height={240}>` | ✅ | Correct — `width` accepts `string | number`; percentage string is the documented pattern. |
| `overview-tab.tsx:153` | `<AreaChart data={dailyData} margin={...}>` | ✅ | Valid `data` + `margin` props. |
| `overview-tab.tsx:154-163` | `<defs><linearGradient>` with `<stop stopColor stopOpacity>` | ✅ | Standard SVG inside Recharts; not Recharts-specific but valid. |
| `overview-tab.tsx:164` | `<CartesianGrid strokeDasharray="3 3" stroke="..." vertical={false} />` | ✅ | All three props are documented v2 props. |
| `overview-tab.tsx:165` | `<XAxis dataKey="date" tick={{ fill, fontSize }} tickLine={false} axisLine={false} tickFormatter={(d) => d.slice(5)} />` | ✅ | `tick` as object style is valid; `tickFormatter` signature is `(value, index) => string`. |
| `overview-tab.tsx:166` | `<YAxis ... allowDecimals={false} />` | ✅ | `allowDecimals` is a documented YAxis prop. |
| `overview-tab.tsx:167` | `<Tooltip contentStyle={...} labelStyle={...} />` | ✅ | Valid style props. |
| `overview-tab.tsx:168-169` | `<Area type="monotone" dataKey="sessions" stroke strokeWidth fill="url(#gS)" />` | ✅ | `type` accepts the curve factory name; `fill` accepts `url(#id)` references to SVG gradients. |
| `overview-tab.tsx:188-200` | `<Pie data={...} dataKey="value" nameKey="name" innerRadius={45} outerRadius={65} paddingAngle={3} stroke="none">` with `<Cell fill="..." />` children | ✅ | All valid v2 Pie + Cell props; donut pattern (`innerRadius` < `outerRadius`) is the documented way. |
| `overview-tab.tsx:216-219` | `<Pie>` with `deviceData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % ...]} />)` | ✅ | Dynamic Cell children pattern is documented. |
| `overview-tab.tsx:256-261` | `<BarChart data={browserData} layout="vertical">` + `<Bar dataKey="value" fill radius={[0,4,4,0]} barSize={16} />` | ✅ | `layout="vertical"` requires `XAxis type="number"` + `YAxis type="category"` — the code does exactly that on lines 257-258. `radius` accepts a 4-tuple (top-left, top-right, bottom-right, bottom-left). |
| `overview-tab.tsx:151, 185, 213, 254` | Wrapping `<ResponsiveContainer>` in `<div role="img" aria-label="...">` | ✅ | Not a Recharts prop — it's the a11y workaround the accessibility agent applied because `ResponsiveContainer`'s type doesn't accept `role`/`aria-label` directly. Sound pattern. |

### 4.2 Recharts — No deprecated APIs found

Cross-checked every prop used against the v2 → v3 migration guide. None of the props used (`type`, `dataKey`, `nameKey`, `innerRadius`, `outerRadius`, `paddingAngle`, `stroke`, `barSize`, `radius`, `tickFormatter`, `tickLine`, `axisLine`, `allowDecimals`, `contentStyle`, `labelStyle`, `cursor`, `vertical`, `layout`, `data`, `margin`) appear on the deprecated/renamed list. **No action needed.**

---

## 5. z-ai-web-dev-sdk

**Version used:** `z-ai-web-dev-sdk: ^0.0.18`.
**Docs cited:**
- `Zai.create()` and chat completions API: https://docs.z.ai/devpack/sdk/overview
- Chat-completion message format: https://docs.z.ai/devpack/sdk/llm (role enum: `system | user | assistant | tool`)
- `thinking` parameter: https://docs.z.ai/devpack/sdk/llm#thinking

### 5.1 Findings

| File:line | Usage | Status | Notes |
|-----------|-------|--------|-------|
| `ai/route.ts:258-260` | `const ZAIModule = await import("z-ai-web-dev-sdk"); const ZAI = (ZAIModule as { default: ... }).default ?? (ZAIModule as unknown as { create: ... })` | ✅ | Correct lazy-import + ESM-default / CJS-namespace interop. Lazy import keeps the SDK out of the route bundle until first call. |
| `ai/route.ts:260` | `const zai = await ZAI.create()` | ✅ | Correct factory usage per docs. |
| `ai/route.ts:269-279` | `zai.chat.completions.create({ messages: [...], thinking: { type: "disabled" } })` | ✅ | `thinking: { type: "disabled" }` is a documented option to suppress the model's reasoning output for cheap/fast responses. Correct for the analytics-summary use case. |
| `ai/route.ts:271-276` | First message: `{ role: "assistant", content: "You are an expert product analyst. ..." }` | ⚠️ **Anti-pattern** | The standard chat-completions role for **instruction-giving** is `"system"`, not `"assistant"`. Using `"assistant"` for the first message puts words in the model's mouth ("the assistant previously said X") — most chat-tuned models will treat this as prior conversation history rather than a directive. The z-ai-web-dev-sdk supports `role: "system"` (per docs). **Recommended:** change to `role: "system"`. The `ai/session/route.ts:236-241` and `ai-search/route.ts:103-106` repeat the same anti-pattern. |
| `ai/route.ts:280` | `completion.choices?.[0]?.message?.content ?? ""` | ✅ | Defensive access; matches the OpenAI-compatible response shape. |
| `ai/route.ts:282-287` | `catch (e) { return NextResponse.json({ analysis: null, error: ... }, { status: 200 }) }` | ⚠️ Minor | Returning HTTP 200 on a 5xx-class failure (SDK error) hides the failure from monitoring. Should be `status: 500` for genuine SDK errors (or 503 if the SDK is down). Returning 200 with `error` in the body is a soft-fail pattern that's fine for the user-facing UI but bad for observability dashboards that count 5xx. |

### 5.2 z-ai-web-dev-sdk — Recommended Fixes

1. **MEDIUM** — Change `role: "assistant"` → `role: "system"` in all three AI routes (`ai/route.ts:272`, `ai/session/route.ts:237`, `ai-search/route.ts:104`). Same prompt, better adherence.
2. **LOW** — Distinguish soft-fail (malformed user input → 200 with `error`) from hard-fail (SDK exception → 503 with `error`) in the catch blocks. Currently all errors return 200.

---

## 6. Tailwind CSS 4

**Version used:** `tailwindcss: ^4`, `@tailwindcss/postcss: ^4`, `tw-animate-css: ^1.3.5`.
**Docs cited:**
- v4 install via PostCSS: https://tailwindcss.com/docs/installation/using-postcss
- v4 CSS-first config: https://tailwindcss.com/docs/configuration
- `@theme`: https://tailwindcss.com/docs/theme
- `@custom-variant`: https://tailwindcss.com/docs/custom-variant
- v3 → v4 migration: https://tailwindcss.com/docs/upgrade-guide

### 6.1 Findings

| File:line | Usage | Status | Notes |
|-----------|-------|--------|-------|
| `postcss.config.mjs:1-3` | `plugins: ["@tailwindcss/postcss"]` | ✅ | Correct v4 PostCSS setup (replaces the v3 `tailwindcss` + `autoprefixer` pair). |
| `src/app/globals.css:1` | `@import "tailwindcss";` | ✅ | The v4 entry import; replaces the v3 `@tailwind base; @tailwind components; @tailwind utilities;` directives. |
| `src/app/globals.css:2` | `@import "tw-animate-css";` | ✅ | Third-party v4-compatible animation utility pack; correct import order. |
| `src/app/globals.css:4` | `@custom-variant dark (&:is(.dark *));` | ✅ | The documented v4 way to make the `dark:` variant respond to a `.dark` class on an ancestor. Equivalent to v3's `darkMode: "class"` config but in CSS. |
| `src/app/globals.css:6-44` | `@theme inline { --color-...: var(--...); --font-sans: ...; --radius-...: ...; }` | ✅ | `@theme inline` is documented v4 syntax; `inline` means the values are inlined into utilities rather than emitted as CSS variables (matches the shadcn-ui v4 pattern). |
| `src/app/globals.css:46-79` | `:root { --background: oklch(...); ... }` | ✅ | Plain CSS custom properties, consumed via `var(--...)` in `@theme inline`. |
| `src/app/globals.css:81-113` | `.dark { --background: oklch(...); ... }` | ✅ | Overrides the same vars in the `.dark` class scope; combines with the `@custom-variant dark` to drive `dark:` utilities. |
| `src/app/globals.css:115-122` | `@layer base { * { @apply border-border outline-ring/50; } body { @apply bg-background text-foreground; } }` | ✅ | `@layer base` + `@apply` are both still supported in v4 (the syntax for `@apply` is unchanged). |
| `src/app/globals.css:124-164` | Custom scrollbar, `.text-gradient`, `.pulse-ring`, `.bg-grid` as plain CSS (no `@layer`) | ✅ | Plain CSS rules outside any layer; works in v4. |
| `tailwind.config.ts` (whole file, 64 lines) | v3-style `Config` with `darkMode: "class"`, `content: [...]`, `theme.extend.colors`, `borderRadius`, `plugins: [tailwindcssAnimate]` | ⚠️ **Redundancy / migration artifact** | In v4 the recommended config is CSS-first via `@theme`. A `tailwind.config.ts` file is **still loaded** by v4 (via auto-detection) for backward compatibility — but having both means (a) duplicate color definitions (the v3 file uses `hsl(var(--...))` while the v4 CSS uses `oklch(...)` directly), (b) `darkMode: "class"` in the v3 file conflicts with `@custom-variant dark (&:is(.dark *))` in the v4 CSS (both happen to target `.dark`, so they agree — but it's fragile), (c) `tailwindcss-animate` plugin is loaded twice (once via v3 plugin array, once via `@import "tw-animate-css"` in v4). **Recommended:** delete `tailwind.config.ts` — it's not needed; the v4 CSS config is complete. |

### 6.2 Tailwind 4 — Recommended Fixes

1. **MEDIUM** — Delete `tailwind.config.ts`. The v4 CSS configuration in `globals.css` is complete and authoritative. The v3 JS config is a migration leftover that duplicates values and risks drift.
2. **LOW** — `src/components/ui/*` (shadcn-ui primitives) import from `tailwind-merge` / `clsx` / `class-variance-authority` — all still compatible with v4. No changes needed.

---

## 7. Cross-cutting observations (out of strict scope, recorded for completeness)

- **ESLint config (`eslint.config.mjs`)** disables 25+ rules including `@typescript-eslint/no-explicit-any`, `react-hooks/exhaustive-deps`, `prefer-const`, `no-console`, `no-unreachable`. This is a flat-config (v9) setup, correct for ESLint 9. The aggressive rule-off list is a smell but not a framework-usage error.
- **`tsconfig.json:3`** sets `"target": "ES2017"` — conservative; Next.js 16 default is `ES2022`. Not wrong, just behind. Bumping to `ES2022` enables top-level `await` semantics matching the runtime.
- **`src/lib/observability.ts:5,6,220`** uses `fs.appendFileSync` / `fs.existsSync` / `fs.mkdirSync` / `fs.readFileSync` and `process.memoryUsage()` / `process.uptime()` / `process.cwd()`. These are Node-only APIs — correct that they're NOT imported in `src/middleware.ts` (which uses its own edge-safe `recordEdgeMetric`). The Edge/Node split is correctly enforced.

---

## Anti-patterns found (consolidated)

| # | Severity | File | Anti-pattern | Recommended fix |
|---|----------|------|--------------|-----------------|
| 1 | HIGH | `next.config.ts:22-24` | `typescript.ignoreBuildErrors: true` | Remove the flag; let `next build` fail on type errors. |
| 2 | MEDIUM | `src/lib/track.ts:107-215` | Multi-step write sequence (session.create → createMany → update → insight.create → session.update ×N → goal.findMany → optional session.update) with no `db.$transaction(...)` | Wrap the post-create writes in `db.$transaction(async (tx) => { ... })`. |
| 3 | MEDIUM | `mini-services/live-service/index.ts:8-11` | `cors: { origin: '*' }` for the production socket.io server | Replace with an allowlist callback matching the per-project origin logic in `/api/track/events`. |
| 4 | MEDIUM | `src/app/api/projects/[id]/ai/route.ts:272` (and `ai/session/route.ts:237`, `ai-search/route.ts:104`) | `role: "assistant"` used for the system-instruction message | Change to `role: "system"`. |
| 5 | MEDIUM | `tailwind.config.ts` (whole file) | v3-style JS config left alongside the v4 CSS-first config | Delete the file; v4 CSS config in `globals.css` is complete. |
| 6 | LOW | `next.config.ts:25` | `reactStrictMode: false` | Restore default `true`. |
| 7 | LOW | `src/components/app/use-tracker.ts:139`, `src/components/app/live-tab.tsx:73` | `forceNew: true` on `io()` inside React hooks with cleanup | Remove `forceNew`; rely on the hook's `ws.disconnect()` cleanup. |
| 8 | LOW | `src/lib/db.ts:10` | `log: ['query']` always-on in dev | Gate behind `NODE_ENV` or remove in favor of Prisma's `?log=info` query param. |
| 9 | LOW | `src/middleware.ts:13` | `getClientIP(req as unknown as Request)` cast | Drop the cast; `NextRequest` is assignable to `Request`. |
| 10 | LOW | `mini-services/live-service/index.ts:101-103` | `socket.on('error', ...)` is undocumented for v4 server sockets | Keep it (prevents EventEmitter crashes) but add `io.engine.on('connection_error', ...)`. |

## Deprecated APIs found

| # | Framework | API | Where used | Status | Replacement |
|---|-----------|-----|-----------|--------|-------------|
| 1 | Socket.io v4 (client) | `error` event | Not used on the client (only server-side, where it's not formally deprecated) | n/a | n/a |
| 2 | Socket.io v4 | `socket.on('error', ...)` server-side | `live-service/index.ts:101` | Not deprecated (still works as a generic EventEmitter listener), but **no longer documented** in v4 server API | `io.engine.on('connection_error', cb)` for transport errors |
| 3 | Recharts v2 | (none) | — | n/a | n/a |
| 4 | Prisma 6 | (none) | — | n/a | n/a |
| 5 | Next.js 16 | (none) | — | n/a | n/a |
| 6 | Tailwind v4 | v3-style `tailwind.config.ts` is supported-but-legacy | `tailwind.config.ts` | ⚠️ Loaded by v4 for backward compat | Migrate fully to CSS `@theme` and delete the JS config |

No fully-deprecated APIs are in active use. The closest calls (`socket.on('error')` server-side and `tailwind.config.ts` v3-compat) still work in their respective v4 releases but are flagged for future cleanup.

## Recommended fixes — prioritized

**P0 (functional bug, fix first):**
1. **Standalone SDK ↔ Socket.io protocol mismatch** (`src/app/api/track/script/route.ts:238-245`). Either bundle `socket.io-client` (UMD) into the SDK string, or expose a raw-WS endpoint on `:3004` and bridge it into socket.io rooms. Until fixed, third-party sites using the standalone snippet have **no live cursor presence** in the Live tab.

**P1 (correctness/quality):**
2. Remove `typescript.ignoreBuildErrors: true` from `next.config.ts`.
3. Wrap `src/lib/track.ts:107-215` in `db.$transaction(...)`.
4. Replace `cors: { origin: '*' }` in `live-service/index.ts` with an allowlist.
5. Change `role: "assistant"` → `role: "system"` in the three AI routes.

**P2 (housekeeping):**
6. Delete `tailwind.config.ts` (v4 CSS config is authoritative).
7. Restore `reactStrictMode: true` in `next.config.ts`.
8. Remove `forceNew: true` from the two `io()` call-sites.
9. Gate `log: ['query']` behind `NODE_ENV` in `src/lib/db.ts`.
10. Add `io.engine.on('connection_error', ...)` to `live-service/index.ts` for transport-level error visibility.
11. Distinguish 200 (soft-fail) from 5xx (hard-fail) in the AI routes' catch blocks.

---

## Sources (per-framework)

- **Next.js 16** — https://nextjs.org/docs/app/api-reference/config/next-config-js ; https://nextjs.org/docs/app/api-reference/file-conventions/dynamic-routes ; https://nextjs.org/docs/app/api-reference/file-conventions/middleware ; https://nextjs.org/docs/app/api-reference/components/font
- **Prisma 6** — https://www.prisma.io/docs/orm/prisma-schema/overview ; https://www.prisma.io/docs/orm/prisma-client/queries/insert ; https://www.prisma.io/docs/orm/prisma-client/queries/aggregation-grouping-summarizing ; https://www.prisma.io/docs/guides/nextjs
- **Socket.io v4** — https://socket.io/docs/v4/server-initialization/ ; https://socket.io/docs/v4/rooms/ ; https://socket.io/docs/v4/server-options/ ; https://socket.io/docs/v4/client-initialization/ ; https://socket.io/docs/v4/client-options/ ; https://socket.io/docs/v4/migrating-from-3-x-to-4-0/
- **Recharts 2** — https://recharts.org/en-US/api/ ; https://recharts.org/en-US/api/responsiveContainer ; https://recharts.org/en-US/api/pie ; https://recharts.org/en-US/guide/migration
- **z-ai-web-dev-sdk** — https://docs.z.ai/devpack/sdk/overview ; https://docs.z.ai/devpack/sdk/llm
- **Tailwind CSS 4** — https://tailwindcss.com/docs/installation/using-postcss ; https://tailwindcss.com/docs/theme ; https://tailwindcss.com/docs/custom-variant ; https://tailwindcss.com/docs/upgrade-guide

---

## Verification (this audit, not the project)

- `ls docs/source-verification.md` — file exists ✓
- No source files were modified; only this documentation file was created.
- `bun run lint` baseline is unaffected (the audit made no code changes).
