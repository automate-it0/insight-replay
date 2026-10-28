import { NextResponse, type NextRequest } from "next/server"
import {
  rateLimit,
  rateLimitByKey,
  getClientIP,
  INGEST_LIMIT,
  API_LIMIT,
  USER_API_LIMIT,
} from "@/lib/rate-limit"
import { validateCsrfToken, CSRF_HEADER_NAME, CSRF_COOKIE_NAME } from "@/lib/csrf"
import {
  verifyRequestSignature,
  REQUEST_SIG_HEADER,
} from "@/lib/request-signer"

// ─── Global request timeout (DoS protection) ──────────────────────────────
//
// Edge middleware cannot abort a downstream route handler once it has
// started — the request is already inside Next.js's handler pipeline by
// the time `middleware()` returns. What we CAN do here:
//
//   1. Stamp `x-request-start` (ms epoch) and `x-request-deadline`
//      (start + REQUEST_TIMEOUT_MS) onto the inbound request, so every
//      route handler can read them via `headers()` from `next/headers`
//      and bail out early (return 504) when its own clock exceeds the
//      deadline. AI / LLM routes already wrap their external calls in a
//      Promise.race timeout; this propagates the same deadline from the
//      edge so non-LLM routes can opt in too.
//
//   2. Reject at the edge any request whose forwarded `x-request-start`
//      (set by an upstream reverse proxy like Caddy) indicates the
//      request has been queued for longer than REQUEST_TIMEOUT_MS. A
//      60-second-queued request is almost certainly a slowloris / retry
//      flood; rejecting it at the edge saves the route handler the work.
//
// REQUEST_TIMEOUT_MS is set to 30s — generous enough for the AI routes
// (which already use a 30s Promise.race) but short enough to fail fast
// on a hung DB connection or a stalling LLM call.
const REQUEST_TIMEOUT_MS = 30_000

/**
 * Read the request's effective start time. Honors an `x-request-start`
 * header forwarded by an upstream proxy (Caddy / a load balancer), so a
 * request that sat in a queue for 30s before reaching us is correctly
 * treated as stale. Falls back to `Date.now()` (set in middleware below)
 * when no forwarded header is present.
 *
 * Returns null when the header is present but malformed (non-numeric or
 * out-of-range), so the caller can choose to ignore the stale-check
 * rather than trust a bogus timestamp.
 */
function getRequestStartMs(req: NextRequest): number | null {
  const fwd = req.headers.get("x-request-start")
  if (!fwd) return null
  const n = Number(fwd)
  if (!Number.isFinite(n) || n <= 0) return null
  // Sanity bound: a start time more than 1 hour in the past or 1 minute
  // in the future is bogus (clock skew, malicious header). Ignore it.
  const now = Date.now()
  const ONE_HOUR = 60 * 60 * 1000
  const ONE_MIN = 60 * 1000
  if (n < now - ONE_HOUR) return null
  if (n > now + ONE_MIN) return null
  return n
}

// Next.js Edge Middleware — runs before all matched routes.
//
// SECURITY INVARIANT (path canonicalization — js/user-controlled-bypass
// hardening): every path-based decision in this file is made against the
// SERVER-COMPUTED canonical path (see `canonicalizePath`), never against
// the raw client-supplied pathname, and every "skip this check" exemption
// additionally requires that the path canonicalized cleanly
// (`pathTrusted`). No spelling of a URL that an attacker puts on the
// request line (percent-encoding, trailing/doubled slashes, dot segments)
// may select a weaker set of checks than the route it actually executes.
//
// Layered responsibilities, in this order:
//   0. CORS allowlist (strict) — on non-track API routes only. Origins NOT
//      on the ALLOWED_ORIGINS env var allowlist (plus dev localhost:3000 /
//      :3005 in dev) get 403. OPTIONS preflight is handled here entirely
//      (204 with CORS headers if allowed, 403 otherwise) with a short
//      Max-Age=300s so a stale CORS cache can't keep allowing a removed
//      origin. Tracking ingest (/api/track/*) is exempt — its route handler
//      does its own per-project origin validation against the project's
//      `siteUrl`, which is necessary because the SDK runs on third-party
//      websites whose origins can't be on this static allowlist. Every
//      response gets `Vary: Origin` (cache-poisoning prevention) and the
//      request Origin is REFLECTED (never `*`) when on the allowlist.
//   1. Rate limiting — INGEST_LIMIT (100/min) on /api/track/events,
//      API_LIMIT (60/min) on /api/projects/*. Both per-IP, in-memory,
//      fail-open. (Login/setup have their own tighter 5/min limit applied
//      inside the route handler — see src/app/api/auth/login/route.ts.)
//   2. Content-Type enforcement — mutating methods (POST/PUT/PATCH/DELETE)
//      MUST send `Content-Type: application/json` (a charset suffix like
//      `application/json; charset=utf-8` is allowed). Anything else —
//      `text/plain`, `multipart/form-data`, or a missing Content-Type — is
//      rejected with 415 before it reaches a route handler. This prevents
//      body-parser bypass where a non-JSON content type would be silently
//      dropped by `req.json()`, leaving the handler with an empty body and
//      no signal that the client sent something else. Exempt: /api/track/*
//      (SDK uses beacon-style payloads / text/plain), /api/auth/* (legacy
//      form-encoded clients), /api/trap/* (honeypot — must let scanners
//      through so the ban-list fires).
//   3. CSRF check — double-submit cookie validation on all mutating methods
//      (POST/PUT/PATCH/DELETE). Exempt: /api/track/*, /api/auth/login,
//      /api/auth/setup, /api/csrf-token. GET/HEAD/OPTIONS are skipped.
//   3b. Request-signature replay protection — every mutating request on a
//      non-exempt path MUST carry `x-request-sig: <timestamp>:<hmac>` where
//      the HMAC is HMAC-SHA256(csrfToken, METHOD+PATH+TIMESTAMP+SHA256(body)).
//      Binds the request to a 5-minute replay window: a captured request
//      is dead after the window closes because the timestamp is part of the
//      signed payload and can't be refreshed without invalidating the HMAC.
//      Exempt: /api/track/* (SDK runs cross-origin on third-party sites,
//      can't fetch a CSRF token to use as the HMAC key), /api/auth/*
//      (pre-auth: login/setup happen before any CSRF cookie exists, so the
//      client has no shared secret to sign with). GET/HEAD/OPTIONS skipped.
//      The shared secret is the CSRF token (which both client and middleware
//      already have — the client reads the ir_csrf cookie, the middleware
//      reads the x-csrf-token header). See src/lib/request-signer.ts.
//   4. Session-cookie gate — for routes that aren't on the public allowlist,
//      require an `ir_session` cookie. Missing cookie → redirect to /login
//      (for pages) or 401 JSON (for API). Middleware only checks for cookie
//      PRESENCE; the cryptographic signature + expiry verification happens
//      server-side in route handlers / server components via getSession().
//      This split is intentional: the Edge runtime can't use next/headers
//      cookies() (async), and a full HMAC verify in the edge would require
//      importing the SESSION_SECRET into the edge bundle. A presence-only
//      check is enough to keep casual snoops off the dashboard; real auth
//      happens server-side on every protected request.
//   4b. Per-user rate limiting — after the cookie format check passes, extract
//      the userId from the (format-validated) session cookie payload (base64url
//      decode + JSON parse — NO HMAC verify) and apply USER_API_LIMIT
//      (120 req/min). Layer 1's per-IP cap (60/min) cannot distinguish two
//      authenticated users behind the same NAT; this layer keys the counter
//      on the userId so a compromised account can't soak up the whole IP's
//      quota. Fails open (skips the cap) if the userId can't be extracted —
//      Layer 1 still applies.
//   4c. Device-fingerprint presence — on authenticated (non-public) routes,
//      mutating methods (POST/PUT/PATCH/DELETE) MUST carry the
//      `x-device-fp` header. GET/HEAD/OPTIONS are exempt — a missing
//      fingerprint on read-only requests degrades to IP-only binding
//      (still verified server-side in getSession()). The cryptographic
//      fpHash-vs-stored-fpHash comparison happens server-side (Edge runtime
//      can't load node:crypto); this layer only enforces HEADER PRESENCE
//      on mutating requests so a stolen cookie can't drive a write
//      without also producing a matching fingerprint.
//   5. Pass-through — NextResponse.next() with request-id stamp.
//
// Public allowlist (session NOT required):
//   - /login                 — the login page itself
//   - /api/auth/*            — login/logout/me/setup endpoints
//   - /api/track/*           — public SDK ingest (no dashboard session)
//   - /api/health            — uptime probe for load balancers
//   - /api/csrf-token        — token-mint endpoint (must be reachable pre-auth)
//
// Edge-runtime note: SESSION_COOKIE_NAME is inlined here as a string literal
// instead of imported from `@/lib/session`, because `session.ts` imports
// `node:crypto` for HMAC operations (Node-only) and pulling it into the Edge
// bundle breaks the middleware with `The edge runtime does not support Node.js
// 'crypto' module`. The full HMAC signature verification still happens
// server-side via `getSession()` in `session.ts` — only the cookie NAME is
// duplicated here, and it's a stable contract (`"ir_session"`).

