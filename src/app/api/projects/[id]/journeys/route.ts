import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

// Query-string schema for GET /api/projects/[id]/journeys. `range` parses to
// a bounded integer; `source` is a URL-ish filter applied in-memory and
// capped at 2000 chars; `maxNodes` parses to a bounded integer (1–1000)
// so an attacker can't request a 1M-node graph.
const JourneysQuerySchema = z.object({
  range: z
    .string()
    .max(8)
    .default("7")
    .transform((v) => {
      const n = parseInt(v, 10)
      return Number.isFinite(n) && n > 0 && n < 3650 ? n : 7
    }),
  source: z.string().max(2000).default(""),
  maxNodes: z
    .string()
    .max(8)
    .default("12")
    .transform((v) => {
      const n = parseInt(v, 10)
      return Number.isFinite(n) && n > 0 && n <= 1000 ? n : 12
    }),
})

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const sp = req.nextUrl.searchParams
    const parsed = JourneysQuerySchema.safeParse({
      range: sp.get("range") ?? undefined,
      source: sp.get("source") ?? undefined,
      maxNodes: sp.get("maxNodes") ?? undefined,
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid query" },
        { status: 400 },
      )
    }
    const range = parsed.data.range
    const source = parsed.data.source
    const maxNodes = parsed.data.maxNodes
    const days = range
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    // Fetch pageview events ordered by session, then time
    const events = await db.event.findMany({
      where: {
        session: { projectId: id },
        type: "pageview",
        timestamp: { gte: since },
      },
      select: { sessionId: true, pageUrl: true, t: true },
      orderBy: [{ sessionId: "asc" }, { t: "asc" }],
      // Bounded — DoS protection. The journeys endpoint groups every
      // matching pageview per session in memory. 50000 covers a busy
      // project's 7-day pageview volume; beyond that the dashboard should
      // switch to a SQL-side journey aggregation.
      take: 50000,
    })

    // Group events into per-session ordered page sequences
    const sessionSeqMap = new Map<string, string[]>()
    for (const e of events) {
      const arr = sessionSeqMap.get(e.sessionId) || []
      arr.push(e.pageUrl || "/")
      sessionSeqMap.set(e.sessionId, arr)
    }

    // Dedupe consecutive duplicates per session, optionally filter by source
    const sequences: string[][] = []
    for (const [, raw] of sessionSeqMap) {
      const deduped: string[] = []
      for (const url of raw) {
        if (deduped[deduped.length - 1] !== url) deduped.push(url)
      }
      if (source) {
        if (deduped[0] !== source) continue
      }
      if (deduped.length > 0) sequences.push(deduped)
    }

    // Count transitions, starts, ends
    const starts: Record<string, number> = {}
    const ends: Record<string, number> = {}
    const transitions: Record<string, number> = {} // key: `${from}\u0000${to}`
    const pathCounts: Record<string, number> = {}
    const incoming: Record<string, number> = {}
    const outgoing: Record<string, number> = {}

    for (const seq of sequences) {
      starts[seq[0]] = (starts[seq[0]] || 0) + 1
      ends[seq[seq.length - 1]] = (ends[seq[seq.length - 1]] || 0) + 1
      for (let i = 0; i < seq.length - 1; i++) {
        const from = seq[i]
        const to = seq[i + 1]
        if (from === to) continue
        const key = `${from}\u0000${to}`
        transitions[key] = (transitions[key] || 0) + 1
        outgoing[from] = (outgoing[from] || 0) + 1
        incoming[to] = (incoming[to] || 0) + 1
      }
      const pathStr = seq.join(" > ")
      pathCounts[pathStr] = (pathCounts[pathStr] || 0) + 1
    }

    // Compute total flow per URL to pick top N
    const flow: Record<string, number> = {}
    const allUrls = new Set<string>([
      ...Object.keys(starts),
      ...Object.keys(ends),
      ...Object.keys(incoming),
      ...Object.keys(outgoing),
    ])
    for (const url of allUrls) {
      flow[url] =
        (starts[url] || 0) + (ends[url] || 0) + (incoming[url] || 0) + (outgoing[url] || 0)
    }

    const topUrls = Object.entries(flow)
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxNodes)
      .map(([url]) => url)
    const topSet = new Set(topUrls)

    // Build nodes: include "Start" and "Exit" virtual nodes
    const nodes = [
      { id: "__start__", name: "Start", virtual: true },
      { id: "__exit__", name: "Exit", virtual: true },
      ...topUrls.map((url) => ({ id: url, name: url, virtual: false })),
    ]

    // Build links
    const links: { source: string; target: string; value: number }[] = []
    for (const [key, value] of Object.entries(transitions)) {
      const [from, to] = key.split("\u0000")
      if (!topSet.has(from) || !topSet.has(to)) continue
      links.push({ source: from, target: to, value })
    }
    // Start → url links
    for (const [url, count] of Object.entries(starts)) {
      if (!topSet.has(url)) continue
      links.push({ source: "__start__", target: url, value: count })
    }
    // url → Exit links
    for (const [url, count] of Object.entries(ends)) {
      if (!topSet.has(url)) continue
      links.push({ source: url, target: "__exit__", value: count })
    }

    const startsArr = Object.entries(starts)
      .map(([url, count]) => ({ url, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, maxNodes)

    const endsArr = Object.entries(ends)
      .map(([url, count]) => ({ url, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, maxNodes)

    const topPaths = Object.entries(pathCounts)
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)

    return NextResponse.json({
      range: days,
      source: source || null,
      maxNodes,
      totalSessions: sequences.length,
      nodes,
      links,
      starts: startsArr,
      ends: endsArr,
      topPaths,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "journeys")
    return NextResponse.json(body, { status })
  }
}
