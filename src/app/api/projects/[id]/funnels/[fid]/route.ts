import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; fid: string }> }) {
  const { id, fid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "funnel_read", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const funnel = await db.funnel.findFirst({ where: { id: fid, projectId: id } })
    if (!funnel) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({
      funnel: { ...funnel, steps: JSON.parse(funnel.steps || "[]") },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "funnel_detail")
    return NextResponse.json(body, { status })
  }
}

/**
 * DELETE — remove a funnel. Destructive: requires a valid API key in
 * production. Open in dev for dashboard testing.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; fid: string }> }) {
  const { id, fid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "funnel_delete")
  if (guard.error) return guard.error
  void guard.session
  try {
    await db.funnel.deleteMany({ where: { id: fid, projectId: id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "funnel_delete")
    return NextResponse.json(body, { status })
  }
}
