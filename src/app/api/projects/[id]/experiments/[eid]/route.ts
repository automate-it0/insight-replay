import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for PATCH body — all fields optional (it's a PATCH). String
// fields are bounded in length; `status` enum-constrained; `endDate` is
// either null (clear) or a date string. All strings flow through stripHtml
// before persistence.
const ExperimentUpdateSchema = z.object({
  status: z.enum(["draft", "running", "completed"]).optional(),
  endDate: z.union([z.null(), z.string().trim().max(40)]).optional(),
  name: z.string().trim().min(1).max(100).optional(),
  hypothesis: z.string().max(4000).optional(),
  variants: z.array(z.unknown()).max(20).optional(),
  goalName: z.string().max(200).optional(),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "experiment_read", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const experiment = await db.experiment.findFirst({ where: { id: eid, projectId: id } })
    if (!experiment) return NextResponse.json({ error: "not found" }, { status: 404 })
    return NextResponse.json({
      experiment: { ...experiment, variants: JSON.parse(experiment.variants || "[]") },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "experiment_detail")
    return NextResponse.json(body, { status })
  }
}

/**
 * PATCH — update an experiment (status, end date, variants, etc.). Mutating:
 * requires a valid API key in production. Open in dev for dashboard testing.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "experiment_update")
  if (guard.error) return guard.error
  void guard.session
  try {
    const existing = await db.experiment.findFirst({ where: { id: eid, projectId: id } })
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 })
    const body = await req.json()
    const parsed = ExperimentUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    const data: {
      status?: string
      endDate?: Date | null
      name?: string
      hypothesis?: string
      variants?: string
      goalName?: string
    } = {}
    if (parsed.data.status) data.status = parsed.data.status
    if (parsed.data.endDate === null) {
      data.endDate = null
    } else if (typeof parsed.data.endDate === "string" && parsed.data.endDate.trim() !== "") {
      const parsedDate = new Date(parsed.data.endDate)
      if (!isNaN(parsedDate.getTime())) data.endDate = parsedDate
    }
    if (parsed.data.name) data.name = stripHtml(parsed.data.name, 100)
    if (parsed.data.hypothesis !== undefined) {
      data.hypothesis = stripHtml(parsed.data.hypothesis, 4000)
    }
    if (parsed.data.variants !== undefined) {
      data.variants = JSON.stringify(parsed.data.variants)
    }
    if (parsed.data.goalName !== undefined) {
      data.goalName = stripHtml(parsed.data.goalName, 200)
    }

    const experiment = await db.experiment.update({ where: { id: eid }, data })
    return NextResponse.json({
      experiment: { ...experiment, variants: JSON.parse(experiment.variants || "[]") },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "experiment_update")
    return NextResponse.json(body, { status })
  }
}

/**
 * DELETE — remove an experiment. Destructive: requires a valid API key in
 * production. Open in dev for dashboard testing.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "experiment_delete")
  if (guard.error) return guard.error
  void guard.session
  try {
    await db.experiment.deleteMany({ where: { id: eid, projectId: id } })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "experiment_delete")
    return NextResponse.json(body, { status })
  }
}
