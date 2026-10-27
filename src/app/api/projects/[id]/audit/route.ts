import { NextRequest, NextResponse } from "next/server";
import { readAuditLog, verifyAuditChain } from "@/lib/audit";
import { sanitizeError, getRequestId } from "@/lib/observability";
import { verifyProjectAccess } from "@/lib/project-auth";

/**
 * GET /api/projects/[id]/audit?limit=100
 *
 * Returns audit entries scoped to a single project (filtered by `projectId`),
 * each augmented with a `__tampered` boolean from `verifyAuditChain()` so
 * consumers can detect tampering.
 *
 * Pulls a wider window from the file then filters in memory — the audit log
 * is file-based so we cannot push the filter down to a query layer. The
 * chain verifier is intentionally run AFTER filtering so a missing predecessor
 * (out-of-filter) does not produce false-positive `__tampered` flags — only
 * per-entry hash mismatches are reported by `verifyAuditChain`.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const { session, error } = await verifyProjectAccess(id)
  if (error) return error
  void session
  const requestId = getRequestId(req as unknown as Request);
  try {
    const limitParam = req.nextUrl.searchParams.get("limit");
    let limit = 100;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.min(parsed, 500);
      }
    }
    // Read a wide window so the post-filter result has a chance to reach `limit`.
    const all = await readAuditLog(500);
    const filtered = all.filter((e) => e.projectId === id);
    const start = Math.max(0, filtered.length - limit);
    const slice = filtered.slice(start);
    // Run the tamper-evident hash chain verifier on the filtered slice before
    // returning so any retroactive edit of action/projectId/actor/ip/timestamp
    // surfaces as `__tampered: true` to the caller. Verifier only checks
    // per-entry hash recomputation (not chain continuity), so filtering by
    // projectId does not produce false positives when the predecessor entry
    // is out-of-window.
    const entries = verifyAuditChain(slice);
    return NextResponse.json({ entries });
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "project_audit");
    return NextResponse.json(body, { status });
  }
}
