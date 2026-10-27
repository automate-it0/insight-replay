import { NextRequest, NextResponse } from "next/server"
import { readFileSync, existsSync, statSync } from "fs"
import { basename, join, resolve, sep } from "path"
import { sanitizeError } from "@/lib/observability"
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
 * request is rejected — we never want to silently expose the full project
 * source download just because someone forgot to set the env var.
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

// ─── Path-traversal hardening (defense-in-depth) ───────────────────────────
//
// No part of `zipPath` is user-controlled today — the filename is a
// hardcoded constant and `process.cwd()` is set by the runtime. The checks
// below exist so that a future refactor that *does* take a user-supplied
// filename cannot regress into a path-traversal / LFI:
//
//   - `EXPECTED_FILENAME` is reduced through `basename()` so even a typo
//     like `"../insight-replay.zip"` would collapse to `insight-replay.zip`.
//   - The constructed path is canonicalized with `resolve()` and we verify
//     that the resolved path starts with `process.cwd() + sep` (i.e. the
//     download can NEVER escape the project root, even if someone later
//     threads a request param into the filename).
//   - We also reject any query string outright — this route has zero
//     legitimate query-param behaviour, so anything in the query string is
//     either a probe or a bug.
const EXPECTED_FILENAME = basename("insight-replay.zip")
const EXPECTED_RELATIVE_PATH = join(sep, EXPECTED_FILENAME)

/**
 * Resolve the absolute on-disk zip path AND assert that the resolved path
 * stays inside `process.cwd()`. Returns the canonical absolute path, or
 * `null` if the path somehow escaped the project root.
 *
 * This is the single chokepoint for all filesystem access in this route —
 * no other code path here is allowed to touch the disk.
 */
function resolveSafeZipPath(): string | null {
  const cwd = resolve(process.cwd())
  const zipPath = resolve(cwd, EXPECTED_RELATIVE_PATH)
  // Canonicalize both sides for the prefix check (resolve() already
  // collapses `..` etc.). The `sep` suffix prevents a sibling directory
  // like `/foo/insight-replay-zip` from matching a cwd of `/foo/insight`.
  const prefix = cwd.endsWith(sep) ? cwd : cwd + sep
  if (!zipPath.startsWith(prefix)) {
    // Resolved path escaped the project root — refuse to serve.
    return null
  }
  return zipPath
}

// ─── CORS hardening ─────────────────────────────────────────────────────────
//
// This route is admin-gated via a custom header (`x-admin-token`), which
// means any cross-origin request triggers a CORS preflight (OPTIONS) and
// the browser will only send the actual request if the preflight response
// echoes the header back via `Access-Control-Allow-Headers`. By NOT
// advertising `x-admin-token` in our CORS headers, we ensure cross-origin
// callers can never complete the preflight → the actual GET never fires.
// Same-origin dashboard requests are unaffected (CORS doesn't apply).
//
// On top of that preflight gate, we also:
//   - Refuse to reflect any `Origin` header value (deny-by-default).
//   - Set `Vary: Origin` so a CDN doesn't cache a permissive response.
//   - Send `Access-Control-Allow-Origin: null` so any (non-preflight) GET
//     that DOES slip through (e.g. a `<a href>` navigation) is also denied
//     cross-origin read access via the no-cors mode response opacity.
const CORS_HEADERS: Record<string, string> = {
  // `null` is the spec value that means "no origin" — browsers treat this
  // as a hard denial for cross-origin reads.
  "Access-Control-Allow-Origin": "null",
  "Vary": "Origin",
}

// Download endpoint for the full project source (zip).
// Serves <process.cwd()>/insight-replay.zip — a HARDCODED path. No query
// param or path param can change the served file: the filename constant is
// reduced through basename() and the resolved absolute path is asserted to
// stay inside process.cwd(). Admin-only: requires `x-admin-token` header
// matching ADMIN_TOKEN env var.
export async function GET(req: NextRequest) {
  // Reject ANY query string. This route has no query-param behaviour; an
  // `?` in the URL is either a probe or a bug, and refusing it here means
  // no future refactor that does `searchParams.get("file")` can ever be
  // reached without first removing this explicit guard.
  if (req.nextUrl.search.length > 0) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_REQUEST", message: "Query string not allowed" } },
      { status: 400, headers: CORS_HEADERS }
    )
  }

  // Auth gate — must come before any file access. Fail closed (403) if the
  // ADMIN_TOKEN env var is not configured or the provided token does not
  // match. This prevents unauthenticated download of the full source tree.
  if (!isAdminAuthorized(req as unknown as Request)) {
    // Fire a security alert — this endpoint serves the full project source
    // (zip), so an unauthorized probe is critical-signal (someone is
    // looking to exfiltrate the codebase). See src/lib/admin-radar.ts.
    reportUnauthorizedAdmin(
      req as unknown as Request,
      "download",
      "missing or invalid x-admin-token",
    )
    return NextResponse.json(
      { ok: false, error: { code: "FORBIDDEN", message: "Admin token required" } },
      { status: 403, headers: CORS_HEADERS }
    )
  }

  // Resolve + assert the canonical zip path stays inside the project root.
  const zipPath = resolveSafeZipPath()
  if (zipPath === null) {
    // Should never happen for a hardcoded filename, but if a future
    // refactor threads a request param into the path, this is the tripwire.
    return NextResponse.json(
      { ok: false, error: { code: "FORBIDDEN", message: "Path escapes project root" } },
      { status: 403, headers: CORS_HEADERS }
    )
  }

  if (!existsSync(zipPath)) {
    return NextResponse.json(
      { error: "Zip file not found. Run the build first." },
      { status: 404, headers: CORS_HEADERS }
    )
  }

  try {
    const fileBuffer = readFileSync(zipPath)
    const stat = statSync(zipPath)

    return new NextResponse(fileBuffer, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${EXPECTED_FILENAME}"`,
        "Content-Length": String(stat.size),
        "Cache-Control": "no-store",
        // MIME-confusion defense — never let a browser sniff this response
        // as anything other than the zip we're serving.
        "X-Content-Type-Options": "nosniff",
        ...CORS_HEADERS,
      },
    })
  } catch (e) {
    // Sanitize: log the real filesystem error (with stack) server-side,
    // return a generic message to the client. The previous implementation
    // returned a hardcoded message WITHOUT logging server-side, which meant
    // an admin investigating a broken download had no log trail to follow.
    // Threading through sanitizeError gives us that trail without leaking
    // internal paths (the absolute zipPath, process.cwd(), errno strings,
    // etc.) to the caller — including the cross-origin CORS-permitted null
    // origin (which would otherwise see whatever `String(e)` produced).
    const { status, body } = sanitizeError(e, undefined, "download_zip")
    return NextResponse.json(body, { status, headers: CORS_HEADERS })
  }
}

// CORS preflight handler — explicitly refuses to advertise `x-admin-token`
// in `Access-Control-Allow-Headers`, so cross-origin callers can never
// complete the preflight and the actual GET never fires from another
// origin. Same-origin dashboard requests are not preflighted.
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      // Deliberately do NOT include `Access-Control-Allow-Headers:
      // x-admin-token`. This is the actual CORS gate: without the echo,
      // the browser refuses to send the credentialed GET.
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "600",
    },
  })
}
