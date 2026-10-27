import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

// Query-string schema for GET /api/projects/[id]/errors. The `sessionId`
// parameter is spread directly into the Prisma `where` clause — validating
// it with Zod bounds length (max 100, session ids are CUID-like) and shape
// (alphanumeric + `_` + `-`) so an attacker can't push a 1MB string or a
// value containing control chars into the clause.
const ErrorsQuerySchema = z.object({
  range: z
    .string()
    .max(8)
    .default("7")
    .transform((v) => {
      const n = parseInt(v, 10)
      return Number.isFinite(n) && n > 0 && n < 3650 ? n : 7
    }),
  sessionId: z
    .string()
    .max(100)
    .regex(/^[A-Za-z0-9_-]*$/)
    .optional(),
})

// GET — list JS errors for a project + aggregate (by type/url, affected sessions, daily trend)
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const sp = req.nextUrl.searchParams
    const parsed = ErrorsQuerySchema.safeParse({
      range: sp.get("range") ?? undefined,
      sessionId: sp.get("sessionId") ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid query" },
        { status: 400 },
      )
    }
    const days = parsed.data.range
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const sessionId = parsed.data.sessionId

    const errors = await db.errorEvent.findMany({
      where: {
        projectId: id,
        timestamp: { gte: since },
        ...(sessionId ? { sessionId } : {}),
      },
      include: {
        session: {
          select: { id: true, visitorId: true, country: true, city: true, browser: true, device: true, startedAt: true },
        },
      },
      orderBy: { timestamp: "desc" },
      take: 200,
    })

    // Aggregates
    const byType: Record<string, number> = {}
    const byUrlMap: Record<string, number> = {}
    const affectedSessions = new Set<string>()

    // Daily buckets
    const daily: Record<string, { date: string; count: number }> = {}
    for (let i = days - 1; i >= 0; i--) {
      const d = startOfDay(new Date(Date.now() - i * 86400000))
      const key = d.toISOString().slice(0, 10)
      daily[key] = { date: key, count: 0 }
    }

    for (const e of errors) {
      byType[e.type] = (byType[e.type] || 0) + 1
      byUrlMap[e.url] = (byUrlMap[e.url] || 0) + 1
      if (e.session) affectedSessions.add(e.session.id)

      const key = startOfDay(e.timestamp).toISOString().slice(0, 10)
      if (daily[key]) daily[key].count += 1
    }

    const byUrl = Object.entries(byUrlMap)
      .map(([url, count]) => ({ url, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)

    return NextResponse.json({
      errors,
      aggregate: {
        total: errors.length,
        byType,
        byUrl,
        affectedSessions: affectedSessions.size,
        daily: Object.values(daily),
      },
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "errors")
    return NextResponse.json(body, { status })
  }
}
