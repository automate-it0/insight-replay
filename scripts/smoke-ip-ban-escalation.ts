// Smoke test for the ban-escalation behavior in src/lib/ip-ban.ts AND the
// HTTP trap route at src/app/api/trap/[...path]/route.ts.
//
// Verifies:
//   - The tiered schedule (1h → 24h → 7d → 999d) at the lib level.
//   - That the ban count persists across expired bans inside the retention
//     window (expiry-reban persistence) — both via direct lib calls AND via
//     the real HTTP trap route.
//   - That a real HTTP server wrapping the actual trap route handler
//     escalates the ban count across 20 sequential requests, with the
//     actual response shape (404 { error: "Not found" }) returned by the
//     trap route.
//
// The HTTP server is a thin Node `http.createServer` shim that hands each
// inbound request to the trap route's real `GET` handler (dynamically
// imported from src/app/api/trap/[...path]/route.ts — Bun resolves the
// `@/lib/ip-ban` alias used inside it via tsconfig). This exercises the
// route's header parsing (x-forwarded-for → IP), its banIP call-out, and
// its 404 response shape — not just the lib.
//
//   bun run scripts/smoke-ip-ban-escalation.ts

import {
  banIP,
  isIPBanned,
  getBanHistory,
  cleanupIPBans,
  computeBanDurationMs,
  isPermanentBanDuration,
  BAN_ESCALATION_POLICY,
} from "../src/lib/ip-ban"
import { createServer, type Server } from "node:http"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg)
    process.exit(1)
  } else {
    console.log("ok  :", msg)
  }
}

// ─── computeBanDurationMs ─────────────────────────────────────────────────
assert(computeBanDurationMs(1) === HOUR, "1st ban = 1 hour")
assert(computeBanDurationMs(2) === DAY, "2nd ban = 24 hours")
assert(computeBanDurationMs(3) === 7 * DAY, "3rd ban = 7 days")
assert(computeBanDurationMs(4) === 999 * DAY, "4th ban = 999 days (permanent)")
assert(computeBanDurationMs(99) === 999 * DAY, "99th ban clamps to permanent tier")
assert(isPermanentBanDuration(999 * DAY), "999-day duration is permanent")
assert(!isPermanentBanDuration(DAY), "24h duration is not permanent")

// ─── BAN_ESCALATION_POLICY shape ──────────────────────────────────────────
assert(BAN_ESCALATION_POLICY.durationsMs.length === 4, "policy exposes 4 tiers")
assert(BAN_ESCALATION_POLICY.historyRetentionMs === 30 * DAY, "30-day history retention")

// ─── Fresh IP ─────────────────────────────────────────────────────────────
const ip1 = "203.0.113.1"
assert(getBanHistory(ip1).banCount === 0, "fresh IP: banCount=0")
assert(!getBanHistory(ip1).currentlyBanned, "fresh IP: not currently banned")
assert(!isIPBanned(ip1).banned, "fresh IP: isIPBanned false")

// ─── 1st ban → 1h ─────────────────────────────────────────────────────────
await banIP(ip1, "honeypot_trap")
const h1 = getBanHistory(ip1)
assert(h1.banCount === 1, "1st ban: banCount=1")
assert(h1.currentlyBanned, "1st ban: currently banned")
assert(!h1.permanent, "1st ban: not permanent")
assert(h1.retryAfterSec! > 0 && h1.retryAfterSec! <= 3600, "1st ban: retryAfterSec ≤ 1h")
const b1 = isIPBanned(ip1)
assert(b1.banned, "1st ban: isIPBanned true")
assert(b1.reason === "honeypot_trap", "1st ban: reason carried through")

// ─── 2nd ban → 24h ────────────────────────────────────────────────────────
await banIP(ip1, "honeypot_trap")
const h2 = getBanHistory(ip1)
assert(h2.banCount === 2, "2nd ban: banCount=2")
assert(h2.currentlyBanned, "2nd ban: currently banned")
assert(h2.retryAfterSec! > 3600 && h2.retryAfterSec! <= 86400, "2nd ban: retryAfterSec in (1h, 24h]")

// ─── 3rd ban → 7d ─────────────────────────────────────────────────────────
await banIP(ip1, "honeypot_trap")
const h3 = getBanHistory(ip1)
assert(h3.banCount === 3, "3rd ban: banCount=3")
assert(h3.retryAfterSec! > 86400 && h3.retryAfterSec! <= 7 * 86400, "3rd ban: retryAfterSec in (24h, 7d]")

// ─── 4th ban → permanent ──────────────────────────────────────────────────
await banIP(ip1, "honeypot_trap")
const h4 = getBanHistory(ip1)
assert(h4.banCount === 4, "4th ban: banCount=4")
assert(h4.permanent, "4th ban: permanent=true")
assert(h4.retryAfterSec! > 7 * 86400, "4th ban: retryAfterSec > 7d")

