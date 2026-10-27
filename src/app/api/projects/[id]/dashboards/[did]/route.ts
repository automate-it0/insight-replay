import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for PUT body — both `name` and `layout` are optional (it's a
// PATCH-style PUT). `name` capped at 100 chars; `layout` is an array capped
// at 100 entries.
const DashboardUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  layout: z.array(z.unknown()).max(100).optional(),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; did: string }> }) {
  const { id, did } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "dashboard_read", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const dashboard = await db.dashboard.findFirst({ where: { id: did, projectId: id } })
    if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({
      dashboard: { ...dashboard, layout: JSON.parse(dashboard.layout || "[]") },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "dashboard_detail")
    return NextResponse.json(body, { status })
  }
}

/**
 * PUT — update a dashboard (name and/or layout). Mutating: requires a valid
 * API key in production. Open in dev for dashboard testing.
 */
export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string; did: string }> }) {
  const { id, did } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "dashboard_update")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json()
    const parsed = DashboardUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    const existing = await db.dashboard.findFirst({ where: { id: did, projectId: id } })
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 })
    const data: { name?: string; layout?: string } = {}
    if (parsed.data.name) data.name = stripHtml(parsed.data.name, 100)
    if (parsed.data.layout !== undefined) {
      data.layout = JSON.stringify(parsed.data.layout)
    }
    const dashboard = await db.dashboard.update({ where: { id: did }, data })
    return NextResponse.json({
      dashboard: { ...dashboard, layout: JSON.parse(dashboard.layout || "[]") },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "dashboard_update")
    return NextResponse.json(body, { status })
  }
}

/**
 * DELETE — remove a dashboard. Destructive: requires a valid API key in
 * production. Open in dev for dashboard testing.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; did: string }> }) {
  const { id, did } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "dashboard_delete")
  if (guard.error) return guard.error
  void guard.session
  try {
    await db.dashboard.deleteMany({ where: { id: did, projectId: id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "dashboard_delete")
    return NextResponse.json(body, { status })
  }
}
