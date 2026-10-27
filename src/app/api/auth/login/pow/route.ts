import { NextRequest, NextResponse } from "next/server"
import { rateLimit, getClientIP } from "@/lib/rate-limit"
import { generatePoWChallenge, POW_TTL_MS } from "@/lib/pow"
import { getRequestId, sanitizeError } from "@/lib/observability"

// GET /api/auth/login/pow
//
// Returns a fresh Proof-of-Work challenge the client must solve before
// POSTing /api/auth/login. The challenge is stored in the in-memory cache
// (single-use, 60s TTL) — see src/lib/pow.ts.
//
// Why a dedicated endpoint (vs only piggy-backing on /api/csrf-token)?
//   - The CSRF token endpoint is hit on every app load (the dashboard needs
//     the CSRF cookie for all subsequent mutating requests). Tying PoW
//     issuance to it would mint a fresh challenge on every page load, even
//     when the user never logs in (e.g. already-authenticated refreshes).
//     A dedicated endpoint lets the login form mint a challenge on-demand
//     only when the user is about to submit.
//   - It also keeps the challenge lifecycle self-contained: the login form
//     mints → solves → submits, all from one place.
//
// The CSRF token endpoint ALSO serves a challenge (see
// /api/csrf-token/route.ts) so a client that already fetched the CSRF token
// can skip the extra round-trip and reuse the piggy-backed challenge.
//
// Rate limit: 30/min per IP. Generous (a forgetful user retrying login many
// times minting a fresh challenge each attempt won't hit it), tight enough
// that an attacker can't mint millions of challenges to bloat the cache.
// The cache layer itself is already size-bounded (see src/lib/cache.ts →
// boundMapSize), so this rate limit is defense-in-depth, not the primary
// bound.
const POW_MINT_LIMIT = { max: 30, windowMs: 60_000 }

export async function GET(req: NextRequest) {
  const requestId = getRequestId(req as unknown as Request)
  try {
    // 1. Per-IP rate limit on challenge minting.
    const ip = getClientIP(req as unknown as Request)
    const rl = rateLimit(ip, POW_MINT_LIMIT)
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many challenge requests. Try again in a minute." },
        { status: 429, headers: { "Retry-After": "60" } },
      )
    }

    // 2. Mint + cache a fresh challenge.
    const challenge = generatePoWChallenge()

    // 3. Return the public challenge info. The client reads `difficulty` to
    //    know how many leading zero hex chars to target; `expiresIn` lets the
    //    client abort a long solve if it's about to time out (a 60s TTL is
    //    plenty for a ~100ms solve, but the client may want to log staleness).
    return NextResponse.json({
      ok: true,
      challenge: challenge.challenge,
      difficulty: challenge.difficulty,
      timestamp: challenge.timestamp,
      expiresIn: Math.floor(POW_TTL_MS / 1000),
    })
  } catch (e) {
    // Same error-sanitization contract as the login route.
    const { status, body } = sanitizeError(e, requestId, "auth_login_pow")
    return NextResponse.json(body, { status })
  }
}
