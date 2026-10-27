import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { verifyProjectAccess } from "@/lib/project-auth"

// Query-string schema for GET /api/projects/[id]/sessions. `range` is parsed
// to a bounded integer; `q` is capped at 200 chars (search filter applied in
// memory, not in the where clause — but bounding the length defends against
// a 1MB query string causing slow in-memory `.toLowerCase()` work);
// `filter` is restricted to a fixed enum so an attacker can't set arbitrary
// `where` keys.
const SessionsQuerySchema = z.object({
  range: z
    .string()
    .max(8)
    .default("7")
    .transform((v) => {
      const n = parseInt(v, 10)
      return Number.isFinite(n) && n > 0 && n < 3650 ? n : 7
    }),
  q: z.string().max(200).default(""),
  filter: z
    .string()
    .max(16)
    .default("all")
    .refine(
      (v) => v === "all" || v === "rage" || v === "dead" || v === "active",
      { message: "filter must be one of: all, rage, dead, active" },
    ),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const sp = req.nextUrl.searchParams
  const parsed = SessionsQuerySchema.safeParse({
    range: sp.get("range") ?? undefined,
    q: sp.get("q") ?? undefined,
    filter: sp.get("filter") ?? undefined,
  })
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid query" },
      { status: 400 },
    )
  }
  const days = parsed.data.range
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const q = parsed.data.q
  const filter = parsed.data.filter

  const where: Record<string, unknown> = { projectId: id, startedAt: { gte: since } }
  if (filter === "rage") where.hasRageClick = true
  if (filter === "dead") where.hasDeadClick = true
  if (filter === "active") where.isActive = true

  let sessions = await db.session.findMany({
    where,
    orderBy: { startedAt: "desc" },
    take: 100,
  })

  if (q) {
    const ql = q.toLowerCase()
    sessions = sessions.filter(
      (s) =>
        s.country.toLowerCase().includes(ql) ||
        s.city.toLowerCase().includes(ql) ||
        s.browser.toLowerCase().includes(ql) ||
        s.os.toLowerCase().includes(ql) ||
        s.device.toLowerCase().includes(ql) ||
        s.visitorId.toLowerCase().includes(ql)
    )
  }

  return NextResponse.json({ sessions })
}