const SESSION_COOKIE_NAME = "ir_session"
/**
 * The request header the browser sends carrying the client-side device
 * fingerprint hash. The fingerprint is computed in the browser (canvas +
 * WebGL + UA + screen + tz + fonts hash — see `src/lib/device-fp.ts`) and
 * sent on every authenticated request. Layer 4c below enforces HEADER
 * PRESENCE on mutating methods; the cryptographic comparison of the
 * fingerprint against the stored `fpHash` in the session happens
 * server-side in `getSession()` (Node runtime, where `SESSION_SECRET`
 * lives). Why split: the Edge runtime can't load `node:crypto` to compute
 * the salted SHA-256, so the deep verification has to live in the route
 * handler. The presence check here is the cheap edge guard that prevents
 * a missing-fingerprint request from sailing through to a mutating
 * endpoint.
 */
const DEVICE_FP_HEADER = "x-device-fp"
const PUBLIC_PATH_PREFIXES = ["/api/auth/", "/api/track/", "/api/health", "/api/download"]
const PUBLIC_PATHS_EXACT = new Set(["/login", "/api/csrf-token", "/download"])

// ─── CORS allowlist (strict) ──────────────────────────────────────────────
// Origins allowed to make cross-origin API requests to NON-track routes.
// In production, this is ONLY the comma-separated list from the
// `ALLOWED_ORIGINS` env var (e.g. "https://app.example.com,https://staging.example.com").
// In development (NODE_ENV !== 'production'), the two localhost dev servers
// (http://localhost:3000 + http://localhost:3005) are auto-added so local
// dashboard / API testing works without env config; any origins in
// ALLOWED_ORIGINS are still honored too.
//
// Tracking ingest (/api/track/*) is EXEMPT from this middleware CORS layer —
// its route handler does its own per-project origin validation against the
// project's `siteUrl`, which is necessary because the SDK runs on third-
// party websites whose origins can't be predicted into a static allowlist.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)

const DEV_ORIGINS = ["http://localhost:3000", "http://localhost:3005"]

function corsAllowlist(): string[] {
  if (process.env.NODE_ENV !== "production") {
    // Dev: localhost dev servers + anything in ALLOWED_ORIGINS (if set).
    return [...DEV_ORIGINS, ...ALLOWED_ORIGINS]
  }
  // Production: ONLY env-configured origins.
  return ALLOWED_ORIGINS
}

/** True iff `origin` exactly matches an entry on the strict CORS allowlist. */
function isCorsOriginAllowed(origin: string): boolean {
  return corsAllowlist().includes(origin)
}

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/")
}

function isTrackPath(path: string): boolean {
  return path === "/api/track" || path.startsWith("/api/track/")
}

// ─── Path canonicalization (js/user-controlled-bypass hardening) ─────────
//
// WHY THIS EXISTS
// ----------------
// `req.nextUrl.pathname` is raw, attacker-controlled bytes. Two CodeQL
// `js/user-controlled-bypass` findings (severity: error) flagged that
// request-controlled data decided whether security checks ran:
//
//   1. Layer 1 — `path === "/api/track/events"` gated the ONLY rate
//      limit on public SDK ingest. Alternate spellings of the same URL
//      (a trailing slash, a doubled slash, a percent-encoded character)
//      failed the byte-exact match and skipped the throttle, while every
//      other layer prefix-exempts /api/track/* — so the variant path
//      sailed through with NO middleware check at all.
//   2. Layer 3b — `isSignatureExemptPath(path)` skipped the request-
//      signature replay check whenever the raw path *looked* like a
//      track/auth route. Because the Next.js router can normalize paths
//      differently from a byte-prefix comparison (percent-decoding,
//      trailing slashes, doubled slashes — "path confusion"), a hostile
//      spelling could claim the exemption here while executing a
//      protected route.
//
// THE FIX — let the SERVER compute the authoritative path:
//
//   - Every path-based security decision in `middleware()` runs against
//     the output of this function (decoded once, dot-segments resolved,
//     duplicate slashes collapsed) — never against the raw client bytes.
//   - Every "skip this check" exemption (CORS track-skip, Content-Type,
//     CSRF, request-signature, public-path) additionally requires
//     `pathTrusted === true` at the call site.
//   - If the raw path cannot be canonicalized with confidence (malformed
//     percent-escape, double-encoding, control characters, backslash),
//     this returns null → `pathTrusted` is false → ALL exemptions are
//     disabled for the request. It must then clear Content-Type, CSRF,
//     signature and session checks like any protected route — the
//     strictest posture the middleware can impose (fail-closed).
//
// Legitimate traffic is unaffected: every route in this app lives in a
// fixed ASCII namespace (/api/track/events, /api/auth/login, /login, …)
// and well-behaved clients send those paths verbatim, for which
// canonicalization is the identity function.
function canonicalizePath(pathname: string): string | null {
  // Next.js always hands middleware an absolute path, but the check keeps
  // this helper total if it is ever reused on an un-parsed string.
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null

  // Decode percent-escapes ONCE — the same depth of decoding the Next.js
  // router applies when resolving a request to a route handler. Anything
  // the decoder chokes on (dangling "%", truncated multi-byte escape)
  // is ambiguous by definition → fail-closed (return null).
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }

  // Escapes still present after one decode = double-encoding ("%252e").
  // The router won't decode them again either, so no single route can be
  // trusted to correspond to these bytes → fail-closed.
  if (decoded.includes("%")) return null

  // Control characters (incl. NUL), DEL, and backslash never occur in this
  // app's route namespace. They are classic path-confusion raw material
  // (%00 truncation, "\" treated as a separator on some stacks), so treat
  // any occurrence as hostile instead of trying to interpret it.
  if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return null

  // Collapse duplicate slashes ("//api/x" → "/api/x") and resolve "." /
  // ".." dot segments. The WHATWG URL parser behind `req.nextUrl` has
  // ALREADY resolved literal and single-encoded dot segments ("/a/../b"
  // and "/a/%2e%2e/b" both arrive here as "/b"), so these passes are
  // normally no-ops — they exist so this helper stays correct if it is
  // ever reused on a raw, un-parsed string.
  const segments: string[] = []
  for (const segment of decoded.replace(/\/{2,}/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  // Trailing slashes fall out of the split naturally ("/x/" → "/x"),
  // matching how the router treats both spellings as the same route.
  // The root path normalizes to "/".
  return segments.length > 0 ? "/" + segments.join("/") : "/"
}

/**
 * Stamp `Vary: Origin` on a response (ALWAYS — prevents cache poisoning on
 * responses that vary by origin) and reflect the request Origin only when:
 *   - the request actually carried an Origin header (cross-origin fetch),
 *   - the route is a non-track API route (track routes do their own
 *     reflection in the route handler — see corsResponseHeaders()), AND
 *   - the origin is on the strict allowlist.
 *
 * Mirrors the `stampRequestId` pattern: void function, mutates `res`.
 */
function stampCorsHeaders(res: NextResponse, origin: string | null, path: string): void {
  // set() replaces any existing Vary value to avoid duplicates like
  // "Origin, Origin" building up when both middleware and the route handler
  // try to add it.
  res.headers.set("Vary", "Origin")
  if (origin && isApiPath(path) && !isTrackPath(path) && isCorsOriginAllowed(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin)
  }
}

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS_EXACT.has(path)) return true
  for (const p of PUBLIC_PATH_PREFIXES) {
    if (path.startsWith(p)) return true
  }
  return false
}

