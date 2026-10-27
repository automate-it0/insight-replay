import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

interface VariantInput {
  name: string
  weight: number
  description?: string | undefined
}

// Zod schema for POST body — `name` required (1–100 chars); `hypothesis`
// optional bounded string; `variants` array of `{ name, weight,
// description? }` (max 20 variants); `goalName` optional; `status` enum.
// All string values flow through stripHtml before persistence.
const VariantSchema = z.object({
  name: z.string().trim().min(1).max(100),
  weight: z.number().finite().min(0).max(1_000_000),
  description: z.string().max(1000).optional(),
})
const ExperimentCreateSchema = z.object({
  name: z.string().trim().min(1, "name required").max(100, "name too long"),
  hypothesis: z.string().max(4000).optional(),
  variants: z.array(VariantSchema).max(20).default([]),
  goalName: z.string().max(200).optional(),
  status: z.enum(["draft", "running", "completed"]).default("draft"),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "experiment_list", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const experiments = await db.experiment.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return NextResponse.json({
      experiments: experiments.map((e) => ({
        ...e,
        variants: JSON.parse(e.variants || "[]"),
      })),
    })
  } catch (e) {
    // Prisma errors carry DB internals (table/column names, constraint codes,
    // SQL fragments) — never leak them to the client. sanitizeError() logs the
    // real error server-side and returns a generic envelope.
    const { status, body } = sanitizeError(e, undefined, "experiments_list")
    return NextResponse.json(body, { status })
  }
}

/**
 * POST — create an experiment. Mutating: requires a valid API key in
 * production. Open in dev for dashboard testing.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "experiment_create")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json()
    const parsed = ExperimentCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    const name = stripHtml(parsed.data.name, 100)
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })
    const cleanVariants: VariantInput[] = parsed.data.variants.map((v) => ({
      name: stripHtml(v.name, 100),
      weight: v.weight,
      description: v.description ? stripHtml(v.description, 1000) : undefined,
    }))
    const cleanStatus = parsed.data.status
    const experiment = await db.experiment.create({
      data: {
        projectId: id,
        name,
        hypothesis: parsed.data.hypothesis ? stripHtml(parsed.data.hypothesis, 4000) : "",
        variants: JSON.stringify(cleanVariants),
        goalName: parsed.data.goalName ? stripHtml(parsed.data.goalName, 200) : "",
        status: cleanStatus,
      },
    })
    return NextResponse.json({
      experiment: { ...experiment, variants: JSON.parse(experiment.variants || "[]") },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "experiment_create")
    return NextResponse.json(body, { status })
  }
}
