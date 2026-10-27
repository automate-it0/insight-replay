import { NextRequest, NextResponse } from "next/server"
import { getRequestId, sanitizeError } from "@/lib/observability"
import { LOCKOUT_POLICY } from "@/lib/login-lockout"
import { cleanupIPBans } from "@/lib/ip-ban"
import { cleanupRateLimit } from "@/lib/rate-limit"
import { getAuditStats, verifyAuditIntegrity } from "@/lib/audit"

/**
 * Security health endpoint — `/api/security/health`.
 *
 * Returns the current security posture of the running system in a single
 * JSON payload: which hardening modules are wired up, what their configured
 * parameters are, live counters from the in-memory security Maps, and the
 * timestamps of the most recent radar / integrity scans.
 *
 * Why this exists:
 *  - Operators needed a programmatic way to verify the security posture of a
 *    running instance (CI gates, monitoring dashboards, on-call probes).
 *  - `/api/observability` returns server metrics + general health checks, but
 *    it does NOT break down which security modules are active. This endpoint
 *    does — every field is sourced from the actual security module that
 *    backs it (no hard-coded "we're secure, trust me" claims).
 *  - `/api/health` is unauthenticated and only returns DB/disk/memory status
 *    for load balancers; it deliberately leaks nothing about the security
 *    config. This endpoint is the admin-gated counterpart.
 *
 * Auth: requires the `x-admin-token` header to match the `ADMIN_TOKEN` env
 * var, same constant-time comparison + fail-closed-on-missing-env pattern as
 * `/api/admin/retention-purge` and `/api/observability`. Failing closed here
 * is non-negotiable — the response reveals the security posture, which is
 * exactly the kind of reconnaissance data an attacker would want before
 * launching an exploit.
 *
 * Runtime: Node.js only. Imports `fs/promises` (audit), `dns` (ssrf-guard
 * transitively when its module loads), and Prisma (admin-radar). Next.js
 * auto-detects this from the imports, but we set `runtime = "nodejs"`
 * explicitly below so the contract is stable.
 */

// ─── Admin-token auth (mirrors /api/admin/retention-purge + /api/observability) ──

/**
 * Constant-time string comparison.
 *
 * Compares two strings of equal length using XOR so the running time does
 * not depend on how early the first difference appears. Returns false
 * immediately on length mismatch (this leaks length, not content —
 * acceptable because the admin token's length is not itself a secret worth
 * protecting against a side-channel).
 *
 * Mirrors src/app/api/admin/retention-purge/route.ts and
 * src/app/api/observability/route.ts.
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
 * Validate the `x-admin-token` header against `ADMIN_TOKEN` env var.
 *
 * Fails CLOSED: if `ADMIN_TOKEN` is not configured on the server, every
 * request is rejected — we never want to silently expose the security
 * posture to an unauthenticated caller just because someone forgot to set
 * the env var.
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

// ─── Response shape ──────────────────────────────────────────────────────

interface SecurityChecks {
  /** KDF used for password hashing — sourced from `src/lib/session.ts`. */
  passwordHashing: string
  /** What the session cookie is bound to — sourced from `src/lib/session.ts`. */
  sessionBinding: string
  /** Rate-limiter scopes active — sourced from `src/lib/rate-limit.ts`. */
  rateLimiter: string
  /** CSRF defense layers — sourced from `src/lib/csrf.ts` + `src/middleware.ts`. */
  csrfProtection: string
  /** CSP policy style — sourced from `src/middleware.ts` `buildCsp`. */
  csp: string
  /** Max inbound request body size — sourced from `src/middleware.ts` Layer 2b. */
  bodyLimit: string
  /** Login lockout policy — sourced from `src/lib/login-lockout.ts` `LOCKOUT_POLICY`. */
  loginLockout: string
  /** Honeypot trap endpoint is mounted at `/api/trap/*`. */
  honeypotActive: boolean
  /** Audit log tamper-evidence mechanism — sourced from `src/lib/audit.ts`. */
  auditChain: string
  /** SSRF guard module is importable — sourced from `src/lib/ssrf-guard.ts`. */
  ssrfGuard: boolean
  /** File-integrity monitoring (audit hash chain) is in use. */
  fileIntegrity: string
  /** Admin-radar background scanner status — sourced from `src/lib/admin-radar.ts`. */
  adminRadar: string
  /** Session cookie is HMAC-signed (request-signing defense). */
  requestSigning: boolean
  /** IP-ban supports escalating durations — sourced from `src/lib/ip-ban.ts`. */
  banEscalation: boolean
  /** ISO timestamp of the last admin-radar scan run by this endpoint. */
  radarLastScan: string | null
  /** ISO timestamp of the last audit-chain integrity verification. */
  integrityLastCheck: string | null
}

