import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { auditLog, AUDIT_ACTIONS } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import { requireProjectAccess } from "@/lib/route-guards"
import { validateUserUrl } from "@/lib/ssrf-guard"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

const VALID_METRICS = ["sessions", "rageClicks", "errors", "conversions", "bounceRate", "avgDuration"] as const
const VALID_CONDITIONS = ["gt", "lt", "drops", "spikes"] as const
const VALID_CHANNELS = ["inapp", "webhook"] as const

// Zod schema for PATCH body — all fields optional. Enum-constrained fields
// reject arbitrary strings; numeric fields are bounded; `webhookUrl` is
// re-validated through the SSRF guard when present. `name` flows through
// stripHtml as defence in depth.
const AlertUpdateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  metric: z.enum(VALID_METRICS).optional(),
  condition: z.enum(VALID_CONDITIONS).optional(),
  threshold: z.number().finite().optional(),
  windowMin: z.number().int().positive().max(604800).optional(),
  channel: z.enum(VALID_CHANNELS).optional(),
  webhookUrl: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
})

/**
 * PATCH — update an alert. Mutating: requires a valid API key in production.
 * Open in dev for dashboard testing.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; aid: string }> }) {
  const { id, aid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "alert_update")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json().catch(() => ({}))
    const parsed = AlertUpdateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }

    const data: Record<string, unknown> = {}
    if (parsed.data.name) data.name = stripHtml(parsed.data.name, 100)
    if (parsed.data.metric) data.metric = parsed.data.metric
    if (parsed.data.condition) data.condition = parsed.data.condition
    if (parsed.data.threshold !== undefined) data.threshold = parsed.data.threshold
    if (parsed.data.windowMin !== undefined) data.windowMin = parsed.data.windowMin
    if (parsed.data.channel) data.channel = parsed.data.channel
    if (parsed.data.webhookUrl !== undefined) {
      // SSRF defense — same as POST /alerts. Reject private-IP / non-http(s)
      // webhook URLs at WRITE time so they can never be fetched later. An
      // empty string is allowed (clears an existing webhook).
      if (parsed.data.webhookUrl.trim()) {
        const v = validateUserUrl(parsed.data.webhookUrl)
        if (!v.ok) {
          return NextResponse.json({ error: `invalid webhookUrl: ${v.reason}` }, { status: 400 })
        }
        data.webhookUrl = v.url.href
      } else {
        data.webhookUrl = ""
      }
    }
    if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled

    // Verify ownership first, then update.
    const existing = await db.alert.findFirst({ where: { id: aid, projectId: id } })
    if (!existing) {
      return NextResponse.json({ error: "alert not found" }, { status: 404 })
    }

    const alert = await db.alert.update({
      where: { id: aid },
      data,
      include: { _count: { select: { history: true } } },
    })
    // Audit-log alert update. (No ALERT_UPDATED constant exists in audit.ts;
    // a literal is used here to keep the action name semantically accurate
    // without modifying the shared audit-actions module.)
    await auditLog({
      action: "alert_updated",
      projectId: id,
      actor: "api",
      ip: getClientIP(req as unknown as Request),
      details: { alertId: aid, fields: Object.keys(data) },
    })
    return NextResponse.json({ alert })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "alert_update")
    return NextResponse.json(body, { status })
  }
}

/**
 * DELETE — remove an alert. Destructive: requires a valid API key in
 * production. Open in dev for dashboard testing.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; aid: string }> }) {
  const { id, aid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "alert_delete")
  if (guard.error) return guard.error
  void guard.session
  try {
    await db.alert.deleteMany({ where: { id: aid, projectId: id } })
    // Audit-log alert deletion.
    await auditLog({
      action: AUDIT_ACTIONS.ALERT_DELETED,
      projectId: id,
      actor: "api",
      ip: getClientIP(req as unknown as Request),
      details: { alertId: aid },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "alert_delete")
    return NextResponse.json(body, { status })
  }
}
