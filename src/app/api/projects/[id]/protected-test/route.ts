import { NextRequest, NextResponse } from "next/server"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError, getRequestId } from "@/lib/observability"

/**
 * Demo endpoint proving the API-key auth middleware works.
 *
 * Usage:
 *   curl -H "Authorization: Bearer ir_xxx" \
 *        http://localhost:3000/api/projects/<id>/protected-test
 *   # or:
 *   curl "http://localhost:3000/api/projects/<id>/protected-test?apikey=ir_xxx"
 *
 * Returns 401 if the key is missing/invalid/wrong-project, otherwise
 * `{ ok: true, message: "Authenticated", keyId }`.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "protected_test", {
    enforceApiKey: "always",
  })
  if (guard.error) return guard.error
  void guard.session
  const requestId = getRequestId(req as unknown as Request)
  try {
    return NextResponse.json({
      ok: true,
      message: "Authenticated",
      keyId: guard.keyId,
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "protected_test")
    return NextResponse.json(body, { status })
  }
}
