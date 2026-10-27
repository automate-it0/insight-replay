import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for POST body — `text` required (1–2000 chars), `date` required
// (ISO 8601-ish, validated by Date constructor), `color` and `author`
// optional. All string values flow through stripHtml before persistence so
// stored annotation rows are inert against stored XSS even if a downstream
// dangerouslySetInnerHTML consumer renders them.
const AnnotationCreateSchema = z.object({
  text: z.string().trim().min(1, "text required").max(2000, "text too long"),
  date: z.string().trim().min(1, "date required").max(40),
  color: z.string().max(32).optional(),
  author: z.string().trim().max(100).optional(),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "annotation_list", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const annotations = await db.annotation.findMany({
      where: { projectId: id },
      orderBy: { date: "desc" },
      take: 1000,
    })
    return NextResponse.json({ annotations })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "annotations_list")
    return NextResponse.json(body, { status })
  }
}

/**
 * POST — create an annotation. Mutating: requires a valid API key in
 * production. Open in dev for dashboard testing.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "annotation_create")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json()
    const parsed = AnnotationCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }

    const parsedDate = new Date(parsed.data.date)
    if (Number.isNaN(parsedDate.getTime())) {
      return NextResponse.json({ error: "invalid date" }, { status: 400 })
    }

    const annotation = await db.annotation.create({
      data: {
        projectId: id,
        date: parsedDate,
        text: stripHtml(parsed.data.text, 2000),
        color: parsed.data.color || "primary",
        author: parsed.data.author
          ? stripHtml(parsed.data.author, 100)
          : "analyst",
      },
    })
    return NextResponse.json({ annotation })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "annotation_create")
    return NextResponse.json(body, { status })
  }
}
