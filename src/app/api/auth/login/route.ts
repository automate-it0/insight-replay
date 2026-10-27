import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import {
  createSession,
  verifyPassword,
} from "@/lib/session"
import { rateLimit, getClientIP } from "@/lib/rate-limit"
import {
  isLocked,
  recordFailedAttempt,
  clearAttempts,
  getLockoutKey,
} from "@/lib/login-lockout"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { decryptField } from "@/lib/db-encryption"
import {
  generatePoWChallenge,
  consumePoWChallenge,
  verifyPoW,
} from "@/lib/pow"

// POST /api/auth/login
//
// Verifies email + password against the User table, then creates a signed
// session cookie (see src/lib/session.ts). Returns 200 + the public user
// profile on success, 401 on bad credentials, 429 if the per-IP login rate
// limit (5/min) is exceeded OR if the email+IP pair has been locked out
// after 5 consecutive failed attempts (15-minute cool-down, see
// src/lib/login-lockout.ts). 403 if the Proof-of-Work header is missing or
// invalid (see below).
//
// Rate limiting is applied INSIDE the handler (not middleware) because the
// middleware's auth-cookie check would short-circuit unauthenticated requests
// before they ever reached the rate-limit logic — and login IS the
// unauthenticated endpoint we most want to protect from brute force.
//
// The lockout layer complements the rate limit: the rate limit caps
// *throughput* per IP (5 req/min), while the lockout caps *accumulated
// failures* per email+IP (5 fails → 15min). Together they make brute force
// impractical even across many minutes / IPs.
//
// Proof of Work (PoW) layer: every login POST MUST carry an `x-pow-challenge`
// + `x-pow-nonce` header pair whose SHA-256 hash starts with `difficulty`
// zero hex chars. The challenge is single-use (issued by GET /api/auth/login/pow
// or piggy-backed on GET /api/csrf-token, stored in cache 60s — see
// src/lib/pow.ts). This adds a per-request computational cost (~100ms on a
// modern CPU) on top of the rate-limit + lockout layers, so an attacker
// rotating IPs must also dedicate real CPU to each guess. If the PoW is
// missing/invalid/expired/reused, the request is rejected with 403 + a fresh
// challenge so the client can retry transparently.
//
// Header names (kept lowercase per HTTP / Web Fetch conventions):
//   - x-pow-challenge: the 32-char hex challenge string issued by the server.
//   - x-pow-nonce:     the nonce the client found that satisfies the PoW.

// Header names exported as constants so the client (login-form.tsx) and any
// future integration tests can reference them without hardcoding strings.
export const POW_CHALLENGE_HEADER = "x-pow-challenge"
export const POW_NONCE_HEADER = "x-pow-nonce"

