/**
 * Security regression tests — Rate Limiting.
 *
 * Verifies two layers:
 *   1. The lib-level `rateLimit()` function in `src/lib/rate-limit.ts`:
 *      enforces a per-IP fixed-window cap, isolates by IP, and resets when
 *      the window elapses. These are pure-function tests and ALWAYS RUN.
 *   2. The middleware-enforced rate limit on `/api/projects` (and ingest):
 *      a real client hammering the dev server must eventually receive HTTP
 *      429 with a Retry-After header. These are integration tests and auto-
 *      skip when the dev server is down.
 *
 * Security properties:
 *   R1. Window cap is enforced — the (max+1)th request is denied.
 *   R2. IPs are isolated — one IP's exhaustion does NOT affect another.
 *   R3. The window resets after `windowMs` — a legitimate client can retry.
 *   R4. The lib fails OPEN — an internal error never blocks a request.
 *   R5. The middleware returns 429 + Retry-After on overflow.
 *   R6. The middleware isolates by IP (different X-Forwarded-For → independent
 *       counters).
 */
import { test, expect, describe, beforeEach } from "bun:test"
import {
  rateLimit,
  getClientIP,
  cleanupRateLimit,
  INGEST_LIMIT,
  API_LIMIT,
} from "@/lib/rate-limit"
import { isDevServerRunning, BASE } from "./helpers"

const SERVER_UP = isDevServerRunning()

// The rate-limit module stashes its Map on globalThis to survive hot reloads.
// Wipe it before each test so each test starts with a clean slate.
beforeEach(() => {
  const g = globalThis as unknown as { __rateLimitMap?: Map<string, unknown> }
  if (g.__rateLimitMap) g.__rateLimitMap.clear()
})

