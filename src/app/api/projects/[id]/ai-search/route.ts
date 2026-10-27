import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { logger, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"
import { AI_TIMEOUT_MS } from "@/lib/constants"

// Parsed filters that the LLM may emit.
type ParsedFilters = {
  device?: string
  browser?: string
  country?: string
  city?: string
  utmSource?: string
  isNewVisitor?: boolean
  hasRageClick?: boolean
  hasDeadClick?: boolean
  hasError?: boolean
  convertedGoal?: string // "any" = any conversion
  minDuration?: number // seconds
  minPages?: number
  entryUrl?: string
  exitUrl?: string
  rangeDays?: number
}

type SessionSummary = {
  id: string
  visitorId: string
  startedAt: string
  lastActiveAt: string
  duration: number
  isActive: boolean
  totalClicks: number
  pageViewsCount: number
  hasRageClick: boolean
  hasDeadClick: boolean
  hasError: boolean
  convertedGoal: string
  entryUrl: string
  exitUrl: string
  isNewVisitor: boolean
  device: string
  browser: string
  os: string
  country: string
  city: string
  utmSource: string
  referrer: string
}

const SYSTEM_PROMPT =
  "You convert natural language analytics queries into JSON filter objects for session search. Respond with ONLY valid JSON, no markdown, no explanation. Available filter fields: device (desktop|mobile|tablet), browser (Chrome|Safari|Firefox|Edge), country (string), city (string), utmSource (string), isNewVisitor (boolean), hasRageClick (boolean), hasDeadClick (boolean), hasError (boolean), convertedGoal (string, use \"any\" for any conversion), minDuration (number in seconds), minPages (number), entryUrl (string, partial match), exitUrl (string). Only include fields the user mentioned. If the query mentions a time range like \"last 3 days\", add \"rangeDays\" field. Example query \"mobile users who raged on pricing last week\" → {\"device\":\"mobile\",\"hasRageClick\":true,\"rangeDays\":7}"

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim()
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)

  let body: { query?: string; range?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { filters: null, sessions: [], count: 0, error: "Invalid JSON body" },
      { status: 200 }
    )
  }

  const query = typeof body?.query === "string" ? body.query.trim() : ""
  const bodyRange =
    typeof body?.range === "number" && Number.isFinite(body.range) && body.range > 0
      ? Math.floor(body.range)
      : 7

  if (!query) {
    return NextResponse.json(
      { filters: null, sessions: [], count: 0, error: "Missing query" },
      { status: 200 }
    )
  }

  // ---- Call LLM to parse natural-language query into structured filters ----
  let filters: ParsedFilters = {}
  try {
    const ZAIModule = await import("z-ai-web-dev-sdk")
    const ZAI =
      (ZAIModule as { default?: { create: () => Promise<unknown> } }).default ??
      (ZAIModule as unknown as { create: () => Promise<unknown> })
    const zai = await ZAI.create()
    // 30s timeout — prevents the route from hanging indefinitely if the LLM stalls.
    const completionPromise = (
      zai as {
        chat: {
          completions: {
            create: (args: unknown) => Promise<{
              choices?: { message?: { content?: string } }[]
            }>
          }
        }
      }
    ).chat.completions.create({
      messages: [
        { role: "assistant", content: SYSTEM_PROMPT },
        { role: "user", content: query },
      ],
      thinking: { type: "disabled" },
    })
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("AI_TIMEOUT")), AI_TIMEOUT_MS)
    )
    const completion = (await Promise.race([completionPromise, timeoutPromise])) as {
      choices?: { message?: { content?: string } }[]
    }

    const raw = completion.choices?.[0]?.message?.content ?? ""
    if (!raw) {
      return NextResponse.json(
        { filters: null, sessions: [], count: 0, error: "Empty LLM response" },
        { status: 200 }
      )
    }

    const cleaned = stripFences(raw)
    filters = JSON.parse(cleaned) as ParsedFilters
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
      throw new Error("Parsed filters is not an object")
    }
  } catch (e) {
    // Log the real error server-side; return only a generic message to the client.
    const err = e instanceof Error ? e : new Error(String(e))
    logger.error("ai_error", {
      requestId,
      context: "ai_search_parse",
      error: err.message,
      stack: err.stack?.slice(0, 500),
    })
    return NextResponse.json(
      {
        filters: null,
        sessions: [],
        count: 0,
        error: "Search unavailable",
      },
      { status: 200 }
    )
  }

  // ---- Build Prisma where clause from parsed filters ----
  const rangeDays =
    typeof filters.rangeDays === "number" &&
    Number.isFinite(filters.rangeDays) &&
    filters.rangeDays > 0
      ? Math.floor(filters.rangeDays)
      : bodyRange
  const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000)

  const where: Record<string, unknown> = {
    projectId: id,
    startedAt: { gte: since },
  }

  if (typeof filters.device === "string" && filters.device.trim()) {
    where.device = filters.device.trim().toLowerCase()
  }
  if (typeof filters.browser === "string" && filters.browser.trim()) {
    where.browser = { contains: filters.browser.trim() }
  }
  if (typeof filters.country === "string" && filters.country.trim()) {
    where.country = { contains: filters.country.trim() }
  }
  if (typeof filters.city === "string" && filters.city.trim()) {
    where.city = { contains: filters.city.trim() }
  }
  if (typeof filters.utmSource === "string" && filters.utmSource.trim()) {
    where.utmSource = { contains: filters.utmSource.trim() }
  }
  if (typeof filters.isNewVisitor === "boolean") {
    where.isNewVisitor = filters.isNewVisitor
  }
  if (typeof filters.hasRageClick === "boolean") {
    where.hasRageClick = filters.hasRageClick
  }
  if (typeof filters.hasDeadClick === "boolean") {
    where.hasDeadClick = filters.hasDeadClick
  }
  if (typeof filters.hasError === "boolean") {
    where.hasError = filters.hasError
  }
  if (typeof filters.convertedGoal === "string" && filters.convertedGoal.trim()) {
    if (filters.convertedGoal.trim().toLowerCase() === "any") {
      // any non-empty convertedGoal
      where.convertedGoal = { not: "" }
    } else {
      where.convertedGoal = { contains: filters.convertedGoal.trim() }
    }
  }
  if (typeof filters.minDuration === "number" && Number.isFinite(filters.minDuration)) {
    where.duration = { gte: Math.max(0, Math.floor(filters.minDuration * 1000)) }
  }
  if (typeof filters.minPages === "number" && Number.isFinite(filters.minPages)) {
    where.pageViewsCount = { gte: Math.max(0, Math.floor(filters.minPages)) }
  }
  if (typeof filters.entryUrl === "string" && filters.entryUrl.trim()) {
    where.entryUrl = { contains: filters.entryUrl.trim() }
  }
  if (typeof filters.exitUrl === "string" && filters.exitUrl.trim()) {
    where.exitUrl = { contains: filters.exitUrl.trim() }
  }

  // ---- Fetch matching sessions ----
  try {
    const rows = await db.session.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: 200,
      select: {
        id: true,
        visitorId: true,
        startedAt: true,
        lastActiveAt: true,
        duration: true,
        isActive: true,
        totalClicks: true,
        pageViewsCount: true,
        hasRageClick: true,
        hasDeadClick: true,
        hasError: true,
        convertedGoal: true,
        entryUrl: true,
        exitUrl: true,
        isNewVisitor: true,
        device: true,
        browser: true,
        os: true,
        country: true,
        city: true,
        utmSource: true,
        referrer: true,
      },
    })

    const sessions: SessionSummary[] = rows.map((s) => ({
      id: s.id,
      visitorId: s.visitorId,
      startedAt: s.startedAt.toISOString(),
      lastActiveAt: s.lastActiveAt.toISOString(),
      duration: s.duration,
      isActive: s.isActive,
      totalClicks: s.totalClicks,
      pageViewsCount: s.pageViewsCount,
      hasRageClick: s.hasRageClick,
      hasDeadClick: s.hasDeadClick,
      hasError: s.hasError,
      convertedGoal: s.convertedGoal,
      entryUrl: s.entryUrl,
      exitUrl: s.exitUrl,
      isNewVisitor: s.isNewVisitor,
      device: s.device,
      browser: s.browser,
      os: s.os,
      country: s.country,
      city: s.city,
      utmSource: s.utmSource,
      referrer: s.referrer,
    }))

    return NextResponse.json({
      filters,
      sessions,
      count: sessions.length,
    })
  } catch (e) {
    // Log the real error server-side; return only a generic message to the client.
    const err = e instanceof Error ? e : new Error(String(e))
    logger.error("ai_error", {
      requestId,
      context: "ai_search_query",
      error: err.message,
      stack: err.stack?.slice(0, 500),
    })
    return NextResponse.json(
      {
        filters,
        sessions: [],
        count: 0,
        error: "Search unavailable",
      },
      { status: 200 }
    )
  }
}
