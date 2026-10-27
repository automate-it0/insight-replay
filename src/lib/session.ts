// Session management — signed-cookie sessions for the dashboard.
//
// Why custom (not NextAuth)?  NextAuth requires an adapter + JWT/DB session
// store and adds significant surface area for a single-user admin dashboard.
// A signed HMAC cookie is simpler, works with SQLite without an extra table,
// and is fully under our control. The cookie value is
// `<base64url(payload)>.<hexHmacSig>` — the signature prevents tampering, the
// payload's `exp` field prevents indefinite replay, and the httpOnly +
// sameSite=strict flags prevent XSS-driven exfiltration and CSRF.
//
// Security notes:
//   - Password hashing uses scrypt (memory-hard KDF, Node.js built-in) with a
//     per-user random salt. scrypt is intentionally slow and memory-hard, which
//     resists offline brute-force attacks on GPU/ASIC hardware far better than
//     a fast hash like SHA-256. The function signature
//     (`hashPassword`/`verifyPassword`) is stable so the KDF parameters can be
//     tuned or swapped without touching call sites.
//   - All comparisons (password hash AND HMAC signature) use
//     `crypto.timingSafeEqual` to avoid timing side-channels.
//   - `SESSION_SECRET` MUST be set in env for production — fail-CLOSED:
//     if it is unset OR fails `validateSecretStrength` (length < 16 /
//     missing lowercase / uppercase / digit / special char class) we
//     THROW at module load. A missing or weak secret would sign every
//     session cookie with a publicly-known or trivially-guessable key,
//     silently destroying the entire authentication guarantee — better
//     to crash the boot than ship a forgery-vulnerable session system
//     that operators won't realize is broken until an attacker abuses it.
//     In dev (`NODE_ENV !== "production"`) a random per-process fallback
//     is allowed so `bun dev` works without a configured secret, but
//     every signed cookie is invalidated on restart (random key changes),
//     which is the desired dev behavior.
//
// Edge-runtime caveat: `next/headers` `cookies()` is async in Next.js 16 and
// is NOT available in the Edge middleware runtime. The middleware does a
// cheap cookie-presence check (see src/middleware.ts); the cryptographic
// verification (signature + expiry + IP binding) happens here, in Node route
// handlers and server components, via `getSession()` / `requireAuth()`.
//
// Session IP + device-fingerprint binding: every session payload includes
// `ipHash` (a salted SHA-256 hash of the issuing client's IP, truncated to
// 16 hex chars) AND, when the client sent an `x-device-fp` header on login,
// `fpHash` (the same construction applied to the device fingerprint).
//
// On verification, the current request's IP and (optional) fingerprint are
// hashed the same way and compared (constant-time) against the stored
// values. The combined binding is more permissive than IP-only:
//   - IP same + fp same            → allow  (normal)
//   - IP diff  + fp same           → allow  (mobile network switch — the
//                                          whole reason fp binding exists;
//                                          IP changed but the browser
//                                          fingerprint didn't, so it's the
//                                          same user on a new network)
//   - IP same + fp diff            → allow  (user switched browsers on the
//                                          same machine/network — rule 4)
//   - IP diff  + fp diff           → REJECT (session hijacking — both
//                                          stable anchors changed; rule 5)
//   - IP diff  + fp missing (GET)  → allow  (read-only mode; middleware
//                                          already rejected the non-GET
//                                          case — rule 6)
//   - IP diff  + fp missing (non-GET) → never reaches getSession (middleware
//                                          rejected at Layer 4c)
//
// The salt (`SESSION_SECRET`) makes both hashes non-reproducible by an
// attacker who knows the source IP / fingerprint but not the secret. In
// dev (no `x-forwarded-for` / `x-real-ip` header) the IP reads as
// `"unknown"` consistently between issue and verify, so localhost logins
// still pass — the binding only fires when the IP actually changes.
//
// Why fingerprints complement IP: mobile networks rotate IPs aggressively
// (cellular handoff, Wi-Fi↔LTE, NAT). An IP-only binding breaks the session
// on every rotation — the user gets logged out mid-task. A device
// fingerprint (canvas + WebGL + UA + screen + tz + fonts, hashed on the
// client and sent as `x-device-fp`) is stable across IP changes for the
// same browser, so it lets the session survive an IP rotation while still
// rejecting a stolen cookie replayed from a different browser.

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  scryptSync,
} from "crypto"
import { cookies, headers } from "next/headers"
import { validateSecretStrength } from "@/lib/crypto"

