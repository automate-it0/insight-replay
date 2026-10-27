// Request signing (replay protection) — per-request HMAC over
// (METHOD + PATH + TIMESTAMP + SHA-256(BODY)).
//
// WHY THIS EXISTS
// ---------------
// CSRF tokens protect against forged requests (an attacker on
// evil.com can't cause the victim's browser to send a request carrying
// the victim's matching `x-csrf-token` header), but they DO NOT protect
// against replay. If an attacker captures a legitimate request — via a
// malicious proxy, a logging endpoint, a TLS-stripping middlebox, a
// compromised CDN edge, or just a stolen laptop with the dashboard tab
// still open — they can resend that exact request for the entire
// lifetime of the CSRF cookie (1 hour), and every existing check (CSRF,
// session, rate-limit) will pass: the CSRF token in the captured header
// still matches the cookie.
//
// This module bounds that window to 5 minutes. Every mutating request
// carries a fresh `x-request-sig: <timestamp>:<hmac>` header where the
// timestamp is part of the signed payload. To replay a captured request
// after the 5-minute window, an attacker would need to substitute a
// newer timestamp AND recompute the HMAC for it — and they can't
// recompute the HMAC without the shared secret. The replay value of a
// captured request collapses from "1 hour" to "5 minutes".
//
// DESIGN — shared secret is the CSRF token
// -----------------------------------------
// HMAC signing needs a key both sides know. We reuse the CSRF token:
//
//   - Client (dashboard): reads the `ir_csrf` cookie (NOT httpOnly — the
//     double-submit pattern already requires JS access) and uses it as
//     the HMAC key when computing the per-request signature.
//   - Server (middleware): already extracts the same token from the
//     `x-csrf-token` header for the CSRF double-submit check (Layer 3
//     in src/middleware.ts). We use the SAME header value as the HMAC
//     key when verifying.
//
// This avoids shipping a separate shared secret to the browser. An
// attacker who can read the CSRF cookie (XSS) can already do anything
// the user can do — adding another secret wouldn't help against that
// threat. The threat model this layer addresses is *captured* requests
// (TLS-stripping middlebox, malicious proxy, stolen laptop with the
// tab still open), not XSS.
//
// FORMAT
// ------
//   x-request-sig: <epoch-millis-integer>:<hex-hmac-sha256>
//
// The HMAC is computed over the canonical string:
//
//   METHOD\nPATH\nTIMESTAMP\nSHA256_HEX(BODY)
//
// The newline separators prevent canonicalization attacks — e.g. a
// path containing a `:` can't bleed into the timestamp slot even if an
// attacker submits a malformed path. The method is uppercased so a
// client using lowercase "post" produces the same canonical string
// the server computes from an uppercase "POST".
//
// RUNTIME NOTE
// ------------
// This module is imported by BOTH the API route handler (Node.js runtime)
// AND the Edge middleware. It MUST NOT use Node-only APIs (no
// `node:crypto`, no `fs`, no `Buffer`). All hashing is via the Web
// Crypto API (`crypto.subtle.digest` / `crypto.subtle.importKey` +
// `sign`), which is available globally in both the Edge runtime and
// Node.js (>=19).
//
// The constant-time comparison uses the same XOR-accumulator pattern as
// `validateCsrfToken` in `src/lib/csrf.ts` — `node:crypto.timingSafeEqual`
// is not available in the Edge runtime, and a hand-rolled XOR loop with
// a fixed iteration count is the portable alternative.

const SIGNATURE_HEADER = "x-request-sig"

/**
 * Max age of a signed request, in milliseconds. A captured request
 * becomes useless to an attacker after this window closes — the
 * timestamp is part of the signed payload, so the attacker cannot
 * refresh it without invalidating the HMAC.
 *
 * 5 minutes is a deliberately generous window: it accommodates
 * legitimate clock skew, slow networks, and queued retries (Caddy / a
 * load balancer reattempting under backpressure) without ever feeling
 * sluggish to a legitimate user, while cutting the previous "1 hour
 * CSRF cookie lifetime" replay window by 12x.
 */
const MAX_AGE_MS = 5 * 60 * 1000

