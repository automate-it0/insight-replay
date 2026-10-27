import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"

// GET — check if session is bookmarked
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "session_bookmark_read", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const bookmark = await db.bookmark.findUnique({ where: { sessionId: sid } })
    return NextResponse.json({ bookmarked: !!bookmark, bookmark })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "session_bookmark_get")
    return NextResponse.json(body, { status })
  }
}

// POST — toggle bookmark (delete if exists, otherwise create). Mutating:
// requires a valid API key in production. Open in dev for dashboard testing.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "session_bookmark_toggle")
  if (guard.error) return guard.error
  void guard.session
  try {
    // Race-safety: the original toggle (findUnique → delete | create) had
    // a classic TOCTOU race — two concurrent POSTs could both see
    // `existing === null`, both call `db.bookmark.create`, and the second
    // would throw P2002 (Bookmark has @@unique([sessionId])) → 500 to the
    // client, with an inconsistent state (the caller's intent was "toggle
    // ON" but they got an error response even though the bookmark WAS
    // created by the other request).
    //
    // Fix: wrap the find+delete-or-create in a transaction so the
    // @@unique constraint is enforced atomically against our create; on
    // P2002 we treat the bookmark as already-present (the concurrent
    // caller won the create) and return `bookmarked: true` so the
    // client's UI reflects the actual state rather than an error.
    const result = await db.$transaction(async (tx) => {
      const existing = await tx.bookmark.findUnique({ where: { sessionId: sid } })
      if (existing) {
        await tx.bookmark.delete({ where: { id: existing.id } })
        return { bookmarked: false, bookmark: null }
      }
      try {
        const created = await tx.bookmark.create({ data: { sessionId: sid, projectId: id } })
        return { bookmarked: true, bookmark: created }
      } catch (e) {
        // P2002 = unique-constraint violation. A concurrent POST created
        // the bookmark between our findUnique and our create. Treat it as
        // "already bookmarked" — the caller's intent (toggle ON) is
        // satisfied; a subsequent POST will toggle it OFF.
        const code = (e as { code?: string })?.code
        if (code === "P2002") return { bookmarked: true, bookmark: null }
        throw e
      }
    })

    return NextResponse.json(result)
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "session_bookmark_toggle")
    return NextResponse.json(body, { status })
  }
}
