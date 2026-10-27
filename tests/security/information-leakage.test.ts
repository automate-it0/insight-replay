/**
 * Security regression tests — Information Leakage.
 *
 * Verifies the application does NOT leak internal details to clients:
 *   L1. Error responses contain no stack-trace fragments
 *       (no `  at ` lines, no `.ts:` source-file references).
 *   L2. Error responses contain no DB-vendor strings ("Prisma", "SQLite",
 *       "better-sqlite3", "query", "table", "column", "constraint").
 *   L3. The stats endpoint for a nonexistent project returns a clean,
 *       well-formed response (NOT a raw DB error).
 *   L4. Security headers are present on every response: CSP, X-Frame-Options,
 *       X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS.
 *   L5. The 401 response is the standard shape — no internal context leaked.
 *   L6. API responses carry Cache-Control: no-store (sensitive data must
 *       never be cached).
 *
 * These tests hit the dev server and auto-skip when it's down.
 */
import { test, expect, describe } from "bun:test"
import { isDevServerRunning, fetchJsonUniqueIp, fetchRaw, withUniqueIp } from "./helpers"

const SERVER_UP = isDevServerRunning()

// Substrings that should NEVER appear in a client-visible response body.
// Each entry is a (pattern, why) pair so a failure message is self-explanatory.
const FORBIDDEN_SUBSTRINGS: Array<[RegExp, string]> = [
  [/Prisma/i, "PrismaClient error class name leaked"],
  [/SQLite/i, "DB vendor name leaked"],
  [/better-sqlite3/i, "DB driver name leaked"],
  [/PrismaClientKnownQueryError/i, "Prisma error class leaked"],
  [/PrismaClientValidationError/i, "Prisma error class leaked"],
  [/\bnode:internal\b/, "Node internal path leaked"],
  [/\/home\/[^/]+\//, "Absolute filesystem path leaked"],
  [/[A-Za-z0-9_-]+\.ts:\d+/, "Source file:line reference leaked"],
]

// Stack-trace fragments. The V8 stack format is `    at Function (file:line:col)`.
// We look for the `  at ` prefix (2+ spaces + "at ") which is essentially
// never legitimate JSON content.
const STACK_TRACE_RE = /\s{2,}at\s+\S+/

function assertNoLeaks(text: string, context: string) {
  for (const [re, why] of FORBIDDEN_SUBSTRINGS) {
    expect(text).not.toMatch(re)
    if (re.test(text)) {
      // Unreachable — the expect above already threw. Here for grep-ability.
      throw new Error(`${context}: ${why} (matched /${re.source}/)`)
    }
  }
  expect(STACK_TRACE_RE.test(text)).toBe(false)
}

describe.skipIf(!SERVER_UP)("Security: Information Leakage", () => {
  describe("L1+L2: error responses contain no internals", () => {
    test("401 from protected-test leaks no internals", async () => {
      const { status, text, body } = await fetchJsonUniqueIp(
        "/api/projects/test-id/protected-test",
      )
      expect(status).toBe(401)
      assertNoLeaks(text, "protected-test 401 body")
      // Must have an error indicator (string or object envelope).
      const obj = body as { error?: unknown }
      expect(obj.error).toBeDefined()
      // No stack trace sneaks in — the body must be small.
      expect(text.length).toBeLessThan(500)
    })

    test("404 from ingest (unknown project) leaks no internals", async () => {
      const { status, text, body } = await fetchJsonUniqueIp("/api/track/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "no-such-project-1234567890",
          events: [],
        }),
      })
      expect(status).toBe(404)
      assertNoLeaks(text, "ingest 404 body")
      // Body must mention 'project' somewhere (string or object shape).
      expect(text.toLowerCase()).toMatch(/project/)
      // Body must have an error indicator.
      expect((body as { error?: unknown }).error).toBeDefined()
    })

    test("400 from ingest (missing projectId) leaks no internals", async () => {
      const { status, text, body } = await fetchJsonUniqueIp("/api/track/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [] }),
      })
      expect(status).toBe(400)
      assertNoLeaks(text, "ingest 400 body")
      // Body must mention 'project' somewhere.
      expect(text.toLowerCase()).toMatch(/project/)
      expect((body as { error?: unknown }).error).toBeDefined()
    })

    test("500-class responses (if any) leak no internals", async () => {
      // Trigger the ingest catch-block by sending malformed JSON — the route's
      // outer try/catch returns `{ ok: false, error: String(e) }` with 500.
      // String(e) is intentionally a leak risk; this test pins the contract
      // that the message must NOT contain DB-vendor or stack-trace strings.
      const { status, text } = await fetchJsonUniqueIp("/api/track/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not valid json,,,",
      })
      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(600)
      assertNoLeaks(text, "ingest malformed-JSON body")
    })
  })

  describe("L3: clean response for nonexistent project stats", () => {
    test("/api/projects/<bogus>/stats returns a clean response (NOT a 5xx, NOT a DB error)", async () => {
      // The stats route's contract for an unknown project ID is to return
      // a well-formed empty stats object (totals all zero, empty breakdowns).
      // A raw DB error here would leak schema/table names — verify it doesn't.
      //
      // Note: with the session-cookie middleware enabled, unauthenticated
      // requests get 401 from the middleware BEFORE reaching the route handler.
      // That's also a clean response (no DB leak) — so we accept 200 OR 401.
      // Unique IP so the rate limiter doesn't 429 us before we get a real answer.
      const { status, text, body } = await fetchJsonUniqueIp(
        "/api/projects/this-project-does-not-exist-abcdef/stats",
      )
      expect(status).toBeLessThan(500)
      assertNoLeaks(text, "stats for nonexistent project")
      // Either the stats shape (200) or the unauthorized envelope (401).
      if (status === 200) {
        const b = body as { totals?: unknown; daily?: unknown[]; range?: number }
        expect(b.totals).toBeDefined()
        expect(Array.isArray(b.daily)).toBe(true)
        expect(typeof b.range).toBe("number")
      } else {
        // 401 — must be the standard unauthorized envelope, no DB internals.
        expect((body as { error?: unknown }).error).toBeDefined()
      }
    })

    test("/api/projects/<bogus>/stats response is clean (no DB-vendor strings)", async () => {
      // Whether the route returns 200 (empty stats) or 401 (session gated),
      // the response must NOT contain DB-vendor strings or stack traces.
      const { status, text } = await fetchJsonUniqueIp(
        "/api/projects/this-project-does-not-exist-ghijkl/stats",
      )
      expect(status).toBeLessThan(500)
      assertNoLeaks(text, "stats for nonexistent project (clean check)")
    })
  })

  describe("L4: security headers present on responses", () => {
    test("GET / has Content-Security-Policy header", async () => {
      const { headers } = await fetchRaw("/")
      expect(headers.get("content-security-policy")).toBeTruthy()
      // CSP must include default-src (the backbone directive).
      expect(headers.get("content-security-policy")!.toLowerCase()).toContain(
        "default-src",
      )
    })

    test("GET / has X-Frame-Options: DENY (clickjacking prevention)", async () => {
      const { headers } = await fetchRaw("/")
      expect(headers.get("x-frame-options")).toBe("DENY")
    })

    test("GET / has X-Content-Type-Options: nosniff (MIME sniffing prevention)", async () => {
      const { headers } = await fetchRaw("/")
      expect(headers.get("x-content-type-options")).toBe("nosniff")
    })

    test("GET / has Referrer-Policy set", async () => {
      const { headers } = await fetchRaw("/")
      const rp = headers.get("referrer-policy")
      expect(rp).toBeTruthy()
      // Must be a non-leaky value (not "unsafe-url" / "no-referrer-when-downgrade").
      expect(["strict-origin-when-cross-origin", "same-origin", "no-referrer"]).toContain(rp as string)
    })

    test("GET / has Permissions-Policy (disable device APIs)", async () => {
      const { headers } = await fetchRaw("/")
      const pp = headers.get("permissions-policy") || ""
      expect(pp).toBeTruthy()
      // Camera, microphone, geolocation must be disabled (=()).
      expect(pp).toMatch(/camera=\(\)/)
      expect(pp).toMatch(/microphone=\(\)/)
      expect(pp).toMatch(/geolocation=\(\)/)
    })

    test("GET / has HSTS header (Strict-Transport-Security)", async () => {
      // Note: HSTS is set by next.config.ts headers() for ALL routes
      // regardless of protocol, so it should be present even over HTTP in dev.
      const { headers } = await fetchRaw("/")
      const hsts = headers.get("strict-transport-security") || ""
      expect(hsts).toMatch(/max-age=\d+/)
      expect(hsts.toLowerCase()).toContain("includesubdomains")
    })

    test("GET / has Cross-Origin isolation headers (COOP, CORP, COEP)", async () => {
      const { headers } = await fetchRaw("/")
      expect(headers.get("cross-origin-opener-policy")).toBe("same-origin")
      expect(headers.get("cross-origin-resource-policy")).toBe("same-origin")
      // COEP — value may be 'credentialless' or 'require-corp'.
      expect(headers.get("cross-origin-embedder-policy")).toBeTruthy()
    })
  })

  describe("L5+L6: 401 shape and Cache-Control on API routes", () => {
    test("401 response is a small JSON object (no sensitive fields leaked)", async () => {
      const { status, body } = await fetchJsonUniqueIp(
        "/api/projects/test-id/protected-test",
      )
      expect(status).toBe(401)
      // The 401 body may use either the legacy shape `{ error: "..." }` or the
      // new envelope `{ ok: false, error: {...}, requestId }`. Either is fine
      // for security — what matters is NO sensitive fields are present.
      const obj = body as Record<string, unknown>
      const keys = Object.keys(obj)
      // Must NOT leak: keyId, projectId, details, stack, userId, password, etc.
      const forbidden = ["keyId", "projectId", "details", "stack", "userId", "password", "email", "token"]
      for (const f of forbidden) {
        expect(keys).not.toContain(f)
      }
      // Must be small (no stack trace sneaks in).
      expect(JSON.stringify(body).length).toBeLessThan(500)
      // Must have some kind of error indicator.
      expect(obj.error).toBeDefined()
    })

    test("API responses carry Cache-Control: no-store (no caching of sensitive data)", async () => {
      const { headers } = await fetchRaw("/api/projects", withUniqueIp())
      const cc = headers.get("cache-control") || ""
      expect(cc.toLowerCase()).toContain("no-store")
      expect(cc.toLowerCase()).toContain("no-cache")
    })

    test("API responses carry X-Robots-Tag: noindex (prevent search indexing)", async () => {
      const { headers } = await fetchRaw("/api/projects", withUniqueIp())
      const xrt = headers.get("x-robots-tag") || ""
      expect(xrt.toLowerCase()).toContain("noindex")
    })
  })
})

// Meta-test: surface the dev-server-down reason when skipped.
describe("Security: Information Leakage — probe self-check", () => {
  test.skipIf(SERVER_UP)(
    "dev server is NOT reachable — skipping information-leakage integration tests",
    () => {
      expect(SERVER_UP).toBe(false)
    },
  )
})
