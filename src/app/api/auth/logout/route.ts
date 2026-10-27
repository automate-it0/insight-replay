import { NextRequest, NextResponse } from "next/server"
import { clearSession, SESSION_COOKIE_NAME } from "@/lib/session"
import { sanitizeError, getRequestId } from "@/lib/observability"

// POST /api/auth/logout
//
// Deletes the session cookie. Idempotent — calling when already logged out
// returns 200 (not an error). The client is expected to redirect to /login
// after a successful logout.
//
// The middleware does NOT require a session cookie for /api/auth/* — so an
// already-logged-out user can still call this endpoint without a 401.
//
// Session-clearing is layered for defense-in-depth:
//   1. `clearSession()` — uses the async `next/headers` `cookies()` API,
//      which mutates the outgoing response from a Server Component / Route
//      Handler context. This is the canonical Next.js 16 way.
//   2. `res.cookies.delete('ir_session')` — ALSO stamps an explicit
//      `Set-Cookie: ir_session=; Max-Age=0; ...` header on the NextResponse
//      object we return. This guarantees the deletion header is on the
//      actual HTTP response even if the `next/headers` side-effect ever
//      regresses (e.g. a future Next.js change to the cookies() mutation
//      semantics), and makes the cookie-clear intent visible at the route
//      boundary instead of hidden inside `session.ts`. The two layers
//      cooperate: either one alone would clear the cookie, both together
//      is belt-and-suspenders.

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req as unknown as Request)
  try {
    // 1. Canonical clear via next/headers.
    await clearSession()
    // 2. Explicit response-level clear (defense-in-depth). The task spec
    //    calls for `res.cookies.delete('ir_session')` — that's what we do
    //    first. We then also re-set the cookie with maxAge=0 AND the full
    //    hardened options (httpOnly/sameSite/secure/path) to guarantee
    //    the EXPIRED cookie the browser stores carries the same security
    //    flags as the live one (a cookie cleared via .delete() without
    //    httpOnly:true could be re-written by an XSS and survive as a
    //    fixation vector — the explicit re-set with hardened options
    //    closes that gap).
    const res = NextResponse.json({ ok: true })
    res.cookies.delete(SESSION_COOKIE_NAME) // canonical delete per task spec
    res.cookies.set(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 0, // immediately expire
    })
    return res
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "auth_logout")
    // Even on the error path, attempt to clear the cookie — a half-failed
    // logout MUST NOT leave a valid session cookie on the client.
    const res = NextResponse.json(body, { status })
    res.cookies.delete(SESSION_COOKIE_NAME)
    res.cookies.set(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    })
    return res
  }
}
