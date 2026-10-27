import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { auditLog, AUDIT_ACTIONS } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import { requireProjectAccess } from "@/lib/route-guards"

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "project_read", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  const project = await db.project.findUnique({ where: { id } })
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 })
  const counts = await db.session.aggregate({
    where: { projectId: id },
    _count: true,
    _sum: { totalClicks: true, pageViewsCount: true },
  })
  return NextResponse.json({ project, counts })
}

/**
 * DELETE — destroy a project and cascade-delete all child rows.
 *
 * Destructive: requires a valid API key in production. Open in dev for
 * dashboard testing (the project list UI calls this).
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "project_delete")
  if (guard.error) return guard.error
  void guard.session
  // Capture project name BEFORE the delete so the audit entry has context.
  // (deleteMany would also be safe if the row is already gone; delete throws.)
  const existing = await db.project.findUnique({ where: { id }, select: { name: true } })
  await db.project.delete({ where: { id } })
  await auditLog({
    action: AUDIT_ACTIONS.PROJECT_DELETED,
    projectId: id,
    actor: "api",
    ip: getClientIP(req as unknown as Request),
    details: { name: existing?.name ?? "project" },
  })
  return NextResponse.json({ ok: true })
}
