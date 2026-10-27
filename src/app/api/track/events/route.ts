import { NextRequest, NextResponse } from "next/server"
import { ingest } from "@/lib/track"
import { db } from "@/lib/db"
import { logger, recordHttpRequest, getRequestId, sanitizeError } from "@/lib/observability"
import { sanitizePayload } from "@/lib/sanitize"

/**
 * Resolve the request's own (dashboard) origin. Prefers `req.url` (full URL in
 * Next.js App Router), then falls back to constructing from `Host` /
 * `X-Forwarded-Host` + `X-Forwarded-Proto` headers. Returns null when nothing
 * works.
 */
function getOwnOrigin(req: NextRequest): string | null {
  try {
    const u = new URL(req.url)
    if (u.origin && u.origin !== "null") return u.origin
  } catch {
    // req.url may be path-only in some runtimes — fall through.
  }
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host")
  if (!host) return null
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https"
  return `${proto}://${host}`
}

/**
 * Pull the request's effective origin. Browsers always send `Origin` on
 * cross-origin POSTs and on same-origin POSTs in newer specs; older browsers
 * may only send `Referer`. If only `Referer` is present, derive its origin.
 */
function getRequestOrigin(req: NextRequest): string | null {
  const origin = req.headers.get("origin")
  if (origin) return origin
  const referer = req.headers.get("referer")
  if (referer) {
    try {
      return new URL(referer).origin
    } catch {
      return referer
    }
  }
  return null
}

/**
 * Normalize a raw siteUrl (which may be a bare hostname like `example.com`,
 * a full URL like `https://example.com`, or include a path) to an origin
 * string (`scheme://host[:port]`). Returns null when the value can't be parsed.
 */
function normalizeSiteOrigin(siteUrl: string): string | null {
  if (!siteUrl) return null
  try {
    return new URL(siteUrl).origin
  } catch {
    // bare hostname — prepend https://
    try {
      return new URL("https://" + siteUrl).origin
    } catch {
      return null
    }
  }
}

/**
 * Build the list of allowed origins for a given project + request:
 *   - the dashboard's own origin (so the dashboard UI can POST)
 *   - the project's siteUrl origin (so the legit tracked site can POST)
 *   - localhost is implicitly allowed by isOriginAllowed() for testing prod builds
 */
function buildAllowedOrigins(req: NextRequest, siteUrl: string | null | undefined): string[] {
  const origins: string[] = []
  const own = getOwnOrigin(req)
  if (own) origins.push(own)
  if (siteUrl) {
    const siteOrigin = normalizeSiteOrigin(siteUrl)
    if (siteOrigin) origins.push(siteOrigin)
  }
  return origins
}

/**
 * Returns true if `origin` is allowed given the `allowedOrigins` list.
 * Matches either exactly (full origin string) or by hostname (with subdomain
 * support — `shop.example.com` is allowed when `example.com` is in the list).
 * `localhost` / `127.0.0.1` on any port are always allowed so prod builds can
 * be tested locally. In development (`NODE_ENV !== 'production'`), always
 * returns true to keep local testing frictionless.
 */
function isOriginAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (process.env.NODE_ENV !== "production") return true
  if (!origin) return false

  let originHost: string
  try {
    originHost = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }

  if (originHost === "localhost" || originHost === "127.0.0.1" || originHost === "0.0.0.0") {
    return true
  }

  for (const allowed of allowedOrigins) {
    if (!allowed) continue
    if (origin === allowed) return true
    try {
      const allowedHost = new URL(allowed).hostname.toLowerCase()
      if (originHost === allowedHost) return true
      // subdomain match: originHost ends with .allowedHost
      if (allowedHost && originHost.endsWith("." + allowedHost)) return true
    } catch {
      // skip malformed entries
    }
  }
  return false
}

/**
 * Build CORS response headers for the actual POST response. In dev we return
 * `*` (matches the SDK script endpoint behaviour). In prod we reflect the
 * request Origin only when it is allowed — this lets legit tracked sites read
 * the response while blocked origins get no CORS header (browser hides the
 * response body from the calling JS).
 */
function corsResponseHeaders(
  req: NextRequest,
  allowedOrigins: string[]
): Record<string, string> {
  if (process.env.NODE_ENV !== "production") {
    return { "Access-Control-Allow-Origin": "*" }
  }
  const origin = getRequestOrigin(req)
  if (origin && isOriginAllowed(origin, allowedOrigins)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" }
  }
  return {}
}

