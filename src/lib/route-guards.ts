/**
 * @file src/lib/route-guards.ts
 *
 * Consolidated route guard for `/api/projects/[id]/*` — collapses the
 * `verifyProjectAccess` + `validateApiKey` + `auditLog` pattern that was
 * duplicated across ~20 route handlers (cluster 31-A's top offender in the
 * 879-duplicate-cluster report).
 *
 * WHY THIS EXISTS
 * ───────────────
 * Before this helper shipped, every mutating route handler under
 * `projects/[id]/*` inlined the same ~6-line guard:
 *
 *     const { id } = await ctx.params
 *     const { session, error } = await verifyProjectAccess(id)
 *     if (error) return error
 *     void session
 *     if (process.env.NODE_ENV === "production") {
 *       const auth = await validateApiKey(req, id)
 *       if (!auth.valid) return unauthorizedResponse()
 *     }
 *     try { /* mutation *\/ } catch (e) { /* sanitize *\/ }
 *
 * That pattern was duplicated verbatim across 20 files and 40+ HTTP method
 * handlers (POST/PUT/PATCH/DELETE on alerts, annotations, dashboards,
 * experiments, funnels, goals, projects, sessions/*, visitors/[vid]/erase,
 * plus the always-keyed GET on /export and /protected-test). Any future change
 * to the guard (e.g. the documented P4-A follow-up to consult
 * `shouldEnforceApiKeyAuth()` instead of `NODE_ENV === "production"`) had to
 * be hand-applied to every copy. This file is the single chokepoint.
 *
 * THE CONTRACT
 * ────────────
 *     const { id } = await ctx.params
 *     const guard = await requireProjectAccess(req, id, "alert_create")
 *     if (guard.error) return guard.error
 *     // guard.session / guard.project available for use below
 *     try { /* mutation *\/ } catch (e) { /* sanitize *\/ }
 *
 * Three duties, all in one (order is identical to the inlined pattern —
 * fail-closed on auth failure, 401 for missing session, 404 for unknown
 * project, 401 for invalid API key when enforcement is on, dev-mode bypass):
 *
 *   1. **verifyProjectAccess** — session + project-existence check (the IDOR
 *      block). Auth runs BEFORE existence, so unauthenticated callers get 401
 *      regardless of whether the project exists — eliminating the enumeration
 *      oracle (200 = exists, 404 = doesn't).
 *   2. **validateApiKey** — the API-key check, gated by `enforceApiKey`:
 *      - `"production-only"` (default): mirror the historical behavior —
 *        `validateApiKey` is consulted only when `shouldEnforceApiKeyAuth()`
 *        returns true (production OR `ENFORCE_AUTH_IN_DEV=true`). This is the
 *        canonical replacement for the inlined `process.env.NODE_ENV ===
 *        "production"` block, centralizing the enforcement decision per the
 *        P4-A migration note in `src/lib/auth.ts`.
 *      - `"always"`: require a valid key in ALL environments. Use for
 *        endpoints that demonstrate / verify API-key auth itself (e.g.
 *        `/api/projects/[id]/protected-test`).
 *      - `"never"`: skip key validation entirely. Use for read-only GET
 *        handlers that don't currently call `validateApiKey`.
 *   3. **auditLog** — a fire-and-forget access-granted entry labeled with the
 *      `action` parameter, capturing project, actor ("api"), client IP, HTTP
 *      method, request path, and the keyId (when a key was used). Never
 *      throws, never blocks the response (auditLog swallows internal errors
 *      per its own contract, and we wrap it in a try/catch as defense in
 *      depth). Default on for mutating methods (POST/PUT/PATCH/DELETE), off
 *      for read methods (GET/HEAD/OPTIONS) — matching the pre-refactor audit
 *      cadence (mutating handlers audited the mutation; GET handlers didn't
 *      audit at all). Callers can override with `audit: true` (e.g. for the
 *      CSV export GET, which already audits `DATA_EXPORTED`).
 *
 * The middleware's audit entry is supplementary observability — it surfaces
 * the fact-of-access (who/what/when) which the pre-refactor handlers did NOT
 * uniformly log. Per-mutation audits (`ALERT_CREATED`, `PROJECT_DELETED`,
 * `gdpr_erasure`, etc.) remain in their handlers, unchanged — they capture
 * resource-specific details (alert IDs, key IDs, masked visitor IDs) that
 * this access-granted entry deliberately does not.
 *
 * EDGE CASES
 * ──────────
 *  - `unauthorizedHeaders` option: merges extra headers onto the 401 response
 *    when the API-key check fails. Used by the CSV export route to attach
 *    `Access-Control-Allow-Origin: null` + `Vary: Origin` so even the
 *    rejection leaks nothing cross-origin (preserves the existing
 *    FILE_SERVING_HEADERS behavior of `src/app/api/projects/[id]/export`).
 *  - `keyId` is surfaced on success when `validateApiKey` was called and
 *    matched. Used by `/api/projects/[id]/protected-test` to return the key
 *    id in the response body.
 *
 * TEST COVERAGE
 * ─────────────
 *  - `tests/idor.test.ts` pins the three failure modes that this middleware
 *    must preserve: 401 for missing session, 404 for unknown project, 404
 *    for unknown project under POST/PATCH (no open-create IDOR). The
 *    middleware's early-return on `access.error` preserves all three.
 *  - `tests/security/auth.test.ts` exercises `validateApiKey` directly via
 *    `src/lib/auth.ts`; the middleware's `validateApiKey` call is the same
 *    function, so its security properties (constant-time comparison, bounded
 *    query, fire-and-forget `lastUsed` update) carry over unchanged.
 */

