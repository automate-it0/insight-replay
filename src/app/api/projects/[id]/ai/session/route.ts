import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { logger, getRequestId, sanitizeError } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"
import { AI_TIMEOUT_MS } from "@/lib/constants"

type EventRow = {
  type: string
  t: number
  pageUrl: string
  scrollY: number
  x: number
  y: number
  data: string
}

type InsightRow = {
  type: string
  severity: string
  data: string
}

function safeParse<T = Record<string, unknown>>(s: string | null | undefined): T {
  try {
    return (s ? JSON.parse(s) : {}) as T
  } catch {
    return {} as T
  }
}

function fmtDuration(ms: number) {
  if (!ms) return "0s"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}

function buildSessionDescription(session: {
  visitorId: string
  device: string
  browser: string
  os: string
  country: string
  city: string
  duration: number
  pageViewsCount: number
  totalClicks: number
  hasRageClick: boolean
  hasDeadClick: boolean
  hasError: boolean
  convertedGoal: string
  isNewVisitor: boolean
  entryUrl: string
  exitUrl: string
  referrer: string
  utmSource: string
  screenWidth: number
  screenHeight: number
  startedAt: Date
}, events: EventRow[], insights: InsightRow[]): string {
  const parts: string[] = []

  parts.push(`Visitor: ${session.visitorId} ${session.isNewVisitor ? "(new)" : "(returning)"}`)
  parts.push(
    `Environment: ${session.device} / ${session.browser} / ${session.os}, ${session.country}${session.city && session.city !== "Unknown" ? " / " + session.city : ""}, viewport ${session.screenWidth}x${session.screenHeight}`
  )
  parts.push(
    `Duration: ${fmtDuration(session.duration)} | Page views: ${session.pageViewsCount} | Clicks: ${session.totalClicks}`
  )
  if (session.referrer) parts.push(`Referrer: ${session.referrer}`)
  if (session.utmSource) parts.push(`UTM source: ${session.utmSource}`)
  if (session.convertedGoal) parts.push(`Converted goal: ${session.convertedGoal}`)
  if (session.hasRageClick) parts.push("Flag: rage click detected")
  if (session.hasDeadClick) parts.push("Flag: dead click detected")
  if (session.hasError) parts.push("Flag: JS error during session")

  // Page flow (from pageview events in order)
  const pageviews = events.filter((e) => e.type === "pageview")
  if (pageviews.length) {
    const flow: string[] = []
    for (const pv of pageviews) {
      const d = safeParse<{ title?: string }>(pv.data)
      flow.push(d.title ? `${pv.pageUrl} (${d.title})` : pv.pageUrl)
    }
    parts.push(`Page flow: ${flow.join(" -> ")}`)
  } else if (session.entryUrl) {
    parts.push(`Entry URL: ${session.entryUrl}`)
    if (session.exitUrl && session.exitUrl !== session.entryUrl) {
      parts.push(`Exit URL: ${session.exitUrl}`)
    }
  }

  // Click summary (compact, dedupe by approximate target text)
  const clicks = events.filter((e) => e.type === "click")
  if (clicks.length) {
    const targets: Record<string, number> = {}
    let maxScrollY = 0
    for (const c of clicks) {
      const d = safeParse<{ text?: string; target?: string }>(c.data)
      const label = d.text || d.target || `(${c.x},${c.y})`
      const key = label.length > 24 ? label.slice(0, 24) + "…" : label
      targets[key] = (targets[key] || 0) + 1
      if (c.scrollY > maxScrollY) maxScrollY = c.scrollY
    }
    const clickSummary = Object.entries(targets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `'${k}'${v > 1 ? ` x${v}` : ""}`)
      .join(", ")
    parts.push(`Click targets: ${clickSummary}`)
    parts.push(`Max scroll depth: ${maxScrollY}px`)
  } else {
    const maxScroll = events.reduce((m, e) => (e.scrollY > m ? e.scrollY : m), 0)
    if (maxScroll) parts.push(`Max scroll depth: ${maxScroll}px`)
  }

  // Notable insights
  if (insights.length) {
    const grouped: Record<string, number> = {}
    for (const ins of insights) grouped[ins.type] = (grouped[ins.type] || 0) + 1
    const summary = Object.entries(grouped)
      .map(([type, count]) => `${type.replace(/_/g, " ")}${count > 1 ? ` x${count}` : ""}`)
      .join(", ")
    parts.push(`Frustration signals: ${summary}`)
    // One example detail
    const example = insights[0]
    if (example) {
      const d = safeParse<Record<string, unknown>>(example.data)
      const detail = Object.entries(d)
        .slice(0, 3)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")
      if (detail) parts.push(`Example insight (${example.type}, ${example.severity}): ${detail}`)
    }
  }

  // Errors
  const errorEvents = events.filter((e) => e.type === "error" || (e.data && e.data.includes('"error"')))
  if (errorEvents.length && session.hasError) {
    parts.push(`JS errors recorded: ${errorEvents.length}`)
  }

  return parts.join("\n")
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session: authSession, error } = await verifyProjectAccess(id)
  if (error) return error
  void authSession
  const requestId = getRequestId(req as unknown as Request)
  try {
    return await handleAiSession(req, id, requestId)
  } catch (e) {
    // Outer catch — wraps the Prisma queries (session lookup, event/insight
    // fetches) that run BEFORE the inner LLM try/catch. Without this, a
    // Prisma error here would bubble up as an unhandled promise rejection;
    // Next.js would then serve its default 500 page (in dev that includes
    // the stack trace + Prisma class name — an info disclosure; in prod it
    // returns a generic HTML error that breaks the API's JSON contract).
    // sanitizeError() logs the real error server-side under event="api_error"
    // context="ai_session_analysis" and returns a generic envelope.
    const { status, body } = sanitizeError(e, requestId, "ai_session_analysis")
    return NextResponse.json(body, { status })
  }
}

