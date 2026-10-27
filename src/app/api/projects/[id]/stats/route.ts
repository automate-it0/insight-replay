import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { cacheGet, cacheSet } from "@/lib/cache"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// Cache TTL: stats aggregations don't need to be real-time — 60s staleness is
// acceptable for a dashboard that polls every 8s. This window is stated
// explicitly so future tuners know the trade-off.
const STATS_CACHE_TTL_MS = 60 * 1000

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const range = req.nextUrl.searchParams.get("range") || "7"

  // Cache key includes every input the response varies on (projectId + range).
  // No per-user data is cached under a key that does not identify the user —
  // stats are project-scoped, not viewer-scoped, so this is safe.
  const cacheKey = `stats:${id}:${range}`
  const cached = cacheGet<{ body: Record<string, unknown>; cachedAt: number }>(cacheKey)
  if (cached) {
    return NextResponse.json({ ...cached.body, cached: true, cachedAt: cached.cachedAt })
  }

  const days = parseInt(range, 10)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const sessions = await db.session.findMany({
    where: { projectId: id, startedAt: { gte: since } },
    select: {
      id: true, startedAt: true, duration: true, device: true, browser: true,
      os: true, country: true, city: true, totalClicks: true, pageViewsCount: true,
      isActive: true, hasRageClick: true, hasDeadClick: true, visitorId: true,
      screenWidth: true, screenHeight: true, language: true,
      referrer: true, utmSource: true, utmMedium: true, entryUrl: true, exitUrl: true,
      isNewVisitor: true, hasError: true, convertedGoal: true,
    },
    // Bounded — DoS protection. The stats endpoint aggregates every
    // matching session in memory; without a cap an attacker-driven project
    // with millions of sessions would exhaust process memory. 5000 covers
    // a busy project's typical 7-30 day range; beyond that the dashboard
    // should switch to SQL-side aggregation.
    take: 5000,
  })

  // Daily buckets
  const daily: Record<string, { date: string; sessions: number; clicks: number; pages: number }> = {}
  for (let i = days - 1; i >= 0; i--) {
    const d = startOfDay(new Date(Date.now() - i * 86400000))
    const key = d.toISOString().slice(0, 10)
    daily[key] = { date: key, sessions: 0, clicks: 0, pages: 0 }
  }
  for (const s of sessions) {
    const key = startOfDay(s.startedAt).toISOString().slice(0, 10)
    if (daily[key]) {
      daily[key].sessions += 1
      daily[key].clicks += s.totalClicks
      daily[key].pages += s.pageViewsCount
    }
  }

  // Breakdowns
  const device: Record<string, number> = {}
  const browser: Record<string, number> = {}
  const os: Record<string, number> = {}
  const country: Record<string, number> = {}
  const referrer: Record<string, number> = {}
  const utmSource: Record<string, number> = {}
  const entryUrl: Record<string, number> = {}
  const exitUrl: Record<string, number> = {}

  // Page-level stats from events (top pages)
  const pageAgg = await db.event.groupBy({
    where: { session: { projectId: id }, type: "pageview", timestamp: { gte: since } },
    by: ["pageUrl"],
    _count: true,
    orderBy: { _count: { pageUrl: "desc" } },
    take: 8,
  })

  for (const s of sessions) {
    device[s.device] = (device[s.device] || 0) + 1
    browser[s.browser] = (browser[s.browser] || 0) + 1
    os[s.os] = (os[s.os] || 0) + 1
    country[s.country] = (country[s.country] || 0) + 1
    if (s.referrer) {
      try {
        const host = new URL(s.referrer).hostname.replace(/^www\./, "")
        referrer[host] = (referrer[host] || 0) + 1
      } catch {
        referrer[s.referrer] = (referrer[s.referrer] || 0) + 1
      }
    } else {
      referrer["Direct"] = (referrer["Direct"] || 0) + 1
    }
    if (s.utmSource) utmSource[s.utmSource] = (utmSource[s.utmSource] || 0) + 1
    entryUrl[s.entryUrl] = (entryUrl[s.entryUrl] || 0) + 1
    exitUrl[s.exitUrl] = (exitUrl[s.exitUrl] || 0) + 1
  }

  const totalSessions = sessions.length
  const activeNow = sessions.filter((s) => s.isActive).length
  const totalClicks = sessions.reduce((a, s) => a + s.totalClicks, 0)
  const totalPages = sessions.reduce((a, s) => a + s.pageViewsCount, 0)
  const avgDuration = totalSessions
    ? Math.round(sessions.reduce((a, s) => a + s.duration, 0) / totalSessions)
    : 0
  const rageClicks = sessions.filter((s) => s.hasRageClick).length
  const deadClicks = sessions.filter((s) => s.hasDeadClick).length
  const errors = sessions.filter((s) => s.hasError).length
  const uniqueVisitors = new Set(sessions.map((s) => s.visitorId)).size
  const newVisitors = sessions.filter((s) => s.isNewVisitor).length
  const returningVisitors = totalSessions - newVisitors
  const conversions = sessions.filter((s) => s.convertedGoal && s.convertedGoal !== "").length
  const bounceRate = totalSessions
    ? Math.round((sessions.filter((s) => s.pageViewsCount <= 1).length / totalSessions) * 100)
    : 0
  const conversionRate = totalSessions ? Math.round((conversions / totalSessions) * 100) : 0

  const body = {
    range: days,
    totals: {
      totalSessions,
      activeNow,
      totalClicks,
      totalPages,
      avgDuration,
      rageClicks,
      deadClicks,
      errors,
      uniqueVisitors,
      newVisitors,
      returningVisitors,
      conversions,
      conversionRate,
      bounceRate,
    },
    daily: Object.values(daily),
    device: Object.entries(device).map(([name, value]) => ({ name, value })),
    browser: Object.entries(browser).map(([name, value]) => ({ name, value })),
    os: Object.entries(os).map(([name, value]) => ({ name, value })),
    country: Object.entries(country)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8),
    referrer: Object.entries(referrer)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8),
    utmSource: Object.entries(utmSource)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8),
    entryPages: Object.entries(entryUrl)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6),
    exitPages: Object.entries(exitUrl)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6),
    // With `_count: true`, Prisma returns `{ _count: number }` per group —
    // access the scalar directly. Using `p._count.pageUrl` here would yield
    // `undefined` at runtime (numbers have no `pageUrl` property).
    topPages: pageAgg.map((p) => ({ url: p.pageUrl, views: p._count })),
  }

  const cachedAt = Date.now()
  // Store the body (without `cached`/`cachedAt`) so the cached entry is
  // reused on hit — the wrapper at the top adds the `cached`/`cachedAt` fields.
  cacheSet(cacheKey, { body, cachedAt }, STATS_CACHE_TTL_MS)

  return NextResponse.json({ ...body, cached: false, cachedAt })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "stats")
    return NextResponse.json(body, { status })
  }
}