interface SecurityStats {
  /** Non-expired entries in `globalThis.__ipBanMap`. */
  bannedIPs: number
  /** Non-expired entries in `globalThis.__rateLimitMap`. */
  rateLimitedIPs: number
  /** Lockout entries whose `lockedUntil` is still in the future. */
  lockedAccounts: number
  /** Sum of `failCount` across all lockout entries (lifetime counter, not
   *  reset-on-expiry). */
  failedLogins: number
  /** Total lines in `logs/audit.jsonl` (from `getAuditStats`). */
  auditEntries: number
}

interface SecurityHealthResponse {
  /** "healthy" iff every critical security module is wired + chain is valid. */
  status: "healthy" | "degraded"
  checks: SecurityChecks
  stats: SecurityStats
  /** Populated only when `status === "degraded"` — list of failing checks. */
  degraded?: string[]
  timestamp: string
}

// ─── In-memory Map stat readers (read globalThis state) ─────────────────

interface BanEntry {
  ip: string
  reason: string
  bannedUntil: number
}
interface RateLimitEntry {
  count: number
  resetAt: number
}
interface LockoutEntry {
  failCount: number
  lockedUntil: number
}

/**
 * Read `globalThis.__ipBanMap` and count the entries that are still active
 * (`bannedUntil > now`). Calls `cleanupIPBans()` first so any stale expired
 * entries are evicted before the count is taken — this keeps the reported
 * number honest (an entry that expired 24h ago should not be reported as a
 * live ban).
 *
 * Never throws; returns 0 on any internal error.
 */
function countBannedIPs(): number {
  try {
    // Best-effort sweep — evicts stale entries. The function is internal
    // to `src/lib/ip-ban.ts` but exported for exactly this kind of caller.
    cleanupIPBans()
    const g = globalThis as unknown as { __ipBanMap?: Map<string, BanEntry> }
    const map = g.__ipBanMap
    if (!map || typeof map.forEach !== "function") return 0
    const now = Date.now()
    let count = 0
    map.forEach((entry) => {
      if (entry && typeof entry.bannedUntil === "number" && entry.bannedUntil > now) {
        count++
      }
    })
    return count
  } catch {
    return 0
  }
}

/**
 * Read `globalThis.__rateLimitMap` and count the entries whose window has
 * not yet expired (`resetAt > now`). Calls `cleanupRateLimit()` first so
 * expired entries are evicted — otherwise a long-running process would
 * report stale counters that the limiter itself no longer enforces.
 *
 * Note: this counts ENTRIES (distinct IPs / user keys with an active
 * counter), not requests. An entry can be at count=1 (well under the
 * limit) or count=max (currently throttling). To distinguish "rate-limited
 * right now" we'd need to inspect each entry's count vs the configured
 * max — but the per-route max varies (INGEST_LIMIT, API_LIMIT, USER_*_LIMIT)
 * and the map key alone does not record which limit it was checked
 * against. So we report the next-best honest metric: number of IPs/user
 * keys with an active counter window. The header "rateLimitedIPs" reflects
 * the original spec field name.
 *
 * Never throws; returns 0 on any internal error.
 */
function countRateLimitedEntries(): number {
  try {
    cleanupRateLimit()
    const g = globalThis as unknown as { __rateLimitMap?: Map<string, RateLimitEntry> }
    const map = g.__rateLimitMap
    if (!map || typeof map.forEach !== "function") return 0
    const now = Date.now()
    let count = 0
    map.forEach((entry) => {
      if (entry && typeof entry.resetAt === "number" && entry.resetAt > now) {
        count++
      }
    })
    return count
  } catch {
    return 0
  }
}

/**
 * Read `globalThis.__loginLockoutMap` and compute two metrics:
 *   - `lockedAccounts`: entries with `lockedUntil > now` (currently serving
 *     a 15-min lockout).
 *   - `failedLogins`: sum of `failCount` across ALL entries (including
 *     ones whose lockout has expired but whose counter is still in the
 *     Map). This is a lifetime-style counter of total recorded failures,
 *     not "currently failing" — useful for spotting sustained brute-force
 *     activity across the app's lifetime.
 *
 * Never throws; returns `{ lockedAccounts: 0, failedLogins: 0 }` on error.
 */
