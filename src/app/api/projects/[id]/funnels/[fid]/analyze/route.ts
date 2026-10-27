import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { verifyProjectAccess } from "@/lib/project-auth"

function dedupeConsecutive<T>(items: T[], key: (t: T) => string): T[] {
  const out: T[] = []
  for (const it of items) {
    if (out.length === 0 || key(out[out.length - 1]) !== key(it)) out.push(it)
  }
  return out
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; fid: string }> }) {
  const { id, fid } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request)
  try {
    const funnel = await db.funnel.findFirst({ where: { id: fid, projectId: id } })
    if (!funnel) return NextResponse.json({ error: "not found" }, { status: 404 })
    const steps = JSON.parse(funnel.steps || "[]") as { url: string; name: string }[]
    if (!Array.isArray(steps) || steps.length === 0) {
      return NextResponse.json({
        funnel: { ...funnel, steps: [] },
        steps: [],
        totalSessions: 0,
        completionRate: 0,
        medianStepTimes: [],
      })
    }

    const range = req.nextUrl.searchParams.get("range") || "7"
    const days = parseInt(range, 10)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    // Total sessions in range
    const totalSessions = await db.session.count({
      where: { projectId: id, startedAt: { gte: since } },
    })

    // Fetch all pageview events in range, ordered by session then t
    const events = await db.event.findMany({
      where: { session: { projectId: id }, type: "pageview", timestamp: { gte: since } },
      select: { sessionId: true, pageUrl: true, t: true },
      orderBy: [{ sessionId: "asc" }, { t: "asc" }],
      // Bounded — DoS protection. The funnel-analyze endpoint groups
      // every matching pageview per session in memory. 50000 covers a
      // busy project's typical 7-day pageview volume; beyond that the
      // dashboard should switch to SQL-side funnel aggregation.
      take: 50000,
    })

    // Group events by session
    const bySession = new Map<string, { url: string; t: number }[]>()
    for (const e of events) {
      let arr = bySession.get(e.sessionId)
      if (!arr) {
        arr = []
        bySession.set(e.sessionId, arr)
      }
      arr.push({ url: e.pageUrl, t: e.t })
    }

    const stepUrls = steps.map((s) => s.url)
    const counts = new Array(steps.length).fill(0)
    const completedTArrays: number[][] = [] // matched t values per step for fully-completed sessions

    for (const [, evs] of bySession) {
      // Dedupe consecutive duplicate URLs (keep first-occurrence t)
      const seq = dedupeConsecutive(evs, (x) => x.url)
      // Sequential matching
      const matchedTs: number[] = []
      let pos = -1
      let reached = -1
      for (let i = 0; i < stepUrls.length; i++) {
        const target = stepUrls[i]
        let found = -1
        for (let j = pos + 1; j < seq.length; j++) {
          if (seq[j].url === target) {
            found = j
            break
          }
        }
        if (found === -1) break
        pos = found
        matchedTs.push(seq[found].t)
        reached = i
      }
      for (let i = 0; i <= reached; i++) counts[i]++
      if (reached === stepUrls.length - 1) {
        completedTArrays.push(matchedTs)
      }
    }

    const base = counts[0] || 0
    const stepOut = steps.map((s, i) => {
      const count = counts[i]
      const prevCount = i === 0 ? 0 : counts[i - 1]
      const rate = base > 0 ? (count / base) * 100 : 0
      const dropoff = i === 0 ? 0 : prevCount - count
      const dropoffPct = i === 0 || prevCount === 0 ? 0 : ((prevCount - count) / prevCount) * 100
      return {
        name: s.name,
        url: s.url,
        count,
        rate: Math.round(rate * 10) / 10,
        dropoff,
        dropoffPct: Math.round(dropoffPct * 10) / 10,
      }
    })

    // Median time (ms) between consecutive steps for completed sessions
    const medianStepTimes: (number | null)[] = []
    for (let i = 0; i < stepUrls.length; i++) {
      if (i === 0) {
        medianStepTimes.push(null)
        continue
      }
      const diffs: number[] = []
      for (const ts of completedTArrays) {
        if (i < ts.length) diffs.push(ts[i] - ts[i - 1])
      }
      medianStepTimes.push(median(diffs))
    }

    const completionRate = base > 0 ? (counts[steps.length - 1] / base) * 100 : 0

    return NextResponse.json({
      funnel: { ...funnel, steps },
      steps: stepOut,
      totalSessions,
      completionRate: Math.round(completionRate * 10) / 10,
      medianStepTimes,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "funnel_analyze")
    return NextResponse.json(body, { status })
  }
}
