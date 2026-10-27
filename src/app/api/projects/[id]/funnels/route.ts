import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for POST body — `name` required (1–100 chars); `steps` is
// an array of `{ url, name }` objects (max 50 steps, each field capped at
// 2000 / 200 chars). All string values flow through stripHtml before
// persistence so stored funnel rows are inert against stored XSS.
const FunnelStepSchema = z.object({
  url: z.string().max(2000),
  name: z.string().max(200),
})
const FunnelCreateSchema = z.object({
  name: z.string().trim().min(1, "name required").max(100, "name too long"),
  steps: z.array(FunnelStepSchema).max(50).default([]),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "funnel_list", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const funnels = await db.funnel.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return NextResponse.json({
      funnels: funnels.map((f) => ({
        ...f,
        steps: JSON.parse(f.steps || "[]"),
      })),
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "funnels_list")
    return NextResponse.json(body, { status })
  }
}

/**
 * POST — create a funnel. Mutating: requires a valid API key in production.
 * Open in dev for dashboard testing.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "funnel_create")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json()
    const parsed = FunnelCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    const name = stripHtml(parsed.data.name, 100)
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })
    const cleanSteps = parsed.data.steps.map((s) => ({
      url: stripHtml(s.url, 2000),
      name: stripHtml(s.name, 200),
    }))
    const funnel = await db.funnel.create({
      data: {
        projectId: id,
        name,
        steps: JSON.stringify(cleanSteps),
      },
    })
    return NextResponse.json({
      funnel: { ...funnel, steps: JSON.parse(funnel.steps || "[]") },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "funnel_create")
    return NextResponse.json(body, { status })
  }
}
