/**
 * Shared helpers for the security regression + fuzz test suite.
 *
 * Design notes:
 *  - `isDevServerRunning()` is SYNCHRONOUS (uses curl via execSync) so it can
 *    be evaluated at module-load time, BEFORE bun:test registers tests. This
 *    lets `describe.skipIf(!isDevServerRunning())(...)` skip the whole block
 *    when the dev server is down — instead of every individual test failing
 *    with ECONNREFUSED. The probe requires HTTP 200 or 503 from /api/health
 *    (503 = a subsystem is degraded but the route handler works), matching
 *    the convention in tests/api-contracts.test.ts. A 500 (route crash) or
 *    connection failure returns false → tests skip rather than turn the suite
 *    red for environmental reasons.
 *  - `fetchJson()` returns the parsed JSON body, raw text, status, and headers
 *    so tests can assert on any of them. The raw `text` is essential for
 *    information-leakage tests that need to scan the response body for
 *    stack-trace fragments or DB-vendor strings.
 */
import { execSync } from "child_process"

export const BASE = "http://localhost:3000"

/**
 * Synchronous dev-server probe. Returns true iff /api/health responds with
 * HTTP 200 or 503 within 2 seconds. Used at module-load time so
 * `describe.skipIf(!isDevServerRunning())` can skip the whole block when the
 * server is down or broken — keeping the suite green for environmental issues.
 */
export function isDevServerRunning(): boolean {
  try {
    // -s silent, -m 2 max-time 2s, -o /dev/null discard body, -w '%{http_code}'
    // print just the HTTP status code. We then compare against the accept-list.
    const code = execSync(
      "curl -s -m 2 -o /dev/null -w '%{http_code}' http://localhost:3000/api/health",
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    ).trim()
    return code === "200" || code === "503"
  } catch {
    return false
  }
}

export interface FetchJsonResult {
  status: number
  body: unknown
  headers: Headers
  /** Raw response body — use for substring scans (stack traces, DB names). */
  text: string
}

/**
 * Fetch `${BASE}${path}` and return `{ status, body, headers, text }`.
 * - `body` is `JSON.parse(text)` when the body is valid JSON, otherwise `{}`.
 * - `text` is the raw response body.
 * - `headers` is the native `Headers` object for header assertions.
 */
export async function fetchJson(
  path: string,
  opts?: RequestInit,
): Promise<FetchJsonResult> {
  const res = await fetch(`${BASE}${path}`, opts)
  const text = await res.text()
  let body: unknown = {}
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      // Non-JSON body (e.g. Next.js error page) — leave body as {}.
    }
  }
  return { status: res.status, body, headers: res.headers, text }
}

/**
 * Fetch a path and return the raw text + status. Useful for endpoints that
 * may return non-JSON (HTML error pages, empty bodies, …).
 */
export async function fetchRaw(
  path: string,
  opts?: RequestInit,
): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(`${BASE}${path}`, opts)
  const text = await res.text()
  return { status: res.status, text, headers: res.headers }
}

/**
 * Generate a unique per-call IP address. Used to give each integration test
 * its own rate-limit bucket via the `X-Forwarded-For` header, so that one
 * test's traffic does NOT exhaust the shared localhost bucket and cause
 * spurious 429s in unrelated tests.
 *
 * Uses a monotonically increasing counter wrapped into the TEST-NET-2 range
 * (198.51.100.0/24, reserved for documentation/testing) so the IP can never
 * accidentally match a real upstream. Wraps at 254 unique IPs per run — more
 * than enough for the security suite.
 */
let __ipCounter = 0
export function uniqueIp(): string {
  __ipCounter += 1
  const octet = ((__ipCounter - 1) % 254) + 1 // 1..254
  return `198.51.100.${octet}`
}

/**
 * Build a RequestInit that sends a unique X-Forwarded-For header, so the
 * request lands in its own rate-limit bucket. Merges with any caller-supplied
 * opts (caller headers win over the auto-IP header).
 */
export function withUniqueIp(opts?: RequestInit): RequestInit {
  const headers = new Headers(opts?.headers || {})
  if (!headers.has("x-forwarded-for")) {
    headers.set("x-forwarded-for", uniqueIp())
  }
  return { ...opts, headers }
}

/**
 * Fetch a path with a unique X-Forwarded-For IP, so the request gets its own
 * rate-limit bucket. Equivalent to `fetchJson(path, withUniqueIp(opts))`.
 */
export function fetchJsonUniqueIp(
  path: string,
  opts?: RequestInit,
): Promise<FetchJsonResult> {
  return fetchJson(path, withUniqueIp(opts))
}
