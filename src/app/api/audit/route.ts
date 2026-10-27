import { NextRequest, NextResponse } from "next/server";
import { readAuditLog, verifyAuditChain } from "@/lib/audit";
import { sanitizeError, getRequestId } from "@/lib/observability";
import { getSession } from "@/lib/session";

/**
 * GET /api/audit?limit=100
 *
 * Returns the most recent audit log entries (newest last, matching the order
 * they were appended to the file), each augmented with a `__tampered` boolean
 * from `verifyAuditChain()` so consumers can detect tampering.
 *
 * Requires a valid authenticated session — audit entries are sensitive
 * (security event trail) and must not be exposed to anonymous callers.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
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
    const rawEntries = await readAuditLog(limit);
    // Run the tamper-evident hash chain verifier on the results before
    // returning so any retroactive edit of action/projectId/actor/ip/timestamp
    // surfaces as `__tampered: true` to the caller.
    const entries = verifyAuditChain(rawEntries);
    return NextResponse.json({ entries });
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "audit_list");
    return NextResponse.json(body, { status });
  }
}
