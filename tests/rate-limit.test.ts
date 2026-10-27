import { test, expect, describe, beforeEach } from "bun:test"
import {
  rateLimit,
  rateLimitByKey,
  getClientIP,
  cleanupRateLimit,
  resetRateLimit,
  INGEST_LIMIT,
  USER_API_LIMIT,
} from "../src/lib/rate-limit"

// The rate-limit module stashes its Map on globalThis to survive hot reloads
// in dev. For test isolation, wipe that Map before every test so each test
// starts with a clean slate.
beforeEach(() => {
  const g = globalThis as unknown as { __rateLimitMap?: Map<string, unknown> }
  if (g.__rateLimitMap) g.__rateLimitMap.clear()
})

// ─── rateLimit ────────────────────────────────────────────────────────────
describe("rateLimit", () => {
  test("allows the first request and reports remaining = max - 1", () => {
    const r = rateLimit("10.0.0.1", { max: 5, windowMs: 1000 })
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(4)
    expect(r.resetAt).toBeGreaterThan(Date.now())
  })

  test("allows up to max requests within the window", () => {
    const opts = { max: 3, windowMs: 1000 }
    const results = [
      rateLimit("10.0.0.2", opts),
      rateLimit("10.0.0.2", opts),
      rateLimit("10.0.0.2", opts),
    ]
    expect(results.every((r) => r.allowed)).toBe(true)
    // remaining counts down: 2, 1, 0
    expect(results[0].remaining).toBe(2)
    expect(results[1].remaining).toBe(1)
    expect(results[2].remaining).toBe(0)
  })

  test("denies the (max+1)th request within the window", () => {
    const opts = { max: 3, windowMs: 1000 }
    rateLimit("10.0.0.3", opts)
    rateLimit("10.0.0.3", opts)
    rateLimit("10.0.0.3", opts)
    const r = rateLimit("10.0.0.3", opts)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
  })

  test("resets the counter after windowMs elapses", async () => {
    const opts = { max: 2, windowMs: 50 } // very short window for fast tests
    rateLimit("10.0.0.4", opts)
    rateLimit("10.0.0.4", opts)
    // Third request within the window is denied.
    expect(rateLimit("10.0.0.4", opts).allowed).toBe(false)

    // Wait for the window to expire, then the next request starts a fresh one.
    await new Promise((r) => setTimeout(r, 80))
    const after = rateLimit("10.0.0.4", opts)
    expect(after.allowed).toBe(true)
    expect(after.remaining).toBe(1) // max - 1 = 1
  })

  test("isolates counters by IP — one IP's limit doesn't affect another", () => {
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

  test("preserves resetAt across subsequent requests within the window", () => {
    const opts = { max: 5, windowMs: 1000 }
    const r1 = rateLimit("10.0.0.30", opts)
    const r2 = rateLimit("10.0.0.30", opts)
    const r3 = rateLimit("10.0.0.30", opts)
    expect(r2.resetAt).toBe(r1.resetAt)
    expect(r3.resetAt).toBe(r1.resetAt)
  })

  test("exports a sensible INGEST_LIMIT default", () => {
    // Sanity-check the shipped default for the tracking ingest endpoint.
    expect(INGEST_LIMIT.max).toBeGreaterThan(0)
    expect(INGEST_LIMIT.windowMs).toBeGreaterThan(0)
  })
})

// ─── rateLimitByKey (per-user) ───────────────────────────────────────────
//
// Per-user rate limiting uses the same in-memory Map as `rateLimit`, but keys
// the counter on `"user:" + userId` so the per-user counter is isolated from
// per-IP counters (which never contain `:`). This lets a single compromised
// account be capped independently of the IP it shares with other users.
describe("rateLimitByKey", () => {
  test("exposes a USER_API_LIMIT matching the spec (120 req / 60s)", () => {
    expect(USER_API_LIMIT).toEqual({ max: 120, windowMs: 60_000 })
  })

  test("allows the first request and reports remaining = max - 1", () => {
    const r = rateLimitByKey("user-1", { max: 5, windowMs: 1000 })
    expect(r.allowed).toBe(true)
    expect(r.remaining).toBe(4)
    expect(r.resetAt).toBeGreaterThan(Date.now())
  })

  test("denies the (max+1)th request within the window", () => {
    const opts = { max: 3, windowMs: 1000 }
    rateLimitByKey("user-2", opts)
    rateLimitByKey("user-2", opts)
    rateLimitByKey("user-2", opts)
    const r = rateLimitByKey("user-2", opts)
    expect(r.allowed).toBe(false)
    expect(r.remaining).toBe(0)
  })

  test("isolates counters by userId — one user's limit doesn't affect another", () => {
    const opts = { max: 2, windowMs: 1000 }
    // Exhaust user A.
    expect(rateLimitByKey("user-a", opts).allowed).toBe(true)
    expect(rateLimitByKey("user-a", opts).allowed).toBe(true)
    expect(rateLimitByKey("user-a", opts).allowed).toBe(false)
    // User B should still have all its quota.
    expect(rateLimitByKey("user-b", opts).allowed).toBe(true)
    expect(rateLimitByKey("user-b", opts).allowed).toBe(true)
    expect(rateLimitByKey("user-b", opts).allowed).toBe(false)
  })

  test("per-user counter is isolated from the per-IP counter for the same string", () => {
    // The `user:` prefix on the map key prevents collisions: exhausting the
    // IP-keyed counter for "alice" must NOT exhaust the user-keyed counter
    // for "alice" (and vice versa).
    const opts = { max: 1, windowMs: 1000 }
    expect(rateLimit("alice", opts).allowed).toBe(true) // IP "alice" 1/1
    expect(rateLimit("alice", opts).allowed).toBe(false) // IP "alice" exhausted
    // Per-user counter for "alice" must still be fresh — different map key
    // ("user:alice" vs "alice").
    expect(rateLimitByKey("alice", opts).allowed).toBe(true) // user "alice" 1/1
    expect(rateLimitByKey("alice", opts).allowed).toBe(false) // user "alice" exhausted
  })

  test("empty key falls back to a literal 'user:' sentinel (no IP collision)", () => {
    // Two callers passing `""` must share a counter (rather than accidentally
    // hitting the IP-keyed `""` slot). The fallback sentinel is `"user:"`.
    const opts = { max: 1, windowMs: 1000 }
    expect(rateLimitByKey("", opts).allowed).toBe(true)
    expect(rateLimitByKey("", opts).allowed).toBe(false)
    // And the IP-keyed `""` slot is untouched.
    expect(rateLimit("", opts).allowed).toBe(true)
  })

  test("resets the counter after windowMs elapses", async () => {
    const opts = { max: 2, windowMs: 50 } // very short window for fast tests
    rateLimitByKey("user-reset", opts)
    rateLimitByKey("user-reset", opts)
    expect(rateLimitByKey("user-reset", opts).allowed).toBe(false)

    // Wait for the window to expire, then the next request starts a fresh one.
    await new Promise((r) => setTimeout(r, 80))
    const after = rateLimitByKey("user-reset", opts)
    expect(after.allowed).toBe(true)
    expect(after.remaining).toBe(1) // max - 1 = 1
  })

  test("respects the shipped USER_API_LIMIT default", () => {
    // The first USER_API_LIMIT.max requests must be allowed; the next one
    // must be denied. We don't actually fire 120 requests in a tight loop —
    // we just spot-check the boundary by injecting a count just under the
    // cap and verifying one more is allowed, then one more is not.
    const g = globalThis as unknown as {
      __rateLimitMap: Map<string, { count: number; resetAt: number }>
    }
    const now = Date.now()
    g.__rateLimitMap.set("user:boundary-user", {
      count: USER_API_LIMIT.max - 1,
      resetAt: now + 60_000,
    })
    // One more within the cap → allowed, remaining = 0.
    const allowed = rateLimitByKey("boundary-user", USER_API_LIMIT)
    expect(allowed.allowed).toBe(true)
    expect(allowed.remaining).toBe(0)
    // One past the cap → denied.
    const denied = rateLimitByKey("boundary-user", USER_API_LIMIT)
    expect(denied.allowed).toBe(false)
    expect(denied.remaining).toBe(0)
    // Cleanup so the next test starts fresh.
    resetRateLimit("user:boundary-user")
  })
})

// ─── getClientIP ──────────────────────────────────────────────────────────
describe("getClientIP", () => {
  test("extracts the first hop from x-forwarded-for", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "203.0.113.5, 198.51.100.1, 10.0.0.1" },
    })
    expect(getClientIP(req)).toBe("203.0.113.5")
  })

  test("trims whitespace around the first x-forwarded-for hop", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "  203.0.113.5  , 198.51.100.1" },
    })
    expect(getClientIP(req)).toBe("203.0.113.5")
  })

  test("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-real-ip": "198.51.100.7" },
    })
    expect(getClientIP(req)).toBe("198.51.100.7")
  })

  test("prefers x-forwarded-for over x-real-ip when both are present", () => {
    const req = new Request("https://example.com/", {
      headers: {
        "x-forwarded-for": "203.0.113.5",
        "x-real-ip": "198.51.100.7",
      },
    })
    expect(getClientIP(req)).toBe("203.0.113.5")
  })

  test('returns "unknown" when neither header is present', () => {
    const req = new Request("https://example.com/")
    expect(getClientIP(req)).toBe("unknown")
  })

  test('returns "unknown" when x-forwarded-for is empty string', () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "" },
    })
    expect(getClientIP(req)).toBe("unknown")
  })

  test('returns "unknown" when x-forwarded-for has only whitespace/commas', () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "  ,  ," },
    })
    // The first split+trim yields "" → falls through to x-real-ip → "unknown".
    expect(getClientIP(req)).toBe("unknown")
  })

  test("trims x-real-ip value", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-real-ip": "  198.51.100.42  " },
    })
    expect(getClientIP(req)).toBe("198.51.100.42")
  })
})