/** Mutating HTTP methods — CSRF protection applies only to these. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/**
 * Generate a 128-bit cryptographically random nonce (base64).
 *
 * Uses the Web Crypto API (`crypto.getRandomValues`), which IS available
 * in the Edge Runtime. NOT `node:crypto` — that module is unavailable in
 * the edge bundle and would crash the middleware with
 * `The edge runtime does not support Node.js 'crypto' module`.
 *
 * 16 random bytes → 128 bits of entropy → base64 (~24 chars). The
 * returned string is the form CSP expects for `'nonce-<value>'` tokens.
 * An attacker cannot guess it; it changes every single request.
 */
function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Build the strict Content-Security-Policy header value for THIS request.
 *
 * `script-src` carries a per-request nonce instead of `'unsafe-inline'` —
 * only `<script>` tags whose `nonce=` attribute matches can run. Combined
 * with `'strict-dynamic'` (the trusted-script propagation rule), this
 * blocks XSS-injected inline scripts (`<script>alert(1)</script>`) while
 * still allowing Next.js's own runtime chunks to execute normally — they
 * are auto-stamped with the nonce by the framework (see `layout.tsx`,
 * which reads the `x-nonce` request header and applies it to `<html>`).
 *
 * `style-src` keeps `'unsafe-inline'` — Tailwind injects runtime `<style>`
 * blocks, and Next.js does not yet nonce-stamp style elements.
 *
 * Other directives are kept identical to the previous static CSP shape
 * (see git history of `next.config.ts`); only `script-src` was tightened.
 */
function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'self' https://*.space-z.ai http://*.space-z.ai",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; ") + ";"
}

/**
 * Stamp per-request nonce + strict CSP onto a response.
 *
 * Sets two response headers:
 *   - `x-nonce`              — exposes the nonce to the layout (read via
 *                             `headers()` from `next/headers`) so it can
 *                             be applied to the `<html>` element. Next.js
 *                             then propagates the html-level nonce to every
 *                             inline `<script>` it emits.
 *   - `Content-Security-Policy` — the actual policy the browser enforces.
 */
function applyCsp(res: NextResponse, nonce: string): void {
  res.headers.set("x-nonce", nonce)
  res.headers.set("Content-Security-Policy", buildCsp(nonce))
}

/**
 * Begin a pass-through NextResponse, propagating the per-request nonce to
 * the downstream route handler's REQUEST headers (so `headers()` from
 * `next/headers` can read it in the layout / server components). Also
 * stamps the strict CSP + nonce on the response via `applyCsp`.
 *
 * Caller is still responsible for stamping rate-limit / request-id
 * headers and calling `applyCsp(res, nonce)` is NOT needed again — this
 * helper does it once.
 */
function nextWithNonce(req: NextRequest, nonce: string): NextResponse {
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set("x-nonce", nonce)
  // Propagate the global request deadline so route handlers can read it
  // via `headers()` from `next/headers` and bail early (return 504) when
  // their own clock exceeds the deadline. If an upstream proxy forwarded
  // `x-request-start`, honor it; otherwise stamp `Date.now()` (the moment
  // middleware saw the request) so downstream has a consistent baseline.
  // `x-request-deadline` = start + REQUEST_TIMEOUT_MS.
  try {
    if (!requestHeaders.has("x-request-start")) {
      requestHeaders.set("x-request-start", String(Date.now()))
    }
    const startMs = Number(requestHeaders.get("x-request-start"))
    if (Number.isFinite(startMs) && startMs > 0) {
      requestHeaders.set("x-request-deadline", String(startMs + REQUEST_TIMEOUT_MS))
    }
  } catch {
    // ignore — best-effort deadline propagation
  }
  const res = NextResponse.next({
    request: { headers: requestHeaders },
  })
  applyCsp(res, nonce)
  return res
}

/**
 * Paths exempt from CSRF protection. Either they're public cross-origin
 * endpoints (tracking ingest — the SDK can't fetch a CSRF token), or they're
 * the auth/login/setup endpoints that legitimately run before a CSRF cookie
 * exists, or they're the token-mint endpoint itself.
 */
function isCsrfExemptPath(path: string): boolean {
  return (
    path === "/api/track" ||
    path.startsWith("/api/track/") ||
    path === "/api/auth/login" ||
    path === "/api/auth/setup" ||
    path === "/api/csrf-token"
  )
}

/**
 * Paths exempt from the Content-Type enforcement layer (Layer 2).
 *
 *   - /api/track/* — public SDK ingest. The tracking SDK / browser beacon
 *     may legitimately send payloads with a non-JSON content type (e.g.
 *     `text/plain` to avoid a CORS preflight, or `application/x-www-form-
 *     urlencoded` from a classic <form>). The SDK can't be retrained to
 *     send JSON cross-origin without a CORS preflight round-trip, so we
 *     exempt it.
 *   - /api/auth/* — login/setup/logout endpoints have historically accepted
 *     form-encoded bodies from browser <form> posts and legacy clients;
 *     we don't want to break those flows by forcing JSON here.
 *   - /api/trap/* — honeypot. Scanners probing with POST/PUT/DELETE won't
 *     send `application/json`; exempt so the trap handler actually fires
 *     and the ban-list gets populated (mirrors the CSRF exemption logic
 *     when present).
 *
 * Note: /api/track/events short-circuits in Layer 1 (rate limit) and never
 * reaches this check anyway, but the exemption is also defense-in-depth in
 * case the Layer 1 short-circuit path changes later.
 */
function isContentTypeExemptPath(path: string): boolean {
  return (
    path === "/api/track" ||
    path.startsWith("/api/track/") ||
    path === "/api/auth" ||
    path.startsWith("/api/auth/") ||
    path === "/api/trap" ||
    path.startsWith("/api/trap/")
  )
}

/**
 * Paths exempt from request-signature replay protection (Layer 3b).
 *
 *   - /api/track/* — public SDK ingest. The tracking SDK runs cross-origin
 *     on third-party websites and has no CSRF token to use as the HMAC key.
 *     Already protected by per-project API key auth + 100/min/IP rate limit,
 *     so the absence of replay protection here has diminishing returns.
 *   - /api/auth/*   — pre-auth. login/setup/logout happen BEFORE any session /
 *     CSRF cookie exists, so the client has no shared secret to sign with.
 *     Login attempts already get their own 5/min rate limit applied inside
 *     the route handler (see src/app/api/auth/login/route.ts).
 *
 * Note: this is BROADER than `isCsrfExemptPath` (which only exempts
 * /api/auth/login + /api/auth/setup) — the signer exemption covers ALL of
 * /api/auth/* because logout and /api/auth/me are also reached without a
 * pre-existing valid session in some flows (e.g. a just-expired session).
 * CSRF still protects those endpoints; the signer is the additional layer
 * that's skipped for them.
 */
