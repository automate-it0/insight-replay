import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for POST body — `name` is required (1–100 chars), `layout`
// is an optional array (any JSON-serializable shape; we cap the array
// length at 100 to bound memory). Both strings flow through stripHtml
// before persistence so stored rows are inert against stored XSS.
const DashboardCreateSchema = z.object({
  name: z.string().trim().min(1, "name required").max(100, "name too long"),
  layout: z.array(z.unknown()).max(100).optional(),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "dashboard_list", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const dashboards = await db.dashboard.findMany({
      where: { projectId: id },
      orderBy: { updatedAt: "desc" },
      take: 100,
    })
    return NextResponse.json({
      dashboards: dashboards.map((d) => ({
        ...d,
        layout: JSON.parse(d.layout || "[]"),
      })),
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "dashboards_list")
    return NextResponse.json(body, { status })
  }
}

/**
 * POST — create a dashboard. Mutating: requires a valid API key in production.
 * Open in dev for dashboard testing.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "dashboard_create")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json()
    const parsed = DashboardCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    const name = stripHtml(parsed.data.name, 100)
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })
    const cleanLayout = parsed.data.layout ?? []
    const dashboard = await db.dashboard.create({
      data: {
        projectId: id,
        name,
        layout: JSON.stringify(cleanLayout),
      },
    })
    return NextResponse.json({
      dashboard: { ...dashboard, layout: JSON.parse(dashboard.layout || "[]") },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "dashboard_create")
    return NextResponse.json(body, { status })
  }
}
