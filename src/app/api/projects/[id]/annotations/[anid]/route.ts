import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"

/**
 * DELETE — remove an annotation. Destructive: requires a valid API key in
 * production. Open in dev for dashboard testing.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; anid: string }> }) {
  const { id, anid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "annotation_delete")
  if (guard.error) return guard.error
  void guard.session
  try {
    await db.annotation.deleteMany({ where: { id: anid, projectId: id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "annotation_delete")
    return NextResponse.json(body, { status })
  }
}
