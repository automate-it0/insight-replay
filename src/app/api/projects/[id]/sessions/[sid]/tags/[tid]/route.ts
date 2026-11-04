import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"

// DELETE — remove a tag. Destructive: requires a valid API key in production.
// Open in dev for dashboard testing.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; sid: string; tid: string }> }) {
  const { id, sid, tid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "session_tag_delete")
  if (guard.error) return guard.error
  void guard.session
  try {
    // Scoped delete (BOLA guard): the tag must belong to this session AND
    // this project — a global id lookup would let a project-A key delete
    // any project's tag by id. deleteMany also avoids the P2025 → 500 on
    // unknown ids (count 0 → clean 404).
    const deleted = await db.tag.deleteMany({
      where: { id: tid, sessionId: sid, session: { projectId: id } },
    })
    if (deleted.count === 0) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "session_tag_delete")
    return NextResponse.json(body, { status })
  }
}