import { NextResponse } from "next/server"

import { verifyProjectAccess } from "@/lib/project-auth"
import {
  validateApiKey,
  unauthorizedResponse,
  shouldEnforceApiKeyAuth,
} from "@/lib/auth"
import { auditLog } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import type { SessionUser } from "@/lib/session"

/**
 * Successful access — `session` and `project` are non-null; `keyId` is set
 * when `validateApiKey` was called and matched, null when key validation was
 * skipped (e.g. dev mode OR `enforceApiKey: "never"`).
 */
export type RequireProjectAccessOk = {
  session: SessionUser
  project: {
    id: string
    name: string
    siteUrl: string
    trackingId: string
    createdAt: Date
  }
  keyId: string | null
  error: null
}

/**
 * Failed access — `error` is the NextResponse the route handler MUST return
 * verbatim (preserves the exact status code + body the inlined guard
 * produced: 401 for missing session, 404 for unknown project, 401 for
 * invalid API key, optionally with extra headers via `unauthorizedHeaders`).
 */
export type RequireProjectAccessErr = {
  session: null
  project: null
  keyId: null
  error: NextResponse
}

export type RequireProjectAccessResult =
  | RequireProjectAccessOk
  | RequireProjectAccessErr

/**
 * When to require a valid API key in addition to the session cookie. See the
 * file header for the full rationale per mode.
 */
export type ApiKeyEnforcement = "production-only" | "always" | "never"

export interface RequireProjectAccessOptions {
  /**
   * When to require a valid API key. Defaults to `"production-only"` —
   * `validateApiKey` is consulted only when `shouldEnforceApiKeyAuth()`
   * returns true (production OR `ENFORCE_AUTH_IN_DEV=true`). Use `"always"`
   * for endpoints that demonstrate API-key auth (e.g. /protected-test, where
   * the existing handler calls `validateApiKey` regardless of NODE_ENV).
   * Use `"never"` for read-only GET handlers.
   */
  enforceApiKey?: ApiKeyEnforcement
  /**
   * Whether to write the fire-and-forget audit-log entry on a successful
   * access. Defaults to on for mutating methods (POST/PUT/PATCH/DELETE), off
   * for read methods — matching the pre-refactor audit cadence. Override
   * with `true` to audit a GET (e.g. the CSV export) or `false` to skip
   * auditing a mutation that the handler audits itself with a more specific
   * action name.
   */
  audit?: boolean
  /**
   * Optional extra headers to attach to the 401 response when the API-key
   * check fails. Used by the CSV export route to merge CORS hardening
   * headers (`Access-Control-Allow-Origin: null` + `Vary: Origin`) so even
   * the rejection leaks nothing cross-origin.
   */
  unauthorizedHeaders?: Record<string, string>
}

