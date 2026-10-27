import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

type SessionRow = {
  id: string
  startedAt: Date
  duration: number
  totalClicks: number
  pageViewsCount: number
  hasRageClick: boolean
  hasDeadClick: boolean
  hasError: boolean
  convertedGoal: string
  visitorId: string
}

type Stats = {
  totalSessions: number
  totalClicks: number
  totalPages: number
  uniqueVisitors: number
  avgDuration: number
  bounceRate: number
  rageClicks: number
  deadClicks: number
  errors: number
  conversions: number
}

function computeStats(sessions: SessionRow[]): Stats {
  const totalSessions = sessions.length
  const totalClicks = sessions.reduce((a, s) => a + s.totalClicks, 0)
  const totalPages = sessions.reduce((a, s) => a + s.pageViewsCount, 0)
  const uniqueVisitors = new Set(sessions.map((s) => s.visitorId)).size
  const avgDuration = totalSessions
    ? Math.round(sessions.reduce((a, s) => a + s.duration, 0) / totalSessions)
    : 0
  const bounceRate = totalSessions
    ? Math.round((sessions.filter((s) => s.pageViewsCount <= 1).length / totalSessions) * 100)
    : 0
  const rageClicks = sessions.filter((s) => s.hasRageClick).length
  const deadClicks = sessions.filter((s) => s.hasDeadClick).length
  const errors = sessions.filter((s) => s.hasError).length
  const conversions = sessions.filter((s) => s.convertedGoal && s.convertedGoal !== "").length
  return {
    totalSessions,
    totalClicks,
    totalPages,
    uniqueVisitors,
    avgDuration,
    bounceRate,
    rageClicks,
    deadClicks,
    errors,
    conversions,
  }
}

function delta(current: number, previous: number) {
  const abs = current - previous
  let pct = 0
  if (previous !== 0) {
    pct = Math.round(((current - previous) / previous) * 1000) / 10
  } else if (current !== 0) {
    pct = 100
  }
  return { abs, pct }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const rangeParam = req.nextUrl.searchParams.get("range") || "7"
  const range = Math.max(1, parseInt(rangeParam, 10) || 7)

  const now = Date.now()
  const periodAStart = new Date(now - range * 24 * 60 * 60 * 1000)
  const periodAEnd = new Date(now)
  const periodBStart = new Date(now - 2 * range * 24 * 60 * 60 * 1000)
  const periodBEnd = periodAStart

  // Fetch all sessions in both windows in one query, then split in memory.
  const allSessions = await db.session.findMany({
    where: {
      projectId: id,
      startedAt: { gte: periodBStart, lte: periodAEnd },
    },
    select: {
      id: true,
      startedAt: true,
      duration: true,
      totalClicks: true,
      pageViewsCount: true,
      hasRageClick: true,
      hasDeadClick: true,
      hasError: true,
      convertedGoal: true,
      visitorId: true,
    },
    // Bounded — DoS protection. The compare endpoint aggregates every
    // matching session in memory; 5000 covers a busy project's typical
    // 7-30 day window pair. Beyond that, the dashboard should switch to
    // SQL-side aggregation (groupBy / count) instead of in-memory loops.
    take: 5000,
  })

  const currentSessions = allSessions.filter(
    (s) => s.startedAt >= periodAStart && s.startedAt <= periodAEnd
  )
  const previousSessions = allSessions.filter(
    (s) => s.startedAt >= periodBStart && s.startedAt < periodBEnd
  )

  const currentStats = computeStats(currentSessions)
  const previousStats = computeStats(previousSessions)

  // Daily series for period A only
  const daily: Record<string, { date: string; sessions: number; clicks: number; pages: number; conversions: number }> = {}
  for (let i = range - 1; i >= 0; i--) {
    const d = startOfDay(new Date(now - i * 86400000))
    const key = d.toISOString().slice(0, 10)
    daily[key] = { date: key, sessions: 0, clicks: 0, pages: 0, conversions: 0 }
  }
  for (const s of currentSessions) {
    const key = startOfDay(s.startedAt).toISOString().slice(0, 10)
    if (daily[key]) {
      daily[key].sessions += 1
      daily[key].clicks += s.totalClicks
      daily[key].pages += s.pageViewsCount
      if (s.convertedGoal && s.convertedGoal !== "") daily[key].conversions += 1
    }
  }

  const deltas = {
    totalSessions: delta(currentStats.totalSessions, previousStats.totalSessions),
    totalClicks: delta(currentStats.totalClicks, previousStats.totalClicks),
    totalPages: delta(currentStats.totalPages, previousStats.totalPages),
    uniqueVisitors: delta(currentStats.uniqueVisitors, previousStats.uniqueVisitors),
    avgDuration: delta(currentStats.avgDuration, previousStats.avgDuration),
    bounceRate: delta(currentStats.bounceRate, previousStats.bounceRate),
    rageClicks: delta(currentStats.rageClicks, previousStats.rageClicks),
    deadClicks: delta(currentStats.deadClicks, previousStats.deadClicks),
    errors: delta(currentStats.errors, previousStats.errors),
    conversions: delta(currentStats.conversions, previousStats.conversions),
  }

  return NextResponse.json({
    range,
    current: { ...currentStats, daily: Object.values(daily) },
    previous: { ...previousStats },
    deltas,
  })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "compare")
    return NextResponse.json(body, { status })
  }
}