function isSignatureExemptPath(path: string): boolean {
  return (
    path === "/api/track" ||
    path.startsWith("/api/track/") ||
    path === "/api/auth" ||
    path.startsWith("/api/auth/")
  )
}

/**
 * Extract the `userId` from a raw `ir_session` cookie value WITHOUT verifying
 * the HMAC signature. Used by middleware's per-user rate-limiting layer
 * (Layer 4b) — the full cryptographic verification (signature + expiry + IP
 * binding) still happens server-side in route handlers / server components
 * via `getSession()`, but we need the userId here at the edge to key the
 * per-user rate-limit counter so a single compromised account cannot soak
 * up the whole IP's quota.
 *
 * Cookie shape: `<base64url(payload)>.<hexHmacSig>` — same as produced by
 * `createSession()` in `src/lib/session.ts`. We split on the LAST dot,
 * base64url-decode the first part, JSON-parse it, and read `userId`.
 *
 * Edge-runtime note: `Buffer.from(s, "base64url")` is unavailable in the
 * Edge runtime (it's a Node-only API), so we convert base64url → standard
 * base64 (swap `-`→`+`, `_`→`/`, pad with `=` to a multiple of 4) and use
 * the Web-standard `atob()` + `TextDecoder` instead. Both are available in
 * the Edge runtime.
 *
 * Returns null on any failure (missing cookie, malformed shape, parse
 * error, missing/non-string `userId`). Never throws — the caller relies
 * on this for fail-open behavior (a parse failure must NOT block the
 * request; the IP-level limit from Layer 1 still applies).
 */
function extractUserIdFromSessionCookie(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const dot = raw.lastIndexOf(".")
    if (dot <= 0 || dot >= raw.length - 1) return null
    const encoded = raw.slice(0, dot)
    // base64url → standard base64 (atob only speaks standard base64).
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/")
    // Pad to a multiple of 4 with `=` (base64url omits padding).
    const pad = base64.length % 4
    const padded = pad ? base64 + "=".repeat(4 - pad) : base64
    // atob() returns a binary string; decode as UTF-8 via TextDecoder so
    // any non-ASCII email / userId field round-trips correctly.
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
      userId?: unknown
    }
    if (typeof payload.userId !== "string" || payload.userId.length === 0) {
      return null
    }
    return payload.userId
  } catch {
    // Malformed payload, bad base64, invalid JSON — fail open (no userId).
    return null
  }
}

// ─── File-integrity monitor flag (Edge-safe read) ──────────────────────
//
// 10x+: File integrity monitor. The Node-side monitor
// (`src/lib/file-integrity.ts`, started by `src/instrumentation.ts` at
// server boot) hashes every .ts/.tsx file in `src/` once at startup and
// re-hashes them every 5 minutes. If ANY file has been modified, deleted,
// or added between the baseline and a verify tick, the monitor flips a
// sticky `compromised` flag on `globalThis.__fileIntegrityState`.
//
// This inline reader is the Edge-runtime-safe counterpart to the
// `isCompromised()` function exported from `src/lib/file-integrity.ts`.
// We can NOT import that module directly here — it uses `fs.readdirSync`,
// `fs.readFileSync`, and `crypto.createHash('sha256')` (all Node-only),
// and pulling it into the Edge bundle crashes the middleware with:
//   "The edge runtime does not support Node.js 'crypto' module"
// (the same pattern that already applies to `src/lib/session.ts`, which
// the middleware also can't import — see the SESSION_COOKIE_NAME comment
// above). The flag, however, is just a primitive boolean stashed on
// `globalThis`, which the Edge runtime CAN read without bundling any
// Node-only module. In the standalone build (Node-based Edge runtime),
// `globalThis` IS shared between the Node process and the Edge
// middleware, so the flag set by the Node-side monitor is visible here.
//
// The function name is identical (`isCompromised`) so that the call site
// in `middleware()` reads naturally as "if isCompromised(), 503" —
// matching the contract published by `file-integrity.ts`.
//
// NEVER clears the flag. The Node-side monitor sets the flag sticky (once
// true, stays true until the process restarts) — fail-closed by design.
// An operator must restart the server after manually verifying the source
// tree is clean; this reader just reflects the current sticky state.
function isCompromised(): boolean {
  try {
    const g = globalThis as unknown as {
      __fileIntegrityState?: {
        compromised?: boolean
      }
    }
    return g.__fileIntegrityState?.compromised === true
  } catch {
    // Defensive — globalThis access shouldn't throw, but if it does
    // (sandboxed runtime, frozen global, etc.), we want fail-OPEN here,
    // not fail-closed: a transient read failure should NOT take the whole
    // app offline. The Node-side monitor will catch the tamper on the
    // next verify tick and re-set the flag, at which point this read
    // will succeed and the 503 will kick in.
    return false
  }
}

