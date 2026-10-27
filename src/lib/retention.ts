// Data retention + GDPR right-to-erasure helpers.
//
// Two responsibilities:
//   1. purgeOldSessions(days) — auto-purge sessions older than the retention
//      window. Cascades to events, insights, errors, notes, tags, bookmarks
//      via the existing Prisma `onDelete: Cascade` relations on Session.
//   2. eraseVisitorData(projectId, visitorId) — GDPR Article 17 right-to-
//      erasure. Deletes ALL sessions for a single visitor within a project.
//
// Both functions are pure (no req/response handling) so they can be invoked
// from API routes, scripts, or background workers without adaptation.

import { db } from "@/lib/db"
import { logger } from "@/lib/observability"

const DEFAULT_RETENTION_DAYS = 90
const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Purge sessions older than the retention period.
 *
 * Cascades to events, insights, errors, notes, tags, bookmarks via Prisma's
 * `onDelete: Cascade` relations on Session (see prisma/schema.prisma) — one
 * deleteMany call removes the session row AND every related row, in the
 * correct order, inside a single transaction Prisma manages internally.
 *
 * Returns the number of sessions purged and the cutoff date used.
 */
export async function purgeOldSessions(
  days = DEFAULT_RETENTION_DAYS
): Promise<{ purgedSessions: number; cutoffDate: Date }> {
  const cutoff = new Date(Date.now() - days * MS_PER_DAY)
  logger.info("retention_purge_start", { days, cutoff: cutoff.toISOString() })

  // Delete sessions older than cutoff — Prisma cascades to related models.
  const result = await db.session.deleteMany({
    where: { startedAt: { lt: cutoff } },
  })

  logger.info("retention_purge_complete", {
    purgedSessions: result.count,
    cutoff: cutoff.toISOString(),
  })

  return { purgedSessions: result.count, cutoffDate: cutoff }
}

/**
 * GDPR Right-to-Erasure (Article 17): delete ALL data for a specific visitor
 * within a project. Deletes every session belonging to that visitor; Prisma
 * cascades the delete to events, insights, errors, notes, tags, bookmarks
 * (all `onDelete: Cascade` relations on Session).
 *
 * Race-safety (the original race this fixes):
 *   Without coordination, a tracking request that arrives microseconds AFTER
 *   the `deleteMany` below but in its own concurrent transaction could INSERT
 *   a brand-new session for the same visitorId AFTER the erase's transaction
 *   committed. That new session would survive the erasure — a GDPR Article
 *   17 violation (the visitor's data "reappeared" after the erase response
 *   was sent).
 *
 * Fix: tombstone + deleteMany run in a single Prisma interactive transaction.
 *   1. `visitorTombstone.upsert({ where: { projectId_visitorId }})` — creates
 *      a tombstone row with `@@unique([projectId, visitorId])`. Concurrent
 *      erase requests for the same visitor see the existing tombstone and
 *      the upsert becomes a no-op update (idempotent erase).
 *   2. `session.deleteMany({ where: { projectId, visitorId }})` — removes
 *      all existing sessions + cascades to child rows.
 *
 * The tracking pipeline (`src/lib/track.ts ingest()`) checks the tombstone
 * before creating any new session, so once this transaction commits, no
 * future tracking payload can re-create data for the visitor.
 *
 * The visitorId is logged with only the first 8 characters visible — enough
 * for correlation in the audit trail without persisting the full identifier
 * (which could itself be considered personal data under GDPR).
 *
 * Returns the number of sessions deleted.
 */
export async function eraseVisitorData(
  projectId: string,
  visitorId: string
): Promise<{ deletedSessions: number; visitorId: string }> {
  logger.info("gdpr_erasure_start", {
    projectId,
    visitorId: visitorId.slice(0, 8) + "...",
  })

  const result = await db.$transaction(async (tx) => {
    // 1. Tombstone FIRST so the constraint is in place BEFORE we delete any
    //    sessions. If a concurrent ingest is racing us, the tombstone will
    //    be there to gate the new session create even before our delete
    //    commits. Using `upsert` so concurrent erase calls for the same
    //    visitor are idempotent (the @@unique on (projectId, visitorId)
    //    would otherwise throw P2002 on a second insert).
    await tx.visitorTombstone.upsert({
      where: { projectId_visitorId: { projectId, visitorId } },
      create: { projectId, visitorId },
      // Refresh the timestamp on a re-erase (the visitor's previous tombstone
      // already exists). No-op semantically — the tombstone just needs to
      // exist for the tracking guard to find it.
      update: { erasedAt: new Date() },
    })

    // 2. Delete every session for this visitor. Prisma cascades to:
    //    events, insights, errors, notes, tags, bookmarks (all onDelete:
    //    Cascade relations on Session in prisma/schema.prisma).
    return await tx.session.deleteMany({
      where: { projectId, visitorId },
    })
  })

  logger.info("gdpr_erasure_complete", {
    projectId,
    visitorId: visitorId.slice(0, 8) + "...",
    deletedSessions: result.count,
  })

  return { deletedSessions: result.count, visitorId }
}

/**
 * Get retention stats: oldest session, total sessions, estimated purge count.
 *
 * Used by /api/admin/retention-stats so operators can preview what a purge
 * would remove BEFORE running it (defense-in-depth against accidentally
 * nuking too much data). All counts are best-effort — they race with new
 * session writes between this call and any subsequent purge.
 */
export async function getRetentionStats(days = DEFAULT_RETENTION_DAYS) {
  const cutoff = new Date(Date.now() - days * MS_PER_DAY)
  const oldest = await db.session.findFirst({
    orderBy: { startedAt: "asc" },
    select: { startedAt: true },
  })
  const total = await db.session.count()
  const toPurge = await db.session.count({
    where: { startedAt: { lt: cutoff } },
  })
  return {
    oldestSession: oldest?.startedAt || null,
    totalSessions: total,
    sessionsToPurge: toPurge,
    retentionDays: days,
    cutoffDate: cutoff,
  }
}