/**
 * Allowed clock skew in milliseconds. Requests with a timestamp up to
 * this far IN THE FUTURE are accepted, so clients with drifted clocks
 * (phones, VMs without NTP) still work. The skew window is small
 * enough that an attacker who can capture a request can't use a
 * future-dated timestamp to extend the replay window by more than a
 * minute.
 */
const CLOCK_SKEW_MS = 60 * 1000

/** Header name. The client sends `x-request-sig: <timestamp>:<hmac>` on every mutating request. */
export const REQUEST_SIG_HEADER = SIGNATURE_HEADER

/** Replay window (ms). Exported for documentation / observability. */
export const REQUEST_SIG_MAX_AGE_MS = MAX_AGE_MS

/** Allowed future clock skew (ms). Exported for documentation / observability. */
export const REQUEST_SIG_CLOCK_SKEW_MS = CLOCK_SKEW_MS

/**
 * Tagged result of `verifyRequestSignature`. The `reason` field on the
 * failure branch lets the caller map each failure mode to a distinct
 * 403 message (missing / malformed / expired / invalid).
 */
export type SignatureVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "expired" | "invalid" }

/**
 * Compute SHA-256(input) and return the lowercase hex digest. Uses the
 * Web Crypto API so it works in both the Edge runtime and Node.js
 * (>=19). Never throws — `crypto.subtle.digest` rejects only on
 * algorithm-name typos, which are compile-time constants here.
 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hashBuf = await crypto.subtle.digest("SHA-256", data)
  return bytesToHex(new Uint8Array(hashBuf))
}

/**
 * Compute HMAC-SHA256(key, message) and return the lowercase hex
 * digest. Uses the Web Crypto API's HMAC primitive so the
 * implementation is the platform's audited crypto code, not a
 * hand-rolled HMAC.
 */
async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key)
  const msgBytes = new TextEncoder().encode(message)
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sigBuf = await crypto.subtle.sign("HMAC", cryptoKey, msgBytes)
  return bytesToHex(new Uint8Array(sigBuf))
}

/** Convert a Uint8Array to lowercase hex without Buffer (Buffer is Node-only in some Edge runtimes). */
function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Build the canonical message string that gets HMAC'd. Format:
 *
 *   METHOD\nPATH\nTIMESTAMP\nBODY_HASH
 *
 * Newline separators prevent a field from being absorbed into the
 * next (e.g. a path containing a `:` can't bleed into the timestamp
 * slot). Method is uppercased so a client using lowercase "post" still
 * produces the same canonical string as the server reading an
 * uppercase "POST".
 */
function canonicalMessage(
  method: string,
  path: string,
  timestamp: string,
  bodyHash: string,
): string {
  return [method.toUpperCase(), path, timestamp, bodyHash].join("\n")
}

/**
 * Client-side: sign a request and return the header value to send as
 * `x-request-sig`. Format: `<timestamp>:<hex-hmac>`.
 *
 * The frontend uses the CSRF token as the shared secret — both the
 * client (ir_csrf cookie) and middleware (x-csrf-token header)
 * already have it, so we don't need to ship another secret to the
 * browser.
 *
 * Example:
 *   const sig = await signRequest("POST", "/api/projects", bodyJson, csrfToken)
 *   fetch("/api/projects", { headers: { "x-request-sig": sig, ... } })
 *
 * Edge-safe — uses the Web Crypto API, no `node:crypto`.
 */
export async function signRequest(
  method: string,
  path: string,
  body: string,
  secret: string,
): Promise<string> {
  const timestamp = String(Date.now())
  const bodyHash = await sha256Hex(body)
  const mac = await hmacSha256Hex(
    secret,
    canonicalMessage(method, path, timestamp, bodyHash),
  )
  return `${timestamp}:${mac}`
}

