import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

function mostCommon(arr: string[]): string {
  if (arr.length === 0) return "Unknown"
  const counts: Record<string, number> = {}
  let best = arr[0]
  let bestN = 0
  for (const v of arr) {
    counts[v] = (counts[v] || 0) + 1
    if (counts[v] > bestN) {
      bestN = counts[v]
      best = v
    }
  }
  return best
}

// Query-string schema for GET /api/projects/[id]/visitors. `range` parses
// to a bounded integer (1–3650 days); `q` is a search filter applied
// in-memory and capped at 200 chars so a hostile query string can't slow
// the in-memory `.toLowerCase().includes()` loop.
const VisitorsQuerySchema = z.object({
  range: z
    .string()
    .max(8)
    .default("7")
    .transform((v) => {
      const n = parseInt(v, 10)
      return Number.isFinite(n) && n > 0 && n < 3650 ? n : 7
    }),
  q: z.string().max(200).default(""),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const sp = req.nextUrl.searchParams
    const parsed = VisitorsQuerySchema.safeParse({
      range: sp.get("range") ?? undefined,
      q: sp.get("q") ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid query" },
        { status: 400 },
      )
    }
    const q = parsed.data.q
    const days = parsed.data.range
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const sessions = await db.session.findMany({
      where: { projectId: id, startedAt: { gte: since } },
      select: {
        id: true,
        visitorId: true,
        startedAt: true,
        lastActiveAt: true,
        duration: true,
        totalClicks: true,
        pageViewsCount: true,
        device: true,
        browser: true,
        country: true,
        city: true,
        os: true,
        convertedGoal: true,
        isNewVisitor: true,
      },
      orderBy: { startedAt: "desc" },
      // Bounded — DoS protection. 5000 sessions covers a busy project's
      // typical 7-30 day range; the visitor list is sliced to 100 below
      // anyway. A project with way more than 5k sessions/day would be
      // better served by SQL aggregation than in-memory grouping.
      take: 5000,
    })

    // Optional visitorId search filter
    const ql = q.trim().toLowerCase()
    const filtered = ql
      ? sessions.filter((s) => s.visitorId.toLowerCase().includes(ql))
      : sessions

    // Group by visitorId
    const groups = new Map<string, typeof filtered>()
    for (const s of filtered) {
      const arr = groups.get(s.visitorId) || []
      arr.push(s)
      groups.set(s.visitorId, arr)
    }

    // Collect tags across all sessions in range (single query)
    const sessionIds = filtered.map((s) => s.id)
    const tagRows = sessionIds.length
      ? await db.tag.findMany({
          where: { sessionId: { in: sessionIds } },
          select: { sessionId: true, label: true, color: true },
          // Bounded — sessions.length is already bounded (≤5000 above), and
          // each session has at most a few tags. Cap to prevent pathological
          // cases from exhausting memory in the join.
          take: 5000,
        })
      : []
    const tagsBySession = new Map<string, { label: string; color: string }[]>()
    for (const t of tagRows) {
      const arr = tagsBySession.get(t.sessionId) || []
      arr.push({ label: t.label, color: t.color })
      tagsBySession.set(t.sessionId, arr)
    }

    type VisitorRow = {
      visitorId: string
      sessionCount: number
      firstSeen: string
      lastSeen: string
      totalClicks: number
      totalPages: number
      totalDuration: number
      avgDuration: number
      device: string
      browser: string
      os: string
      country: string
      city: string
      isNewVisitor: boolean
      convertedGoal: string
      tags: { label: string; color: string }[]
    }
    const visitors: VisitorRow[] = []
    for (const [visitorId, sess] of groups) {
      const sessionCount = sess.length
      const firstSeen = sess.reduce((a, s) => (s.startedAt < a ? s.startedAt : a), sess[0].startedAt)
      const lastSeen = sess.reduce((a, s) => (s.lastActiveAt > a ? s.lastActiveAt : a), sess[0].lastActiveAt)
      const totalClicks = sess.reduce((a, s) => a + s.totalClicks, 0)
      const totalPages = sess.reduce((a, s) => a + s.pageViewsCount, 0)
      const totalDuration = sess.reduce((a, s) => a + s.duration, 0)
      const avgDuration = sessionCount ? Math.round(totalDuration / sessionCount) : 0
      const device = mostCommon(sess.map((s) => s.device))
      const browser = mostCommon(sess.map((s) => s.browser))
      const country = mostCommon(sess.map((s) => s.country))
      const city = mostCommon(sess.map((s) => s.city))
      const isNewVisitor = sessionCount === 1 && sess[0].isNewVisitor
      const convertedGoal = sess.find((s) => s.convertedGoal && s.convertedGoal.trim() !== "")

      // Distinct tags across this visitor's sessions
      const tagSet = new Map<string, { label: string; color: string }>()
      for (const s of sess) {
        const tags = tagsBySession.get(s.id) || []
        for (const t of tags) {
          if (!tagSet.has(t.label)) tagSet.set(t.label, t)
        }
      }

      visitors.push({
        visitorId,
        sessionCount,
        firstSeen: firstSeen.toISOString(),
        lastSeen: lastSeen.toISOString(),
        totalClicks,
        totalPages,
        totalDuration,
        avgDuration,
        device,
        browser,
        os: mostCommon(sess.map((s) => s.os)),
        country,
        city,
        isNewVisitor,
        convertedGoal: convertedGoal?.convertedGoal || "",
        tags: [...tagSet.values()],
      })
    }

    // Sort by lastSeen desc, limit 100
    visitors.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0))
    const limited = visitors.slice(0, 100)

    return NextResponse.json({
      range: days,
      q: ql || null,
      totalVisitors: visitors.length,
      visitors: limited,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "visitors")
    return NextResponse.json(body, { status })
  }
}