// ─── R1–R4: lib-level rate-limit properties (always run) ──────────────────
describe("R1–R4: rateLimit lib — security properties", () => {
  test("R1: allows up to `max` requests, denies the (max+1)th", () => {
    const opts = { max: 5, windowMs: 1000 }
    // 5 requests allowed
    for (let i = 0; i < 5; i++) {
      expect(rateLimit("10.0.0.1", opts).allowed).toBe(true)
    }
    // 6th denied
    const r = rateLimit("10.0.0.1", opts)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
  })

  test("R1: returns the correct remaining count (max - count)", () => {
    const opts = { max: 5, windowMs: 1000 }
    expect(rateLimit("10.0.0.2", opts).remaining).toBe(4)
    expect(rateLimit("10.0.0.2", opts).remaining).toBe(3)
    expect(rateLimit("10.0.0.2", opts).remaining).toBe(2)
    expect(rateLimit("10.0.0.2", opts).remaining).toBe(1)
    expect(rateLimit("10.0.0.2", opts).remaining).toBe(0)
    // Over the cap — still 0 remaining.
    expect(rateLimit("10.0.0.2", opts).remaining).toBe(0)
  })

  test("R2: isolates counters by IP — one IP's limit doesn't affect another", () => {
    const opts = { max: 2, windowMs: 1000 }
    // Exhaust IP A.
    expect(rateLimit("10.0.0.10", opts).allowed).toBe(true)
    expect(rateLimit("10.0.0.10", opts).allowed).toBe(true)
    expect(rateLimit("10.0.0.10", opts).allowed).toBe(false)
    // IP B should still have all its quota.
    expect(rateLimit("10.0.0.20", opts).allowed).toBe(true)
    expect(rateLimit("10.0.0.20", opts).allowed).toBe(true)
    expect(rateLimit("10.0.0.20", opts).allowed).toBe(false)
  })

  test("R2: even same /24 IPs are isolated (no prefix sharing)", () => {
    const opts = { max: 1, windowMs: 1000 }
    expect(rateLimit("10.0.0.1", opts).allowed).toBe(true)
    // A buggy limiter that keyed on /24 would deny this — it must NOT.
    expect(rateLimit("10.0.0.2", opts).allowed).toBe(true)
    expect(rateLimit("10.0.0.3", opts).allowed).toBe(true)
  })

  test("R3: resets the counter after `windowMs` elapses", async () => {
    const opts = { max: 2, windowMs: 50 } // very short window for fast tests
    rateLimit("10.0.0.4", opts)
    rateLimit("10.0.0.4", opts)
    expect(rateLimit("10.0.0.4", opts).allowed).toBe(false)
    // Wait for the window to expire, then the next request starts a fresh one.
    await new Promise((r) => setTimeout(r, 80))
    const after = rateLimit("10.0.0.4", opts)
    expect(after.allowed).toBe(true)
    expect(after.remaining).toBe(1) // max - 1 = 1
  })

  test("R3: resetAt is preserved across subsequent requests within the window", () => {
    // If the limiter accidentally recomputed resetAt on every call, a client
    // could effectively bypass the window by sending requests often enough.
    const opts = { max: 5, windowMs: 1000 }
    const r1 = rateLimit("10.0.0.30", opts)
    const r2 = rateLimit("10.0.0.30", opts)
    const r3 = rateLimit("10.0.0.30", opts)
    expect(r2.resetAt).toBe(r1.resetAt)
    expect(r3.resetAt).toBe(r1.resetAt)
  })

  test("R4: fails open on degenerate-but-typed inputs (no throw)", () => {
    // The lib must never throw on inputs that satisfy the type signature —
    // a throw would crash the route handler. We exercise a battery of edge
    // cases that are valid `RateLimitOptions` values but degenerate.
    expect(() => rateLimit("", { max: 5, windowMs: 1000 })).not.toThrow()
    expect(() => rateLimit("unknown", { max: 0, windowMs: 0 })).not.toThrow()
    expect(() => rateLimit("unknown", { max: 1, windowMs: 1 })).not.toThrow()
    // Very large but finite values — must not overflow or throw.
    expect(() =>
      rateLimit("unknown", { max: Number.MAX_SAFE_INTEGER, windowMs: 60_000 }),
    ).not.toThrow()
  })

  test("shipped INGEST_LIMIT and API_LIMIT are sane (positive, finite)", () => {
    expect(INGEST_LIMIT.max).toBeGreaterThan(0)
    expect(INGEST_LIMIT.windowMs).toBeGreaterThan(0)
    expect(Number.isFinite(INGEST_LIMIT.max)).toBe(true)
    expect(Number.isFinite(INGEST_LIMIT.windowMs)).toBe(true)
    expect(API_LIMIT.max).toBeGreaterThan(0)
    expect(API_LIMIT.windowMs).toBeGreaterThan(0)
  })

  test("cleanupRateLimit removes expired entries without touching live ones", () => {
    // Inject expired + live entries directly into the shared map.
    const g = globalThis as unknown as {
      __rateLimitMap: Map<string, { count: number; resetAt: number }>
    }
    const now = Date.now()
    g.__rateLimitMap.set("expired", { count: 1, resetAt: now - 1000 })
    g.__rateLimitMap.set("live", { count: 1, resetAt: now + 10_000 })
    expect(cleanupRateLimit()).toBe(1)
    expect(g.__rateLimitMap.has("expired")).toBe(false)
    expect(g.__rateLimitMap.has("live")).toBe(true)
  })

  test("getClientIP extracts the FIRST hop of x-forwarded-for (no spoofing via later hops)", () => {
    // An attacker cannot inject a "trusted" IP as the 2nd hop to bypass a
    // first-hop-only limiter — we always take the FIRST entry.
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "203.0.113.5, 127.0.0.1, 10.0.0.1" },
    })
    expect(getClientIP(req)).toBe("203.0.113.5")
  })

  test("getClientIP returns 'unknown' when no IP headers are present", () => {
    // 'unknown' becomes its OWN bucket — so attackers without XFF headers
    // still share a single bucket and cannot bypass the limit.
    const req = new Request("https://example.com/")
    expect(getClientIP(req)).toBe("unknown")
  })
})

