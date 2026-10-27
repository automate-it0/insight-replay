import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { validateApiKey, unauthorizedResponse } from "@/lib/auth"
import { auditLog, AUDIT_ACTIONS } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import { sanitizeError } from "@/lib/observability"

/**
 * DELETE — revoke an API key.
 *
 * Requires a valid existing API key in production (revoking a key is a
 * destructive mutation — an attacker who could call this anonymously could
 * lock the project owner out of their own data). Open in dev for testing.
 */
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; kid: string }> },
) {
  const { id, kid } = await ctx.params
  if (process.env.NODE_ENV === "production") {
    const auth = await validateApiKey(req, id)
    if (!auth.valid) return unauthorizedResponse()
  }
  try {
    await db.apiKey.deleteMany({ where: { id: kid, projectId: id } })
    // Audit-log API key revocation. The key itself is never logged — only its
    // database id, which is enough to trace back through prior audit entries.
    await auditLog({
      action: AUDIT_ACTIONS.APIKEY_REVOKED,
      projectId: id,
      actor: "api",
      ip: getClientIP(req as unknown as Request),
      details: { keyId: kid },
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "apikey_revoke")
    return NextResponse.json(body, { status })
  }
}
