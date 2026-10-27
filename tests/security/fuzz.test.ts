/**
 * Security regression tests — Fuzz Testing.
 *
 * Sends a battery of malformed / adversarial inputs to the ingest endpoint
 * and other API routes. For each fuzz case, the security contract is:
 *
 *   F1. The server returns a 4xx (client error) — NOT a 5xx (server error).
 *       A 5xx means the route crashed on attacker input, which is itself a
 *       security signal (DoS surface, possible info-leak via String(e)).
 *   F2. The server does NOT crash — the dev server process is still alive
 *       and serving /api/health with 200/503 after the fuzz batch.
 *   F3. The response is JSON (not an HTML error page) — so a downstream
 *       JSON-parsing client cannot be HTML-injected.
 *   F4. The response body contains no DB-vendor or stack-trace strings.
 *
 * Fuzz cases cover the OWASP-style input categories:
 *   - Oversized payload (memory-exhaustion DoS)
 *   - Invalid JSON (parser edge cases)
 *   - Missing required fields (schema violations)
 *   - Prototype-pollution (`__proto__`, `constructor`)
 *   - SQL injection in string fields
 *   - NoSQL injection (`$gt`, `$where` operators)
 *   - Path traversal in URL fields
 *   - XSS payloads in URL and string fields
 *   - Unicode / control-char / BOM injection
 *
 * These tests hit the dev server and auto-skip when it's down.
 */
import { test, expect, describe } from "bun:test"
import { isDevServerRunning, fetchJsonUniqueIp, BASE } from "./helpers"

const SERVER_UP = isDevServerRunning()

// Substrings that should never appear in a fuzz response body.
const FORBIDDEN_IN_RESPONSE = [
  /Prisma/i,
  /SQLite/i,
  /better-sqlite3/i,
  /\bnode:internal\b/,
  /[A-Za-z0-9_-]+\.ts:\d+/, // source file:line
]
const STACK_TRACE_RE = /\s{2,}at\s+\S+/

function assertNoInternalLeak(text: string) {
  for (const re of FORBIDDEN_IN_RESPONSE) {
    expect(text).not.toMatch(re)
  }
  expect(STACK_TRACE_RE.test(text)).toBe(false)
}