// ─── R5–R6: middleware-enforced rate limiting (dev server required) ───────
describe.skipIf(!SERVER_UP)("R5–R6: middleware rate-limit enforcement (dev server)", () => {
  // Use TEST-NET-3 (203.0.113.0/24) for the rate-limit-exhaustion tests so
  // they don't collide with the per-test unique IPs (TEST-NET-2 /24) used by
  // the other security tests. Each test below picks a fresh IP from this
  // range so cross-test pollution is impossible.
  test("R5: hammering /api/projects eventually returns 429 with Retry-After", async () => {
    const codes: number[] = []
    const retryAfterSeen: boolean[] = []
    // Send API_LIMIT.max + a small overflow to guarantee a 429. We cap at
    // 80 total requests to keep the test bounded even if API_LIMIT is large.
    const total = Math.min(API_LIMIT.max + 10, 80)
    for (let i = 0; i < total; i++) {
      const res = await fetch(`${BASE}/api/projects`, {
        headers: { "x-forwarded-for": "203.0.113.10" },
        signal: AbortSignal.timeout(3000),
      })
      codes.push(res.status)
      const ra = res.headers.get("retry-after")
      retryAfterSeen.push(ra !== null)
      if (res.status === 429) {
        // Once we've seen at least one 429 with a Retry-After header, the
        // property is proven — stop hammering to be a good citizen.
        expect(ra).toBeTruthy()
        break
      }
    }
    expect(codes).toContain(429)
    expect(retryAfterSeen).toContain(true)
  })

  test("R6: different X-Forwarded-For values produce independent limits", async () => {
    // Exhaust the limit for IP "203.0.113.20" and verify IP "203.0.113.21"
    // can still get through. This proves the middleware keys on the IP
    // extracted by getClientIP, not on a single shared "localhost" bucket.
    //
    // Note: with the session-cookie middleware enabled, /api/projects returns
    // 401 (no session) AFTER the rate-limit check passes. So the "exhausted"
    // IP gets 429 (rate limited) and the "fresh" IP gets 401 (session gated)
    // — both prove the rate-limit buckets are independent. The key assertion
    // is that the fresh IP does NOT get 429.
    const codesA: number[] = []
    const total = Math.min(API_LIMIT.max + 5, 70)
    for (let i = 0; i < total; i++) {
      const res = await fetch(`${BASE}/api/projects`, {
        headers: { "x-forwarded-for": "203.0.113.20" },
        signal: AbortSignal.timeout(3000),
      })
      codesA.push(res.status)
      if (res.status === 429) break
    }
    expect(codesA).toContain(429)

    // Now from a different IP — must NOT be 429 (its bucket is fresh).
    // It may be 401 (session gated) or 200 (if session is present) — either
    // proves the rate-limit bucket is independent.
    const res2 = await fetch(`${BASE}/api/projects`, {
      headers: { "x-forwarded-for": "203.0.113.21" },
      signal: AbortSignal.timeout(3000),
    })
    expect(res2.status).not.toBe(429)
  })

  test("R5: ingest endpoint also returns 429 with Retry-After on overflow", async () => {
    // INGEST_LIMIT is higher (100/min) — we send up to INGEST_LIMIT.max + 5
    // requests, breaking on first 429. Uses a unique TEST-NET-3 IP so it
    // doesn't collide with R5/R6 above or with other tests' unique IPs.
    const codes: number[] = []
    const total = Math.min(INGEST_LIMIT.max + 5, 120)
    for (let i = 0; i < total; i++) {
      const res = await fetch(`${BASE}/api/track/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.30",
        },
        body: JSON.stringify({ projectId: "rate-limit-test", events: [] }),
        signal: AbortSignal.timeout(3000),
      })
      codes.push(res.status)
      if (res.status === 429) {
        expect(res.headers.get("retry-after")).toBeTruthy()
        break
      }
    }
    expect(codes).toContain(429)
  })
})

// Meta-test: surface the dev-server-down reason when skipped.
describe("Security: Rate Limiting — probe self-check", () => {
  test.skipIf(SERVER_UP)(
    "dev server is NOT reachable — skipping middleware rate-limit tests",
    () => {
      expect(SERVER_UP).toBe(false)
    },
  )
})