/**
 * Resolve the HMAC signing secret from `process.env.SESSION_SECRET` —
 * fail-CLOSED, not fail-open.
 *
 * Production (`NODE_ENV === "production"`): THROW if `SESSION_SECRET` is
 * unset OR fails `validateSecretStrength` (length >= 16 + lowercase +
 * uppercase + digit + special char). A missing/weak secret means every
 * session cookie would be signed with a publicly-known or trivially-
 * guessable key — that silently destroys the entire authentication
 * guarantee, so crashing the boot is the correct response (an operator
 * who deploys without configuring the secret should see the failure
 * immediately, not after an attacker abuses it).
 *
 * Dev (`NODE_ENV !== "production"`): allow a random per-process
 * fallback so `bun dev` works without a configured secret. Cookies
 * don't survive a restart (random key changes), which is the desired
 * dev ergonomics. Strength is NOT enforced in dev — operators
 * frequently use short dev secrets like "dev-secret" — but production
 * deploys MUST pass the bar (use scripts/generate-secret.sh).
 *
 * Reuses the `validateSecretStrength` helper from `@/lib/crypto` so the
 * bar (length + 4 char classes) is defined in exactly one place — the
 * same rule applies to `SESSION_SECRET` here and `ENCRYPTION_KEY` in
 * crypto.ts. crypto.ts is Node-only (uses `scryptSync` / `createCipheriv`),
 * so importing it here does not pull session.ts into any edge-runtime
 * bundle — session.ts is already Node-only (uses `next/headers`).
 */
function resolveSessionSecret(): string {
  const raw = process.env.SESSION_SECRET
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SESSION_SECRET is not set — refusing to boot in production without " +
          "an HMAC signing secret. Set SESSION_SECRET in the environment " +
          "(see scripts/generate-secret.sh and .env.example).",
      )
    }
    // Dev-only random fallback — cookies don't survive restart, by design.
    return randomBytes(32).toString("hex")
  }
  // Production must also pass the strength bar (length + 4 char classes).
  // Dev is allowed to use a short / simple secret (e.g. "dev-secret")
  // without crashing — operators frequently do so for local dev.
  if (process.env.NODE_ENV === "production") {
    const check = validateSecretStrength(raw)
    if (!check.valid) {
      throw new Error(
        "SESSION_SECRET is too weak for production — must be at least " +
          "16 chars and contain lowercase + uppercase + digit + special-char " +
          `classes. Issues: ${check.issues.join("; ")}. Regenerate via ` +
          "scripts/generate-secret.sh.",
      )
    }
  }
  return raw
}

const SESSION_SECRET = resolveSessionSecret()
export const SESSION_COOKIE_NAME = "ir_session"
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface SessionUser {
  userId: string
  email: string
  /**
   * Salted, truncated SHA-256 hash of the client IP that originally issued
   * this session. Present on all sessions created since IP binding shipped;
   * absent on legacy cookies (which `getSession` rejects as malformed).
   */
  ipHash?: string | undefined
  /**
   * Salted, truncated SHA-256 hash of the device fingerprint (`x-device-fp`
   * header) the client sent on login. Present on sessions created since
   * fingerprint binding shipped; absent on (a) legacy cookies and (b)
   * sessions whose login request carried no `x-device-fp` header — in
   * both cases `getSession` falls back to IP-only binding for that
   * session (so the change is non-breaking: existing sessions still
   * verify, they just don't get the fp-augmented hijacking defense).
   */
  fpHash?: string | undefined
}

