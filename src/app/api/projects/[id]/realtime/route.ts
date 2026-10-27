import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

const MINUTE_MS = 60 * 1000

function pad(n: number) {
  return n < 10 ? "0" + n : String(n)
}

function minuteKey(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const now = Date.now()
    const since60 = new Date(now - 60 * MINUTE_MS)
    const since5 = new Date(now - 5 * MINUTE_MS)

    // ---- Active sessions in the last 60 minutes (for per-minute buckets) ----
    const recentSessions = await db.session.findMany({
      where: { projectId: id, lastActiveAt: { gte: since60 } },
      select: { lastActiveAt: true, isActive: true, visitorId: true },
      take: 5000,
    })

    // Pre-build 60 minute buckets (oldest → newest)
    const buckets: { minute: string; users: number }[] = []
    const bucketByKey: Record<string, number> = {}
    // Align to wall-clock minutes: oldest bucket = floor(now - 59min) → newest = floor(now)
    const baseMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS
    for (let i = 59; i >= 0; i--) {
      const bucketStart = baseMinute - i * MINUTE_MS
      const d = new Date(bucketStart)
      const key = minuteKey(d)
      const idx = buckets.length
      buckets.push({ minute: key, users: 0 })
      bucketByKey[key + "|" + bucketStart] = idx
    }

    // Map each session's lastActiveAt minute → bucket. Use absolute minute offset
    // (not just "HH:MM" string, to disambiguate hour wrap) by matching on bucketStart
    // nearest to the session's minute.
    for (const s of recentSessions) {
      const t = s.lastActiveAt.getTime()
      // find nearest bucket start <= t
      const bucketStart = Math.floor(t / MINUTE_MS) * MINUTE_MS
      const idx = bucketByKey[minuteKey(new Date(bucketStart)) + "|" + bucketStart]
      if (idx !== undefined) buckets[idx].users += 1
    }

    // ---- Realtime summary stats ----
    const activeNow = recentSessions.filter((s) => s.isActive).length

    const visitorsLast5Min = new Set(
      recentSessions
        .filter((s) => s.lastActiveAt.getTime() >= since5.getTime())
        .map((s) => s.visitorId)
    ).size

    // Recent pageview events (last 5 min) for pagesViewedLast5Min + topActivePages
    const recentPageviews = await db.event.findMany({
      where: {
        session: { projectId: id },
        type: "pageview",
        timestamp: { gte: since5 },
      },
      select: { pageUrl: true, timestamp: true },
      take: 5000,
    })

    const distinctUrls = new Set<string>()
    const urlCounts: Record<string, number> = {}
    for (const e of recentPageviews) {
      if (e.pageUrl) {
        distinctUrls.add(e.pageUrl)
        urlCounts[e.pageUrl] = (urlCounts[e.pageUrl] || 0) + 1
      }
    }

    const pagesViewedLast5Min = distinctUrls.size

    const topActivePages = Object.entries(urlCounts)
      .map(([url, views]) => ({ url, views }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 5)

    return NextResponse.json({
      activeNow,
      visitorsLast5Min,
      pagesViewedLast5Min,
      topActivePages,
      series: buckets,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "realtime")
    return NextResponse.json(body, { status })
  }
}
