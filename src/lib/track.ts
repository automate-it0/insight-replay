// Ingest hot path for the tracking SDK — /api/track/events calls ingest() to
// persist a batch of events + errors for a session. Handles project lookup,
// GDPR-safe session find-or-create (with tombstone race-guard), bulk event
// insert, rage-click + goal-conversion detection, and bulk error insert.
import { db } from "@/lib/db"
import { parseUA, fakeGeo, anonymizeIP, type UAInfo } from "@/lib/ua"
import { sanitizePayload, type SanitizablePayload } from "@/lib/sanitize"
import { logger } from "@/lib/observability"
import { randomBytes } from "crypto"

/**
 * Sentinel error thrown from inside the find-or-create transaction when the
 * GDPR tombstone check (re-run inside the transaction) detects that the
 * visitor was erased mid-flight. Caught outside the transaction and
 * translated into a silent drop of the tracking payload (return ok:false).
 */
class VisitorTombstonedError extends Error {
  constructor() {
    super("VISITOR_TOMBSTONED")
    this.name = "VisitorTombstonedError"
  }
}

export interface TrackEventInput {
  type: string
  t: number // ms from session start
  x?: number
  y?: number
  scrollX?: number
  scrollY?: number
  viewportWidth?: number
  viewportHeight?: number
  pageUrl?: string
  data?: Record<string, unknown>
}

export interface IngestPayload {
  projectId: string
  visitorId: string
  sessionId?: string
  userAgent?: string
  ip?: string
  language?: string
  referrer?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  entryUrl?: string
  screenWidth?: number
  screenHeight?: number
  startedAt?: number
  events: TrackEventInput[]
  errors?: { message: string; stack?: string; url?: string; line?: number; t?: number }[]
  end?: boolean
}

function getClientIP(req: Request): string {
  const f = req.headers.get("x-forwarded-for")
  if (f) return f.split(",")[0].trim()
  return req.headers.get("x-real-ip") || "0.0.0.0"
}