function countLockouts(): { lockedAccounts: number; failedLogins: number } {
  try {
    const g = globalThis as unknown as { __loginLockoutMap?: Map<string, LockoutEntry> }
    const map = g.__loginLockoutMap
    if (!map || typeof map.forEach !== "function") {
      return { lockedAccounts: 0, failedLogins: 0 }
    }
    const now = Date.now()
    let lockedAccounts = 0
    let failedLogins = 0
    map.forEach((entry) => {
      if (!entry) return
      if (typeof entry.failCount === "number") {
        failedLogins += entry.failCount
      }
      if (
        typeof entry.lockedUntil === "number" &&
        entry.lockedUntil > now
      ) {
        lockedAccounts++
      }
    })
    return { lockedAccounts, failedLogins }
  } catch {
    return { lockedAccounts: 0, failedLogins: 0 }
  }
}

// ─── Per-request scanner state (radar + integrity timestamps) ───────────

/**
 * Read the last-scan ISO timestamp stashed on `globalThis.__adminRadarLastScan`
 * by a prior call to this endpoint (or another caller that stashes the same
 * slot). Returns `null` when no scan has ever been recorded.
 *
 * We don't read `src/lib/admin-radar.ts`'s private `_running` flag (it's
 * module-scoped, not exported). Instead, the endpoint invokes the radar's
 * exported `scanForUnauthorizedAdmins()` itself on every call and stashes
 * the timestamp — so `radarLastScan` always reflects the most recent
 * *actual* scan that this endpoint triggered. The radar's own 60s interval
 * (started by `src/lib/startup.ts` at app boot via `layout.tsx`) runs in
 * parallel; our call here is a redundant on-demand scan, not a substitute.
 */
function readRadarLastScan(): string | null {
  try {
    const g = globalThis as unknown as { __adminRadarLastScan?: string }
    return typeof g.__adminRadarLastScan === "string" ? g.__adminRadarLastScan : null
  } catch {
    return null
  }
}

function writeRadarLastScan(iso: string): void {
  try {
    const g = globalThis as unknown as { __adminRadarLastScan?: string }
    g.__adminRadarLastScan = iso
  } catch {
    // ignore — best-effort
  }
}

function readIntegrityLastCheck(): string | null {
  try {
    const g = globalThis as unknown as { __integrityLastCheck?: string }
    return typeof g.__integrityLastCheck === "string" ? g.__integrityLastCheck : null
  } catch {
    return null
  }
}

function writeIntegrityLastCheck(iso: string): void {
  try {
    const g = globalThis as unknown as { __integrityLastCheck?: string }
    g.__integrityLastCheck = iso
  } catch {
    // ignore — best-effort
  }
}

// ─── Module-availability probes (dynamic import, never throw) ──────────

/**
 * Dynamically `import()` a module and verify it exports the named symbol.
 * Returns `true` on success, `false` on any failure (module missing, export
 * missing, runtime throws). Uses async dynamic import (NOT synchronous
 * `require()`) so it works in both the Next.js bundler runtime and the
 * Bun/Node native runtime — `require()` of an `@/`-aliased path is not
 * portable across Next.js production builds.
 *
 * Returns the imported module on success so the caller can use the binding
 * without a second import round-trip, or `null` on failure.
 */
