// CSRF (Cross-Site Request Forgery) protection — double-submit cookie pattern.
//
// Strategy:
//   1. On app load, the frontend calls `GET /api/csrf-token` which generates a
//      random token, sets it as a `SameSite=strict` cookie (NOT httpOnly — the
//      browser JS must read it to echo it back in a header), and returns the
//      token in the response body.
//   2. For every mutating request (POST/PUT/PATCH/DELETE) the frontend sends
//      the same token in the `x-csrf-token` header (read from the cookie).
//   3. The middleware reads both the header token and the cookie token and
//      requires them to be byte-equal. If they're missing or differ, the
//      request is rejected with 403 before it reaches the route handler.
//
// Why this is safe:
//   - The cookie's `SameSite=strict` attribute prevents a malicious
//     third-party site from causing the browser to attach the cookie to a
//     cross-site request. An attacker on `evil.com` can't read the victim's
//     `ir_csrf` cookie (same-origin policy) and can't cause the victim's
//     browser to send it (SameSite), so they can't forge the matching header.
//   - The double-submit pattern doesn't require server-side session state —
//     the token in the cookie IS the proof, validated by being echoed in the
//     header (which an attacker cannot set on a victim-initiated request).
//
// Runtime note:
//   This module is imported by BOTH the API route handler (Node.js runtime)
//   AND the Edge middleware. It MUST NOT use Node-only APIs (no `node:crypto`,
//   no `fs`, no `Buffer`). We use the Web Crypto API (`crypto.getRandomValues`,
//   available globally in both Node 19+ and the Edge runtime) and a pure-TS
//   constant-time comparison so the bundle is runtime-portable.

const CSRF_COOKIE = "ir_csrf"

/** Cookie name. The browser stores the token here; JS reads it to send in the header. */
export const CSRF_COOKIE_NAME = CSRF_COOKIE

/** Header name. The frontend echoes the token here on every mutating request. */
export const CSRF_HEADER_NAME = "x-csrf-token"

/**
 * Generate a fresh CSRF token — 32 random bytes (256 bits) hex-encoded to a
 * 64-character string. Uses the Web Crypto API so it works in both the Edge
 * and Node.js runtimes (this module is imported by middleware).
 */
export function generateCsrfToken(): string {
  const bytes = new Uint8Array(32)
  // `crypto.getRandomValues` is a Web Crypto global available in both the
  // Edge runtime and Node.js (>=19). Throws synchronously if unavailable,
  // which is the correct behavior — failing closed is safer than falling
  // back to Math.random() (which is NOT cryptographically secure).
  crypto.getRandomValues(bytes)
  // Convert to hex without Buffer (Buffer is Node-only in some Edge runtimes).
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Validate that the header token and cookie token match using a
 * constant-time comparison (XOR accumulator) to avoid timing side-channels.
 *
 * Returns false when either value is missing, when their lengths differ, or
 * when they don't byte-equal. Never throws — guards every branch so a
 * malformed input (non-string, weird encoding) can't crash the middleware.
 *
 * The pure-TS implementation (no `node:crypto` `timingSafeEqual`) keeps this
 * module Edge-runtime-safe — this is the same pattern already used by
 * `verifyApiKey` in `src/lib/auth.ts`.
 */
export function validateCsrfToken(
  headerToken: string | null | undefined,
  cookieToken: string | null | undefined,
): boolean {
  // Missing on either side → reject. We treat undefined and null identically
  // because both `req.headers.get()` and `req.cookies.get()?.value` can
  // return either, depending on the Next.js runtime.
  if (!headerToken || !cookieToken) return false
  if (typeof headerToken !== "string" || typeof cookieToken !== "string") {
    return false
  }
  // Length-check first so the loop below runs a fixed iteration count for
  // same-length inputs (early-exit on length would not leak the secret, but
  // we still need this guard because the XOR loop only makes sense for
  // equal-length strings).
  if (headerToken.length !== cookieToken.length) return false
  if (headerToken.length === 0) return false

  // XOR accumulator — branch-free, fixed iteration count.
  let diff = 0
  for (let i = 0; i < headerToken.length; i++) {
    diff |= headerToken.charCodeAt(i) ^ cookieToken.charCodeAt(i)
  }
  return diff === 0
}
