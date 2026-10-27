import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { verifyProjectAccess } from "@/lib/project-auth"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await ctx.params
  const { session: authSession, error } = await verifyProjectAccess(id)
  if (error) return error
  void authSession
  const session = await db.session.findUnique({ where: { id: sid } })
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 })
  const events = await db.event.findMany({
    where: { sessionId: sid },
    orderBy: { t: "asc" },
    take: 5000,
  })
  const insights = await db.insight.findMany({
    where: { sessionId: sid },
    orderBy: { timestamp: "asc" },
    take: 1000,
  })
  return NextResponse.json({
    session,
    events: events.map((e) => ({ ...e, data: JSON.parse(e.data || "{}") })),
    insights,
  })
}
