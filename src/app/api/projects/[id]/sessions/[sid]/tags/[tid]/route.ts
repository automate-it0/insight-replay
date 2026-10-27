import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"

// DELETE — remove a tag. Destructive: requires a valid API key in production.
// Open in dev for dashboard testing.
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; sid: string; tid: string }> }) {
  const { id, tid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "session_tag_delete")
  if (guard.error) return guard.error
  void guard.session
  try {
    await db.tag.delete({ where: { id: tid } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "session_tag_delete")
    return NextResponse.json(body, { status })
  }
}