// ─── 5th ban still permanent, count keeps climbing ────────────────────────
await banIP(ip1, "honeypot_trap")
const h5 = getBanHistory(ip1)
assert(h5.banCount === 5, "5th ban: banCount=5")
assert(h5.permanent, "5th ban: still permanent")

// ─── Different IP starts fresh ────────────────────────────────────────────
const ip2 = "203.0.113.2"
await banIP(ip2, "honeypot_trap")
assert(getBanHistory(ip2).banCount === 1, "different IP starts at banCount=1")
assert(getBanHistory(ip2).retryAfterSec! <= 3600, "different IP gets 1h on first ban")

// ─── banCount persists after expiry (within retention window) ─────────────
// Simulate expiry by manipulating Date.now via a stub: we instead verify
// by inspecting that the same-IP entry, when re-banned, escalates. We
// cannot easily time-travel Date.now in a smoke test, so this is just a
// re-ban check (the entry is still active, so count increments).
const ip3 = "203.0.113.3"
await banIP(ip3, "trap")
await banIP(ip3, "trap")
assert(getBanHistory(ip3).banCount === 2, "ip3: two bans escalate to banCount=2")
assert(getBanHistory(ip3).retryAfterSec! > 3600, "ip3: 2nd ban is >1h")

// ─── cleanupIPBans is callable, never throws ──────────────────────────────
const before = cleanupIPBans()
assert(typeof before === "number", "cleanupIPBans returns a number (no throws)")
// Nothing should be swept yet — no entries are stale past the 30-day
// retention window (everything was just banned).
assert(before === 0, "cleanupIPBans removes 0 entries (none stale yet)")

// ─── getBanHistory on unknown IP ──────────────────────────────────────────
const hUnknown = getBanHistory("198.51.100.99")
assert(hUnknown.banCount === 0, "unknown IP: banCount=0")
assert(!hUnknown.currentlyBanned, "unknown IP: not currently banned")
assert(!hUnknown.permanent, "unknown IP: not permanent")
assert(hUnknown.reason === undefined, "unknown IP: no reason")
assert(hUnknown.retryAfterSec === undefined, "unknown IP: no retryAfterSec")

// ═════════════════════════════════════════════════════════════════════════
// PART 2 — HTTP trap route smoke (real server + real route handler)
// ═════════════════════════════════════════════════════════════════════════
//
// The previous assertions exercise the lib directly. The block below
// exercises the actual HTTP trap route handler — the same code path a
// scanner hits in production. We:
//
//   1. Dynamically import the trap route's GET/POST/PUT/DELETE handlers
//      from src/app/api/trap/[...path]/route.ts.
//   2. Spin up a real Node `http` server on port 3099 whose request
//      handler translates the inbound node IncomingMessage into a Web
//      `Request` (preserving method, URL, headers — including
//      x-forwarded-for, which the route reads to identify the caller IP)
//      and hands it to the trap route's GET handler. The handler's
//      `NextResponse` is then translated back into a node ServerResponse.
//   3. Send N=20 sequential HTTP requests through `fetch` against the
//      running server, all carrying the same x-forwarded-for IP, so the
//      trap route's banIP call-out escalates the banCount across the run.
//   4. Verify (a) the response code on every hit is the trap route's
//      actual response (404 — see note below), (b) the response body is
//      `{ "error": "Not found" }`, (c) the lib-level banCount climbs to 20,
//      (d) the permanent flag flips true on the 4th hit and stays true.
//
// NOTE on response-code escalation (200 → 429 → 403): the task spec asked
// us to verify "the response codes escalate (200 → 429 → 403)". The actual
// trap route implementation (src/app/api/trap/[...path]/route.ts) returns
// `404 { error: "Not found" }` on every hit, and no middleware layer
// (rate-limit, CSRF, request-signature, ban-check) is wired to /api/trap/*
// today — so the response code never escalates. The escalation happens
// *inside* the lib (banCount climbs, retryAfterSec grows, permanent flag
// flips), but the HTTP surface is uniformly 404. We assert the actual
// behavior here; meeting the spec's "200 → 429 → 403" expectation would
// require modifying the trap route or wiring isIPBanned into middleware,
// both of which are out of scope ("Don't touch other files"). The
// discrepancy is documented in the cluster-9-A report.

const PORT = 3099
const TRAP_IP = "198.51.100.20"
const N_REQUESTS = 20

// Dynamically import the trap route handler. The route lives at a
// bracketed path (src/app/api/trap/[...path]/route.ts) — Bun resolves it
// from a relative string literal just fine, and the `@/lib/ip-ban` alias
// used inside the route file resolves via tsconfig's `paths` mapping.
type RouteHandler = (req: Request) => Promise<Response>
const trapModule = (await import("../src/app/api/trap/[...path]/route")) as {
  GET: RouteHandler
  POST: RouteHandler
  PUT: RouteHandler
  DELETE: RouteHandler
}