export async function middleware(req: NextRequest) {
  // ─── Request-path canonicalization (feeds every decision below) =======
  //
  // `rawPathname` is EXACTLY what the client put on the HTTP request
  // line — untrusted bytes. `canonicalizePath()` computes the server-side,
  // normalized interpretation of those bytes (percent-decoded, dot-segment
  // resolved, slash-collapsed). All security decisions below run against
  // `path` (the canonical form), and every check exemption additionally
  // requires `pathTrusted` — see the full rationale on `canonicalizePath`.
  //
  // Fail-closed contract: if the raw path can't be canonicalized with
  // confidence, `pathTrusted` is false and NO exemption or short-circuit
  // applies for this request — it must clear the strict layers
  // (Content-Type, CSRF, signature, session) like any protected route.
  const rawPathname = req.nextUrl.pathname
  const canonicalPath = canonicalizePath(rawPathname)
  // Canonical form when computable, else the raw bytes (so metrics and
  // redirect bookkeeping still have something to work with — those are
  // non-security uses and must not crash on hostile input).
  const path = canonicalPath ?? rawPathname
  // True ⇒ the path decoded + normalized cleanly, so `path` reliably
  // names the route Next.js will execute. False ⇒ ambiguous/hostile
  // path ⇒ every check-exemption below is disabled (fail-closed).
  const pathTrusted = canonicalPath !== null
  const start = Date.now()
  const method = req.method.toUpperCase()
  const origin = req.headers.get("origin")

  // Per-request CSP nonce — generated fresh for EVERY request so that an
  // attacker who finds an XSS sink cannot replay a nonce from a prior
  // response. See `applyCsp` / `buildCsp` above for the policy shape.
  // Generated up here (before the stale-request check) so the 504 path
  // also gets a CSP header stamped on it.
  const nonce = generateNonce()

  // ─── Layer -2: File-integrity maintenance mode (503 fail-closed) =======
  //
  // 10x+: File integrity monitor. If the Node-side monitor
  // (`src/lib/file-integrity.ts`, started by `src/instrumentation.ts`)
  // has detected that ANY .ts/.tsx file under `src/` was modified, deleted,
  // or added since the startup baseline, `isCompromised()` returns true and
  // we bail with 503 "System maintenance" BEFORE any other layer runs.
  //
  // Why this is BEFORE Layer -1 (stale-request) and everything else:
  //   - If a source file was tampered, the rest of this middleware's logic
  //     is no longer trustworthy — an attacker who weakened `session.ts`
  //     could have also weakened the cookie format check (Layer 4) to let
  //     a forged cookie through. The only safe posture is to refuse to
  //     process the request AT ALL until an operator restarts the server
  //     with a verified-clean source tree.
  //   - The flag is STICKY (once true, stays true for the process lifetime),
  //     so once tripped, EVERY subsequent request gets 503 — the app is
  //     effectively offline until restart. This is fail-closed by design.
  //
  // Response shape:
  //   - 503 Service Unavailable (RFC 7231 §6.6.4) — the canonical "server
  //     is temporarily unable to handle the request" status. Browsers + LBs
  //     treat 503 as "retry later" (vs. 500 "the server broke" which implies
  //     a transient error). `Retry-After: 3600` tells clients to back off
  //     for an hour — long enough for an operator to investigate + restart.
  //   - Body is a static "System maintenance" string (NOT the list of
  //     changed files — that would leak the file paths + change list to any
  //     unauthenticated client, including the attacker who tripped the
  //     monitor, giving them intel on whether their tamper was detected).
  //     The detailed change list lives in logs/app.jsonl (logged by the
  //     Node-side monitor at `error` level with event name
  //     `CRITICAL:file_integrity_violation`).
  //   - `Cache-Control: no-store` — a 503 in response to a tamper detection
  //     must NEVER be cached, or a CDN could keep serving "maintenance"
  //     long after the operator has restarted with a clean tree.
  //   - CSP is still stamped via `applyCsp(res, nonce)` — defense in depth:
  //     even a maintenance page should carry a strict CSP so an attacker
  //     who somehow managed to inject HTML into the (static, server-side)
  //     503 body cannot execute scripts in the browser.
  //   - `Vary: Origin` so any cache that DID disobey `no-store` at least
  //     doesn't conflate cross-origin 503s with same-origin ones.
  if (isCompromised()) {
    recordEdgeMetric(method, path, 503, Date.now() - start)
    const res = new NextResponse("System maintenance", {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Retry-After": "3600",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
      },
    })
    res.headers.set("Vary", "Origin")
    applyCsp(res, nonce)
    return res
  }

  // ─── Layer -1: Global request deadline (stale-request rejection) ===========
  // If an upstream reverse proxy (Caddy / load balancer) forwarded an
  // `x-request-start` header, check whether the request has been queued
  // longer than REQUEST_TIMEOUT_MS before reaching us. A request that
  // sat in a proxy queue for 30s+ is almost certainly a slowloris /
  // retry flood — reject it with 504 so the route handler doesn't pay
  // the cost of running an already-timed-out request. (We can't abort
  // a route handler once it has started, but we CAN refuse to start one
  // for a request that's already over budget.)
  //
  // This layer is the FIRST "normal-path" layer — only the Layer -2 file-
  // integrity kill-switch (above) runs before it, and that's a global
  // 503 short-circuit, not per-request logic. Even CORS / rate-limit
  // checks are skipped for stale requests, since a stale request has no
  // legitimate business reaching the route handler at all.
  const fwdStart = getRequestStartMs(req)
  if (fwdStart !== null && start - fwdStart > REQUEST_TIMEOUT_MS) {
    recordEdgeMetric(method, path, 504, Date.now() - start)
    const res = new NextResponse(
      JSON.stringify({ error: "Request timeout (stale)" }),
      {
        status: 504,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "5",
        },
      },
    )
    applyCsp(res, nonce)
    return res
  }

  // Stash rate-limit headers (set on the final pass-through response when
  // rate-limiting allowed the request). `null` means "this path wasn't
  // rate-limited" — the headers are skipped on the pass-through.
  let rateLimitHeaders: Record<string, string> | null = null

  // ─── Layer 0: CORS allowlist (strict, non-track API routes) ===========
  // Tracking ingest (/api/track/*) keeps its own per-project origin
  // validation in the route handler — skip middleware CORS for those paths
  // to avoid duplicating the check (and breaking the SDK, which legitimately
  // posts from third-party website origins). Page routes don't go through
  // CORS here — browsers don't enforce CORS on top-level navigations, and
  // same-origin fetches don't send an Origin header.
  //
  // Hardening (js/user-controlled-bypass): the track-path CORS skip is
  // only honored for canonical, server-verified paths. A path spelling
  // that doesn't canonicalize cleanly (`pathTrusted === false`) gets the
  // CORS check applied — never the exemption.
  if (isApiPath(path) && !(pathTrusted && isTrackPath(path))) {
    if (method === "OPTIONS") {
      // Preflight — return 204 with CORS headers if origin is allowlisted,
      // 403 otherwise. Max-Age is intentionally short (5 min) so a stale
      // CORS cache won't keep allowing an origin that's been removed from
      // the allowlist since the last preflight.
      if (origin && isCorsOriginAllowed(origin)) {
        const res = new NextResponse(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, x-csrf-token, x-request-id, x-device-fp, x-request-sig",
            "Access-Control-Max-Age": "300",
            Vary: "Origin",
          },
        })
        applyCsp(res, nonce)
        return res
      }
      // No Origin header, or origin not on the allowlist → reject preflight.
      // (Server-to-server / curl probes with no Origin are also blocked
      // here, which is intentional — preflight is browser-only, and a
      // missing Origin on an OPTIONS to a non-track API route is suspicious.)
      recordEdgeMetric(method, path, 403, Date.now() - start)
      const res = new NextResponse(
        JSON.stringify({ error: "CORS origin not allowed" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json", Vary: "Origin" },
        },
      )
      applyCsp(res, nonce)
      return res
    }

    // Non-preflight cross-origin API request — strict allowlist check.
    // Same-origin requests don't send Origin (or send the same-origin
    // value), so those pass through and get Vary: Origin + (if origin
    // matches) Access-Control-Allow-Origin stamped on the final pass-through
    // response by stampCorsHeaders().
    if (origin && !isCorsOriginAllowed(origin)) {
      recordEdgeMetric(method, path, 403, Date.now() - start)
      const res = new NextResponse(
        JSON.stringify({ error: "CORS origin not allowed" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json", Vary: "Origin" },
        },
      )
      applyCsp(res, nonce)
      return res
    }
  }

  // ─── Layer 1: Rate limiting ============================================
  // SECURITY FIX (CodeQL js/user-controlled-bypass — this exact-match on
  // the request-controlled pathname was the flagged conditional): the
  // ingest throttle used to apply only when the RAW pathname byte-equals
  // "/api/track/events". Any other spelling of the SAME route — a
  // trailing slash ("/api/track/events/"), a doubled slash
  // ("//api/track/events"), a percent-encoded character
  // ("/api/track/e%76ents") — failed the comparison and therefore
  // skipped the ONLY middleware check in front of public SDK ingest
  // (every other layer prefix-exempts /api/track/*). In other words: the
  // attacker-controlled URL decided whether the rate-limit security
  // check ran at all.
  //
  // Now the match runs against the server-computed canonical path, so
  // every spelling of the ingest route lands in the same INGEST_LIMIT
  // bucket, and a path we can't canonicalize with confidence
  // (`pathTrusted === false`) doesn't get this short-circuit at all — it
  // falls through to the strict CSRF / signature / session layers below.
  if (pathTrusted && path === "/api/track/events") {
    const ip = getClientIP(req as unknown as Request)
    const result = rateLimit(ip, INGEST_LIMIT)

    if (!result.allowed) {
      recordEdgeMetric(req.method, "/api/track/events", 429, Date.now() - start)
      const res = new NextResponse(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      })
      // Vary: Origin always — this 429 may vary by request origin.
      res.headers.set("Vary", "Origin")
      applyCsp(res, nonce)
      return res
    }

    // Tracking ingest is public + CSRF-exempt — short-circuit straight to
    // the pass-through with rate-limit headers attached. Don't fall through
    // to the CSRF / session layers below. stampCorsHeaders only stamps
    // Vary: Origin here (track paths skip Access-Control-Allow-Origin
    // reflection — the route handler does that against the project's siteUrl).
    // `nextWithNonce` propagates the per-request nonce to the downstream
    // request headers (so the layout can read it via `headers()` from
    // `next/headers`) AND stamps the strict CSP + nonce on the response.
    const res = nextWithNonce(req, nonce)
    res.headers.set("X-RateLimit-Remaining", String(result.remaining))
    res.headers.set("X-RateLimit-Reset", String(result.resetAt))
    stampCorsHeaders(res, origin, path)
    stampRequestId(req, res)
    return res
  }

  if (path === "/api/projects" || path.startsWith("/api/projects/")) {
    const ip = getClientIP(req as unknown as Request)
    const result = rateLimit(ip, API_LIMIT)

    if (!result.allowed) {
      recordEdgeMetric(req.method, path, 429, Date.now() - start)
      const res = new NextResponse(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "60",
        },
      })
      // Vary: Origin always — this 429 may vary by request origin.
      res.headers.set("Vary", "Origin")
      applyCsp(res, nonce)
      return res
    }

    // Rate-limit OK — stash headers and fall through to the CSRF + session
    // layers below. We'll stamp them on the pass-through response after
    // those checks pass.
    rateLimitHeaders = {
      "X-RateLimit-Remaining": String(result.remaining),
      "X-RateLimit-Reset": String(result.resetAt),
    }
  }

  // ─── Layer 2: Content-Type enforcement (mutating requests only) =======
  // POST/PUT/PATCH/DELETE MUST send `Content-Type: application/json` (a
  // charset suffix like `application/json; charset=utf-8` is allowed).
  // Anything else — `text/plain`, `multipart/form-data`, or a missing
  // Content-Type header — is rejected with 415 before reaching a route
  // handler. This prevents body-parser bypass where a non-JSON content
  // type would be silently dropped by `req.json()`, leaving the handler
  // with an empty body and no signal that the client actually sent a
  // different payload shape (which could then sail past input validation
  // that assumed an empty object == "no fields provided").
  //
  // Exempt paths (see isContentTypeExemptPath):
  //   - /api/track/*  — public SDK ingest. The beacon/SDK may send payloads
  //                     as text/plain (CORS-pre-flight avoidance) or other
  //                     non-JSON types.
  //   - /api/auth/*   — login/setup/logout may accept form-encoded bodies
  //                     from legacy <form> posts; we don't want to break
  //                     those flows by forcing JSON.
  //   - /api/trap/*   — honeypot. Scanners probing with POST/PUT/DELETE
  //                     won't send `application/json`; exempt so the trap
  //                     handler actually fires and bans the IP (mirrors
  //                     the CSRF exemption logic when present).
  // GET/HEAD/OPTIONS are skipped — they have no body.
  //
  // Hardening (js/user-controlled-bypass): exemptions are only honored
  // for canonical, trusted paths — an ambiguous path gets the strict
  // Content-Type check, never the skip.
  if (MUTATING_METHODS.has(method) && !(pathTrusted && isContentTypeExemptPath(path))) {
    const contentType = req.headers.get("content-type")
    // Compare case-insensitively: HTTP header values are case-insensitive
    // and some clients send `Application/JSON`. startsWith() covers the
    // `application/json; charset=utf-8` suffix.
    if (
      !contentType ||
      !contentType.toLowerCase().startsWith("application/json")
    ) {
      recordEdgeMetric(method, path, 415, Date.now() - start)
      // 415 Unsupported Media Type — Content-Type must be application/json
      const res = new NextResponse(
        JSON.stringify({ error: "Unsupported Media Type: Content-Type must be application/json" }),
        {
          status: 415,
          headers: {
            "Content-Type": "application/json",
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "SAMEORIGIN",
          },
        },
      )
      applyCsp(res, nonce)
      return res
    }
  }

  // ─── Layer 2b: Body size limit (15KB) =================================
  // Rejects payloads > 15KB (15360 bytes) on mutating requests. Prevents
  // memory-exhaustion DoS via huge JSON bodies. Mirrors qaorders limit.
  // Server Actions have their own limit via next.config.ts serverActions.bodySizeLimit.
  if (MUTATING_METHODS.has(method)) {
    const contentLength = parseInt(req.headers.get("content-length") || "0", 10)
    if (contentLength > 15360) {
      recordEdgeMetric(method, path, 413, Date.now() - start)
      const res = new NextResponse(
        JSON.stringify({ error: "Payload too large (max 15KB)" }),
        { status: 413, headers: { "Content-Type": "application/json" } },
      )
      applyCsp(res, nonce)
      stampCorsHeaders(res, "", path)
      return res
    }
  }

  // ─── Layer 3: CSRF protection (double-submit cookie) ===================
  // Validated for all mutating methods on every API route except the
  // explicitly-exempted paths. Reads the token from both the `x-csrf-token`
  // header AND the `ir_csrf` cookie, and requires them to byte-equal
  // (constant-time compare in `validateCsrfToken`).
  //
  // Why exempt these paths:
  //   - /api/track/*        — public SDK ingest. The SDK is loaded cross-
  //                           origin by external sites which can't fetch a
  //                           CSRF token; uses project-ID bearer instead.
  //   - /api/auth/login     — the login request itself (no CSRF cookie yet).
  //   - /api/auth/setup     — first-time setup (no CSRF cookie yet).
  //   - /api/csrf-token     — the endpoint that mints the token (chicken-
  //                           and-egg: must be reachable to GET a token).
  // GET/HEAD/OPTIONS are safe / preflight → skipped.
  //
  // Hardening (js/user-controlled-bypass): the CSRF exemption is only
  // honored for canonical, trusted paths — a path spelling that doesn't
  // canonicalize cleanly must present a valid CSRF token like every other
  // protected route.
  if (MUTATING_METHODS.has(method) && !(pathTrusted && isCsrfExemptPath(path))) {
    const headerToken = req.headers.get(CSRF_HEADER_NAME)
    const cookieToken = req.cookies.get(CSRF_COOKIE_NAME)?.value ?? null
    if (!validateCsrfToken(headerToken, cookieToken)) {
      recordEdgeMetric(method, path, 403, Date.now() - start)
      const res = new NextResponse(
        JSON.stringify({ error: "CSRF token invalid" }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      )
      // Vary: Origin always — this 403 may vary by request origin.
      res.headers.set("Vary", "Origin")
      applyCsp(res, nonce)
      return res
    }
  }

  // ─── Layer 3b: Request-signature replay protection (HMAC) =============
  // After CSRF passes, verify the per-request HMAC signature in
  // `x-request-sig: <timestamp>:<hmac>`. The HMAC is keyed with the CSRF
  // token (which both the client and middleware already have — the client
  // reads the ir_csrf cookie, we read the x-csrf-token header that the
  // double-submit pattern just verified above) and covers
  // METHOD + PATH + TIMESTAMP + SHA256(body). The timestamp is part of the
  // signed payload, so an attacker who captures a request can't refresh
  // the timestamp without invalidating the HMAC — the request is dead
  // after REQUEST_SIG_MAX_AGE_MS (5 minutes).
  //
  // Threat model: CSRF protects against FORGED requests (an attacker on
  // evil.com can't cause the victim's browser to send the matching
  // x-csrf-token header). It does NOT protect against REPLAY: an attacker
  // who captures a legitimate request (malicious proxy, TLS-stripping
  // middlebox, compromised CDN edge, stolen laptop with the dashboard
  // tab still open) can resend that exact request for the full 1-hour
  // CSRF cookie lifetime and every existing check (CSRF, session, rate
  // limit) will still pass — the captured CSRF token still matches the
  // cookie. This layer bounds that window to 5 minutes.
  //
  // Exemptions (see isSignatureExemptPath):
  //   - /api/track/* — the tracking SDK runs cross-origin on third-party
  //     sites and can't fetch a CSRF token to use as the HMAC key. Already
  //     covered by per-project API key auth + rate limiting.
  //   - /api/auth/* — pre-auth. login/setup happen before any CSRF cookie
  //     exists, so there's no shared secret to sign with. Login already
  //     has its own 5/min rate limit inside the route handler.
  // GET/HEAD/OPTIONS are skipped (no mutating effect, no signature needed).
  //
  // Body reading: we CLONE the request first so the downstream route
  // handler still has an unconsumed body stream. `req.clone()` is the
  // standard Web Fetch API pattern; the original stream is preserved when
  // the clone is read. The clone's text is what we feed to SHA-256.
  //
  // Failure modes (mapped to distinct 403 messages for debuggability):
  //   - "missing"    → header absent entirely (client didn't sign).
  //   - "malformed"  → header present but not `<int>:<hex>`.
  //   - "expired"    → timestamp older than 5 min or > 60s in the future.
  //   - "invalid"    → HMAC doesn't match (tampered payload, wrong key).
  //
  // SECURITY FIX (CodeQL js/user-controlled-bypass — this exemption guard
  // was the flagged conditional): the signature requirement used to be
  // skipped whenever the RAW request-controlled pathname claimed to be a
  // track/auth route. Because the Next.js router can normalize a path
  // differently than a byte-prefix comparison does (percent-decoding,
  // trailing slashes, doubled slashes — "path confusion"), a hostile
  // spelling could present itself as an exempt prefix here while
  // executing a protected route, silently shedding the replay check.
  // The exemption is now honored ONLY when the path canonicalized cleanly
  // (`pathTrusted`), i.e. the server has verified the bytes actually name
  // a track/auth route; anything ambiguous must carry a valid signature.
  if (MUTATING_METHODS.has(method) && !(pathTrusted && isSignatureExemptPath(path))) {
    const sigHeader = req.headers.get(REQUEST_SIG_HEADER)
    // The CSRF token from the header is the shared secret the client used
    // to compute the HMAC. The CSRF layer above already verified this
    // header value matches the ir_csrf cookie (constant-time compare), so
    // we can safely use it as the HMAC key here. An empty string here
    // would cause crypto.subtle.importKey to throw — verifyRequestSignature
    // guards that and returns `{ ok: false, reason: "invalid" }`.
    const csrfToken = req.headers.get(CSRF_HEADER_NAME) ?? ""
    // Clone the request so reading the body for the hash doesn't consume
    // the original stream the downstream route handler will read. Reading
    // from the clone leaves the original's stream intact (Web Fetch API
    // `clone()` tees the body into two independent streams).
    let bodyText = ""
    try {
      const cloned = req.clone()
      bodyText = await cloned.text()
    } catch {
      // If body reading fails (rare: malformed stream, OOM), treat the
      // signature as invalid — fail-closed rather than skip the check.
      // We still pass bodyText = "" (sha256 of empty string is a fixed
      // constant), but verifyRequestSignature will compute the expected
      // HMAC over the empty-body hash and compare to the provided mac —
      // which will not match what the client signed over the real body.
    }
    // NOTE: the signature is verified over the RAW pathname, not the
    // canonical one — the client signs the URL exactly as it fetches it,
    // so canonicalizing only the server side would break legitimate
    // signed requests. (The decision whether to REQUIRE a signature at
    // all is what was hardened above; the verification itself was never
    // the path-confusable part.)
    const sigResult = await verifyRequestSignature(
      method,
      rawPathname,
      bodyText,
      sigHeader,
      csrfToken,
    )
    if (!sigResult.ok) {
      const reasonMap: Record<string, string> = {
        missing: "Missing request signature",
        malformed: "Malformed request signature",
        expired: "Request expired",
        invalid: "Invalid signature",
      }
      const errorMsg = reasonMap[sigResult.reason] || "Invalid signature"
      recordEdgeMetric(method, path, 403, Date.now() - start)
      const res = new NextResponse(
        JSON.stringify({ error: errorMsg }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      )
      // Vary: Origin always — this 403 may vary by request origin.
      res.headers.set("Vary", "Origin")
      applyCsp(res, nonce)
      return res
    }
  }

  // ─── Layer 4: Session-cookie gate (Agent 1's auth) =====================
  // Public paths skip the session check (login, /api/auth/*, /api/track/*,
  // /api/health, /api/csrf-token). For everything else, require the
  // `ir_session` cookie to be PRESENT and structurally well-formed.
  //
  // Format check (defense-in-depth, NOT a full HMAC verify):
  //   `<base64url(payload)>.<hexHmacSig>` — exactly two non-empty
  //   dot-separated parts, with the second part being a hex string. This
  //   mirrors the cookie shape produced by `createSession()` in `session.ts`.
  //
  // The Edge runtime can't load `node:crypto`, so the full cryptographic
  // signature + expiry verification still happens server-side in route
  // handlers / server components via `getSession()`. But many route handlers
  // don't actually call `getSession()`, so this format check rejects obviously
  // fake / malformed cookies early — preventing a cookie like `ir_session=1`
  // or `ir_session=garbage` from sailing straight through to a protected page.
  //
  // Hardening (js/user-controlled-bypass): the public-path skip is only
  // honored for canonical, trusted paths. A path that doesn't canonicalize
  // cleanly is treated as PROTECTED (fail-closed) — it must present a
  // session cookie like any dashboard route.
  if (!(pathTrusted && isPublicPath(path))) {
    const session = req.cookies.get(SESSION_COOKIE_NAME)?.value

    // Validate format: two dot-separated non-empty parts, second part is hex.
    let formatValid = false
    if (session) {
      const parts = session.split(".")
      formatValid =
        parts.length === 2 &&
        parts[0].length > 0 &&
        parts[1].length > 0 &&
        /^[a-f0-9]+$/i.test(parts[1])
    }

    if (!formatValid) {
      if (path.startsWith("/api/")) {
        recordEdgeMetric(req.method, path, 401, Date.now() - start)
        const res = new NextResponse(
          JSON.stringify({ ok: false, error: "Unauthorized" }),
          {
            status: 401,
            headers: { "Content-Type": "application/json" },
          },
        )
        // Clear the bad/missing cookie so the client doesn't keep replaying it.
        if (session) res.cookies.delete(SESSION_COOKIE_NAME)
        // Vary: Origin always — this 401 may vary by request origin.
        res.headers.set("Vary", "Origin")
        applyCsp(res, nonce)
        return res
      }
      // Page route — redirect to /login, preserving the original path so the
      // login flow can bounce the user back after a successful sign-in.
      const loginUrl = req.nextUrl.clone()
      loginUrl.pathname = "/login"
      loginUrl.search = ""
      // Use the RAW pathname for the post-login bounce-back so the user
      // returns to exactly what they requested (canonicalization feeds
      // security decisions only — it must not rewrite user-visible
      // redirects).
      const from = rawPathname + req.nextUrl.search
      loginUrl.searchParams.set("from", from)
      const res = NextResponse.redirect(loginUrl)
      // Clear the bad/missing cookie so the client doesn't keep replaying it.
      if (session) res.cookies.delete(SESSION_COOKIE_NAME)
      // Vary: Origin always — redirect responses may vary by request origin.
      res.headers.set("Vary", "Origin")
      applyCsp(res, nonce)
      return res
    }

    // ─── Layer 4b: Per-user rate limiting (per-account abuse control) =====
    //
    // Layer 1 limits per-IP, but a compromised account behind a shared
    // NAT / corporate proxy can make unlimited requests from the same IP
    // while staying under Layer 1's per-IP cap — and conversely one user's
    // burst shouldn't count against another user's quota on a shared IP.
    // This layer keys the rate-limit counter on the authenticated userId
    // (extracted from the format-validated session cookie — NOT HMAC-
    // verified here, that happens server-side via `getSession()`) so the
    // cap is per-account regardless of source IP.
    //
    // USER_API_LIMIT (120 req/min) is intentionally HIGHER than the per-IP
    // API_LIMIT (60 req/min) — a single legitimate user on a dedicated IP
    // would otherwise be capped at 60/min and could hit it during normal
    // dashboard scrolling. 120/min gives legitimate users headroom while
    // still stopping a compromised account from hammering the API. The
    // per-IP Layer 1 cap (60/min) still applies underneath, so a single
    // attacker IP with N forged userIds still only gets 60/min total.
    //
    // Fails open: if `extractUserIdFromSessionCookie` can't extract a
    // userId (malformed payload, parse error), we skip the per-user limit
    // and let the request through. The IP-level limit (Layer 1) still
    // applies, and the format check (Layer 4) already rejected obviously
    // fake cookies. A determined attacker could spoof a session cookie
    // with a forged userId to dodge this layer, but the server-side
    // `getSession()` verify in the route handler would reject the forged
    // cookie — so they only get past this layer to hit a 401 anyway.
    //
    // `rateLimitByKey` shares the same Map as `rateLimit` (Layer 1) and
    // calls `boundMapSize()` internally on every new entry, so the map
    // is bounded against userId-spoofing-driven unbounded growth.
    const userId = extractUserIdFromSessionCookie(session)
    if (userId) {
      const userRl = rateLimitByKey("user:" + userId, USER_API_LIMIT)
      if (!userRl.allowed) {
        recordEdgeMetric(method, path, 429, Date.now() - start)
        // Retry-After = seconds until the per-user window resets.
        const retryAfterSec = Math.max(
          1,
          Math.ceil((userRl.resetAt - Date.now()) / 1000),
        )
        const res = new NextResponse(
          JSON.stringify({ error: "Rate limit exceeded (per-user)" }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": String(retryAfterSec),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": String(userRl.resetAt),
            },
          },
        )
        // Vary: Origin always — this 429 may vary by request origin.
        res.headers.set("Vary", "Origin")
        applyCsp(res, nonce)
        return res
      }
      // Stash per-user rate-limit headers on the pass-through response.
      // These take precedence over the per-IP headers (Layer 1) when both
      // apply — per-user is the more specific, more actionable signal for
      // the client (it tells them which counter they're burning down).
      rateLimitHeaders = {
        "X-RateLimit-Remaining": String(userRl.remaining),
        "X-RateLimit-Reset": String(userRl.resetAt),
      }
    }

    // ─── Layer 4c: Device-fingerprint presence (mutating requests only) ==
    //
    // On authenticated non-public routes, mutating requests
    // (POST/PUT/PATCH/DELETE) MUST carry the `x-device-fp` header. A missing
    // (or whitespace-only) header is rejected with 401 here, before the
    // request reaches the route handler. GET/HEAD/OPTIONS are exempt — a
    // missing fingerprint on read-only requests degrades to IP-only binding
    // (still verified server-side in `getSession()`; see the matrix in
    // session.ts).
    //
    // Why only mutating? A stolen cookie being replayed from a different
    // browser is the threat model for write actions — a stolen session
    // driving a DELETE /resources/:id or a POST /apikeys is what we want
    // to stop. A stolen session that can only read dashboard HTML is bad
    // but recoverable (the legitimate user notices the read anomaly, the
    // attacker can't change state). Forcing the fingerprint on GETs would
    // break the initial page load before the client has had time to
    // compute one, and would block curl / programmatic reads — neither
    // is worth the marginal extra security on read-only paths.
    //
    // What this layer does NOT do: it does NOT verify that the fingerprint
    // matches the `fpHash` stored in the session. That comparison requires
    // the secret-salted SHA-256, which can only run in the Node runtime
    // (the Edge bundle can't load `node:crypto`). The full cryptographic
    // fpHash-vs-stored-fpHash verification happens in `getSession()` when
    // the route handler calls it. This layer only enforces HEADER
    // PRESENCE on mutating requests so a missing-fingerprint request can't
    // reach a mutating route handler at all — defense in depth.
    //
    // Why 401 and not 403? 403 implies "you are authenticated but not
    // allowed". Here the request is missing a required credential
    // component (the device fingerprint is part of the session-binding
    // credential); 401 "Unauthorized" + WWW-Authenticate is the more
    // accurate signal and tells the client to re-issue with the header.
    if (MUTATING_METHODS.has(method)) {
      const fp = req.headers.get(DEVICE_FP_HEADER)
      if (!fp || !fp.trim()) {
        recordEdgeMetric(method, path, 401, Date.now() - start)
        const res = new NextResponse(
          JSON.stringify({
            ok: false,
            error: "Device fingerprint required",
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              // Hint to the client what header is missing.
              "WWW-Authenticate": `DeviceFP realm="insight-replay"`,
            },
          },
        )
        // Vary: Origin always — this 401 may vary by request origin.
        res.headers.set("Vary", "Origin")
        applyCsp(res, nonce)
        return res
      }
    }
  }

  // ─── Layer 5: Pass-through =============================================
  // `nextWithNonce` creates a NextResponse.next() that propagates the
  // per-request nonce to the downstream route handler's REQUEST headers
  // (so `headers()` from `next/headers` can read it in the layout / server
  // components), and stamps the strict CSP + nonce on the response.
  const res = nextWithNonce(req, nonce)
  if (rateLimitHeaders) {
    for (const [k, v] of Object.entries(rateLimitHeaders)) res.headers.set(k, v)
  }
  // Stamp CORS: always Vary: Origin (cache-poisoning prevention); reflect
  // the request Origin only on non-track API routes when it's allowlisted.
  stampCorsHeaders(res, origin, path)
  stampRequestId(req, res)
  return res
}

