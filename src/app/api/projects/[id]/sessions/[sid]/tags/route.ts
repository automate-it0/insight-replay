import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for POST body — `label` is required (1–50 chars) and `color`
// is optional, enum-constrained to the dashboard's known palette so a
// malicious `color` can't carry stored XSS or break CSS class lookups.
const TagCreateSchema = z.object({
  label: z.string().trim().min(1, "label required").max(50, "label too long"),
  color: z
    .string()
    .max(32)
    .optional()
    .refine(
      (v) =>
        !v ||
        ["primary", "secondary", "success", "warning", "danger", "info", "default"].includes(v),
      { message: "color must be a known palette value" },
    ),
})

// GET — list tags for a session
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "session_tags_list", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const tags = await db.tag.findMany({
      where: { sessionId: sid },
      orderBy: { createdAt: "asc" },
      take: 100,
    })
    return NextResponse.json({ tags })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "session_tags_list")
    return NextResponse.json(body, { status })
  }
}

// POST — create a tag (upsert on [sessionId, label]). Mutating: requires a
// valid API key in production. Open in dev for dashboard testing.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "session_tag_create")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json()
    const parsed = TagCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    // stripHtml as defence-in-depth: Zod already bounded length + shape, but
    // stripHtml also removes any residual HTML tags and escapes entities so
    // the persisted label/color are inert even if rendered via dangerouslySetInnerHTML.
    const label = stripHtml(parsed.data.label, 50)
    const color = parsed.data.color || "primary"
    if (!label) return NextResponse.json({ error: "label required" }, { status: 400 })

    const tag = await db.tag.upsert({
      where: { sessionId_label: { sessionId: sid, label } },
      create: { sessionId: sid, label, color },
      update: {},
    })
    return NextResponse.json({ tag })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "session_tag_create")
    return NextResponse.json(body, { status })
  }
}