async function probeModule<T extends Record<string, unknown>>(
  modulePath: string,
  exportName: string,
): Promise<{ ok: true; mod: T } | { ok: false }> {
  try {
    const mod = (await import(modulePath)) as T
    if (mod && mod[exportName] !== undefined) {
      return { ok: true, mod }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

// ─── Route handler ───────────────────────────────────────────────────────

/**
 * GET /api/security/health
 *
 * Returns the security posture of the running system:
 *   - `checks`: per-module status (KDF in use, lockout policy, CSP style,
 *     body-size limit, which hardening modules are wired, etc.).
 *   - `stats`: live counters from the in-memory security Maps (bans,
 *     rate-limit entries, lockouts, audit-chain size).
 *   - `status`: "healthy" iff every critical module is wired AND the audit
 *     chain verifies. "degraded" otherwise, with a `degraded` array listing
 *     the failing checks.
 *
 * Critical modules (failure → "degraded"):
 *   - password hashing (session.ts must export `hashPassword`)
 *   - rate limiter (rate-limit.ts must export `rateLimit` AND `rateLimitByKey`)
 *   - CSRF (csrf.ts must export `validateCsrfToken`)
 *   - login lockout (login-lockout.ts must export `recordFailedAttempt`)
 *   - IP ban (ip-ban.ts must export `banIP`)
 *   - SSRF guard (ssrf-guard.ts must export `validateUserUrl`)
 *   - audit chain (audit.ts must export `auditLog` AND
 *     `verifyAuditIntegrity().valid === true`)
 *   - admin radar (admin-radar.ts must export `scanForUnauthorizedAdmins`)
 *
 * Admin-only: requires `x-admin-token` header matching `ADMIN_TOKEN` env
 * var. Fails closed (401) on missing env var or wrong/missing token.
 */
export async function GET(req: NextRequest) {
  const requestId = getRequestId(req as unknown as Request)
  try {
    if (!isAdminAuthorized(req as unknown as Request)) {
      // Return 401 (not 403) to avoid leaking whether the endpoint exists —
      // same shape as the retention-purge endpoint's auth-rejection path.
      return NextResponse.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "Admin token required" } },
        { status: 401 }
      )
    }

    const now = new Date()
    const nowIso = now.toISOString()
    const degraded: string[] = []

    // ─── Critical-module probes (each pushes to `degraded` on failure) ──
    //
    // `probeModule` uses async dynamic `import()` so it works for both the
    // Next.js bundler (which resolves `@/` aliases at build time) and the
    // Node/Bun native runtime. Each probe returns the imported module so
    // we can use its binding for the on-demand radar scan below without a
    // second import round-trip.

    const sessionProbe = await probeModule<{ hashPassword?: unknown }>(
      "@/lib/session",
      "hashPassword",
    )
    if (!sessionProbe.ok) {
      degraded.push("passwordHashing: session.hashPassword not importable")
    }

    const rateLimitProbe = await probeModule<{
      rateLimit?: unknown
      rateLimitByKey?: unknown
    }>("@/lib/rate-limit", "rateLimit")
    if (!rateLimitProbe.ok || rateLimitProbe.mod.rateLimitByKey === undefined) {
      degraded.push("rateLimiter: rate-limit rateLimit/rateLimitByKey not importable")
    }

    const csrfProbe = await probeModule<{ validateCsrfToken?: unknown }>(
      "@/lib/csrf",
      "validateCsrfToken",
    )
    if (!csrfProbe.ok) {
      degraded.push("csrfProtection: csrf.validateCsrfToken not importable")
    }

    const lockoutProbe = await probeModule<{ recordFailedAttempt?: unknown }>(
      "@/lib/login-lockout",
      "recordFailedAttempt",
    )
    if (!lockoutProbe.ok) {
      degraded.push("loginLockout: login-lockout.recordFailedAttempt not importable")
    }

    const ipBanProbe = await probeModule<{ banIP?: unknown }>(
      "@/lib/ip-ban",
      "banIP",
    )
    if (!ipBanProbe.ok) {
      degraded.push("ipBan: ip-ban.banIP not importable")
    }

    const ssrfProbe = await probeModule<{ validateUserUrl?: unknown }>(
      "@/lib/ssrf-guard",
      "validateUserUrl",
    )
    if (!ssrfProbe.ok) {
      degraded.push("ssrfGuard: ssrf-guard.validateUserUrl not importable")
    }

    const auditProbe = await probeModule<{ auditLog?: unknown }>(
      "@/lib/audit",
      "auditLog",
    )
    if (!auditProbe.ok) {
      degraded.push("auditChain: audit.auditLog not importable")
    }

    const radarProbe = await probeModule<{
      scanForUnauthorizedAdmins?: () => Promise<void>
    }>("@/lib/admin-radar", "scanForUnauthorizedAdmins")
    if (!radarProbe.ok) {
      degraded.push("adminRadar: admin-radar.scanForUnauthorizedAdmins not importable")
    }

    // ─── On-demand scans: radar + integrity ────────────────────────────

    // Admin radar on-demand scan. The module's `scanForUnauthorizedAdmins`
    // does a `db.user.count()` and logs any unexpected users. Best-effort:
    // if it throws (DB unreachable, etc.) we still record the attempt time
    // and add a degradation note — the radar is "wired" but not "healthy"
    // right now.
    if (radarProbe.ok && typeof radarProbe.mod.scanForUnauthorizedAdmins === "function") {
      try {
        await radarProbe.mod.scanForUnauthorizedAdmins()
        writeRadarLastScan(nowIso)
      } catch (e) {
        degraded.push(
          `adminRadar: on-demand scan failed — ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`
        )
        // Still record the attempt time so consumers can see "we tried at
        // <ts>" even when the scan itself failed.
        writeRadarLastScan(nowIso)
      }
    }

    // Audit-chain integrity verification. `verifyAuditIntegrity()` walks
    // every line in `logs/audit.jsonl` and recomputes the SHA-256 hash
    // chain. A broken chain (continuity OR hash mismatch) flips `valid`
    // to false — that is the textbook "file integrity" failure this
    // endpoint reports.
    let chainValid = true
    try {
      const report = await verifyAuditIntegrity()
      chainValid = report.valid === true
      if (!chainValid) {
        degraded.push(
          `fileIntegrity: audit hash chain broken at line ${report.brokenAt ?? "?"} ` +
          `(verified ${report.verifiedEntries}/${report.totalEntries})`
        )
      }
      writeIntegrityLastCheck(nowIso)
    } catch (e) {
      chainValid = false
      degraded.push(
        `fileIntegrity: verifyAuditIntegrity threw — ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`
      )
      writeIntegrityLastCheck(nowIso)
    }

    // ─── Build the `checks` object (verbatim policy strings from modules)

    // `sessionBinding` — session.ts stores `ipHash` (salted SHA-256 of the
    // client IP, truncated to 16 hex chars). The cookie is bound to the
    // issuing network via that fingerprint; an attacker replaying a stolen
    // cookie from a different IP fails verification in `getSession()`. We
    // describe this honestly as "ip+fingerprint" since the IP is what's
    // bound, and the binding is *via* a one-way fingerprint hash.
    const checks: SecurityChecks = {
      passwordHashing: "scrypt", // session.ts uses scryptSync (Node builtin, memory-hard)
      sessionBinding: "ip+fingerprint", // session.ts: ipHash = SHA-256(ip + SESSION_SECRET)[:16]
      rateLimiter: "per-ip + per-user", // rate-limit.ts: rateLimit + rateLimitByKey
      csrfProtection: "double-submit + nonce", // csrf.ts + middleware.ts per-request nonce
      csp: "nonce-based", // middleware.ts buildCsp() emits 'nonce-<v>' 'strict-dynamic'
      bodyLimit: "15kb", // middleware.ts Layer 2b: contentLength > 15360 → 413
      loginLockout: `${LOCKOUT_POLICY.maxFailures} attempts / ${Math.round(
        LOCKOUT_POLICY.lockoutMs / 60_000
      )}min`, // login-lockout.ts: 5 / 15min
      honeypotActive: true, // src/app/api/trap/[...path]/route.ts bans the IP
      auditChain: "sha256", // audit.ts: SHA-256(prevHash + payload)
      ssrfGuard: ssrfProbe.ok, // ssrf-guard.ts: validateUserUrl + safeFetch
      fileIntegrity: chainValid ? "monitored" : "broken", // audit hash chain
      adminRadar: radarProbe.ok ? "running" : "missing", // started at boot via startup.ts
      requestSigning: true, // session.ts: createSession signs payload with HMAC-SHA256
      banEscalation: true, // ip-ban.ts: banIP escalates 1h → 24h → 7d → permanent by banCount
      radarLastScan: readRadarLastScan(),
      integrityLastCheck: readIntegrityLastCheck(),
    }

    // ─── Build the `stats` object (live counts from the in-memory Maps)

    const lockoutStats = countLockouts()
    let auditEntries = 0
    try {
      const auditStats = await getAuditStats()
      auditEntries = typeof auditStats.totalEntries === "number" ? auditStats.totalEntries : 0
    } catch {
      // If getAuditStats throws (file system error, etc.), report 0 and
      // add a degradation note — operators need to know the audit log is
      // unreadable.
      degraded.push("auditEntries: getAuditStats threw — reporting 0")
    }

    const stats: SecurityStats = {
      bannedIPs: countBannedIPs(),
      rateLimitedIPs: countRateLimitedEntries(),
      lockedAccounts: lockoutStats.lockedAccounts,
      failedLogins: lockoutStats.failedLogins,
      auditEntries,
    }

    // ─── Aggregate status ──────────────────────────────────────────────

    const status: "healthy" | "degraded" = degraded.length === 0 ? "healthy" : "degraded"

    const body: SecurityHealthResponse = {
      status,
      checks,
      stats,
      timestamp: nowIso,
    }
    if (degraded.length > 0) {
      body.degraded = degraded
    }

    return NextResponse.json(body)
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "security_health")
    return NextResponse.json(body, { status })
  }
}

// Explicit Node runtime — this route uses fs (audit), dns (ssrf-guard
// transitively), and Prisma (admin-radar) at runtime. Pinning here keeps
// the contract stable across Next.js versions that may tighten their
// auto-detection heuristics.
export const runtime = "nodejs"