/** Stamp a request id header for correlation (edge-safe). */
function stampRequestId(req: NextRequest, res: NextResponse) {
  const reqId =
    req.headers.get("x-request-id") ||
    "req_" + Math.random().toString(36).slice(2, 12)
  res.headers.set("x-request-id", reqId)
}

// Edge-safe metric recording (in-memory, no fs) — mirrors observability.ts
// but without Node imports so it runs in the Edge runtime.
function recordEdgeMetric(_method: string, _route: string, status: number, durationMs: number) {
  try {
    const g = globalThis as unknown as { __edgeMetrics?: { requests: number; errors: number; totalMs: number } }
    if (!g.__edgeMetrics) g.__edgeMetrics = { requests: 0, errors: 0, totalMs: 0 }
    g.__edgeMetrics.requests++
    if (status >= 400) g.__edgeMetrics.errors++
    g.__edgeMetrics.totalMs += durationMs
  } catch {
    // ignore
  }
}

// Run on all routes EXCEPT static assets (handled by Next.js for speed).
// The middleware internally routes:
//   - /api/track/events    → INGEST_LIMIT rate limit, no session check
//   - /api/projects/*      → API_LIMIT rate limit + session check
//   - /api/auth/* /login   → public, no session check
//   - other /api/*         → session check (401 if missing)
//   - other pages          → session check (redirect to /login if missing)
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
}