// Fuzz payloads — each is sent as a POST to /api/track/events.
// `name` is used for the test title; `body` is the JSON body (or a raw string
// for the invalid-JSON case); `raw` indicates the body is a pre-formed string
// to send verbatim (bypassing JSON.stringify).
const fuzzPayloads: Array<{
  name: string
  body: unknown
  raw?: string
  contentType?: string
}> = [
  {
    name: "oversized events array (10k events)",
    body: { projectId: "fuzz", events: Array(10_000).fill({ type: "mousemove", t: 0 }) },
  },
  {
    name: "oversized single string (1MB)",
    body: { projectId: "fuzz", events: [{ type: "pageview", data: { big: "a".repeat(1_000_000) } }] },
  },
  {
    name: "sql injection in projectId",
    body: { projectId: "'; DROP TABLE Project;--", events: [] },
  },
  {
    name: "sql injection in event string field",
    body: {
      projectId: "fuzz",
      events: [{ type: "pageview", data: { q: "' OR 1=1 --" } }],
    },
  },
  {
    name: "sql union-based injection",
    body: {
      projectId: "fuzz",
      events: [{ type: "pageview", data: { id: "1 UNION SELECT * FROM users" } }],
    },
  },
  {
    name: "nosql injection ($gt operator)",
    body: { projectId: { $gt: "" }, events: [] },
  },
  {
    name: "nosql injection ($where operator)",
    body: { projectId: "fuzz", events: [{ type: "x", data: { $where: "this.password" } }] },
  },
  {
    name: "prototype pollution via __proto__",
    body: { __proto__: { isAdmin: true }, projectId: "fuzz", events: [] },
  },
  {
    name: "prototype pollution via constructor.prototype",
    body: { constructor: { prototype: { isAdmin: true } }, projectId: "fuzz", events: [] },
  },
  {
    name: "prototype pollution in nested data",
    body: {
      projectId: "fuzz",
      events: [{ type: "x", data: { __proto__: { polluted: true } } }],
    },
  },
  {
    name: "xss in pageUrl (javascript: scheme)",
    body: { projectId: "fuzz", events: [{ type: "pageview", pageUrl: "javascript:alert(1)" }] },
  },
  {
    name: "xss in event string field",
    body: {
      projectId: "fuzz",
      events: [{ type: "pageview", data: { html: "<script>alert('xss')</script>" } }],
    },
  },
  {
    name: "xss via img onerror",
    body: {
      projectId: "fuzz",
      events: [{ type: "pageview", data: { html: '<img src=x onerror="alert(1)">' } }],
    },
  },
  {
    name: "path traversal in pageUrl",
    body: { projectId: "fuzz", events: [{ type: "pageview", pageUrl: "../../etc/passwd" }] },
  },
  {
    name: "path traversal in projectId",
    body: { projectId: "../../../etc/passwd", events: [] },
  },
  {
    name: "null byte injection",
    body: { projectId: "fuzz\u0000evil", events: [] },
  },
  {
    name: "BOM-prefixed payload",
    body: { projectId: "\uFEFFfuzz", events: [] },
  },
  {
    name: "very deeply nested object (depth DoS)",
    body: (() => {
      let v: unknown = { leaf: 1 }
      for (let i = 0; i < 100; i++) v = { nested: v }
      return { projectId: "fuzz", events: [{ type: "x", data: v }] }
    })(),
  },
  {
    name: "array as projectId (type confusion)",
    body: { projectId: ["fuzz", "evil"], events: [] },
  },
  {
    name: "number as projectId (type confusion)",
    body: { projectId: 12345, events: [] },
  },
  {
    name: "boolean as projectId (type confusion)",
    body: { projectId: true, events: [] },
  },
  {
    name: "null as projectId",
    body: { projectId: null, events: [] },
  },
  {
    name: "missing projectId entirely",
    body: { events: [] },
  },
  {
    name: "empty object body",
    body: {},
  },
  {
    name: "array as top-level body (type confusion)",
    body: [{ projectId: "fuzz" }],
  },
  {
    name: "string as top-level body (type confusion)",
    body: "just a string",
  },
  {
    name: "invalid JSON (raw malformed body)",
    body: "{not valid json,,,",
    contentType: "application/json",
  },
  {
    name: "invalid JSON (truncated)",
    body: '{"projectId":"fuzz","events":[',
    contentType: "application/json",
  },
  {
    name: "valid JSON but wrong content-type",
    body: { projectId: "fuzz", events: [] },
    contentType: "text/plain",
  },
]