async function handleAiSession(req: NextRequest, id: string, requestId: string) {
  let body: { sessionId?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ analysis: null, error: "invalid body" }, { status: 200 })
  }

  const sessionId = body.sessionId
  if (!sessionId) {
    return NextResponse.json({ analysis: null, error: "sessionId required" }, { status: 200 })
  }

  const session = await db.session.findUnique({ where: { id: sessionId } })

  if (!session) {
    return NextResponse.json({ analysis: null, error: "session not found" }, { status: 200 })
  }
  if (session.projectId !== id) {
    return NextResponse.json({ analysis: null, error: "session does not belong to project" }, { status: 200 })
  }

  const [eventRows, insightRows] = await Promise.all([
    db.event.findMany({
      where: { sessionId },
      orderBy: { t: "asc" },
      take: 2000,
    }),
    db.insight.findMany({
      where: { sessionId },
      orderBy: { timestamp: "asc" },
      take: 1000,
    }),
  ])

  const description = buildSessionDescription(
    {
      visitorId: session.visitorId,
      device: session.device,
      browser: session.browser,
      os: session.os,
      country: session.country,
      city: session.city,
      duration: session.duration,
      pageViewsCount: session.pageViewsCount,
      totalClicks: session.totalClicks,
      hasRageClick: session.hasRageClick,
      hasDeadClick: session.hasDeadClick,
      hasError: session.hasError,
      convertedGoal: session.convertedGoal,
      isNewVisitor: session.isNewVisitor,
      entryUrl: session.entryUrl,
      exitUrl: session.exitUrl,
      referrer: session.referrer,
      utmSource: session.utmSource,
      screenWidth: session.screenWidth,
      screenHeight: session.screenHeight,
      startedAt: session.startedAt,
    },
    eventRows.map((e) => ({
      type: e.type,
      t: e.t,
      pageUrl: e.pageUrl,
      scrollY: e.scrollY,
      x: e.x,
      y: e.y,
      data: e.data,
    })),
    insightRows.map((i) => ({
      type: i.type,
      severity: i.severity,
      data: i.data,
    }))
  )

  try {
    // Imported lazily so the SDK only loads in the route handler (server-side).
    const ZAIModule = await import("z-ai-web-dev-sdk")
    const ZAI = (ZAIModule as { default: { create: () => Promise<unknown> } }).default ?? (ZAIModule as unknown as { create: () => Promise<unknown> })
    const zai = await ZAI.create()
    // 30s timeout — prevents the route from hanging indefinitely if the LLM stalls.
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
            "You are an expert product analyst. Analyze user session recordings and provide concise, actionable insights. Respond in clean markdown with these sections: ## Summary, ## What happened, ## Pain points, ## Recommendations. Be specific and brief.",
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
    // Log the real error server-side; return only a generic message to the client.
    const err = e instanceof Error ? e : new Error(String(e))
    logger.error("ai_error", {
      requestId,
      context: "ai_session_analysis",
      error: err.message,
      stack: err.stack?.slice(0, 500),
    })
    return NextResponse.json(
      { analysis: null, error: "AI analysis unavailable" },
      { status: 200 }
    )
  }
}