export async function POST(req: NextRequest) {
  const start = Date.now()
  const requestId = getRequestId(req as unknown as Request)
  try {
    // Sanitize the payload BEFORE any use — escapes HTML, strips control chars,
    // prevents prototype pollution, caps string/array/depth sizes. Returns a NEW
    // object; reassigned here so every downstream read (projectId, ingest, event
    // count) operates on the safe copy. See src/lib/sanitize.ts for the contract.
    let payload = await req.json()
    payload = sanitizePayload(payload)
    const projectId = payload?.projectId
    if (!projectId || typeof projectId !== "string") {
      recordHttpRequest("POST", "/api/track/events", 400, Date.now() - start)
      return NextResponse.json(
        { ok: false, error: "missing projectId" },
        { status: 400, headers: corsResponseHeaders(req, []) }
      )
    }

    // Fetch project to get siteUrl BEFORE ingest so we can validate origin.
    const project = await db.project.findFirst({
      where: { OR: [{ id: projectId }, { trackingId: projectId }] },
      select: { siteUrl: true },
    })
    if (!project) {
      logger.warn("ingest_unknown_project", { requestId, projectId, entryPoint: "ingest" })
      recordHttpRequest("POST", "/api/track/events", 404, Date.now() - start)
      return NextResponse.json(
        { ok: false, error: "unknown project" },
        { status: 404, headers: corsResponseHeaders(req, []) }
      )
    }

    // Origin validation: in dev, isOriginAllowed short-circuits to true.
    const allowedOrigins = buildAllowedOrigins(req, project.siteUrl)
    const requestOrigin = getRequestOrigin(req)
    if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
      logger.warn("ingest_origin_blocked", { requestId, origin: requestOrigin, projectId, entryPoint: "ingest" })
      recordHttpRequest("POST", "/api/track/events", 403, Date.now() - start)
      return NextResponse.json(
        { error: "Origin not allowed" },
        { status: 403, headers: corsResponseHeaders(req, allowedOrigins) }
      )
    }

    // Origin is allowed — proceed with ingest.
    const result = await ingest(payload, req as unknown as Request)
    if (!result.ok) {
      recordHttpRequest("POST", "/api/track/events", 404, Date.now() - start)
      return NextResponse.json(result, {
        status: 404,
        headers: corsResponseHeaders(req, allowedOrigins),
      })
    }
    logger.info("ingest_success", {
      requestId,
      projectId: result.projectId,
      sessionId: result.sessionId,
      eventCount: payload?.events?.length || 0,
      durationMs: Date.now() - start,
      entryPoint: "ingest",
    })
    recordHttpRequest("POST", "/api/track/events", 200, Date.now() - start)
    return NextResponse.json(result, {
      headers: corsResponseHeaders(req, allowedOrigins),
    })
  } catch (e) {
    // Sanitize BEFORE logging — String(e) can include Prisma error class
    // names, SQL fragments, file paths, etc. sanitizeError() logs the real
    // error server-side (with stack, truncated) under event="api_error"
    // context="ingest" and returns a generic client-safe envelope. NEVER
    // return String(e) to the client — this endpoint is hit cross-origin
    // by the tracking SDK from third-party sites, so it is the most
    // exposed surface in the whole app.
    const { status, body } = sanitizeError(e, requestId, "ingest")
    recordHttpRequest("POST", "/api/track/events", status, Date.now() - start)
    return NextResponse.json(
      body,
      { status, headers: corsResponseHeaders(req, []) }
    )
  }
}

export async function OPTIONS(req: NextRequest) {
  const isDev = process.env.NODE_ENV !== "production"
  const origin = req.headers.get("origin")

  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  }

  if (isDev) {
    // Open preflight for local testing.
    headers["Access-Control-Allow-Origin"] = "*"
  } else if (origin) {
    // In prod, OPTIONS has no body so we can't resolve a projectId → siteUrl.
    // Only allow the dashboard's own origin (same-host) and localhost.
    // (Cross-site tracking POSTs will be re-validated against the project's
    // siteUrl inside POST; the preflight is intentionally restrictive so an
    // attacker cannot even probe the endpoint from arbitrary origins.)
    let allow = false
    try {
      const originHost = new URL(origin).hostname.toLowerCase()
      if (originHost === "localhost" || originHost === "127.0.0.1" || originHost === "0.0.0.0") {
        allow = true
      } else {
        const own = getOwnOrigin(req)
        if (own) {
          try {
            if (new URL(own).hostname.toLowerCase() === originHost) allow = true
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* malformed origin — leave allow=false */
    }
    if (allow) {
      headers["Access-Control-Allow-Origin"] = origin
      headers["Vary"] = "Origin"
    }
  }

  return new NextResponse(null, { headers })
}