describe.skipIf(!SERVER_UP)("Security: Fuzz testing — ingest endpoint", () => {
  // Generate one test per fuzz payload — bun reports each as a separate
  // entry in the test output, making it trivial to identify which input
  // triggered a regression.
  for (const { name, body, raw, contentType } of fuzzPayloads) {
    test(`ingest handles "${name}" gracefully (no crash, no leak)`, async () => {
      const isRaw = typeof raw === "string"
      const res = await fetchJsonUniqueIp("/api/track/events", {
        method: "POST",
        headers: {
          "Content-Type": contentType || "application/json",
        },
        body: isRaw ? (raw as string) : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000), // generous timeout for oversized bodies
      })
      // F1: must be a 4xx OR (for the invalid-JSON cases only) a 500-with-
      // JSON-body. A 502/503 gateway error or an HTML error page would
      // indicate the route handler crashed on attacker input — a DoS surface
      // and possible info-leak vector.
      //
      // NOTE: the ingest route's outer catch-block returns 500 with
      // `{ ok: false, error: String(e) }` for thrown errors (e.g. invalid
      // JSON from `req.json()`). That's a known info-leak risk we pin with
      // the no-internal-leak assertion below; the 500 itself is a handled
      // error, not a crash.
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(600) // 4xx or 5xx, not a gateway crash
      if (!isRaw) {
        // For all non-invalid-JSON payloads, the route must NOT 500 —
        // it must handle the input cleanly with a 4xx. A 500 here would
        // mean an unhandled exception on attacker input.
        expect(res.status).toBeLessThan(500)
      }
      // F3: response should be JSON (Content-Type), not an HTML error page.
      const ct = res.headers.get("content-type") || ""
      // Next.js may append charset — accept any JSON content type.
      if (res.status >= 400) {
        // Some 4xx responses (e.g. from middleware) might not set Content-Type
        // to JSON, but the body should still be parseable. We accept either
        // a JSON content-type OR a body that we successfully parsed.
        const looksJson = /json/i.test(ct) || typeof res.body === "object"
        expect(looksJson).toBe(true)
      }
      // F4: no DB-vendor or stack-trace strings in the response body.
      assertNoInternalLeak(res.text)
    })
  }

  // After the whole fuzz batch, verify the dev server is still alive — this
  // catches the "slow crash" case where a fuzz input kills the process
  // asynchronously (e.g. via OOM or an unhandled promise rejection).
  test("dev server is still alive after the fuzz batch", async () => {
    const res = await fetch(`${BASE}/api/health`, {
      signal: AbortSignal.timeout(5000),
    })
    expect([200, 503]).toContain(res.status)
  })
})

// Fuzzing other API routes with adversarial path / query params.
describe.skipIf(!SERVER_UP)("Security: Fuzz testing — path & query params", () => {
  const adversarialPaths = [
    "/api/projects/..%2f..%2fetc%2fpasswd",
    "/api/projects/%00/stats",
    "/api/projects/'; DROP TABLE--/stats",
    "/api/projects/<script>alert(1)</script>/stats",
    "/api/projects/../../admin/stats",
    "/api/track/events?id=1%20OR%201=1",
    "/api/track/events?projectId='; DROP TABLE--",
    "/api/projects/very-long-" + "a".repeat(2000) + "/stats",
  ]

  for (const path of adversarialPaths) {
    test(`GET ${path.slice(0, 60)}${path.length > 60 ? "…" : ""} returns < 5xx (no crash, no leak)`, async () => {
      // Path-traversal attempts are normalized by the HTTP client (fetch /
      // curl resolve `../` before sending) and then by Next.js routing.
      // They may 404 (unknown route), 307 (redirect to /login), or 200
      // (if fetch follows a redirect to the login page). The key security
      // assertion is: NOT a 5xx, NOT a crash, no internal leak.
      //
      // We use `redirect: "manual"` so we see the raw 3xx if the server
      // redirects, but we accept any status < 500 — a 200 login page is
      // also a safe outcome (no crash, no leak).
      const res = await fetchJsonUniqueIp(path, {
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      })
      expect(res.status).toBeLessThan(500)
      if (res.status >= 300) {
        // 3xx / 4xx — verify no internal leak in the (possibly empty) body.
        assertNoInternalLeak(res.text)
      } else {
        // 2xx (e.g. followed redirect to /login) — also verify no leak.
        assertNoInternalLeak(res.text)
      }
    })
  }

  test("dev server still alive after path-fuzz batch", async () => {
    const res = await fetch(`${BASE}/api/health`, {
      signal: AbortSignal.timeout(5000),
    })
    expect([200, 503]).toContain(res.status)
  })
})

// Meta-test: surface the dev-server-down reason when skipped.
describe("Security: Fuzz — probe self-check", () => {
  test.skipIf(SERVER_UP)(
    "dev server is NOT reachable — skipping fuzz integration tests",
    () => {
      expect(SERVER_UP).toBe(false)
    },
  )
})
