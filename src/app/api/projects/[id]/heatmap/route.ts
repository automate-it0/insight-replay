import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

// Query-string schema for GET /api/projects/[id]/heatmap. The `url`
// parameter flows directly into a Prisma `where: { pageUrl: url }` clause —
// while Prisma parameterizes the value (so SQLi is not exploitable), an
// attacker-controlled `url` of arbitrary length or shape can cause unbounded
// row scans or be echoed back in the response. We cap length at 2000 (sane
// URL limit), constrain `kind` to a fixed enum, and parse `range` into a
// bounded integer (1–3650 days) with a safe default.
const HeatmapQuerySchema = z.object({
  url: z.string().max(2000).default("/"),
  range: z
    .string()
    .max(8)
    .default("7")
    .transform((v) => {
      const n = parseInt(v, 10)
      return Number.isFinite(n) && n > 0 && n < 3650 ? n : 7
    }),
  kind: z
    .string()
    .max(16)
    .default("click")
    .refine((v) => v === "click" || v === "move" || v === "scroll", {
      message: "kind must be one of: click, move, scroll",
    }),
})

// Returns heatmap points (click + move aggregate) for a given page url
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    // Validate search params before any DB read. On validation failure,
    // return 400 with the human-readable Zod issue — this prevents
    // attacker-controlled `url` strings from reaching the where clause
    // unsanitized and bounds the work the DB does on a hostile payload.
    const sp = req.nextUrl.searchParams
    const parsed = HeatmapQuerySchema.safeParse({
      url: sp.get("url") ?? undefined,
      range: sp.get("range") ?? undefined,
      kind: sp.get("kind") ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid query" },
        { status: 400 },
      )
    }
    const url = parsed.data.url
    const days = parsed.data.range
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const kind = parsed.data.kind

    if (kind === "scroll") {
      // scroll depth distribution
      const events = await db.event.findMany({
        where: {
          type: "scroll",
          session: { projectId: id },
          pageUrl: url,
          timestamp: { gte: since },
        },
        select: { scrollY: true, viewportHeight: true },
        take: 8000,
      })
      // bucket scrollY into 20 buckets based on max
      const max = events.reduce((m, e) => Math.max(m, e.scrollY), 0) || 1
      const buckets = new Array(20).fill(0)
      for (const e of events) {
        const idx = Math.min(19, Math.floor((e.scrollY / max) * 20))
        buckets[idx]++
      }
      return NextResponse.json({ kind: "scroll", url, max, buckets, count: events.length })
    }

    const events = await db.event.findMany({
      where: {
        type: kind,
        session: { projectId: id },
        pageUrl: url,
        timestamp: { gte: since },
      },
      select: { x: true, y: true, scrollY: true },
      take: 12000,
    })
    const points = events.map((e) => ({ x: e.x, y: e.y + e.scrollY, sy: e.scrollY }))
    return NextResponse.json({ kind, url, points, count: points.length })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "heatmap")
    return NextResponse.json(body, { status })
  }
}
