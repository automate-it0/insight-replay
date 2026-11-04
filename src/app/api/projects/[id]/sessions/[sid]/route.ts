import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { verifyProjectAccess } from "@/lib/project-auth"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await ctx.params
  const { session: authSession, error } = await verifyProjectAccess(id)
  if (error) return error
  void authSession
  // Scoped fetch (BOLA guard) + parallel round-trips: the session must
  // belong to THIS project, and the three independent queries run together
  // instead of serially (saves two round-trips per player open).
  const [session, events, insights] = await Promise.all([
    db.session.findFirst({ where: { id: sid, projectId: id } }),
    db.event.findMany({ where: { sessionId: sid }, orderBy: { t: "asc" }, take: 5000 }),
    db.insight.findMany({ where: { sessionId: sid }, orderBy: { timestamp: "asc" }, take: 1000 }),
  ])
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 })
  return NextResponse.json({
    session,
    // One corrupted Event.data row must not 500 the whole recording —
    // degrade that single event to an empty payload instead.
    events: events.map((e) => {
      try {
        return { ...e, data: JSON.parse(e.data || "{}") }
      } catch {
        return { ...e, data: {} }
      }
    }),
    insights,
  })
}
