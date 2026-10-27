import { NextResponse } from "next/server"
import { getSession } from "@/lib/session"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { decryptField } from "@/lib/db-encryption"

// GET /api/auth/me
//
// Returns the currently-logged-in user's public profile, or 401 if no
// session (or the session is invalid/expired). The frontend uses this on
// dashboard mount to decide whether to redirect to /login.
//
// Why fetch the user from the DB instead of trusting the cookie payload?
//   - The cookie only carries `{ userId, email }`. If the user was deleted
//     or the email changed, the DB is the source of truth.
//   - The role/name fields can change over time; we don't want stale data
//     in the dashboard UI for up to 7 days.

export async function GET(req: Request) {
  const requestId = getRequestId(req)
  try {
    const session = await getSession()
    if (!session) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      )
    }

    const user = await db.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, name: true, role: true },
    })

    // User was deleted after the session was issued — treat as logged out.
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      )
    }

    // Encryption-at-rest: the DB stores `email` as an AES-256-GCM
    // ciphertext (`iv:ciphertext:authTag`) — decrypt it here before
    // returning the profile to the dashboard. A failed decrypt (tampered
    // row, key rotation, etc.) yields "", which surfaces to the UI as an
    // empty email — degraded but not broken (the user is still logged in
    // via the session cookie's `email` field).
    return NextResponse.json({
      ok: true,
      user: { ...user, email: decryptField(user.email) },
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "auth_me")
    return NextResponse.json(body, { status })
  }
}
