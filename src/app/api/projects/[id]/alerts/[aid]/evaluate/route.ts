import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { verifyProjectAccess } from "@/lib/project-auth"
import { sanitizeError } from "@/lib/observability"

type MetricKey = "sessions" | "rageClicks" | "errors" | "conversions" | "bounceRate" | "avgDuration"

function computeMetric(metric: string, sessions: Array<{
  duration: number
  pageViewsCount: number
  totalClicks: number
  hasRageClick: boolean
  hasError: boolean
  convertedGoal: string
}>): number {
  const count = sessions.length
  if (count === 0) return 0
  switch (metric as MetricKey) {
    case "sessions":
      return count
    case "rageClicks":
      return sessions.filter((s) => s.hasRageClick).length
    case "errors":
      return sessions.filter((s) => s.hasError).length
    case "conversions":
      return sessions.filter((s) => s.convertedGoal && s.convertedGoal !== "").length
    case "bounceRate": {
      const bounced = sessions.filter((s) => s.pageViewsCount <= 1).length
      return Math.round((bounced / count) * 10000) / 100 // pct with 2 decimals
    }
    case "avgDuration": {
      const total = sessions.reduce((acc, s) => acc + (s.duration || 0), 0)
      return Math.round((total / count) * 100) / 100
    }
    default:
      return 0
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; aid: string }> }) {
  const { id, aid } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  try {
    const alert = await db.alert.findFirst({ where: { id: aid, projectId: id } })
    if (!alert) {
      return NextResponse.json({ error: "alert not found" }, { status: 404 })
    }

    const now = Date.now()
    const windowMs = alert.windowMin * 60 * 1000
    const currentStart = new Date(now - windowMs)

    const sessionSelect = {
      duration: true,
      pageViewsCount: true,
      totalClicks: true,
      hasRageClick: true,
      hasError: true,
      convertedGoal: true,
      startedAt: true,
    } as const

    // Current window sessions (use startedAt as the canonical event time).
    const currentSessions = await db.session.findMany({
      where: { projectId: id, startedAt: { gte: currentStart } },
      select: sessionSelect,
      // Bounded — DoS protection. The alert-evaluate endpoint computes a
      // metric over every matching session in memory. 5000 covers any
      // realistic alert window (60min+); a window with more than 5k
      // sessions/min would be better served by SQL-side aggregation.
      take: 5000,
    })

    const currentValue = computeMetric(alert.metric, currentSessions)

    let triggered = false
    let message = ""

    if (alert.condition === "gt") {
      triggered = currentValue > alert.threshold
      if (triggered)
        message = `${alert.metric} (${currentValue}) exceeded threshold ${alert.threshold} in the last ${alert.windowMin}m`
    } else if (alert.condition === "lt") {
      triggered = currentValue < alert.threshold
      if (triggered)
        message = `${alert.metric} (${currentValue}) dropped below threshold ${alert.threshold} in the last ${alert.windowMin}m`
    } else if (alert.condition === "spikes" || alert.condition === "drops") {
      // Compare current window to previous equal window.
      const prevEnd = currentStart
      const prevStart = new Date(now - 2 * windowMs)
      const prevSessions = await db.session.findMany({
        where: { projectId: id, startedAt: { gte: prevStart, lt: prevEnd } },
        select: sessionSelect,
        // Bounded — DoS protection (same rationale as currentSessions).
        take: 5000,
      })
      const prevValue = computeMetric(alert.metric, prevSessions)

      const ratio = prevValue > 0 ? currentValue / prevValue : currentValue > 0 ? Infinity : 1
      const pctChange = prevValue > 0 ? (ratio - 1) * 100 : currentValue > 0 ? 100 : 0

      if (alert.condition === "spikes") {
        // Spike: current > previous * (1 + threshold/100).
        const spikeThreshold = prevValue * (1 + alert.threshold / 100)
        triggered = currentValue > spikeThreshold
        if (triggered)
          message = `${alert.metric} spiked from ${prevValue} to ${currentValue} (+${pctChange.toFixed(
            1,
          )}%) in the last ${alert.windowMin}m`
      } else {
        // drops
        const dropThreshold = prevValue * (1 - alert.threshold / 100)
        triggered = currentValue < dropThreshold
        if (triggered)
          message = `${alert.metric} dropped from ${prevValue} to ${currentValue} (${pctChange.toFixed(
            1,
          )}%) in the last ${alert.windowMin}m`
      }
    }

    if (triggered) {
      // Race-safety: two concurrent GET /evaluate requests can both read the
      // alert, both compute currentValue, both pass `triggered === true`,
      // and both try to insert a history row + update lastTriggered. The
      // result is duplicate AlertHistory entries (i.e. double-alerts) for
      // the same condition — noisy and potentially firing the webhook twice.
      //
      // Fix: use a conditional UPDATE that only succeeds when the alert was
      // NOT already triggered within the current window. The update is a
      // single atomic SQL statement so concurrent evaluators serialize on
      // it — exactly one request sees `result.count === 1` and proceeds to
      // insert history; the others see `result.count === 0` and bail out.
      // Wrapped in a transaction so the history insert + the lastTriggered
      // bump can't get split apart by a crash.
      const now = new Date()
      // Cooldown threshold: any `lastTriggered` strictly older than this
      // means the alert has NOT fired within the current evaluation window
      // and is eligible to fire again now. (NULL counts as "never fired"
      // and is also eligible.)
      const cooldownThreshold = new Date(now.getTime() - windowMs)

      const history = await db.$transaction(async (tx) => {
        // Conditional UPDATE — atomic claim of "I am the request that gets
        // to fire this alert within the current window".
        const claim = await tx.alert.updateMany({
          where: {
            id: alert.id,
            OR: [
              { lastTriggered: null },
              { lastTriggered: { lt: cooldownThreshold } },
            ],
          },
          data: { lastTriggered: now },
        })
        if (claim.count === 0) {
          // Another concurrent evaluation already claimed the alert within
          // this window — suppress the duplicate history insert.
          return null
        }
        return await tx.alertHistory.create({
          data: {
            alertId: alert.id,
            projectId: id,
            value: currentValue,
            message,
            acknowledged: false,
          },
        })
      })

      if (!history) {
        // Suppressed — duplicate within cooldown window.
        return NextResponse.json({
          triggered: false,
          value: currentValue,
          suppressed: "duplicate",
        })
      }
      return NextResponse.json({
        triggered: true,
        value: currentValue,
        message,
        historyId: history.id,
      })
    }

    return NextResponse.json({ triggered: false, value: currentValue })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "alert_evaluate")
    return NextResponse.json(body, { status })
  }
}