// Build a Node HTTP server that delegates to the trap route's GET handler.
// The handler is the same function Next.js would dispatch to in
// production — we're just running it without the rest of the Next.js
// request pipeline (middleware, RSC, etc.).
const trapServer: Server = createServer((req, res) => {
  // Read the request body to completion so the underlying socket isn't
  // left pending. For GET there is no body; for POST/PUT/DELETE the trap
  // route ignores it anyway (delegates to GET). We swallow read errors —
  // the trap handler is the point of the test, not the body parsing.
  const chunks: Buffer[] = []
  req.on("data", (c: Buffer) => chunks.push(c))
  req.on("end", async () => {
    try {
      const host = req.headers.host ?? `localhost:${PORT}`
      const url = `http://${host}${req.url ?? "/api/trap/smoke"}`
      // Flatten node's IncomingHttpHeaders into a plain string record.
      // (Most headers are strings; array-valued headers like "set-cookie"
      // get joined — irrelevant for the trap route, which only reads
      // x-forwarded-for.)
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v
        else if (Array.isArray(v)) headers[k] = v.join(", ")
      }
      const bodyBuf = Buffer.concat(chunks)
      const init: RequestInit = {
        method: req.method ?? "GET",
        headers,
        body: bodyBuf.length > 0 ? (bodyBuf as unknown as BodyInit) : null,
      }
      const trapReq = new Request(url, init)
      const trapRes = await trapModule.GET(trapReq)
      res.statusCode = trapRes.status
      trapRes.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })
      const responseBody = await trapRes.text()
      res.end(responseBody)
    } catch (err) {
      res.statusCode = 500
      res.end(`smoke server error: ${String(err)}`)
    }
  })
  req.on("error", () => {
    res.statusCode = 400
    res.end("smoke server: bad request")
  })
})

await new Promise<void>((resolve) => {
  trapServer.listen(PORT, () => resolve())
})
console.log("\n--- HTTP trap route smoke (port 3099) ---")
console.log(`listening on http://localhost:${PORT}/api/trap/*`)

// Send N=20 sequential HTTP requests through the trap route, all with the
// same x-forwarded-for IP. We use the global Web `fetch` (Bun ships it as
// a global). Each request trips the trap route's GET handler, which in
// turn calls banIP — so the banCount climbs by 1 per request.
const trapResponses: { status: number; body: string }[] = []
for (let i = 0; i < N_REQUESTS; i++) {
  const r = await fetch(`http://localhost:${PORT}/api/trap/probe-${i}`, {
    method: "GET",
    headers: { "x-forwarded-for": TRAP_IP },
  })
  trapResponses.push({ status: r.status, body: await r.text() })
}

// (a) Response codes: 404 on every hit (the trap route's actual shape —
// see the long NOTE above for why the spec's "200 → 429 → 403" doesn't
// hold against the current implementation).
assert(
  trapResponses.every((r) => r.status === 404),
  `all ${N_REQUESTS} HTTP trap responses are 404 (actual route behavior)`,
)
// (b) Response bodies: the trap route returns `{ "error": "Not found" }`
// verbatim. Bun's Response.json() serializes the object exactly this way
// (no extra whitespace), so a strict string compare is fine.
assert(
  trapResponses.every((r) => r.body === JSON.stringify({ error: "Not found" })),
  `all ${N_REQUESTS} HTTP trap bodies are { error: "Not found" }`,
)

// (c) Lib-level ban count after 20 HTTP hits: should be exactly 20.
const trapHist = getBanHistory(TRAP_IP)
assert(trapHist.banCount === N_REQUESTS, `trap IP banCount=${N_REQUESTS} after ${N_REQUESTS} HTTP hits`)
assert(trapHist.currentlyBanned, "trap IP currently banned after HTTP hits")
// (d) Permanent flag: 4+ bans → permanent tier. The 4th HTTP hit should
// have flipped this on, and it should still be on after 20 hits.
assert(trapHist.permanent, "trap IP escalated to permanent (banCount ≥ 4 via HTTP)")
assert(trapHist.reason === "honeypot_trap", "trap IP reason=honeypot_trap (carried through HTTP route)")
// retryAfterSec for the permanent (999-day) tier is huge — well past 7d.
assert(
  trapHist.retryAfterSec! > 7 * 86400,
  "trap IP retryAfterSec > 7d (permanent tier reached via HTTP)",
)

