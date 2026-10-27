import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { auditLog, AUDIT_ACTIONS } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import { requireProjectAccess } from "@/lib/route-guards"
import { validateUserUrl } from "@/lib/ssrf-guard"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for POST body — `name` required (1–100 chars); `metric`,
// `condition`, `channel` are enum-constrained; `threshold` and `windowMin`
// are bounded numbers; `webhookUrl` is a string passed through the SSRF
// guard before storage. `name` is run through stripHtml as defence in depth.
const VALID_METRICS = ["sessions", "rageClicks", "errors", "conversions", "bounceRate", "avgDuration"] as const
const VALID_CONDITIONS = ["gt", "lt", "drops", "spikes"] as const
const VALID_CHANNELS = ["inapp", "webhook"] as const

const AlertCreateSchema = z.object({
  name: z.string().trim().min(1, "name required").max(100, "name too long"),
  metric: z.enum(VALID_METRICS).default("sessions"),
  condition: z.enum(VALID_CONDITIONS).default("gt"),
  threshold: z.number().finite().default(0),
  windowMin: z.number().int().positive().max(604800).default(60),
  channel: z.enum(VALID_CHANNELS).default("inapp"),
  webhookUrl: z.string().max(2000).optional().or(z.literal("")),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "alert_list", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const alerts = await db.alert.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { history: true } } },
      take: 100,
    })
    return NextResponse.json({ alerts })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "alerts_list")
    return NextResponse.json(body, { status })
  }
}

/**
 * POST — create an alert. Mutating: requires a valid API key in production.
 * Open in dev for dashboard testing.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "alert_create")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json()
    const parsed = AlertCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    const name = stripHtml(parsed.data.name, 100)
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })

    const finalMetric = parsed.data.metric
    const finalCondition = parsed.data.condition
    const finalChannel = parsed.data.channel

    // SSRF defense — `webhookUrl` is a user-supplied URL that, when the
    // alert channel is "webhook", will be fetched server-side to deliver
    // notifications. Delivery is not yet implemented (see A10 advisory in
    // src/lib/security-checklist.ts) but the value persists in the DB; if a
    // future delivery loop naively fetches it, an attacker who planted
    // `http://169.254.169.254/...` here could exfiltrate cloud metadata.
    // Validate at WRITE time so bad URLs never enter the DB. Empty is
    // allowed (channel may be "inapp" with no webhook).
    let safeWebhookUrl = ""
    if (parsed.data.webhookUrl && parsed.data.webhookUrl.trim()) {
      const v = validateUserUrl(parsed.data.webhookUrl)
      if (!v.ok) {
        return NextResponse.json({ error: `invalid webhookUrl: ${v.reason}` }, { status: 400 })
      }
      safeWebhookUrl = v.url.href
    }

    const alert = await db.alert.create({
      data: {
        projectId: id,
        name,
        metric: finalMetric,
        condition: finalCondition,
        threshold: parsed.data.threshold,
        windowMin: parsed.data.windowMin,
        channel: finalChannel,
        webhookUrl: safeWebhookUrl,
        enabled: true,
      },
      include: { _count: { select: { history: true } } },
    })
    // Audit-log alert creation. Fire-and-forget semantically; auditLog swallows
    // internal errors so a logging failure can never break the request.
    await auditLog({
      action: AUDIT_ACTIONS.ALERT_CREATED,
      projectId: id,
      actor: "api",
      ip: getClientIP(req as unknown as Request),
      details: {
        name,
        metric: finalMetric,
        condition: finalCondition,
        threshold: parsed.data.threshold,
        channel: finalChannel,
        alertId: alert.id,
      },
    })
    return NextResponse.json({ alert })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "alert_create")
    return NextResponse.json(body, { status })
  }
}
