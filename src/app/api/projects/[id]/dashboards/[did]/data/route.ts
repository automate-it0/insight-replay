import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

interface Widget {
  id: string
  type: string
  title?: string
  metric?: string
  chart?: string
  table?: string
  w?: number
  h?: number
  x?: number
  y?: number
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; did: string }> }) {
  const { id, did } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const dashboard = await db.dashboard.findFirst({ where: { id: did, projectId: id } })
    if (!dashboard) return NextResponse.json({ error: "not found" }, { status: 404 })

    const layout = JSON.parse(dashboard.layout || "[]") as Widget[]
    if (!Array.isArray(layout) || layout.length === 0) {
      return NextResponse.json({ dashboard: { ...dashboard, layout }, widgets: {} })
    }

    const rangeStr = req.nextUrl.searchParams.get("range") || "7"
    const days = parseInt(rangeStr, 10) || 7
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    // Fetch all sessions in range with the fields any widget may need
    const sessions = await db.session.findMany({
      where: { projectId: id, startedAt: { gte: since } },
      select: {
        id: true,
        startedAt: true,
        duration: true,
        device: true,
        browser: true,
        os: true,
        country: true,
        city: true,
        totalClicks: true,
        pageViewsCount: true,
        isActive: true,
        hasRageClick: true,
        hasDeadClick: true,
        hasError: true,
        visitorId: true,
        referrer: true,
        utmSource: true,
        isNewVisitor: true,
        convertedGoal: true,
      },
      // Bounded — DoS protection. Dashboard widgets aggregate every
      // matching session in memory; 5000 covers a busy project's typical
      // 7-30 day range. Beyond that, widgets should be rewritten to use
      // SQL-side aggregation (groupBy / count) instead of in-memory loops.
      take: 5000,
    })

    // Top pages via event groupBy (only if any table widget needs it)
    const needsTopPages = layout.some((w) => w.type === "table" && w.table === "topPages")
    let topPages: { url: string; views: number }[] = []
    if (needsTopPages) {
      const pageAgg = await db.event.groupBy({
        where: { session: { projectId: id }, type: "pageview", timestamp: { gte: since } },
        by: ["pageUrl"],
        _count: { pageUrl: true },
        orderBy: { _count: { pageUrl: "desc" } },
        take: 10,
      })
      topPages = pageAgg.map((p) => ({ url: p.pageUrl, views: p._count.pageUrl }))
    }

    // Daily buckets (sessions + errors) pre-seeded for the range
    const daily: Record<string, { date: string; sessions: number; errors: number }> = {}
    for (let i = days - 1; i >= 0; i--) {
      const d = startOfDay(new Date(Date.now() - i * 86400000))
      const key = d.toISOString().slice(0, 10)
      daily[key] = { date: key, sessions: 0, errors: 0 }
    }

    // Breakdown accumulators
    const deviceMap: Record<string, number> = {}
    const browserMap: Record<string, number> = {}
    const countryMap: Record<string, number> = {}
    const referrerMap: Record<string, number> = {}

    // Totals
    let totalSessions = sessions.length
    let activeNow = 0
    let totalClicks = 0
    let totalDuration = 0
    let rageClicks = 0
    let deadClicks = 0
    let errors = 0
    let conversions = 0
    let bounceCount = 0
    const visitorSet = new Set<string>()

    for (const s of sessions) {
      const key = startOfDay(s.startedAt).toISOString().slice(0, 10)
      if (daily[key]) {
        daily[key].sessions += 1
        if (s.hasError) daily[key].errors += 1
      }
      if (s.isActive) activeNow += 1
      totalClicks += s.totalClicks
      totalDuration += s.duration
      if (s.hasRageClick) rageClicks += 1
      if (s.hasDeadClick) deadClicks += 1
      if (s.hasError) errors += 1
      if (s.convertedGoal && s.convertedGoal !== "") conversions += 1
      if (s.pageViewsCount <= 1) bounceCount += 1
      visitorSet.add(s.visitorId)

      deviceMap[s.device] = (deviceMap[s.device] || 0) + 1
      browserMap[s.browser] = (browserMap[s.browser] || 0) + 1
      countryMap[s.country] = (countryMap[s.country] || 0) + 1
      const ref = s.referrer && s.referrer !== ""
        ? safeHost(s.referrer)
        : "Direct"
      referrerMap[ref] = (referrerMap[ref] || 0) + 1
    }

    const avgDuration = totalSessions ? Math.round(totalDuration / totalSessions) : 0
    const bounceRate = totalSessions ? Math.round((bounceCount / totalSessions) * 100) : 0
    const uniqueVisitors = visitorSet.size

    const metricValues: Record<string, number> = {
      totalSessions,
      conversions,
      rageClicks,
      errors,
      avgDuration,
      bounceRate,
      activeNow,
      uniqueVisitors,
    }

    const dailyArr = Object.values(daily)
    const deviceArr = Object.entries(deviceMap).map(([name, value]) => ({ name, value }))
    const browserArr = Object.entries(browserMap).map(([name, value]) => ({ name, value }))
    const countryArr = Object.entries(countryMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
    const referrerArr = Object.entries(referrerMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)

    // Compute each widget's data
    const widgets: Record<string, { data: unknown }> = {}
    for (const w of layout) {
      if (!w.id) continue
      let data: unknown = null
      if (w.type === "metric") {
        const key = (w.metric || "").trim()
        data = { value: metricValues[key] ?? 0, label: w.title || key }
      } else if (w.type === "chart") {
        const kind = (w.chart || "").trim()
        if (kind === "area") {
          data = dailyArr
        } else if (kind === "pie") {
          data = deviceArr
        } else if (kind === "bar") {
          // default: daily errors; if widget.metric === "browser" return browser breakdown
          if (w.metric === "browser") {
            data = browserArr
          } else {
            data = dailyArr.map((d) => ({ date: d.date, errors: d.errors }))
          }
        }
      } else if (w.type === "table") {
        const kind = (w.table || "").trim()
        if (kind === "topPages") {
          data = topPages
        } else if (kind === "referrer") {
          data = referrerArr
        } else if (kind === "country") {
          data = countryArr
        }
      }
      widgets[w.id] = { data }
    }

    return NextResponse.json({
      dashboard: { ...dashboard, layout },
      widgets,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "dashboard_data")
    return NextResponse.json(body, { status })
  }
}

function safeHost(referrer: string): string {
  try {
    return new URL(referrer).hostname.replace(/^www\./, "")
  } catch {
    return referrer
  }
}