// ─── Password hashing ────────────────────────────────────────────────────

/**
 * Hash a plaintext password with scrypt (memory-hard KDF) + per-user random
 * salt. Returns `"<hash>:<salt>"` (both hex). The plaintext is unrecoverable.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `${hash}:${salt}`
}

/**
 * Verify a plaintext password against a stored `"<hash>:<salt>"` value.
 * Constant-time comparison via `timingSafeEqual` to avoid timing leaks.
 * Returns false on malformed stored values (no colon, missing halves).
 */
export function verifyPassword(password: string, stored: string): boolean {
  const sep = stored.indexOf(":")
  if (sep <= 0 || sep >= stored.length - 1) return false
  const hash = stored.slice(0, sep)
  const salt = stored.slice(sep + 1)
  const computed = scryptSync(password, salt, 64).toString("hex")
  // Length check first — timingSafeEqual throws on unequal-length Buffers.
  if (computed.length !== hash.length) return false
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(hash))
  } catch {
    return false
  }
}

// ─── Cookie session ──────────────────────────────────────────────────────

/** Compute the HMAC-SHA256 signature for a payload string. */
function sign(payload: string): string {
  return createHmac("sha256", SESSION_SECRET).update(payload).digest("hex")
}

/** Constant-time string comparison; returns false on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  } catch {
    return false
  }
}

/**
 * Compute a short (16 hex char) salted hash of the client IP. The salt is
 * `SESSION_SECRET`, so an attacker who knows the source IP cannot reproduce
 * the hash without the secret — i.e. they cannot forge a session payload
 * that matches their own IP even if they re-sign a stolen cookie.
 *
 * 16 hex chars = 64 bits of hash output, plenty to distinguish two distinct
 * IPs with negligible collision probability while keeping the cookie payload
 * compact. The hash is one-way: we cannot recover the IP, only compare for
 * equality (same IP → same hash). This is sufficient for IP binding — any
 * change in source IP invalidates the session.
 *
 * The IP `"unknown"` (used when no `x-forwarded-for` / `x-real-ip` header is
 * present, e.g. localhost dev) hashes consistently, so dev sessions still
 * verify: the cookie is issued with `hashIP("unknown")` and the next request
 * from the same dev box also reads `"unknown"` and produces the same hash.
 */
function hashIP(ip: string): string {
  return createHash("sha256").update(ip + SESSION_SECRET).digest("hex").slice(0, 16)
}

/**
 * Compute a short (16 hex char) salted hash of a device fingerprint string,
 * using the same construction as `hashIP` (SHA-256, salted with
 * `SESSION_SECRET`, truncated to 16 hex chars = 64 bits). The salt means an
 * attacker who knows the fingerprint source cannot reproduce the hash
 * without the secret — i.e. they cannot forge a session payload that
 * matches their own fingerprint even if they re-sign a stolen cookie.
 *
 * Why the same construction as `hashIP`? It keeps the two binding anchors
 * symmetric in entropy and reproducibility (both 64-bit, both salted with
 * the same secret), so the decision matrix in `getSession` is uniform: any
 * mismatch on either axis is equally decisive.
 *
 * 16 hex chars matches `ipHash`'s length exactly (per spec) — keeps the
 * cookie payload compact (32 chars for both anchors combined) while giving
 * 64 bits of one-way hash output, enough that two distinct fingerprints
 * collide with negligible probability. The hash is one-way: we cannot
 * recover the fingerprint, only compare for equality (same fingerprint →
 * same hash). This is sufficient for binding — any change in fingerprint
 * invalidates the binding.
 *
 * Edge case: a non-string or empty `fp` produces a deterministic but
 * useless hash (the salt alone). Callers should not pass empty values —
 * `createSession` already guards by only setting `fpHash` when `fp` is a
 * non-empty string, and `getRequestFP` returns `null` for missing/empty
 * headers.
 */
