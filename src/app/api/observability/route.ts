import { NextRequest, NextResponse } from "next/server"
import { snapshotMetrics, readAppLog, runHealthChecks, sanitizeError } from "@/lib/observability"
import { reportUnauthorizedAdmin } from "@/lib/admin-radar"

/**
 * Constant-time string comparison.
 *
 * Compares two strings of equal length using XOR so the running time does
 * not depend on how early the first difference appears. Returns false
 * immediately on length mismatch (this leaks length, not content —
 * acceptable because the admin token's length is not itself a secret worth
 * protecting against a side-channel).
 *
 * Mirrors src/app/api/admin/retention-purge/route.ts.
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
 * request is rejected — the observability endpoint exposes server metrics,
 * recent application logs, and health-check details, none of which should
 * ever leak to an unauthenticated caller just because someone forgot to
 * set the env var.
 *
 * Returns true iff the request carries the exact expected token.
 *
 * Mirrors src/app/api/admin/retention-purge/route.ts.
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

// Observability dashboard endpoint — metrics, recent logs, health.
//
// Admin-only: requires `x-admin-token` header matching ADMIN_TOKEN env var.
// Fails closed (403) if ADMIN_TOKEN is unset or the header doesn't match.
export async function GET(req: NextRequest) {
  try {
    if (!isAdminAuthorized(req as unknown as Request)) {
      // Fire a security alert — this endpoint exposes server metrics, logs,
      // and health details; an unauthorized probe is high-signal.
      // See src/lib/admin-radar.ts.
      reportUnauthorizedAdmin(
        req as unknown as Request,
        "observability",
        "missing or invalid x-admin-token",
      )
      // 403 (not 401): this endpoint is intentionally discoverable, but the
      // data it returns is privileged. Fail closed on both missing env var
      // and wrong/missing token.
      return NextResponse.json(
        { ok: false, error: { code: "FORBIDDEN", message: "Admin token required" } },
        { status: 403 }
      )
    }

    const metrics = snapshotMetrics()
    const logs = readAppLog(50)
    const health = await runHealthChecks()
    return NextResponse.json({
      status: health.status,
      uptime: health.uptime,
      health: health.checks,
      metrics,
      recentLogs: logs,
      timestamp: new Date().toISOString(),
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, undefined, "observability")
    return NextResponse.json(body, { status })
  }
}
