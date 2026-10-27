import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"

/**
 * DELETE — remove a goal. Destructive: requires a valid API key in
 * production. Open in dev for dashboard testing.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; gid: string }> }) {
  const { id, gid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "goal_delete")
  if (guard.error) return guard.error
  void guard.session
  try {
    await db.goal.deleteMany({ where: { id: gid, projectId: id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "goal_delete")
    return NextResponse.json(body, { status })
  }
}
