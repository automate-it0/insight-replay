import { NextResponse } from "next/server"
import { generateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@/lib/csrf"
import { generatePoWChallenge, POW_TTL_MS } from "@/lib/pow"

/**
 * GET /api/csrf-token
 *
 * Returns a fresh CSRF token and sets it as a `SameSite=strict` cookie. The
 * frontend calls this once on app load (and again whenever a mutating
 * request fails with 403 because the cookie expired) so it can echo the
 * token in the `x-csrf-token` header on every POST/PUT/PATCH/DELETE.
 *
 * Also returns a Proof-of-Work challenge (`pow: { challenge, difficulty,
 * expiresIn }`) piggy-backed on the response so the login form can skip the
 * extra round-trip to GET /api/auth/login/pow. The challenge is single-use,
 * 60s TTL — see src/lib/pow.ts. Clients that don't need it (already-authed
 * dashboard refreshes) just ignore the field.
 *
 * Cookie attributes:
 *   - httpOnly: false  — the browser JS MUST be able to read the cookie to
 *                        echo it in the header. The security does NOT come
 *                        from hiding the token from JS (an XSS already wins
 *                        by reading both the cookie and the page DOM); it
 *                        comes from `SameSite=strict`, which prevents a
 *                        cross-site attacker from causing the victim's
 *                        browser to attach the cookie in the first place.
 *   - sameSite: strict — the browser will NOT send this cookie on any
 *                        cross-site request, including top-level navigations
 *                        from an external link. This is the CSRF defense.
 *   - secure: true in production — cookie only sent over HTTPS.
 *   - maxAge: 1 hour   — short-lived; the frontend re-fetches as needed.
 *   - path: "/"        — visible to all routes.
 *
 * Double-submit pattern: the cookie value and the response-body `token`
 * value are identical. The middleware validates that the header token (which
 * the frontend reads from the cookie) equals the cookie token on every
 * mutating request. An attacker cannot forge this because they can't read
 * the victim's same-origin cookie and SameSite prevents them from causing
 * the browser to send it on a cross-site POST.
 */
export async function GET() {
  const token = generateCsrfToken()

  // Mint a PoW challenge alongside the CSRF token. This is a courtesy for the
  // login form (which always needs both a CSRF-exempt POST endpoint AND a PoW
  // challenge before submitting). Piggy-backing saves a round-trip on the
  // login page. The challenge is cached server-side (single-use, 60s TTL).
  // Already-authenticated page loads that don't submit login also pay the
  // (negligible) cost of minting + caching one challenge, which simply expires
  // unused — no harm done.
  const pow = generatePoWChallenge()

  const res = NextResponse.json({
    token,
    header: CSRF_HEADER_NAME,
    cookie: CSRF_COOKIE_NAME,
    pow: {
      challenge: pow.challenge,
      difficulty: pow.difficulty,
      timestamp: pow.timestamp,
      expiresIn: Math.floor(POW_TTL_MS / 1000),
    },
  })

  res.cookies.set(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // JS must read this to send it in the header
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 60 * 60, // 1 hour
    path: "/",
  })

  return res
}
