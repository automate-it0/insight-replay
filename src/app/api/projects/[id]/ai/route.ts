import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { logger, getRequestId, sanitizeError } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"
import { AI_TIMEOUT_MS } from "@/lib/constants"

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
  country: string
  device: string
  browser: string
  os: string
  utmSource: string
  referrer: string
}

function buildProjectDescription(
  stats: {
    totalSessions: number
    totalClicks: number
    totalPages: number
    avgDuration: number
    rageClicks: number
    deadClicks: number
    errors: number
    conversions: number
    bounceRate: number
    uniqueVisitors: number
  },
  topPages: { url: string; views: number }[],
  topCountries: { name: string; value: number }[],
  topReferrers: { name: string; value: number }[],
  deviceBreakdown: { name: string; value: number }[],
  browserBreakdown: { name: string; value: number }[],
  daily: { date: string; sessions: number }[],
  recentInsights: { type: string; severity: string; pageUrl?: string | undefined }[]
): string {
  const parts: string[] = []

  parts.push(`# Project analytics (last N days)`)
  parts.push(
    `## Totals`
  )
  parts.push(
    [
      `Sessions: ${stats.totalSessions}`,
      `Unique visitors: ${stats.uniqueVisitors}`,
      `Page views: ${stats.totalPages}`,
      `Clicks: ${stats.totalClicks}`,
      `Avg duration: ${Math.round(stats.avgDuration / 1000)}s`,
      `Bounce rate: ${stats.bounceRate}%`,
      `Conversions: ${stats.conversions}`,
    ].join(" | ")
  )
  parts.push(
    `Frustration & errors: rage clicks ${stats.rageClicks} | dead clicks ${stats.deadClicks} | JS errors ${stats.errors}`
  )

  if (topPages.length) {
    parts.push(
      `## Top pages\n` +
        topPages.map((p, i) => `${i + 1}. ${p.url} (${p.views} views)`).join("\n")
    )
  }

  if (topCountries.length) {
    parts.push(
      `## Top countries: ` +
        topCountries.map((c) => `${c.name} (${c.value})`).join(", ")
    )
  }

  if (topReferrers.length) {
    parts.push(
      `## Top referrers / UTM sources: ` +
        topReferrers.map((r) => `${r.name || "(direct)"} (${r.value})`).join(", ")
    )
  }

  if (deviceBreakdown.length) {
    parts.push(
      `## Devices: ` + deviceBreakdown.map((d) => `${d.name} (${d.value})`).join(", ")
    )
  }
  if (browserBreakdown.length) {
    parts.push(
      `## Browsers: ` + browserBreakdown.map((b) => `${b.name} (${b.value})`).join(", ")
    )
  }

  if (daily.length) {
    parts.push(
      `## Daily sessions (last ${daily.length} days)\n` +
        daily.map((d) => `${d.date}: ${d.sessions}`).join(", ")
    )
  }

  if (recentInsights.length) {
    const grouped: Record<string, number> = {}
    for (const i of recentInsights) grouped[i.type] = (grouped[i.type] || 0) + 1
    parts.push(
      `## Recent frustration signals (${recentInsights.length} sampled)\n` +
        Object.entries(grouped)
          .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`)
          .join("\n")
    )
    // Show a few concrete examples
    const examples = recentInsights.slice(0, 5).map((i) => {
      return `- ${i.type.replace(/_/g, " ")} (${i.severity})${i.pageUrl ? ` on ${i.pageUrl}` : ""}`
    })
    if (examples.length) parts.push(`Examples:\n${examples.join("\n")}`)
  }

  return parts.join("\n\n")
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
    const since = new Date(Date.now() - range * 24 * 60 * 60 * 1000)

  const sessions: SessionRow[] = await db.session.findMany({
    where: { projectId: id, startedAt: { gte: since } },
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
      country: true,
      device: true,
      browser: true,
      os: true,
      utmSource: true,
      referrer: true,
    },
    // Bounded — DoS protection. The AI route feeds every matching session
    // into an LLM prompt; an unbounded project could blow up both memory
    // and the LLM context window. 5000 sessions fits a 30-day range on
    // a busy project; beyond that the summary description should be built
    // from SQL-side aggregation, not raw session rows.
    take: 5000,
  })

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

  // Top pages (pageview events)
  const pageAgg = await db.event.groupBy({
    where: { session: { projectId: id }, type: "pageview", timestamp: { gte: since } },
    by: ["pageUrl"],
    _count: { pageUrl: true },
    orderBy: { _count: { pageUrl: "desc" } },
    take: 8,
  })

  // Breakdowns
  const deviceMap: Record<string, number> = {}
  const browserMap: Record<string, number> = {}
  const countryMap: Record<string, number> = {}
  const referrerMap: Record<string, number> = {}
  for (const s of sessions) {
    deviceMap[s.device] = (deviceMap[s.device] || 0) + 1
    browserMap[s.browser] = (browserMap[s.browser] || 0) + 1
    countryMap[s.country] = (countryMap[s.country] || 0) + 1
    const ref = s.utmSource || s.referrer || ""
    const key = ref || "(direct)"
    referrerMap[key] = (referrerMap[key] || 0) + 1
  }

  // Daily series
  const dailyMap: Record<string, { date: string; sessions: number }> = {}
  for (let i = range - 1; i >= 0; i--) {
    const d = startOfDay(new Date(Date.now() - i * 86400000))
    const key = d.toISOString().slice(0, 10)
    dailyMap[key] = { date: key, sessions: 0 }
  }
  for (const s of sessions) {
    const key = startOfDay(s.startedAt).toISOString().slice(0, 10)
    if (dailyMap[key]) dailyMap[key].sessions += 1
  }

  // Recent insights sample
  const recentInsightRows = await db.insight.findMany({
    where: { projectId: id, timestamp: { gte: since } },
    orderBy: { timestamp: "desc" },
    take: 30,
    select: { type: true, severity: true, data: true, session: { select: { entryUrl: true } } },
  })
  const recentInsights = recentInsightRows.map((i) => {
    let pageUrl: string | undefined
    try {
      const d = JSON.parse(i.data || "{}")
      pageUrl = d.pageUrl || d.url || i.session?.entryUrl
    } catch {
      pageUrl = i.session?.entryUrl
    }
    return { type: i.type, severity: i.severity, pageUrl }
  })

  const description = buildProjectDescription(
    {
      totalSessions,
      totalClicks,
      totalPages,
      avgDuration,
      rageClicks,
      deadClicks,
      errors,
      conversions,
      bounceRate,
      uniqueVisitors,
    },
    pageAgg.map((p) => ({ url: p.pageUrl, views: p._count.pageUrl })),
    Object.entries(countryMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8),
    Object.entries(referrerMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8),
    Object.entries(deviceMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value),
    Object.entries(browserMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value),
    Object.values(dailyMap),
    recentInsights
  )

  try {
    const ZAIModule = await import("z-ai-web-dev-sdk")
    const ZAI = (ZAIModule as { default: { create: () => Promise<unknown> } }).default ?? (ZAIModule as unknown as { create: () => Promise<unknown> })
    const zai = await ZAI.create()
    // 30s timeout — prevents the route from hanging indefinitely if the LLM
    // stalls. The Promise.race rejects with AI_TIMEOUT, caught below.
    const completionPromise = (zai as {
      chat: {
        completions: {
          create: (args: unknown) => Promise<{
            choices?: { message?: { content?: string } }[]
          }>
        }
      }
    }).chat.completions.create({
      messages: [
        {
          role: "assistant",
          content:
            "You are an expert product analyst. Analyze website analytics and surface actionable insights. Respond in clean markdown with sections: ## Overview, ## Key trends, ## Frustration signals, ## Top opportunities, ## Recommended actions. Be specific, data-driven, and concise.",
        },
        { role: "user", content: description },
      ],
      thinking: { type: "disabled" },
    })
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("AI_TIMEOUT")), AI_TIMEOUT_MS)
    )
    const completion = (await Promise.race([completionPromise, timeoutPromise])) as {
      choices?: { message?: { content?: string } }[]
    }
    const result = completion.choices?.[0]?.message?.content ?? ""
    return NextResponse.json({ analysis: result || null })
  } catch (e) {
    // Log the real error server-side; return only a generic message to the
    // client (status 200 so the UI doesn't show a hard error).
    const err = e instanceof Error ? e : new Error(String(e))
    logger.error("ai_error", {
      requestId,
      context: "ai_project_insights",
      error: err.message,
      stack: err.stack?.slice(0, 500),
    })
    return NextResponse.json(
      { analysis: null, error: "AI analysis unavailable" },
      { status: 200 }
    )
  }
  } catch (e) {
    // Outer catch — wraps the Prisma queries that run BEFORE the LLM call
    // (sessions, pageAgg, recentInsightRows). Without this outer try, a
    // Prisma error here would escape as an unhandled promise rejection and
    // Next.js would serve its default 500 page (which in dev includes the
    // stack trace + Prisma class name — an info disclosure) or a generic
    // 500 in prod (which breaks the API's JSON contract — callers expect
    // `{ analysis, error? }`, not an HTML error page).
    // sanitizeError() logs the real error server-side under
    // event="api_error" context="ai_project_insights" and returns a generic
    // envelope, matching the shape used by every other route.
    const { status, body } = sanitizeError(e, requestId, "ai_project_insights")
    return NextResponse.json(body, { status })
  }
}
