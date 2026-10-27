import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const range = req.nextUrl.searchParams.get("range") || "7"
    const days = parseInt(range, 10)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const insights = await db.insight.findMany({
    where: { projectId: id, timestamp: { gte: since } },
    include: { session: { select: { id: true, country: true, city: true, browser: true, device: true, startedAt: true } } },
    orderBy: { timestamp: "desc" },
    take: 200,
  })
  const counts: Record<string, number> = {}
  for (const i of insights) counts[i.type] = (counts[i.type] || 0) + 1
  return NextResponse.json({
    insights: insights.map((i) => ({ ...i, data: JSON.parse(i.data || "{}") })),
    counts,
  })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "insights")
    return NextResponse.json(body, { status })
  }
}
