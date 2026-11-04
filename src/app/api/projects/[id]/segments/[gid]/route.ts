import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; gid: string }> }) {
  const { id, gid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "segment_delete")
  if (guard.error) return guard.error
  try {
    await db.segment.deleteMany({ where: { id: gid, projectId: id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "segment_delete")
    return NextResponse.json(body, { status })
  }
}
