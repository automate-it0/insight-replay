import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { verifyProjectAccess } from "@/lib/project-auth"
import { sanitizeError } from "@/lib/observability"

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; gid: string }> }) {
  const { id, gid } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  try {
    await db.segment.deleteMany({ where: { id: gid, projectId: id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "segment_delete")
    return NextResponse.json(body, { status })
  }
}
