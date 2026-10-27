import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { auditLog, AUDIT_ACTIONS } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"

function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

// ─── CORS hardening ─────────────────────────────────────────────────────────
//
// This route serves a PII-rich CSV (visitor IPs, locations, full page URLs).
// It is dashboard-only — session-gated in dev, API-key-gated in prod. Cross-
// origin callers should NEVER be able to read this response. We set
// `Access-Control-Allow-Origin: null` explicitly so even a credentialed
// cross-origin fetch that somehow slipped past the session/API-key gate would
// be opaque to the calling page. `Vary: Origin` defeats CDN caching.
//
// Note: the `id` path param only flows into a Prisma `where` clause
// (`{ projectId: id }`) — it is NEVER interpolated into a filesystem path.
// This route generates the CSV inline; it does not write a temp file to disk.
const FILE_SERVING_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "null",
  "Vary": "Origin",
  "X-Content-Type-Options": "nosniff",
}

// GET — export sessions as CSV. Returns up to 5000 sessions of raw PII-rich
// analytics data (IPs, locations, visit URLs) — treat as a sensitive export.
// Requires a valid API key in production. Open in dev for dashboard testing.
//
// Path-traversal / LFI posture: NO path traversal vector. The `id` path
// param is used only as a Prisma `where` filter (`{ projectId: id }`); the
// `range` and `filter` query params are parsed into integers / matched
// against a fixed enum-style allowlist. The CSV is generated inline and
// served directly from the response body — no temp file is written to disk,
// so no user input ever reaches a filesystem path.
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "data_export", {
    unauthorizedHeaders: FILE_SERVING_HEADERS,
  })
  if (guard.error) return guard.error
  void guard.session
  const requestId = (req.headers.get("x-request-id") as string | null) ?? undefined
  try {
    const range = req.nextUrl.searchParams.get("range") || "7"
    const days = parseInt(range, 10)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const filter = req.nextUrl.searchParams.get("filter") || "all"

    // Allowlist `filter` against a fixed set — rejects anything that is not
    // one of the four known rage/dead/active/error filters or "all".
    const FILTER_ALLOWLIST = new Set(["all", "rage", "dead", "active", "error"])
    if (!FILTER_ALLOWLIST.has(filter)) {
      return NextResponse.json(
        { error: "Invalid filter" },
        { status: 400, headers: FILE_SERVING_HEADERS }
      )
    }

    const where: Record<string, unknown> = { projectId: id, startedAt: { gte: since } }
    if (filter === "rage") where.hasRageClick = true
    if (filter === "dead") where.hasDeadClick = true
    if (filter === "active") where.isActive = true
    if (filter === "error") where.hasError = true

    const sessions = await db.session.findMany({
      where,
      orderBy: { startedAt: "desc" },
      take: 5000,
    })

    // Audit-log the data export. Sensitive because the CSV contains PII
    // (visitor IPs, locations, full page URLs). We log filter + row count so
    // a forensic review can reconstruct who pulled what, when, from where.
    await auditLog({
      action: AUDIT_ACTIONS.DATA_EXPORTED,
      projectId: id,
      actor: "api",
      ip: getClientIP(req as unknown as Request),
      details: { filter, range: String(days), count: sessions.length },
    })

    const headers = [
      "sessionId", "visitorId", "startedAt", "duration", "device", "browser", "os",
      "country", "city", "pageViews", "clicks", "entryUrl", "exitUrl",
      "hasRageClick", "hasDeadClick", "hasError", "convertedGoal", "referrer", "utmSource",
    ]

    const rows = sessions.map((s) => [
      s.id,
      s.visitorId,
      s.startedAt.toISOString(),
      s.duration,
      s.device,
      s.browser,
      s.os,
      s.country,
      s.city,
      s.pageViewsCount,
      s.totalClicks,
      s.entryUrl,
      s.exitUrl,
      s.hasRageClick,
      s.hasDeadClick,
      s.hasError,
      s.convertedGoal,
      s.referrer,
      s.utmSource,
    ].map(csvCell).join(","))

    const csv = [headers.join(","), ...rows].join("\n")

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="sessions.csv"',
        "Cache-Control": "no-store",
        ...FILE_SERVING_HEADERS,
      },
    })
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "export_csv")
    return NextResponse.json(body, {
      status,
      headers: FILE_SERVING_HEADERS,
    })
  }
}

// CORS preflight — refuse to advertise any custom auth header so cross-origin
// callers can never complete the preflight and the actual GET never fires
// from another origin. Same-origin dashboard requests are not preflighted.
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...FILE_SERVING_HEADERS,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "600",
    },
  })
}