// ─── Expiry-reban persistence via HTTP trap route ─────────────────────────
//
// The lib-level reban block above only checks escalation while the ban is
// still active. The block below verifies the retention-window behavior
// that the spec calls out: a ban that has *expired* (but whose entry is
// still inside the 30-day history retention window) must STILL escalate
// on the next banIP call, rather than resetting to a 1st-time 1h ban.
//
// We can't wait 1h+ for a real expiry, so we mutate the banMap entry's
// `bannedUntil` field directly. The banMap is intentionally exposed on
// `globalThis.__ipBanMap` for exactly this kind of introspection (see
// src/lib/ip-ban.ts — the globalThis stash is the same pattern used to
// persist the Map across dev hot reloads).
const PERSIST_IP = "198.51.100.30"
// Trip the trap 3 times via HTTP → banCount=3 (7-day tier, NOT permanent).
for (let i = 0; i < 3; i++) {
  await fetch(`http://localhost:${PORT}/api/trap/persist-${i}`, {
    method: "GET",
    headers: { "x-forwarded-for": PERSIST_IP },
  })
}
const persistBefore = getBanHistory(PERSIST_IP)
assert(persistBefore.banCount === 3, "persist IP banCount=3 after 3 HTTP hits")
assert(!persistBefore.permanent, "persist IP not permanent (3 bans → 7d tier)")
assert(persistBefore.currentlyBanned, "persist IP currently banned (3rd ban still active)")
assert(
  persistBefore.retryAfterSec! > 86400 && persistBefore.retryAfterSec! <= 7 * 86400,
  "persist IP retryAfterSec in (24h, 7d] (3rd-tier ban)",
)

// Backdate the ban entry's `bannedUntil` to simulate expiry. The ban is
// now "expired" from isIPBanned's perspective (now >= bannedUntil), but
// the entry survives in the banMap for the 30-day retention window.
const g = globalThis as unknown as {
  __ipBanMap: Map<string, { bannedUntil: number; banCount: number }>
}
const persistEntry = g.__ipBanMap.get(PERSIST_IP)
assert(!!persistEntry, "persist IP has a banMap entry (visible via globalThis.__ipBanMap)")
persistEntry!.bannedUntil = Date.now() - 1000 // 1s in the past → "expired"

// isIPBanned now reports not-banned — the ban has "expired" ...
const expiredCheck = isIPBanned(PERSIST_IP)
assert(!expiredCheck.banned, "persist IP: isIPBanned=false after backdated expiry")
// ... but banCount is STILL 3 (the entry was not swept — it's inside the
// 30-day retention window). This is the persistence the spec requires.
const histExpired = getBanHistory(PERSIST_IP)
assert(histExpired.banCount === 3, "persist IP banCount still 3 after expiry (retained in window)")
assert(!histExpired.currentlyBanned, "persist IP not currently banned after backdated expiry")
assert(!histExpired.permanent, "persist IP not permanent after backdated expiry (still tier 3)")

// One more HTTP hit through the trap route. The route calls banIP, which
// sees the prior banCount=3 (preserved by the retention window),
// increments to 4, and escalates to the permanent (999-day) tier. If
// persistence were broken (entry swept on expiry), this would reset to
// banCount=1 → 1h instead. So this assertion is the load-bearing one for
// the "expiry-reban persistence" requirement.
await fetch(`http://localhost:${PORT}/api/trap/persist-reban`, {
  method: "GET",
  headers: { "x-forwarded-for": PERSIST_IP },
})
const afterReban = getBanHistory(PERSIST_IP)
assert(
  afterReban.banCount === 4,
  "persist IP banCount=4 after post-expiry HTTP reban (escalation persisted across expiry)",
)
assert(afterReban.currentlyBanned, "persist IP currently banned after post-expiry HTTP reban")
assert(
  afterReban.permanent,
  "persist IP permanent after post-expiry HTTP reban (4th ban tier — persistence works)",
)
assert(afterReban.reason === "honeypot_trap", "persist IP reason=honeypot_trap after reban")

// ─── cleanupIPBans after HTTP traffic ──────────────────────────────────────
// No entries should be swept — the persist IP entry was backdated only 1s
// past expiry (well inside the 30-day retention window), and the trap IP
// entry is still active. The hard size cap from `boundMapSize()` is
// nowhere near full (we've only banned a handful of IPs in this run).
const removedAfterHttp = cleanupIPBans()
assert(
  typeof removedAfterHttp === "number",
  "cleanupIPBans returns a number after HTTP traffic (no throws)",
)
assert(
  removedAfterHttp === 0,
  "cleanupIPBans removes 0 entries after HTTP traffic (none past 30-day retention)",
)

// Shut down the HTTP server cleanly so the process can exit.
await new Promise<void>((resolve) => {
  trapServer.close(() => resolve())
})
console.log("HTTP server shut down")

console.log("\nALL SMOKE CHECKS PASSED")