/** HTTP methods that mutate server state — used to default the `audit` flag. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/**
 * Require project access — the consolidated guard for every route under
 * `/api/projects/[id]/*`. Replaces the inlined `verifyProjectAccess` +
 * `validateApiKey` + `auditLog` pattern. See the file header for the full
 * contract, ordering rationale, and edge cases.
 *
 * @example
 *   // Mutating handler (POST/PUT/PATCH/DELETE):
 *   export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
 *     const { id } = await ctx.params
 *     const guard = await requireProjectAccess(req, id, "alert_create")
 *     if (guard.error) return guard.error
 *     try {
 *       // ... mutation
 *     } catch (e) { /* sanitize *\/ }
 *   }
 *
 * @example
 *   // Read-only GET handler (no API-key check, no audit by default):
 *   export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
 *     const { id } = await ctx.params
 *     const guard = await requireProjectAccess(req, id, "alert_list", {
 *       enforceApiKey: "never",
 *     })
 *     if (guard.error) return guard.error
 *     // ... read
 *   }
 *
 * @example
 *   // GET that requires an API key in ALL environments (e.g. /protected-test):
 *   const guard = await requireProjectAccess(req, id, "protected_test", {
 *     enforceApiKey: "always",
 *   })
 *   if (guard.error) return guard.error
 *   return NextResponse.json({ ok: true, keyId: guard.keyId })
 *
 * @example
 *   // CSV export — merge CORS hardening headers onto the 401 rejection:
 *   const guard = await requireProjectAccess(req, id, "data_export", {
 *     unauthorizedHeaders: FILE_SERVING_HEADERS,
 *   })
 *   if (guard.error) return guard.error
 */
export async function requireProjectAccess(
  req: Request,
  projectId: string,
  action: string,
  options: RequireProjectAccessOptions = {},
): Promise<RequireProjectAccessResult> {
  const {
    enforceApiKey = "production-only",
    audit = MUTATING_METHODS.has(req.method),
    unauthorizedHeaders,
  } = options

  // (1) verifyProjectAccess — handles session + project existence (the IDOR
  //     block). Auth runs first, so unauthenticated callers get 401 regardless
  //     of whether the project exists; existence runs second, returning 404
  //     for unknown ids. No try/catch around this call — verifyProjectAccess
  //     intentionally does NOT catch Prisma errors (any throw propagates up
  //     to the route handler, which has its own try/catch + sanitizeError).
  const access = await verifyProjectAccess(projectId)
  if (access.error) {
    return { session: null, project: null, keyId: null, error: access.error }
  }

  // (2) validateApiKey — only when enforcement conditions are met. The
  //     `shouldEnforceApiKeyAuth()` helper centralizes the production +
  //     ENFORCE_AUTH_IN_DEV decision (the P4-A migration target).
  let keyId: string | null = null
  const enforce =
    enforceApiKey === "always" ||
    (enforceApiKey === "production-only" && shouldEnforceApiKeyAuth())
  if (enforce) {
    const auth = await validateApiKey(req, projectId)
    if (!auth.valid) {
      let error = unauthorizedResponse()
      if (unauthorizedHeaders) {
        // Merge the caller-supplied headers onto the 401 response so even
        // the rejection carries the route's CORS / caching posture (e.g.
        // the CSV export route's `Access-Control-Allow-Origin: null`).
        error = new NextResponse(error.body, {
          status: error.status,
          headers: {
            ...Object.fromEntries(error.headers.entries()),
            ...unauthorizedHeaders,
          },
        })
      }
      return { session: null, project: null, keyId: null, error }
    }
    if (auth.keyId) keyId = auth.keyId
  }

  // (3) auditLog — fire-and-forget access-granted entry. Default on for
  //     mutating methods (matching the spirit of the pre-refactor per-
  //     mutation audits), off for read methods (matching the pre-refactor
  //     GET handlers' no-audit behavior). Wrapped in try/catch as defense
  //     in depth — auditLog swallows internally, but a throw from
  //     getClientIP / URL parsing here would otherwise leak to the route
  //     handler's try block (changing the error class from "audit failure,
  //     request continues" to "audit failure, request 500s").
  if (audit) {
    try {
      const url = safeUrl(req)
      await auditLog({
        action,
        projectId,
        actor: "api",
        ip: getClientIP(req),
        details: {
          method: req.method,
          path: url ? url.pathname : null,
          keyId,
        },
      })
    } catch {
      // Intentionally swallowed — audit logging must never break the request.
    }
  }

  return {
    session: access.session,
    project: access.project,
    keyId,
    error: null,
  }
}

/** Parse `req.url` defensively — malformed URLs return null (audit logs `null`). */
function safeUrl(req: Request): URL | null {
  try {
    return new URL(req.url)
  } catch {
    return null
  }
}
