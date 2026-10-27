import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

function uniq(arr: string[]): string[] {
  return [...new Set(arr.filter(Boolean))]
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; vid: string }> }
) {
  const { id, vid } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const sessions = await db.session.findMany({
      where: { projectId: id, visitorId: vid },
      orderBy: { startedAt: "desc" },
      include: {
        tags: { select: { label: true, color: true } },
        notes: { select: { id: true, text: true, author: true, createdAt: true, t: true } },
      },
      take: 500,
    })

    if (sessions.length === 0) {
      return NextResponse.json(
        { error: "visitor not found", visitor: null },
        { status: 404 }
      )
    }

    const totalSessions = sessions.length
    const totalClicks = sessions.reduce((a, s) => a + s.totalClicks, 0)
    const totalPages = sessions.reduce((a, s) => a + s.pageViewsCount, 0)
    const totalDuration = sessions.reduce((a, s) => a + s.duration, 0)
    const avgDuration = totalSessions ? Math.round(totalDuration / totalSessions) : 0

    const startedTimes = sessions.map((s) => s.startedAt)
    const lastActiveTimes = sessions.map((s) => s.lastActiveAt)
    const firstSeen = startedTimes.reduce((a, b) => (a < b ? a : b))
    const lastSeen = lastActiveTimes.reduce((a, b) => (a > b ? a : b))

    const devices = uniq(sessions.map((s) => s.device))
    const browsers = uniq(sessions.map((s) => s.browser))
    const oses = uniq(sessions.map((s) => s.os))
    const countries = uniq(sessions.map((s) => s.country))
    const cities = uniq(sessions.map((s) => s.city))

    const conversionCount = sessions.filter(
      (s) => s.convertedGoal && s.convertedGoal.trim() !== ""
    ).length

    // Distinct tags across all sessions
    const tagMap = new Map<string, { label: string; color: string }>()
    for (const s of sessions) {
      for (const t of s.tags) {
        if (!tagMap.has(t.label)) tagMap.set(t.label, t)
      }
    }
    const tags = [...tagMap.values()]

    // Build session summary list
    const sessionList = sessions.map((s) => ({
      id: s.id,
      startedAt: s.startedAt.toISOString(),
      lastActiveAt: s.lastActiveAt.toISOString(),
      duration: s.duration,
      totalClicks: s.totalClicks,
      pageViewsCount: s.pageViewsCount,
      device: s.device,
      browser: s.browser,
      os: s.os,
      country: s.country,
      city: s.city,
      entryUrl: s.entryUrl,
      exitUrl: s.exitUrl,
      isActive: s.isActive,
      hasRageClick: s.hasRageClick,
      hasDeadClick: s.hasDeadClick,
      hasError: s.hasError,
      convertedGoal: s.convertedGoal,
      isNewVisitor: s.isNewVisitor,
      referrer: s.referrer,
      utmSource: s.utmSource,
      utmMedium: s.utmMedium,
      utmCampaign: s.utmCampaign,
      screenWidth: s.screenWidth,
      screenHeight: s.screenHeight,
      language: s.language,
      tags: s.tags,
      notes: s.notes,
    }))

    return NextResponse.json({
      visitor: {
        visitorId: vid,
        projectId: id,
        totalSessions,
        totalClicks,
        totalPages,
        totalDuration,
        avgDuration,
        firstSeen: firstSeen.toISOString(),
        lastSeen: lastSeen.toISOString(),
        devices,
        browsers,
        oses,
        countries,
        cities,
        conversionCount,
        tags,
        sessions: sessionList,
      },
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "visitor_detail")
    return NextResponse.json(body, { status })
  }
}