export async function ingest(payload: IngestPayload, req: Request) {
  // Defence-in-depth: even though /api/track/events calls sanitizePayload()
  // before passing the payload here, ingest() is also called from the seed
  // route and could be called from future ingest paths. Run a final
  // sanitizePayload() pass so no caller can bypass the edge sanitization.
  // sanitizePayload is pure, idempotent, and returns a NEW object, so the
  // second pass is cheap and safe.
  // `IngestPayload` intentionally declares no index signature, but the
  // sanitizer is a defence-in-depth boundary that accepts (and strips)
  // arbitrary extra keys. The cast widens to the sanitizable shape; the
  // result is re-narrowed back to `IngestPayload` on the next line.
  const safe = sanitizePayload(payload as unknown as SanitizablePayload) as IngestPayload
  const project = await db.project.findFirst({
    where: { OR: [{ id: safe.projectId }, { trackingId: safe.projectId }] },
  })
  if (!project) return { ok: false, error: "unknown project" }

  const ua = safe.userAgent || req.headers.get("user-agent") || ""
  const uaInfo: UAInfo = parseUA(ua)
  // GDPR: IP anonymized before storage — last octet zeroed (IPv4) / last 80 bits zeroed (IPv6).
  const rawIp = safe.ip || getClientIP(req)
  const ip = anonymizeIP(rawIp)
  const geo = fakeGeo(ip)
  // v11.18.6 SECURITY FIX: use crypto.randomBytes instead of Math.random for
  // visitor ID generation. Math.random is NOT cryptographically secure — its
  // output can be predicted, allowing an attacker to impersonate other visitors
  // and pollute their analytics data.
  const visitorId = safe.visitorId || "anon-" + randomBytes(8).toString("hex")

  // Find or create session
  let session = safe.sessionId
    ? await db.session.findUnique({ where: { id: safe.sessionId } })
    : null

  if (!session) {
    // GDPR race-safety (the original race this fixes):
    //   A visitor can be GDPR-erased concurrently with this ingest request.
    //   Without a guard, the erase's `deleteMany` (in src/lib/retention.ts)
    //   could commit BETWEEN our findUnique (above, returned null) and our
    //   create (below) — and then the new session we create would survive
    //   the erasure, leaking the visitor's data after the erase response
    //   was sent (Article 17 violation).
    //
    // Fix: check the tombstone first (cheap fast-path); then re-check
    //   inside the find+create transaction to close the window between
    //   the outer check and the create.
    const tombstoned = await db.visitorTombstone.findUnique({
      where: { projectId_visitorId: { projectId: project.id, visitorId } },
      select: { id: true },
    })
    if (tombstoned) {
      logger.warn("ingest_tombstoned_visitor", {
        projectId: project.id,
        visitorId: visitorId.slice(0, 8) + "...",
      })
      // Don't reveal to the client that the visitor was erased — return a
      // generic ok:false so a probe learns nothing about the tombstone state.
      return { ok: false, error: "unknown project" }
    }

    // Wrap the new-visitor find + session create in a transaction so the
    // tombstone re-check inside the transaction reads a consistent snapshot
    // with the create. SQLite interactive transactions are serializable, so
    // if an erase commits its tombstone before our create, our re-check
    // (run inside the same transaction after the tombstone is visible)
    // would catch it. The microsecond race between the re-check and the
    // create is the irreducible window without a DB trigger; the tombstone
    // approach catches the typical case of two HTTP requests racing.
    try {
      session = await db.$transaction(async (tx) => {
        // Re-check inside the transaction — the erase could have committed
        // between our outer check (above) and this point. If so, refuse.
        const t = await tx.visitorTombstone.findUnique({
          where: { projectId_visitorId: { projectId: project.id, visitorId } },
          select: { id: true },
        })
        if (t) throw new VisitorTombstonedError()

        // Detect new vs returning visitor. NOTE: this is a best-effort
        // signal — two concurrent ingests for the same visitor (no
        // sessionId provided) can BOTH see "no existing session" and BOTH
        // create a session, BOTH with isNewVisitor=false when one should
        // have been true. Fully closing this race would require a Visitor
        // table with @@unique([projectId, visitorId]) and an upsert; that's
        // a larger schema change tracked as follow-up. The transaction
        // here at least makes the find+create atomic.
        const existing = await tx.session.findFirst({
          where: { projectId: project.id, visitorId },
          select: { id: true },
        })
        const isNewVisitor = !existing
        const entryUrl = safe.entryUrl || safe.events?.find((e) => e.type === "pageview")?.pageUrl || "/"
        return await tx.session.create({
          data: {
            projectId: project.id,
            visitorId,
            userAgent: ua,
            ip,
            country: geo.country,
            city: geo.city,
            device: uaInfo.device,
            browser: uaInfo.browser,
            os: uaInfo.os,
            screenWidth: safe.screenWidth || 1440,
            screenHeight: safe.screenHeight || 900,
            language: safe.language || "en",
            referrer: safe.referrer || "",
            utmSource: safe.utmSource || "",
            utmMedium: safe.utmMedium || "",
            utmCampaign: safe.utmCampaign || "",
            entryUrl,
            exitUrl: entryUrl,
            isNewVisitor,
            startedAt: safe.startedAt ? new Date(safe.startedAt) : new Date(),
            lastActiveAt: new Date(),
            isActive: !safe.end,
          },
        })
      })
    } catch (e) {
      if (e instanceof VisitorTombstonedError) {
        logger.warn("ingest_tombstoned_visitor_race", {
          projectId: project.id,
          visitorId: visitorId.slice(0, 8) + "...",
        })
        return { ok: false, error: "unknown project" }
      }
      throw e
    }
  } else {
    session = await db.session.update({
      where: { id: session.id },
      data: {
        lastActiveAt: new Date(),
        isActive: !safe.end,
      },
    })
  }

  // Insert events in bulk
  if (safe.events?.length) {
    const events = safe.events.map((e) => ({
      sessionId: session.id,
      type: e.type,
      t: Math.max(0, Math.floor(e.t || 0)),
      data: JSON.stringify(e.data || {}),
      pageUrl: e.pageUrl || "/",
      viewportWidth: e.viewportWidth || safe.screenWidth || 1440,
      viewportHeight: e.viewportHeight || safe.screenHeight || 900,
      scrollX: Math.floor(e.scrollX || 0),
      scrollY: Math.floor(e.scrollY || 0),
      x: Math.floor(e.x || 0),
      y: Math.floor(e.y || 0),
    }))
    // chunk insert to avoid too-large queries
    for (let i = 0; i < events.length; i += 200) {
      await db.event.createMany({ data: events.slice(i, i + 200) })
    }

    // Update aggregates + exit URL
    const clicks = safe.events.filter((e) => e.type === "click").length
    const pageviews = safe.events.filter((e) => e.type === "pageview").length
    const lastPv = [...safe.events].reverse().find((e) => e.type === "pageview")
    const updateData: Record<string, unknown> = {
      totalClicks: { increment: clicks },
      pageViewsCount: { increment: pageviews },
      duration: Math.floor(
        Math.max(session.duration || 0, safe.events[safe.events.length - 1]?.t || 0) / 1000
      ),
      lastActiveAt: new Date(),
    }
    if (lastPv?.pageUrl) updateData.exitUrl = lastPv.pageUrl
    await db.session.update({
      where: { id: session.id },
      data: updateData,
    })

    // Detect rage clicks: 3+ clicks within 1s on same area
    const clickEvents = safe.events.filter((e) => e.type === "click")
    for (let i = 0; i < clickEvents.length; i++) {
      const cluster = clickEvents.slice(i, i + 3)
      if (cluster.length === 3) {
        const dt = cluster[2].t - cluster[0].t
        const sameArea =
          Math.abs((cluster[0].x || 0) - (cluster[2].x || 0)) < 50 &&
          Math.abs((cluster[0].y || 0) - (cluster[2].y || 0)) < 50
        if (dt < 1200 && sameArea) {
          await db.insight.create({
            data: {
              sessionId: session.id,
              projectId: project.id,
              type: "rage_click",
              severity: "high",
              data: JSON.stringify({ x: cluster[0].x, y: cluster[0].y, pageUrl: cluster[0].pageUrl }),
            },
          }).catch(() => null)
          await db.session.update({ where: { id: session.id }, data: { hasRageClick: true } })
          break
        }
      }
    }

    // Goal conversion: check project goals against visited pages
    const visitedUrls = new Set(
      safe.events
        .filter((e) => e.type === "pageview")
        .map((e) => e.pageUrl)
        .filter((u): u is string => typeof u === "string" && u.length > 0)
    )
    if (visitedUrls.size > 0 && !session.convertedGoal) {
      // Bounded query — caps the goal set so an attacker who creates many
      // goals can't make the ingest path load an unbounded result set.
      const goals = await db.goal.findMany({
        where: { projectId: project.id, type: "url" },
        take: 100,
      })
      for (const g of goals) {
        const target = g.url || ""
        if (!target) continue
        const matched = Array.from(visitedUrls).some((u) => {
          if (g.match === "equals") return u === target
          if (g.match === "startsWith") return u.startsWith(target)
          return u.includes(target)
        })
        if (matched) {
          await db.session.update({ where: { id: session.id }, data: { convertedGoal: g.name } })
          break
        }
      }
    }
  }

  // Insert errors in bulk (single createMany per chunk — was N+1: one
  // db.errorEvent.create() per error on the ingest hot path, which serialised
  // N round-trips through SQLite's per-query transaction overhead). Same
  // .catch(() => null) swallow + hasError:true flag semantics as before.
  if (safe.errors?.length) {
    const errRows = safe.errors.map((err) => ({
      sessionId: session.id,
      projectId: project.id,
      message: err.message || "Unknown error",
      stack: err.stack || "",
      type: "js",
      url: err.url || "/",
      line: err.line || 0,
      t: err.t || 0,
    }))
    // Chunk to stay below SQLite's bound-parameter cap (matches the events
    // chunk-insert pattern above — 200 rows per INSERT).
    for (let i = 0; i < errRows.length; i += 200) {
      await db.errorEvent
        .createMany({ data: errRows.slice(i, i + 200) })
        .catch(() => null)
    }
    await db.session.update({ where: { id: session.id }, data: { hasError: true } })
  }

  if (safe.end) {
    await db.session.update({ where: { id: session.id }, data: { isActive: false } })
  }

  return { ok: true, sessionId: session.id, projectId: project.id }
}
