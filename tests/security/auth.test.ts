/**
 * Security regression tests — Authentication.
 *
 * Verifies that API-key auth is enforced on protected endpoints, that invalid
 * credentials are rejected, and that the rejection does NOT leak information
 * about whether a resource exists (no enumeration oracle).
 *
 * These tests hit the running Next.js dev server on localhost:3000. The whole
 * suite auto-skips when the dev server is unreachable so environmental issues
 * (server down, port conflict, OOM) never turn the security suite red.
 */
import { test, expect, describe } from "bun:test"
import { isDevServerRunning, fetchJsonUniqueIp } from "./helpers"

const SERVER_UP = isDevServerRunning()

describe.skipIf(!SERVER_UP)("Security: Authentication", () => {
  describe("GET /api/projects/:id/protected-test — API-key enforcement", () => {
    test("returns 401 when no API key is provided", async () => {
      const { status, body } = await fetchJsonUniqueIp(
        "/api/projects/test-id/protected-test",
      )
      expect(status).toBe(401)
      // The 401 body has an `error` field — either a string (legacy shape
      // `{ error: "Unauthorized: ..." }`) or an object (envelope
      // `{ ok: false, error: { code, message } }`). Either is acceptable
      // for the auth-enforcement contract.
      const obj = body as { error?: unknown }
      expect(obj.error).toBeDefined()
      const errStr =
        typeof obj.error === "string"
          ? obj.error
          : String((obj.error as { message?: string })?.message || obj.error)
      expect(errStr).toMatch(/unauthorized|api key/i)
    })

    test("returns 401 when the apikey query param is invalid", async () => {
      const { status } = await fetchJsonUniqueIp(
        "/api/projects/test-id/protected-test?apikey=invalid",
      )
      expect(status).toBe(401)
    })

    test("returns 401 when the Authorization Bearer token is invalid", async () => {
      const { status } = await fetchJsonUniqueIp(
        "/api/projects/test-id/protected-test",
        { headers: { Authorization: "Bearer ir_definitely_not_a_real_key" } },
      )
      expect(status).toBe(401)
    })

    test("returns 401 when the Authorization header is malformed (not 'Bearer …')", async () => {
      // A header that's present but doesn't match the Bearer scheme must NOT
      // be treated as authenticated — the parser must reject it cleanly.
      const { status } = await fetchJsonUniqueIp(
        "/api/projects/test-id/protected-test",
        { headers: { Authorization: "Basic not-a-bearer-token" } },
      )
      expect(status).toBe(401)
    })

    test("returns 401 when the Authorization header is empty", async () => {
      const { status } = await fetchJsonUniqueIp(
        "/api/projects/test-id/protected-test",
        { headers: { Authorization: "" } },
      )
      expect(status).toBe(401)
    })

    test("returns 401 for a nonexistent project — no existence enumeration oracle", async () => {
      // Whether the project exists or not, an unauthenticated caller MUST get
      // 401. If a missing project returned 404 while an existing one returned
      // 401, an attacker could enumerate project IDs by status code.
      const { status } = await fetchJsonUniqueIp(
        "/api/projects/this-project-does-not-exist-12345/protected-test",
      )
      expect(status).toBe(401)
    })

    test("the 401 response is JSON with an `error` field (not an HTML error page)", async () => {
      const { status, body, headers } = await fetchJsonUniqueIp(
        "/api/projects/test-id/protected-test",
      )
      expect(status).toBe(401)
      expect(headers.get("content-type") || "").toMatch(/application\/json/i)
      expect(body).toBeTypeOf("object")
      expect((body as { error?: unknown }).error).toBeDefined()
    })
  })

  describe("POST /api/track/events — ingest input validation", () => {
    test("returns 400 when projectId is missing from the payload", async () => {
      // No projectId → 400 (not 500). Verifies the route validates input
      // before touching the DB. Unique IP to avoid rate-limit bleed-through.
      const { status, body } = await fetchJsonUniqueIp("/api/track/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [] }),
      })
      expect(status).toBe(400)
      expect((body as { error?: string }).error).toMatch(/projectId/i)
    })

    test("does not crash (returns 4xx or 5xx-with-JSON, not a process kill) when the body is not valid JSON", async () => {
      // The ingest route's outer catch-block returns 500 with `String(e)` for
      // a thrown `req.json()`. That's a known info-leak risk (String(e) may
      // contain parse-error details) — but it is NOT a process crash. This
      // test pins the weaker-but-critical contract: no crash, JSON body, no
      // DB-vendor or stack-trace strings in the response.
      const { status, body, text } = await fetchJsonUniqueIp("/api/track/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not valid json",
      })
      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(600) // no process crash / 5xx-gateway
      // Body must be JSON (we parsed it), not an HTML error page.
      expect(typeof body).toBe("object")
      // And must not leak DB internals or stack traces.
      expect(text).not.toMatch(/Prisma|SQLite|better-sqlite3/i)
      expect(text).not.toMatch(/\s{2,}at\s+\S+/) // V8 stack frame
    })

    test("returns 404 when projectId does not match any known project", async () => {
      // Unknown project → 404 (not 500). Verifies the lookup handles the
      // not-found case cleanly without leaking DB internals.
      const { status, body } = await fetchJsonUniqueIp("/api/track/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "no-such-project-id-1234567890",
          events: [],
        }),
      })
      expect(status).toBe(404)
      expect((body as { error?: string }).error).toMatch(/project/i)
    })
  })
})

// Meta-test: surface the dev-server-down reason when skipped, mirroring the
// pattern in tests/api-contracts.test.ts so a skip is never silent.
describe("Security: Authentication — probe self-check", () => {
  test.skipIf(SERVER_UP)(
    "dev server is NOT reachable — skipping all auth integration tests",
    () => {
      expect(SERVER_UP).toBe(false)
    },
  )
})