// 5 login attempts per minute per IP — tight enough to make brute force
// impractical on a 7-day session, loose enough that a forgetful admin typing
// their password wrong 3-4 times won't get locked out.
const LOGIN_LIMIT = { max: 5, windowMs: 60_000 }

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req as unknown as Request)
  try {
    // 1. Per-IP rate limit. 429 returns the standard Retry-After header so
    //    automated clients back off instead of hammering the endpoint.
    const ip = getClientIP(req as unknown as Request)
    const rl = rateLimit(ip, LOGIN_LIMIT)
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many login attempts. Try again in a minute." },
        { status: 429, headers: { "Retry-After": "60" } },
      )
    }

    // 2. Proof of Work. The client must send `x-pow-challenge` (issued by
    //    GET /api/auth/login/pow or piggy-backed on GET /api/csrf-token) and
    //    `x-pow-nonce` (a value the client found such that
    //    SHA-256(challenge + nonce) starts with `difficulty` zero hex chars).
    //
    //    We CONSUME the challenge (single-use) BEFORE verifying the hash, so
    //    a duplicate submission racing in the same tick fails — this enforces
    //    the per-attempt cost even when the same challenge is replayed.
    //
    //    PoW is checked BEFORE body parsing / lockout because:
    //      - It doesn't depend on the body.
    //      - It rejects unauthenticated brute-force at the cheapest possible
    //        point (one cache lookup + one SHA-256), before we touch the DB
    //        or even parse JSON.
    //      - A PoW failure must NOT increment the per-email lockout counter
    //        (we don't have an email yet, and a PoW failure isn't a credential
    //        guess — it's "this client didn't even solve the puzzle").
    //
    //    On PoW failure we return 403 + a fresh challenge in the body so the
    //    client can solve + retry transparently (login-form.tsx does this
    //    automatically, up to one retry per submit).
    const powChallengeHeader = req.headers.get(POW_CHALLENGE_HEADER)
    const powNonceHeader = req.headers.get(POW_NONCE_HEADER)
    const consumed = powChallengeHeader
      ? consumePoWChallenge(powChallengeHeader)
      : { valid: false as const }
    let powOk = false
    if (consumed.valid) {
      // The challenge was issued by us + not yet consumed. Now verify the
      // client's nonce actually satisfies the difficulty stored at issuance.
      powOk =
        !!powNonceHeader &&
        verifyPoW(powChallengeHeader!, powNonceHeader, consumed.difficulty)
    }
    if (!powOk) {
      // Issue a fresh challenge for the client's retry. We do this on every
      // 403 so the client always has a usable challenge in the response — no
      // extra round-trip required.
      const fresh = generatePoWChallenge()
      return NextResponse.json(
        {
          ok: false,
          error: "Proof of work required",
          // Fresh challenge so the client can solve + retry without an
          // extra GET /api/auth/login/pow round-trip.
          pow: {
            challenge: fresh.challenge,
            difficulty: fresh.difficulty,
            timestamp: fresh.timestamp,
          },
        },
        { status: 403 },
      )
    }

    // 3. Parse + validate the request body.
    const body = (await req.json().catch(() => null)) as {
      email?: unknown
      password?: unknown
    } | null
    if (!body) {
      return NextResponse.json(
        { ok: false, error: "Invalid request body" },
        { status: 400 },
      )
    }
    const email = typeof body.email === "string" ? body.email.trim() : ""
    const password = typeof body.password === "string" ? body.password : ""
    if (!email || !password) {
      return NextResponse.json(
        { ok: false, error: "Email and password are required" },
        { status: 400 },
      )
    }

    // 4. Persistent failed-attempt lockout. Keyed on email+IP so a single
    //    attacker IP brute-forcing multiple targets gets locked per-target,
    //    while a legitimate user on a shared NAT is only affected by their
    //    own failures against their own email. Checked AFTER body parsing
    //    (we need the email) but BEFORE the DB lookup so a locked-out
    //    request doesn't even hit the database. The response is identical
    //    regardless of whether the lock was triggered by this IP+email or a
    //    different one — same 429 shape as the rate-limit branch above.
    const lockoutKey = getLockoutKey(email, ip)
    const lockout = isLocked(lockoutKey)
    if (lockout.locked) {
      return NextResponse.json(
        {
          ok: false,
          error: `Account locked. Try again in ${lockout.retryAfterSec}s.`,
        },
        {
          status: 429,
          headers: { "Retry-After": String(lockout.retryAfterSec) },
        },
      )
    }

    // 5. Look up the user. We do NOT distinguish "no such user" from "wrong
    //    password" in the response — both return the same 401 message to
    //    avoid user enumeration. We still run verifyPassword against a dummy
    //    hash when the user is missing to keep the response time roughly
    //    constant (mitigates timing-based user enumeration).
    //
    //    Encryption-at-rest: the `email` column is now an AES-256-GCM
    //    ciphertext (`iv:ciphertext:authTag`), and a fresh random IV is used
    //    on every write — so the same plaintext email produces a DIFFERENT
    //    ciphertext each time, which means a direct `findUnique({ where: { email } })`
    //    cannot match. Instead we fetch all users (the system is single-admin
    //    by design — `findMany` returns 1 row in steady state, O(1) effectively)
    //    and run a decrypt-then-compare loop. The timing of the loop is
    //    dominated by the scrypt `verifyPassword` call below, so user-presence
    //    is not leaked by the lookup itself; the existing DUMMY_HASH branch
    //    still flattens the password-verify timing for the no-user case.
    const allUsers = await db.user.findMany({
      select: {
        id: true,
        email: true,
        passwordHash: true,
        name: true,
        role: true,
      },
    })
    const user = allUsers.find((u) => decryptField(u.email) === email) || null
    const DUMMY_HASH =
      "0000000000000000000000000000000000000000000000000000000000000000:00000000000000000000000000000000"
    // Decrypt the stored passwordHash BEFORE verifyPassword. If the row's
    // passwordHash is tampered or was encrypted under a different key,
    // decryptField returns "" and verifyPassword returns false (no ":" in "")
    // — which is exactly the behavior we want for a corrupt/tampered row.
    const storedHash = user ? decryptField(user.passwordHash) : DUMMY_HASH
    const ok = user
      ? verifyPassword(password, storedHash)
      : verifyPassword(password, DUMMY_HASH)

    if (!user || !ok) {
      // Record the failure against the lockout counter. If this attempt
      // tipped the counter past MAX_FAILURES, the response is upgraded from
      // 401 to 429 with a Retry-After — the message still doesn't reveal
      // whether the email exists (the 401 path and the rate-limit / lockout
      // path both fire for non-existent emails too, since we don't know
      // which until after the DB lookup, and the lockout key is built from
      // the *submitted* email regardless of whether the row exists).
      const after = recordFailedAttempt(lockoutKey)
      if (after.locked) {
        return NextResponse.json(
          {
            ok: false,
            error: `Too many failed attempts. Account locked. Try again in ${after.retryAfterSec}s.`,
          },
          {
            status: 429,
            headers: { "Retry-After": String(after.retryAfterSec) },
          },
        )
      }
      // Attach a fresh PoW challenge to the 401 body so the client doesn't
      // need a separate GET round-trip before its next attempt — the
      // challenge it solved for THIS request was already consumed (single-
      // use), so the client MUST mint + solve a new one for the retry.
      const fresh401 = generatePoWChallenge()
      return NextResponse.json(
        {
          ok: false,
          error: "Invalid credentials",
          pow: {
            challenge: fresh401.challenge,
            difficulty: fresh401.difficulty,
            timestamp: fresh401.timestamp,
          },
        },
        { status: 401 },
      )
    }

    // 6. Successful login — wipe the failure counter so a forgetful user who
    //    failed 4 times and then succeeded doesn't carry a half-full counter
    //    forward (which would lock them after just 1 more typo next time).
    clearAttempts(lockoutKey)

    // 7. Create the signed session cookie. Pass the client IP so the
    //    session payload is bound to this network — a stolen cookie
    //    replayed from a different IP will fail verification in
    //    `getSession()` (see src/lib/session.ts `hashIP` / `ipHash`).
    //    Use the local plaintext `email` (NOT `user.email`, which is the
    //    encrypted ciphertext stored in the DB) so the cookie payload
    //    carries a human-readable email for the dashboard UI.
    //
    //    Also pass the client device fingerprint (`x-device-fp` header)
    //    when present — `getSession()` uses the COMBINED binding to
    //    distinguish "mobile network switch" (IP changed but fingerprint
    //    same → allow, the whole point of fp binding) from "session
    //    hijacking" (both IP and fingerprint changed → reject). If the
    //    client didn't send the header, `fpHash` is omitted from the
    //    payload and the session falls back to IP-only binding for this
    //    session — non-breaking for clients that haven't yet been updated
    //    to send the fingerprint.
    const clientFP = req.headers.get("x-device-fp")?.trim() || undefined
    await createSession(user.id, email, ip, clientFP)

    // 8. Return the public profile. The passwordHash is intentionally absent;
    //    the email is the decrypted plaintext (NOT the DB-stored ciphertext)
    //    so the dashboard UI can render it.
    return NextResponse.json({
      ok: true,
      user: { id: user.id, email, name: user.name, role: user.role },
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "auth_login")
    return NextResponse.json(body, { status })
  }
}
