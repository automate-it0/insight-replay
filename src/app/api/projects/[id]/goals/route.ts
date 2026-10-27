import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for POST body — `name` required (1–100 chars); `type`,
// `match` enum-constrained; `url` and `eventName` optional bounded
// strings; `value` is a non-negative number. All string values flow
// through stripHtml before persistence so stored rows are inert against
// stored XSS even if a downstream dangerouslySetInnerHTML consumer renders
// them.
const GoalCreateSchema = z.object({
  name: z.string().trim().min(1, "name required").max(100, "name too long"),
  type: z.enum(["url", "event"]).default("url"),
  match: z.enum(["equals", "startsWith", "contains"]).default("contains"),
  url: z.string().max(2000).optional(),
  eventName: z.string().max(200).optional(),
  value: z.number().finite().min(0).default(0),
})

// Query-string schema for GET — `range` parses to a bounded integer.
const GoalsQuerySchema = z.object({
  range: z
    .string()
    .max(8)
    .default("7")
    .transform((v) => {
      const n = parseInt(v, 10)
      return Number.isFinite(n) && n > 0 && n < 3650 ? n : 7
    }),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "goal_list", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  const rangeParsed = GoalsQuerySchema.safeParse({
    range: req.nextUrl.searchParams.get("range") ?? undefined,
  })
  if (!rangeParsed.success) {
    return NextResponse.json(
      { error: rangeParsed.error.issues[0]?.message ?? "invalid query" },
      { status: 400 },
    )
  }
  const days = rangeParsed.data.range
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  try {
    const goals = await db.goal.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
    })

    if (goals.length === 0) {
      return NextResponse.json({ goals: [], totalSessions: 0 })
    }

    // Total sessions in range (denominator for conversion rate)
    const totalSessions = await db.session.count({
      where: { projectId: id, startedAt: { gte: since } },
    })

    // Sessions in range with convertedGoal set
    const sessionsInRange = await db.session.findMany({
      where: { projectId: id, startedAt: { gte: since } },
      select: { id: true, convertedGoal: true, entryUrl: true, exitUrl: true },
      // Bounded — DoS protection. The goals endpoint joins every matching
      // session against every goal in memory. 5000 covers a busy project's
      // typical 7-30 day range; beyond that the dashboard should switch to
      // SQL-side aggregation.
      take: 5000,
    })

    // For url-type goals, also count sessions whose entry/exit url matches.
    const result = goals.map((g) => {
      let conversions = 0
      for (const s of sessionsInRange) {
        if (s.convertedGoal === g.name) {
          conversions++
        } else if (g.type === "url") {
          if (matchesUrl(g.match, s.entryUrl, g.url) || matchesUrl(g.match, s.exitUrl, g.url)) {
            conversions++
          }
        }
      }
      const conversionRate =
        totalSessions > 0 ? Math.round((conversions / totalSessions) * 1000) / 10 : 0
      const value = Math.round(conversions * g.value * 100) / 100
      return {
        ...g,
        conversions,
        conversionRate,
        value,
      }
    })

    return NextResponse.json({ goals: result, totalSessions })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "goals_list")
    return NextResponse.json(body, { status })
  }
}

function matchesUrl(match: string, candidate: string, target: string): boolean {
  if (!target) return false
  if (match === "equals") return candidate === target
  if (match === "startsWith") return candidate.startsWith(target)
  return candidate.includes(target) // contains (default)
}

/**
 * POST — create a goal. Mutating: requires a valid API key in production.
 * Open in dev for dashboard testing.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "goal_create")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json()
    const parsed = GoalCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    const name = stripHtml(parsed.data.name, 100)
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })
    const goal = await db.goal.create({
      data: {
        projectId: id,
        name,
        type: parsed.data.type,
        match: parsed.data.match,
        url: parsed.data.url ? stripHtml(parsed.data.url, 2000) : "",
        eventName: parsed.data.eventName ? stripHtml(parsed.data.eventName, 200) : "",
        value: parsed.data.value,
      },
    })
    return NextResponse.json({ goal })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "goal_create")
    return NextResponse.json(body, { status })
  }
}