// ─── cleanupRateLimit ─────────────────────────────────────────────────────
describe("cleanupRateLimit", () => {
  test("removes expired entries and returns the count removed", () => {
    // Access the shared internal map directly to inject expired entries
    // without having to wait real time.
    const g = globalThis as unknown as {
      __rateLimitMap: Map<string, { count: number; resetAt: number }>
    }
    const map = g.__rateLimitMap
    expect(map).toBeDefined()

    const now = Date.now()
    map.set("expired-1", { count: 1, resetAt: now - 1000 })
    map.set("expired-2", { count: 5, resetAt: now - 1 })
    map.set("live-1", { count: 1, resetAt: now + 10_000 })
    map.set("live-2", { count: 2, resetAt: now + 60_000 })

    const removed = cleanupRateLimit()

    expect(removed).toBe(2)
    expect(map.has("expired-1")).toBe(false)
    expect(map.has("expired-2")).toBe(false)
    expect(map.has("live-1")).toBe(true)
    expect(map.has("live-2")).toBe(true)
  })

  test("returns 0 when there is nothing to remove", () => {
    // beforeEach already wiped the map; insert only live entries.
    const g = globalThis as unknown as {
      __rateLimitMap: Map<string, { count: number; resetAt: number }>
    }
    const now = Date.now()
    g.__rateLimitMap.set("live", { count: 1, resetAt: now + 10_000 })

    expect(cleanupRateLimit()).toBe(0)
  })

  test("returns 0 on an empty map", () => {
    // Map was cleared by beforeEach.
    expect(cleanupRateLimit()).toBe(0)
  })

  test("removes entries whose resetAt equals now (boundary: <=)", () => {
    const g = globalThis as unknown as {
      __rateLimitMap: Map<string, { count: number; resetAt: number }>
    }
    const now = Date.now()
    g.__rateLimitMap.set("boundary", { count: 1, resetAt: now })

    expect(cleanupRateLimit()).toBe(1)
    expect(g.__rateLimitMap.has("boundary")).toBe(false)
  })
})