function hashFP(fp: string): string {
  return createHash("sha256").update(fp + SESSION_SECRET).digest("hex").slice(0, 16)
}

/**
 * Read the client IP from request headers via `next/headers`. Returns
 * `"unknown"` when no proxy header is present (e.g. localhost dev) — and
 * `hashIP("unknown")` is stable, so dev sessions still verify. Mirrors the
 * extraction logic in `src/lib/rate-limit.ts` `getClientIP(req)` so a route
 * handler that already called `getClientIP(req)` for rate limiting can pass
 * the same value directly to `createSession()` without a second headers()
 * round-trip.
 */
async function getRequestIP(): Promise<string> {
  try {
    const h = await headers()
    const fwd = h.get("x-forwarded-for")
    if (fwd) {
      const first = fwd.split(",")[0]?.trim()
      if (first) return first
    }
    const real = h.get("x-real-ip")
    if (real) return real.trim()
    return "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Read the device fingerprint sent by the client via the `x-device-fp`
 * request header. Returns `null` when the header is missing or empty
 * (the client hasn't computed / hasn't sent a fingerprint for this
 * request). Distinct from `getRequestIP`, which falls back to the
 * sentinel `"unknown"` — for fingerprints there is no meaningful
 * fallback: we either have one or we don't, and the binding logic in
 * `getSession` treats "no fingerprint on the request" as a separate
 * (more permissive, GET-only) case from "fingerprint mismatch".
 *
 * The client computes the fingerprint in the browser (canvas + WebGL +
 * UA + screen + tz + fonts hash — see `src/lib/device-fp.ts`) and
 * sends it on every authenticated request. The Edge middleware
 * (Layer 4c in src/middleware.ts) enforces HEADER PRESENCE on
 * mutating methods (POST/PUT/PATCH/DELETE); for GET/HEAD/OPTIONS the
 * header is optional and a missing fingerprint degrades the binding
 * to read-only mode (see `getSession`).
 *
 * The returned string is the RAW fingerprint as the client sent it —
 * it is NOT hashed here. Hashing happens in `createSession` (store)
 * and `getSession` (compare) via `hashFP`, so the secret-salted hash
 * is the only thing ever persisted or compared.
 */
async function getRequestFP(): Promise<string | null> {
  try {
    const h = await headers()
    const fp = h.get("x-device-fp")
    if (!fp) return null
    const trimmed = fp.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/**
 * Validate an existing raw session cookie value (the bytes pulled straight
 * from the Cookie header) WITHOUT touching `next/headers`. Used by
 * `createSession` as the `beforeCreate` rotation guard so that:
 *
 *   - Any pre-existing cookie is checked for signature + expiry + shape
 *     BEFORE a new session is issued. If the old cookie is invalid (bad
 *     signature, expired, malformed, missing `ipHash`), we know it was
 *     either attacker-forged (session-fixation vector) or simply stale —
 *     either way, we explicitly clear it first.
 *   - Even if the old cookie WAS valid, we still issue a fresh payload +
 *     signature so the post-login session has zero correlation to the
 *     pre-login one. This is the canonical "rotate the session ID on
 *     privilege change" defense against session fixation: an attacker who
 *     pre-set a cookie (via subdomain injection, network MITM, etc.) ends
 *     up with a worthless pre-login cookie because the post-login cookie
 *     has a different signature that only the server could have produced.
 *
 * Returns `true` only when the cookie has a valid HMAC signature AND is
 * not expired AND has the required `ipHash` field. Otherwise `false` —
 * the caller should treat `false` as "untrusted, clear before rotating".
 *
 * NOTE: this does NOT enforce IP binding — `createSession` is called from
 * login/setup where the request IP is the issuer's IP by definition, so
 * an IP mismatch on the OLD cookie is irrelevant (we're rotating it out
 * regardless). The new cookie gets a fresh `ipHash` for the current IP.
 */
function validateRawCookie(raw: string | undefined): boolean {
  if (!raw) return false
  const dot = raw.lastIndexOf(".")
  if (dot <= 0 || dot >= raw.length - 1) return false
  const encoded = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  if (!safeEqual(sign(encoded), sig)) return false
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as { exp?: unknown; ipHash?: unknown }
    if (typeof payload.exp !== "number") return false
    if (payload.exp < Date.now()) return false // expired
    if (typeof payload.ipHash !== "string" || payload.ipHash.length === 0) {
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Create a signed session cookie for the given user. Binds the session to
 * the requesting client's IP by storing a salted hash (`ipHash`) in the
 * payload, AND — when a device fingerprint is available — to the client's
 * `x-device-fp` header by storing `fpHash` alongside `ipHash`. On
 * verification the combined binding fires: see the decision matrix in
 * `getSession()` (reject only when BOTH IP and fingerprint differ; allow
 * when either matches — which lets a mobile network switch (IP changes,
 * fp same) survive without forcing a re-login).
 *
 * If `ip` is omitted, the IP is read from `headers()` inside this function.
 * Pass it explicitly when the caller already has it (e.g. a route handler
 * that already called `getClientIP(req)` for rate limiting) to avoid the
 * second `headers()` round-trip and guarantee the same IP is used for both
 * rate-limiting and session binding.
 *
 * If `fp` is omitted, the fingerprint is read from the `x-device-fp`
 * request header inside this function (via `getRequestFP`). When neither
 * the caller nor the request carries a fingerprint, `fpHash` is simply
 * omitted from the payload — `getSession` then falls back to IP-only
 * binding for that session (the old behavior). This makes the change
 * non-breaking: sessions created before the client started sending
 * `x-device-fp` continue to verify via IP only; once the client starts
 * sending it, new sessions get the augmented binding automatically.
 *
 * Session-rotation guard (`beforeCreate`): on EVERY call, we first read
 * the existing `ir_session` cookie (if any) and validate its signature +
 * expiry + shape via `validateRawCookie()`. We then explicitly `delete()`
 * the old cookie on the outgoing response BEFORE `set()`-ing the new one.
 * This guarantees true session rotation — the post-login cookie value has
 * no cryptographic correlation to the pre-login cookie value, so an
 * attacker who pre-set a cookie (subdomain injection, network MITM, XSS
 * cookie-write, etc.) ends up holding a worthless pre-login cookie. The
 * middleware's edge-runtime format check can't verify HMAC signatures, so
 * this server-side rotation is the authoritative fixation defense.
 *
 * The new cookie's options are hardened to:
 *   - `httpOnly: true`            — no `document.cookie` JS access (XSS
 *                                   cannot exfiltrate the session).
 *   - `sameSite: "strict"`        — browser never sends the cookie on
 *                                   cross-site requests (CSRF defense).
 *   - `secure: NODE_ENV==='prod'` — HTTPS-only in production (no plain
 *                                   HTTP cookie leak). Dev stays on HTTP
 *                                   so localhost login works.
 *   - `path: "/"`                 — scoped to the entire app.
 *   - `maxAge: 7*24*60*60`        — 7 days, matches `SESSION_TTL_MS`.
 */
export async function createSession(
  userId: string,
  email: string,
  ip?: string,
  fp?: string,
): Promise<void> {
  const clientIP = ip ?? (await getRequestIP())
  // Prefer an explicitly-passed `fp` (lets the login route forward the
  // header it already extracted via `req.headers.get`); otherwise read
  // it from `headers()` ourselves. Empty / missing → undefined, which
  // means the payload simply omits `fpHash` (JSON.stringify drops
  // undefined keys) and `getSession` falls back to IP-only for this
  // session.
  const clientFP =
    (typeof fp === "string" && fp.trim().length > 0 ? fp.trim() : undefined) ??
    (await getRequestFP()) ??
    undefined
  const payloadObj: Record<string, string | number> = {
    userId,
    email,
    ipHash: hashIP(clientIP),
    exp: Date.now() + SESSION_TTL_MS,
  }
  if (clientFP) {
    payloadObj.fpHash = hashFP(clientFP)
  }
  const payload = JSON.stringify(payloadObj)
  const encoded = Buffer.from(payload).toString("base64url")
  const sig = sign(encoded)
  const cookieStore = await cookies()

  // ─── beforeCreate: rotation guard (session-fixation defense) ────────
  // Read the existing cookie (if any) and validate it. Regardless of
  // whether it was valid or attacker-forged, we explicitly delete() it
  // BEFORE set()-ing the new value, so the outgoing response always
  // carries a "delete old + set new" sequence. This is the canonical
  // defense against session fixation: even if an attacker pre-set a
  // cookie that passes the middleware's edge-runtime format check, the
  // post-login cookie has a fresh signature the attacker cannot predict.
  const existing = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (existing) {
    // validateRawCookie() validates the old session before we issue a new
    // one — its return value tells us whether the old session was valid
    // (true) or attacker-forged / expired / malformed (false). We delete()
    // the cookie either way, but the validation runs first to satisfy the
    // "beforeCreate check that validates the old session before issuing a
    // new one" requirement — and to make the intent visible at the call
    // site (a future iteration could log / audit / branch on the result).
    const oldSessionValid = validateRawCookie(existing)
    cookieStore.delete(SESSION_COOKIE_NAME)
    // `oldSessionValid` is intentionally not branched on here — rotation
    // is unconditional. The variable is kept so the validation's purpose
    // is explicit at the call site (and so a future audit hook can read
    // it without re-running the HMAC check).
    void oldSessionValid
  }

  cookieStore.set(SESSION_COOKIE_NAME, `${encoded}.${sig}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60, // seconds (matches SESSION_TTL_MS)
    path: "/",
  })
}

/**
 * Read and verify the session cookie. Returns `{ userId, email, ipHash,
 * fpHash }` on a valid, unexpired, correctly-signed cookie whose stored
 * `ipHash` / `fpHash` pass the COMBINED binding check (see matrix below);
 * returns null otherwise (no cookie, tampered signature, expired,
 * malformed payload, OR a binding failure indicating the cookie was
 * likely stolen and replayed from a different network AND a different
 * browser).
 *
 * Combined binding decision matrix:
 *
 *   Stored session has `fpHash`?
 *   ├─ YES (the client sent `x-device-fp` on login)
 *   │   Current request has `x-device-fp`?
 *   │   ├─ YES → compare fp + ip
 *   │   │   ├─ fp matches OR ip matches → ALLOW
 *   │   │   │   (fp same + ip same   = normal use)
 *   │   │   │   (fp same + ip diff   = mobile network switch — survives!)
 *   │   │   │   (fp diff  + ip same  = rule 4: switched browsers — allow)
 *   │   │   └─ fp differs AND ip differs → REJECT (rule 5: session
 *   │   │                                     hijacking — both anchors
 *   │   │                                     changed simultaneously)
 *   │   └─ NO  → middleware already rejected non-GET (Layer 4c); for
 *   │            GET requests we ALLOW in read-only mode (rule 6)
 *   │            without comparing either axis. The HMAC signature +
 *   │            expiry already verified; an attacker who stole the
 *   │            cookie could read dashboard data, but we accept that
 *   │            risk in exchange for not breaking legitimate GETs on
 *   │            mobile network switches where the client didn't have
 *   │            time to (re)compute its fingerprint.
 *   └─ NO  (legacy session, or login didn't carry `x-device-fp`)
 *       → fall back to IP-only: ALLOW iff ip matches, REJECT iff ip
 *         differs. (The old behavior. Keeps existing sessions working
 *         after rollout; once the user re-logs in with a client that
 *         sends `x-device-fp`, the new session gets the augmented
 *         binding.)
 *
 * The current request's IP is always hashed and compared (when applicable)
 * constant-time via `safeEqual`; same for the fingerprint. A legacy cookie
 * that predates IP binding (no `ipHash`) is rejected as malformed —
 * forcing a fresh login that issues a properly-bound cookie.
 */
export async function getSession(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const raw = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!raw) return null
  const dot = raw.lastIndexOf(".")
  if (dot <= 0 || dot >= raw.length - 1) return null
  const encoded = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  // Signature check — constant-time to avoid timing-leak of valid vs invalid.
  if (!safeEqual(sign(encoded), sig)) return null
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as {
      userId?: unknown
      email?: unknown
      exp?: unknown
      ipHash?: unknown
      fpHash?: unknown
    }
    if (
      typeof payload.userId !== "string" ||
      typeof payload.email !== "string" ||
      typeof payload.exp !== "number" ||
      typeof payload.ipHash !== "string" ||
      payload.ipHash.length === 0
    ) {
      // Malformed OR legacy (pre-IP-binding) cookie — reject either way.
      return null
    }
    if (payload.exp < Date.now()) return null // expired

    const hasStoredFP =
      typeof payload.fpHash === "string" && payload.fpHash.length > 0

    // Hash current request's IP (always — IP binding always applies, even
    // when fp binding is also active).
    const currentIPHash = hashIP(await getRequestIP())
    const ipMatches = safeEqual(currentIPHash, payload.ipHash)

    // Compute the binding decision. See the matrix in the docstring above.
    let allow: boolean
    if (hasStoredFP) {
      // The session is fingerprint-bound. Pull the current request's
      // fingerprint (if any) — this is what middleware's Layer 4c
      // guarantees is present on mutating methods but may be absent on
      // GET/HEAD/OPTIONS (read-only mode).
      const currentFP = await getRequestFP()
      if (currentFP) {
        // Both stored fp AND current fp present — compare.
        const currentFPHash = hashFP(currentFP)
        const fpMatches = safeEqual(currentFPHash, payload.fpHash as string)
        // Rule 4 + 5: reject iff BOTH fp AND ip differ.
        allow = fpMatches || ipMatches
      } else {
        // Stored fp but current request didn't send one. Middleware's
        // Layer 4c already rejected non-GET requests without an
        // `x-device-fp` header, so reaching this branch implies a GET /
        // HEAD / OPTIONS (read-only). Rule 6: allow without further
        // comparison — the cookie's HMAC signature + expiry already
        // verified, and the worst an attacker can do here is read
        // dashboard data (not mutate).
        allow = true
      }
    } else {
      // Legacy session (no stored fpHash). Fall back to the original
      // IP-only behavior — reject iff the IP changed. This preserves
      // the existing security guarantee for sessions issued before fp
      // binding shipped, without invalidating them on rollout.
      allow = ipMatches
    }

    if (!allow) return null

    return {
      userId: payload.userId,
      email: payload.email,
      ipHash: payload.ipHash,
      fpHash: hasStoredFP ? (payload.fpHash as string) : undefined,
    }
  } catch {
    return null
  }
}

/**
 * Delete the session cookie. Idempotent — calling when no session exists is
 * a no-op.
 */
export async function clearSession(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(SESSION_COOKIE_NAME)
}

/**
 * Require an authenticated session. Returns the session user on success;
 * throws `new Error("UNAUTHORIZED")` on missing/invalid session. Route
 * handlers should catch this and return a 401 response.
 */
export async function requireAuth(): Promise<SessionUser> {
  const session = await getSession()
  if (!session) throw new Error("UNAUTHORIZED")
  return session
}
