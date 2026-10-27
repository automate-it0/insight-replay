import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

const DAY_MS = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const range = req.nextUrl.searchParams.get("range") || "30"
    const cohortSizeParam = req.nextUrl.searchParams.get("cohortSize") || "7"
    const days = parseInt(range, 10) || 30
    const cohortSizeDays = Math.max(1, parseInt(cohortSizeParam, 10) || 7)
    const cohortMs = cohortSizeDays * DAY_MS
    const since = new Date(Date.now() - days * DAY_MS)

    const sessions = await db.session.findMany({
      where: { projectId: id, startedAt: { gte: since } },
      select: { visitorId: true, startedAt: true, isNewVisitor: true },
      orderBy: { startedAt: "asc" },
      // Bounded — DoS protection. The retention endpoint groups every
      // matching session by visitor in memory. 50000 covers a 30-day
      // retention window on a busy project; projects with more traffic
      // should move cohort construction to SQL.
      take: 50000,
    })

    // Group session timestamps by visitor
    const visitorSessions = new Map<string, Date[]>()
    const visitorFirstNew = new Map<string, boolean>() // visitorId -> isNewVisitor of earliest session
    for (const s of sessions) {
      const arr = visitorSessions.get(s.visitorId) || []
      arr.push(s.startedAt)
      visitorSessions.set(s.visitorId, arr)
      // Track the earliest session's isNewVisitor flag (true => genuinely new)
      if (!visitorFirstNew.has(s.visitorId)) visitorFirstNew.set(s.visitorId, s.isNewVisitor)
    }

    const totalVisitors = visitorSessions.size

    // New vs returning: a visitor is "new" if their earliest session had isNewVisitor=true
    let newVisitors = 0
    let returningVisitors = 0
    for (const [, isNew] of visitorFirstNew) {
      if (isNew) newVisitors++
      else returningVisitors++
    }

    // Cohort bucket index = floor((startedAt - since) / cohortMs)
    // For each visitor, cohort = bucket of their FIRST session
    const visitorCohort = new Map<string, number>()
    const cohortMembers = new Map<number, Set<string>>()
    for (const [vid, dates] of visitorSessions) {
      const first = dates.reduce((a, b) => (a < b ? a : b))
      const cohortIndex = Math.max(
        0,
        Math.floor((first.getTime() - since.getTime()) / cohortMs)
      )
      visitorCohort.set(vid, cohortIndex)
      if (!cohortMembers.has(cohortIndex)) cohortMembers.set(cohortIndex, new Set())
      cohortMembers.get(cohortIndex)!.add(vid)
    }

    // Determine total number of cohort periods in the range
    const totalPeriods = Math.max(1, Math.ceil(days / cohortSizeDays))

    // Pre-bucket each visitor's sessions by period index relative to their cohort
    const visitorPeriods = new Map<string, Set<number>>()
    for (const [vid, dates] of visitorSessions) {
      const cIdx = visitorCohort.get(vid)!
      const cohortStartMs = since.getTime() + cIdx * cohortMs
      const periods = new Set<number>()
      for (const d of dates) {
        const pIdx = Math.floor((d.getTime() - cohortStartMs) / cohortMs)
        if (pIdx >= 0) periods.add(pIdx)
      }
      visitorPeriods.set(vid, periods)
    }

    // Build cohorts
    const sortedCohortIdx = [...cohortMembers.keys()].sort((a, b) => a - b)
    type CohortPeriod = { periodIndex: number; retained: number; rate: number }
    type Cohort = {
      cohortIndex: number
      label: string
      cohortStart: string
      size: number
      periods: CohortPeriod[]
    }
    const cohorts: Cohort[] = []
    let retainedSum = 0
    let retainedCellCount = 0

    for (const cIdx of sortedCohortIdx) {
      const members = cohortMembers.get(cIdx)!
      const size = members.size
      const cohortStart = new Date(since.getTime() + cIdx * cohortMs)
      const periods: CohortPeriod[] = []
      const maxP = totalPeriods - cIdx
      for (let p = 0; p <= maxP; p++) {
        let retained = 0
        for (const vid of members) {
          if (visitorPeriods.get(vid)!.has(p)) retained++
        }
        const rate = size ? retained / size : 0
        periods.push({ periodIndex: p, retained, rate: Number(rate.toFixed(4)) })
        if (p > 0) {
          retainedSum += retained
          retainedCellCount += size
        }
      }
      cohorts.push({
        cohortIndex: cIdx,
        label: `Cohort starting ${cohortStart.toISOString().slice(0, 10)}`,
        cohortStart: cohortStart.toISOString(),
        size,
        periods,
      })
    }

    const avgRetention = retainedCellCount
      ? Number((retainedSum / retainedCellCount).toFixed(4))
      : 0

    return NextResponse.json({
      range: days,
      cohortSize: cohortSizeDays,
      totalVisitors,
      newVisitors,
      returningVisitors,
      avgRetention,
      cohortCount: cohorts.length,
      cohorts,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "retention")
    return NextResponse.json(body, { status })
  }
}
