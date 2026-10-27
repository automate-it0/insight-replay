import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

// Standard normal CDF using the Abramowitz-Stegun approximation
function normalCDF(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp(-z * z / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

interface VariantDef {
  name: string
  weight: number
  description?: string
}

interface VariantResult {
  name: string
  description: string
  sessions: number
  conversions: number
  conversionRate: number
  avgDuration: number
  avgClicks: number
  z: number | null
  pValue: number | null
  significant: boolean
  lift: number | null
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; eid: string }> }) {
  const { id, eid } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(_req as unknown as Request)
  try {
    const experiment = await db.experiment.findFirst({ where: { id: eid, projectId: id } })
    if (!experiment) return NextResponse.json({ error: "not found" }, { status: 404 })

    const variantDefs = JSON.parse(experiment.variants || "[]") as VariantDef[]
    const goalName = experiment.goalName

    // Fetch all sessions assigned to this experiment
    const sessions = await db.session.findMany({
      where: { projectId: id, experimentId: eid, variant: { not: "" } },
      select: {
        variant: true,
        duration: true,
        totalClicks: true,
        convertedGoal: true,
      },
      // Bounded — DoS protection. Experiments typically accumulate a few
      // thousand sessions; 10k is enough for any realistic A/B test and
      // caps the in-memory aggregation cost.
      take: 10000,
    })

    // Group sessions per variant
    const perVariant = new Map<string, { sessions: number; conversions: number; totalDuration: number; totalClicks: number }>()
    for (const v of variantDefs) {
      perVariant.set(v.name, { sessions: 0, conversions: 0, totalDuration: 0, totalClicks: 0 })
    }
    for (const s of sessions) {
      let bucket = perVariant.get(s.variant)
      if (!bucket) {
        // variant in sessions but not in defs (legacy data) — create on the fly
        bucket = { sessions: 0, conversions: 0, totalDuration: 0, totalClicks: 0 }
        perVariant.set(s.variant, bucket)
      }
      bucket.sessions += 1
      bucket.totalDuration += s.duration
      bucket.totalClicks += s.totalClicks
      if (goalName && s.convertedGoal === goalName) bucket.conversions += 1
    }

    const totalSessions = sessions.length
    const variantNames = variantDefs.map((v) => v.name)
    // Control = first defined variant (fall back to first variant seen in sessions)
    let controlName = variantNames[0]
    if (!controlName && sessions.length > 0) controlName = sessions[0].variant
    const control = controlName ? perVariant.get(controlName) : undefined

    const controlSessions = control?.sessions ?? 0
    const controlConversions = control?.conversions ?? 0
    const controlRate = controlSessions > 0 ? controlConversions / controlSessions : 0

    const variantResults: VariantResult[] = []
    let winnerName: string | null = null
    let winnerRate = -Infinity
    let anySignificant = false

    for (const v of variantDefs) {
      const bucket = perVariant.get(v.name)
      const n = bucket?.sessions ?? 0
      const conv = bucket?.conversions ?? 0
      const rate = n > 0 ? conv / n : 0
      const avgDuration = n > 0 ? Math.round(bucket!.totalDuration / n) : 0
      const avgClicks = n > 0 ? Math.round((bucket!.totalClicks / n) * 10) / 10 : 0

      let z: number | null = null
      let pValue: number | null = null
      let significant = false
      let lift: number | null = null

      if (controlName && v.name !== controlName && n > 0 && controlSessions > 0) {
        const p1 = controlRate
        const p2 = rate
        const n1 = controlSessions
        const n2 = n
        const pooledP = (controlConversions + conv) / (n1 + n2)
        const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / n1 + 1 / n2))
        if (se > 0) {
          z = (p2 - p1) / se
          pValue = 2 * (1 - normalCDF(Math.abs(z)))
          significant = pValue < 0.05
          lift = controlRate > 0 ? ((p2 - p1) / controlRate) * 100 : (p2 > 0 ? 100 : 0)
        } else {
          // se = 0 means both rates identical (or no conversions at all)
          z = 0
          pValue = 1
          significant = false
          lift = controlRate > 0 ? ((p2 - p1) / controlRate) * 100 : 0
        }
      } else if (v.name === controlName) {
        // Control vs itself
        z = 0
        pValue = 1
        significant = false
        lift = 0
      }

      if (significant && rate > winnerRate) {
        winnerRate = rate
        winnerName = v.name
      }
      if (significant) anySignificant = true

      variantResults.push({
        name: v.name,
        description: v.description || "",
        sessions: n,
        conversions: conv,
        conversionRate: Math.round(rate * 10000) / 100, // percent w/ 2 decimals
        avgDuration,
        avgClicks,
        z: z === null ? null : Math.round(z * 1000) / 1000,
        pValue: pValue === null ? null : Math.round(pValue * 100000) / 100000,
        significant,
        lift: lift === null ? null : Math.round(lift * 10) / 10,
      })
    }

    // If no significant winner was found but there's a clear leader, leave winner null
    return NextResponse.json({
      experiment: { ...experiment, variants: variantDefs },
      variants: variantResults,
      winner: winnerName,
      isSignificant: anySignificant,
      totalSessions,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "experiment_analyze")
    return NextResponse.json(body, { status })
  }
}
