import { NextRequest, NextResponse } from "next/server"
import { getRetentionStats } from "@/lib/retention"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { reportUnauthorizedAdmin } from "@/lib/admin-radar"

/**
 * Constant-time string comparison (see retention-purge/route.ts for rationale).
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
 * Fails CLOSED: if ADMIN_TOKEN is unset, no request is authorized.
 */
function isAdminAuthorized(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN
  if (!expected) return false
  const provided = req.headers.get("x-admin-token")
  if (!provided) return false
  return safeEqual(provided, expected)
}

/**
 * GET /api/admin/retention-stats?days=90
 *
 * Returns retention stats so operators can preview what a purge would
 * remove BEFORE running it:
 *   {
 *     ok: true,
 *     oldestSession: "2024-01-01T..." | null,
 *     totalSessions: 12345,
 *     sessionsToPurge: 1234,
 *     retentionDays: 90,
 *     cutoffDate: "2024-..."
 *   }
 *
 * Admin-only: requires `x-admin-token` header matching ADMIN_TOKEN env var.
 */
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req as unknown as Request)
  try {
    if (!isAdminAuthorized(req as unknown as Request)) {
      // Fire a security alert — someone is probing admin endpoints
      // without a valid token. See src/lib/admin-radar.ts.
      reportUnauthorizedAdmin(
        req as unknown as Request,
        "admin/retention-stats",
        "missing or invalid x-admin-token",
      )
      return NextResponse.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "Admin token required" } },
        { status: 401 }
      )
    }

    // Parse `days` query param (default 90, clamped to [1, 3650]).
    const daysParam = req.nextUrl.searchParams.get("days")
    let days = 90
    if (daysParam) {
      const parsed = parseInt(daysParam, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        days = Math.min(3650, Math.max(1, parsed))
      }
    }

    const stats = await getRetentionStats(days)

    return NextResponse.json({
      ok: true,
      ...stats,
      // Serialize Date → ISO string for JSON response.
      oldestSession: stats.oldestSession
        ? stats.oldestSession.toISOString()
        : null,
      cutoffDate: stats.cutoffDate.toISOString(),
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "admin_retention_stats")
    return NextResponse.json(body, { status })
  }
}
