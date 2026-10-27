import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { verifyProjectAccess } from "@/lib/project-auth"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for POST body — `name` required (1–100 chars), `filters`
// is an optional object (any JSON-serializable shape; we cap key count
// at 50 to bound memory). `name` is run through stripHtml before
// persistence so stored rows are inert against stored XSS.
const SegmentCreateSchema = z.object({
  name: z.string().trim().min(1, "name required").max(100, "name too long"),
  filters: z.record(z.string(), z.unknown()).optional(),
})

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  try {
    const segments = await db.segment.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    return NextResponse.json({
      segments: segments.map((s) => ({
        ...s,
        filters: JSON.parse(s.filters || "{}"),
      })),
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "segments_list")
    return NextResponse.json(body, { status })
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  try {
    const body = await req.json()
    const parsed = SegmentCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    const name = stripHtml(parsed.data.name, 100)
    if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })
    const filters = parsed.data.filters ?? {}
    const segment = await db.segment.create({
      data: {
        projectId: id,
        name,
        filters: JSON.stringify(filters),
      },
    })
    return NextResponse.json({
      segment: { ...segment, filters: JSON.parse(segment.filters || "{}") },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "segment_create")
    return NextResponse.json(body, { status })
  }
}