/**
 * Server-side: verify an inbound request signature.
 *
 * Reads the `x-request-sig` header value, splits it on the first `:`
 * into `<timestamp>:<mac>`, then:
 *
 *   1. Validates the timestamp is a positive integer.
 *   2. Checks `|now - timestamp| <= MAX_AGE_MS` (with a small
 *      future-skew allowance so drifted client clocks don't get
 *      rejected).
 *   3. Recomputes the expected HMAC over the canonical message and
 *      compares it to the provided mac in constant time.
 *
 * The `bodyText` argument is what the route handler will see as the
 * request body. Middleware computes it via `req.clone().text()` BEFORE
 * calling this, so the original body stream stays consumable downstream
 * (see Layer 3b in `src/middleware.ts`).
 *
 * The `secret` is the CSRF token, taken from the `x-csrf-token` header
 * (which has already been validated against the `ir_csrf` cookie
 * earlier in the middleware chain by the CSRF double-submit check).
 *
 * Returns a tagged result so the caller can map each failure mode to
 * the right 403 message:
 *
 *   - "missing"   → "Missing request signature"
 *   - "malformed" → "Malformed request signature"
 *   - "expired"   → "Request expired"
 *   - "invalid"   → "Invalid signature"
 *
 * Never throws — a malformed header or internal crypto error collapses
 * to `{ ok: false, reason: "malformed" }` or `"invalid"` respectively,
 * so the middleware never crashes on attacker-controlled input.
 */
export async function verifyRequestSignature(
  method: string,
  path: string,
  bodyText: string,
  headerValue: string | null | undefined,
  secret: string,
): Promise<SignatureVerifyResult> {
  // Missing on either side → reject. We treat undefined and null
  // identically because `req.headers.get()` can return either,
  // depending on the Next.js runtime.
  if (!headerValue) return { ok: false, reason: "missing" }

  // Split on the FIRST colon only — the hex HMAC never contains a
  // colon, but a malformed header like "::" should still be rejected
  // cleanly rather than crashing on slice(-1).
  const sep = headerValue.indexOf(":")
  if (sep <= 0 || sep === headerValue.length - 1) {
    return { ok: false, reason: "malformed" }
  }
  const timestamp = headerValue.slice(0, sep)
  const providedMac = headerValue.slice(sep + 1)

  // Timestamp must be a positive integer (ms epoch). Non-numeric or
  // negative values are malformed — bail before touching crypto.
  const tsNum = Number(timestamp)
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { ok: false, reason: "malformed" }
  }

  // Replay-window check. A timestamp older than MAX_AGE_MS is stale.
  // A timestamp more than CLOCK_SKEW_MS in the future is from a drifted
  // client clock (or an attacker trying to extend the replay window) —
  // reject with the "expired" reason so the error message is helpful.
  const now = Date.now()
  const age = now - tsNum
  if (age > MAX_AGE_MS || age < -CLOCK_SKEW_MS) {
    return { ok: false, reason: "expired" }
  }

  // No shared secret → can't compute the expected HMAC. This shouldn't
  // happen on a signed mutating request (the CSRF layer that ran
  // before us would have rejected a request missing the token), but
  // treat it as "invalid" rather than letting crypto.subtle.importKey
  // throw on an empty key.
  if (!secret) return { ok: false, reason: "invalid" }

  try {
    const bodyHash = await sha256Hex(bodyText)
    const expectedMac = await hmacSha256Hex(
      secret,
      canonicalMessage(method, path, timestamp, bodyHash),
    )

    // Length-check first so the XOR loop below runs a fixed iteration
    // count for same-length inputs. Different lengths short-circuit
    // (no secret info leaked — hex SHA-256 is always 64 chars, so any
    // other length is a syntactically-invalid submission, not a secret
    // mismatch).
    if (
      expectedMac.length !== providedMac.length ||
      expectedMac.length === 0
    ) {
      return { ok: false, reason: "invalid" }
    }

    // Constant-time XOR accumulator — same pattern as validateCsrfToken
    // in src/lib/csrf.ts. Branch-free, fixed iteration count, no
    // early-exit on mismatch.
    let diff = 0
    for (let i = 0; i < providedMac.length; i++) {
      diff |= expectedMac.charCodeAt(i) ^ providedMac.charCodeAt(i)
    }
    if (diff !== 0) return { ok: false, reason: "invalid" }
    return { ok: true }
  } catch {
    // crypto.subtle can throw on a degenerate input (empty key, OOM) —
    // collapse to "invalid" rather than crashing the middleware.
    return { ok: false, reason: "invalid" }
  }
}
