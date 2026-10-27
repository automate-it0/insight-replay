import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"

/**
 * PATCH /api/projects/[id]/alerts/history/[hid]
 * Acknowledge an alert-history entry. Reuses the shared
 * `requireProjectAccess` middleware (auth + IDOR block + audit) instead
 * of the previous inline `getSession()` + 401 guard — closes the last
 * route that the cluster-31-A refactor sweep missed.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; hid: string }> }) {
  const { id, hid } = await ctx.params
  const guard = await requireProjectAccess(req, id, "alert_history_ack")
  if (guard.error) return guard.error

  try {
    const existing = await db.alertHistory.findFirst({
      where: { id: hid, projectId: id },
    })
    if (!existing) {
      return NextResponse.json({ error: "history entry not found" }, { status: 404 })
    }
    const history = await db.alertHistory.update({
      where: { id: hid },
      data: { acknowledged: true },
    })
    return NextResponse.json({ history })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "alert_history_ack")
    return NextResponse.json(body, { status })
  }
}

