import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { verifyProjectAccess } from "@/lib/project-auth"
import { sanitizeError } from "@/lib/observability"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  try {
    const history = await db.alertHistory.findMany({
      where: { projectId: id },
      orderBy: { triggeredAt: "desc" },
      take: 50,
      include: { alert: { select: { id: true, name: true, metric: true, condition: true } } },
    })
    return NextResponse.json({ history })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "alert_history_list")
    return NextResponse.json(body, { status })
  }
}
