import { NextRequest, NextResponse } from "next/server"
import { purgeOldSessions } from "@/lib/retention"
import { auditLog } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { reportUnauthorizedAdmin } from "@/lib/admin-radar"

/**
 * Constant-time string comparison.
 *
 * Compares two strings of equal length using XOR so the running time does
 * not depend on how early the first difference appears. Returns false
 * immediately on length mismatch (this leaks length, not content —
 * acceptable because the admin token's length is not itself a secret worth
 * protecting against a side-channel).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Validate the x-admin-token header against ADMIN_TOKEN env var.
 *
 * Fails CLOSED: if ADMIN_TOKEN is not configured on the server, every
 * request is rejected — we never want to silently expose a destructive
 * purge endpoint just because someone forgot to set the env var.
 *
 * Returns true iff the request carries the exact expected token.
 */
function isAdminAuthorized(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN
  if (!expected) {
    // Server misconfiguration — fail closed.
    return false
  }
  const provided = req.headers.get("x-admin-token")
  if (!provided) return false
  return safeEqual(provided, expected)
}

/**
 * POST /api/admin/retention-purge?days=90
 *
 * Triggers a purge of all sessions older than `days` (default 90). Cascades
 * to events, insights, errors, notes, tags, bookmarks via Prisma relations.
 *
 * Admin-only: requires `x-admin-token` header matching ADMIN_TOKEN env var.
 * Intended to be called by scripts/cron-purge.sh on a daily schedule.
 *
 * Returns: { ok: true, purged: N, cutoff: "<iso>", days: 90 }
 */
export async function POST(req: NextRequest) {
  const requestId = getRequestId(req as unknown as Request)
  try {
    if (!isAdminAuthorized(req as unknown as Request)) {
      // Fire a security alert — this is a destructive endpoint; an
      // unauthorized probe here is high-signal. See src/lib/admin-radar.ts.
      reportUnauthorizedAdmin(
        req as unknown as Request,
        "admin/retention-purge",
        "missing or invalid x-admin-token",
      )
      // Return 401 (not 403) to avoid leaking whether the endpoint exists —
      // same shape a missing-auth response would have elsewhere.
      return NextResponse.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "Admin token required" } },
        { status: 401 }
      )
    }

    // Parse `days` query param, defaulting to 90. Clamp to [1, 3650] so a
    // typo (days=0, days=-1, days=999999) cannot wipe the entire DB or do
    // nothing useful.
    const daysParam = req.nextUrl.searchParams.get("days")
    let days = 90
    if (daysParam) {
      const parsed = parseInt(daysParam, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        days = Math.min(3650, Math.max(1, parsed))
      }
    }

    const { purgedSessions, cutoffDate } = await purgeOldSessions(days)

    // Audit-log the purge — this is a destructive operation, so we want a
    // record of who triggered it, when, and how much was removed. AUDIT_ACTIONS
    // doesn't have a retention action constant; using a literal keeps the
    // action name semantically accurate (see Task B precedent with "alert_updated").
    await auditLog({
      action: "retention_purge",
      actor: "admin",
      ip: getClientIP(req as unknown as Request),
      details: {
        days,
        cutoff: cutoffDate.toISOString(),
        purgedSessions,
      },
    })

    return NextResponse.json({
      ok: true,
      purged: purgedSessions,
      cutoff: cutoffDate.toISOString(),
      days,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "admin_retention_purge")
    return NextResponse.json(body, { status })
  }
}
