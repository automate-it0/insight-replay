import { NextRequest, NextResponse } from "next/server"
import { eraseVisitorData } from "@/lib/retention"
import { auditLog } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError, getRequestId } from "@/lib/observability"

/**
 * DELETE /api/projects/[id]/visitors/[vid]/erase
 *
 * GDPR Article 17 — Right to Erasure ("Right to be Forgotten").
 *
 * Deletes ALL sessions belonging to visitor `[vid]` in project `[id]`, and
 * cascades to events, insights, errors, notes, tags, bookmarks via Prisma's
 * `onDelete: Cascade` relations on Session. After this call returns, no
 * analytics data remains for that visitor within the project.
 *
 * Auth:
 *   - In production (NODE_ENV=production): requires a valid API key for the
 *     project (Authorization: Bearer <key> or ?apikey=<key>).
 *   - In dev: open — so the dashboard can exercise the endpoint without
 *     passing keys during local testing. This mirrors the convention used
 *     by /api/projects/[id]/export and other mutating dashboard endpoints.
 *
 * Returns: { ok: true, deletedSessions: N, visitorId: "<vid>" }
 *
 * Audit: writes a "gdpr_erasure" entry to logs/audit.jsonl capturing the
 * project, masked visitor id, count of deleted sessions, and caller IP.
 * This is essential for demonstrating GDPR compliance on request.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; vid: string }> }
) {
  const { id, vid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "gdpr_erasure_access")
  if (guard.error) return guard.error
  void guard.session
  const requestId = getRequestId(req as unknown as Request)
  try {
    // Basic input validation — cuid-shaped IDs only. Defends against
    // malformed inputs reaching the DB layer.
    if (!id || typeof id !== "string" || id.length > 64) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_REQUEST", message: "Invalid project id" } },
        { status: 400 }
      )
    }
    if (!vid || typeof vid !== "string" || vid.length > 200) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_REQUEST", message: "Invalid visitor id" } },
        { status: 400 }
      )
    }

    const { deletedSessions, visitorId } = await eraseVisitorData(id, vid)

    // Audit-log the erasure. We deliberately mask the visitor id (first 8
    // chars + "...") in the audit log: the full visitor id is itself
    // personal data under GDPR, and the audit trail's job here is to prove
    // the erasure happened (not to re-persist the identifier).
    await auditLog({
      action: "gdpr_erasure",
      projectId: id,
      actor: "api",
      ip: getClientIP(req as unknown as Request),
      details: {
        visitorIdMasked: visitorId.slice(0, 8) + "...",
        deletedSessions,
      },
    })

    return NextResponse.json({
      ok: true,
      deletedSessions,
      visitorId,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "gdpr_erasure")
    return NextResponse.json(body, { status })
  }
}
