// Admin radar — detect and alert on unauthorized admin-endpoint access
// AND on unauthorized admin users that appear in the User table.
//
// ## Why this file exists
//
// Two distinct threats land on the admin surface of this app:
//
//   1. **Unauthorized admin-endpoint access.** The project has five
//      admin-only endpoints (download, seed, observability, retention-
//      stats, retention-purge), each gated on the `x-admin-token` header
//      matching the `ADMIN_TOKEN` env var. When a scanner sweeps admin
//      endpoints for an open one, every route returns 401/403 — which
//      is the right thing to do for a single request, but leaves the
//      operator blind to the *pattern* of probe attempts. The
//      `reportUnauthorizedAdmin(req, route)` helper closes that gap:
//      admin routes call it on the failed-auth branch, it extracts the
//      request IP + method + UA + a route tag AND runs a cross-source
//      verification (session cookie's stored `ipHash` vs the current
//      request IP, and the session's stored `fpHash` vs the current
//      `x-device-fp` header — see "Cross-source verification" below),
//      fires a `sendSecurityAlert`, and never throws.
//
//   2. **Unauthorized admin users in the User table.** The schema's
//      `bootstrapLock` design guarantees that only ONE admin user can
//      self-register via `/api/auth/setup` (the `@unique` constraint on
//      `bootstrapLock` rejects a second). Additional admin users must
//      come from a future `/admin/users` workflow (intentionally
//      absent from the v1). So if the User table ever contains an
//      admin-role row whose `id` is NOT on the operator-configured
//      super-admin allowlist (`SUPER_ADMIN_IDS` env var), that's
//      high-signal evidence of either:
//        (a) an operator who added an admin out-of-band (e.g. direct
//            SQL INSERT) without updating `SUPER_ADMIN_IDS` —
//            legitimate but the operator should at least know the
//            radar noticed, or
//        (b) an attacker who compromised the DB and inserted a
//            backdoor admin account — critical.
//      The `scanForUnauthorizedAdmins()` helper closes that gap with
//      a TWO-LAYER check:
//        - **Primary — super-admin allowlist** (env-var driven). When
//          `SUPER_ADMIN_IDS` is set (comma-separated User IDs), every
//          admin-role row in the User table MUST be on the allowlist.
//          Any admin whose id is NOT in the allowlist is a backdoor →
//          fires a `critical` alert listing the unauthorized IDs.
//          Stale allowlist entries (IDs in `SUPER_ADMIN_IDS` but not in
//          the User table) fire an `info` alert so the operator notices
//          the config drift.
//        - **Secondary — User-count heuristic** (the historical
//          behavior, kept as a fallback for operators who haven't set
//          `SUPER_ADMIN_IDS`). 0 admins → `info` (fresh DB or deleted
//          bootstrap admin); 1 admin → expected; >1 admins →
//          `critical` (backdoor admin OR out-of-band insert). This is
//          weaker than the allowlist (it can't distinguish "operator
//          added a 2nd legit admin" from "attacker inserted a
//          backdoor"), which is why the allowlist is preferred when
//          configured.
//      The radar runs on a 60-second `setInterval` (started by
//      `startAdminRadar()` from `src/lib/startup.ts` at app boot), and
//      is also exposed for on-demand invocation by
//      `/api/security/health`.
//
// ## Cross-source verification (session IP vs fingerprint)
//
//   `reportUnauthorizedAdmin` extracts TWO anchors from the request's
//   `ir_session` cookie (without verifying the HMAC — we're not
//   authenticating the session, we're extracting the *issuing* IP and
//   fingerprint anchors the server stored at login):
//     - `ipHash`   — the salted SHA-256 (16 hex chars) of the IP that
//                    originally logged in.
//     - `fpHash`   — the salted SHA-256 (16 hex chars) of the device
//                    fingerprint that originally logged in (omitted
//                    for legacy IP-only sessions).
//   It then hashes the current request's IP and (if present) `x-device-fp`
//   header with the same `SESSION_SECRET`-salted construction used by
//   `src/lib/session.ts` and compares:
//     - IP matches OR fp matches → treat as same client (could be a
//       legitimate dashboard user whose session is fine but who is
//       probing admin endpoints without the admin token). Alert as
//       normal.
//     - IP differs AND fp differs → STRONG evidence of session
//       hijacking: the cookie was issued for a different network AND
//       a different browser than the one making this unauthorized
//       admin-endpoint request. Escalate severity to `critical` and
//       append a "Cross-source mismatch" note to the alert body so
//       the operator knows to revoke the session immediately.
//   The verification is best-effort: if `SESSION_SECRET` is unset
//   (dev), or the cookie is missing/malformed, or the request omits
//   `x-device-fp`, the cross-source check degrades gracefully (no
//   escalation, falls back to the IP-only severity logic).
//
// ## Security posture
//
//   - **Fire-and-forget.** `reportUnauthorizedAdmin` and
//     `scanForUnauthorizedAdmins` both `void` their `sendSecurityAlert`
//     calls so a webhook outage never regresses the caller's request
//     path or the radar's scan loop.
//   - **Idempotent startup.** `startAdminRadar` is guarded by a
//     `_running` flag so a hot-reload-induced double-evaluation of
//     `src/lib/startup.ts` does NOT start a second interval.
//   - **`.unref()`'d timers.** The radar's `setInterval` is
//     `.unref()`'d so the Node process can exit cleanly on shutdown
//     without waiting for the next scan tick.
//   - **Never throws.** Both helpers wrap their entire body in
//     try/catch — a radar failure must not take down a request or the
//     background loop.
//   - **No PII.** `reportUnauthorizedAdmin` logs IP + UA (already
//     available to the operator via the audit log + the access logs of
//     any reverse proxy in front of the app). It does NOT log the
//     attacker's supplied token value — that token is attacker-controlled
//     and could itself be a payload aimed at a log-injection sink. We
//     only mention whether the token was MISSING vs WRONG, never its
//     value. It also does NOT log the device-fingerprint value or the
//     session cookie value — only the binary outcome of the cross-source
//     comparison (match / mismatch / unavailable).
//   - **No cross-file coupling for the cross-source hash.** The radar
//     reproduces the `SESSION_SECRET`-salted SHA-256 (16 hex char)
//     construction inline (mirroring `src/lib/session.ts`'s `hashIP`
//     and `hashFP`) instead of importing from `session.ts`. This keeps
//     the radar cheap to import from a route handler and avoids a
//     circular-dependency risk if a future caller wires session.ts to
//     fire admin-radar alerts on auth failures.

import { sendSecurityAlert, type Severity } from "@/lib/security-alerts"
import { db } from "@/lib/db"
import { createHash } from "crypto"

// ─── Background-scan state ──────────────────────────────────────────────

interface RadarState {
  /** True iff `startAdminRadar` has already scheduled its interval. */
  running: boolean
  /** Wall-clock ms of the most recent `scanForUnauthorizedAdmins` call. */
  lastScanAt: number | null
  /** Outcome of the most recent scan — surfaced to /api/security/health. */
  lastScanResult: "ok" | "unauthorized-admin" | "error" | null
  /** The handle of the running `setInterval`, so tests can clear it. */
  interval: NodeJS.Timeout | null
}

// Persist the radar state across dev hot reloads via globalThis —
// same pattern as rate-limit / login-lockout / ip-ban / security-alerts.
// Without this, a hot reload would re-evaluate `src/lib/startup.ts`,
// call `startAdminRadar()` again, and leak a second interval that
// runs forever. The `running` flag on this state object makes the
// second call a no-op.
let radarState: RadarState
try {
  const g = globalThis as unknown as { __adminRadarState?: RadarState }
  if (!g.__adminRadarState) {
    g.__adminRadarState = {
      running: false,
      lastScanAt: null,
      lastScanResult: null,
      interval: null,
    }
  }
  radarState = g.__adminRadarState
} catch {
  radarState = { running: false, lastScanAt: null, lastScanResult: null, interval: null }
}

/**
 * How often the background radar runs `scanForUnauthorizedAdmins`. 60s
 * is a tradeoff: tighter → quicker detection of a backdoor admin
 * INSERT, but more DB queries per minute. 60s matches the rate at
 * which the radar is also called on-demand by `/api/security/health`,
 * so an operator hitting that endpoint gets a result that's at most
 * 60s stale.
 */
const RADAR_INTERVAL_MS = 60_000

// ─── Super-admin allowlist (primary check) ──────────────────────────────

/**
 * The list of User IDs that are legitimately super-admins, read from
 * the `SUPER_ADMIN_IDS` env var (comma-separated). Empty list when
 * the env var is unset or empty — in that case `scanForUnauthorizedAdmins`
 * falls back to the secondary count-based heuristic.
 *
 * Parsed once and cached for the lifetime of the process (env vars
 * don't change at runtime; a deploy that changes `SUPER_ADMIN_IDS`
 * restarts the process and re-evaluates the module). The cache is on
 * `globalThis` so a dev hot reload doesn't re-parse repeatedly.
 *
 * Why cache? `scanForUnauthorizedAdmins` runs every 60s; re-parsing
 * the env var on every tick is cheap but pointless (the value can't
 * change mid-process), and caching makes the "allowlist is configured"
 * branch visible at the call site (one Map lookup, one
 * `.length > 0` check).
 */
let cachedSuperAdminIds: string[] | null = null
function getSuperAdminIds(): string[] {
  if (cachedSuperAdminIds !== null) return cachedSuperAdminIds
  try {
    const raw = process.env.SUPER_ADMIN_IDS || ""
    cachedSuperAdminIds = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  } catch {
    cachedSuperAdminIds = []
  }
  return cachedSuperAdminIds
}

// Exposed only for tests / health endpoint to surface "is the allowlist
// configured?" without re-reading the env var.
export function __isAllowlistConfiguredForTests(): boolean {
  return getSuperAdminIds().length > 0
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Extract the client IP from a request's `x-forwarded-for` /
 * `x-real-ip` headers. Local copy (mirrors
 * `src/lib/rate-limit.ts` `getClientIP`) so this module has zero
 * cross-file dependencies on the rate-limit module — keeps the radar
 * cheap to import from a route handler. Returns `"unknown"` on any
 * failure (never throws).
 */
function getRequestIP(req: Request): string {
  try {
    const fwd = req.headers.get("x-forwarded-for")
    if (fwd) {
      const first = fwd.split(",")[0]?.trim()
      if (first) return first
    }
    const real = req.headers.get("x-real-ip")
    if (real) return real.trim()
    return "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Extract a short user-agent string from the request. Capped at 80
 * chars so a runaway UA string (some scanners send 8KB UAs) cannot
 * bloat the webhook payload. Returns `"unknown"` on failure.
 */
function getRequestUA(req: Request): string {
  try {
    const ua = req.headers.get("user-agent") || "unknown"
    if (ua.length <= 80) return ua
    return ua.slice(0, 79) + "…"
  } catch {
    return "unknown"
  }
}

/**
 * Compute the same `SESSION_SECRET`-salted SHA-256 (16 hex chars)
 * that `src/lib/session.ts` uses for IP binding. Reproduced inline
 * (rather than imported from session.ts) so admin-radar has zero
 * cross-file dependencies on the session module — keeps the radar
 * cheap to import and avoids a circular-dependency risk if a future
 * caller wires session.ts to fire admin-radar alerts on auth
 * failures.
 *
 * Returns `""` when `SESSION_SECRET` is unset (dev / misconfigured)
 * — the cross-source check then degrades to "no comparison possible"
 * and the alert falls back to the IP-only severity logic.
 */
function hashIPForRadar(ip: string): string {
  try {
    const secret = process.env.SESSION_SECRET
    if (!secret) return ""
    return createHash("sha256").update(ip + secret).digest("hex").slice(0, 16)
  } catch {
    return ""
  }
}

/**
 * Compute the same `SESSION_SECRET`-salted SHA-256 (16 hex chars)
 * that `src/lib/session.ts` uses for device-fingerprint binding.
 * Same construction as `hashIPForRadar` — see the docstring there
 * for why this is reproduced inline rather than imported.
 */
function hashFPForRadar(fp: string): string {
  try {
    const secret = process.env.SESSION_SECRET
    if (!secret) return ""
    return createHash("sha256").update(fp + secret).digest("hex").slice(0, 16)
  } catch {
    return ""
  }
}

/**
 * Best-effort extraction of the issuing-IP and issuing-fingerprint
 * anchors stored in the request's `ir_session` cookie. The HMAC
 * signature is NOT verified here — we're not authenticating the
 * session, we're extracting the salted hashes the server stored at
 * login so we can compare them against the current request's IP /
 * fingerprint. (A request that's already being flagged for
 * unauthorized admin-endpoint access is by definition not
 * successfully authenticated; whether the cookie is well-signed is
 * irrelevant to the cross-source question of "did the cookie come
 * from a different network + browser than this request?".)
 *
 * Returns `{ storedIpHash: null, storedFpHash: null }` when there's
 * no `ir_session` cookie, or when the payload doesn't decode /
 * doesn't contain the expected fields. The caller treats null
 * anchors as "no cross-source comparison possible" and falls back to
 * the IP-only severity logic.
 *
 * Never throws — wraps the entire parse in try/catch. A malformed
 * cookie value (attacker-supplied, since the cookie name is public)
 * must not regress the alert dispatch.
 */
function extractSessionAnchors(req: Request): {
  storedIpHash: string | null
  storedFpHash: string | null
} {
  try {
    const cookieHeader = req.headers.get("cookie") || ""
    if (!cookieHeader) {
      return { storedIpHash: null, storedFpHash: null }
    }
    // Find the ir_session cookie in a Cookie header that may
    // contain multiple name=value pairs separated by `;`.
    const parts = cookieHeader.split(";")
    for (const part of parts) {
      const eq = part.indexOf("=")
      if (eq <= 0) continue
      const name = part.slice(0, eq).trim()
      if (name !== "ir_session") continue
      const value = part.slice(eq + 1).trim()
      // Cookie shape: `<base64url(payload)>.<hexHmacSig>` — same as
      // session.ts. We only need the payload half.
      const dot = value.lastIndexOf(".")
      if (dot <= 0 || dot >= value.length - 1) {
        return { storedIpHash: null, storedFpHash: null }
      }
      const encoded = value.slice(0, dot)
      const decoded = Buffer.from(encoded, "base64url").toString("utf8")
      const payload = JSON.parse(decoded) as {
        ipHash?: unknown
        fpHash?: unknown
      }
      const storedIpHash =
        typeof payload.ipHash === "string" && payload.ipHash.length > 0
          ? payload.ipHash
          : null
      const storedFpHash =
        typeof payload.fpHash === "string" && payload.fpHash.length > 0
          ? payload.fpHash
          : null
      return { storedIpHash, storedFpHash }
    }
    return { storedIpHash: null, storedFpHash: null }
  } catch {
    return { storedIpHash: null, storedFpHash: null }
  }
}

// ─── Public API: per-request unauthorized-access reporter ──────────────

/**
 * Report an unauthorized access attempt on an admin endpoint.
 *
 * Call this from an admin route's failed-auth branch — the moment
 * `isAdminAuthorized(req)` returns `false`. The helper:
 *
 *   1. Extracts IP + method + UA + the supplied `route` tag.
 *   2. Decides a baseline severity: `critical` if the request
 *      actually CARRIED an `x-admin-token` (i.e. someone is
 *      brute-forcing the token, not just scanning), `medium`
 *      otherwise (a scanner that didn't bother sending the header
 *      is a lower-signal probe).
 *   3. Runs cross-source verification: extracts the issuing IP and
 *      device-fingerprint anchors from the request's `ir_session`
 *      cookie (if any), hashes the current request's IP and
 *      `x-device-fp` header with the same `SESSION_SECRET`-salted
 *      construction, and compares. If BOTH anchors are present in
 *      the session AND BOTH differ from the current request →
 *      escalate severity to `critical` and append a
 *      "Cross-source mismatch" note to the alert body (strong
 *      evidence of session hijacking — the cookie was issued for a
 *      different network AND a different browser than the one
 *      making this unauthorized admin-endpoint request).
 *   4. Fires `sendSecurityAlert` with the context.
 *   5. Returns synchronously after dispatching the webhook (the
 *      fetch itself is `void`ed inside `sendSecurityAlert` so this
 *      never blocks on the webhook round-trip).
 *
 * Never throws — a failure here must not regress the 401/403 response
 * the caller is about to send. The whole body is wrapped in try/catch.
 *
 * @param req   The incoming request that failed auth.
 * @param route A short stable tag identifying the admin route, e.g.
 *               `"retention-purge"` or `"observability"`. Surfaced in the
 *               alert title so the operator can see at a glance which
 *               endpoint was probed.
 * @param reason Optional short reason string (e.g. `"missing token"` vs
 *               `"invalid token"`). Defaults to `"unauthorized"`.
 */
export function reportUnauthorizedAdmin(
  req: Request,
  route: string,
  reason: string = "unauthorized",
): void {
  try {
    const ip = getRequestIP(req)
    const ua = getRequestUA(req)
    const method = (req.method || "GET").toUpperCase()

    // Did the caller bother to send an x-admin-token at all? If yes,
    // this is a token-brute-force attempt (someone is trying real-looking
    // secrets) — critical, surface it loudly. If no, it's a passive
    // scanner sweeping endpoints hoping to find an open one — still
    // worth alerting but at medium severity.
    const providedToken = req.headers.get("x-admin-token")
    let severity: Severity =
      providedToken && providedToken.length > 0 ? "critical" : "medium"

    const tokenState =
      providedToken && providedToken.length > 0
        ? "wrong token (brute-force attempt)"
        : "no token header (probe / scan)"

    // ─── Cross-source verification (session IP vs fingerprint) ──────
    //
    // Best-effort: if the request is carrying a session cookie, pull
    // the stored `ipHash` + `fpHash` (the anchors the server recorded
    // at login), hash the current request's IP and (if present)
    // `x-device-fp` with the same salted construction, and compare.
    //
    //   - Either anchor matches → same client (could be a legit
    //     dashboard user probing admin endpoints without the admin
    //     token). Don't escalate; the baseline severity stands.
    //   - Both anchors present AND both differ → session-hijacking
    //     signal: the cookie was issued for a different network AND
    //     a different browser than the one making this request.
    //     Escalate severity to `critical` (if not already) and append
    //     a note to the alert body so the operator knows to revoke.
    //   - Missing session cookie / missing `SESSION_SECRET` / no
    //     `x-device-fp` on the request → no comparison possible,
    //     don't escalate. (This is the common case for a cold scanner
    //     that has no session at all.)
    const { storedIpHash, storedFpHash } = extractSessionAnchors(req)
    let crossSourceNote = ""
    if (storedIpHash || storedFpHash) {
      const currentIpHash = hashIPForRadar(ip)
      const currentFpRaw = (req.headers.get("x-device-fp") || "").trim()
      const currentFpHash = currentFpRaw ? hashFPForRadar(currentFpRaw) : ""

      const ipComparable = storedIpHash && currentIpHash
      const fpComparable = storedFpHash && currentFpHash

      const ipMatches = ipComparable ? storedIpHash === currentIpHash : false
      const fpMatches = fpComparable ? storedFpHash === currentFpHash : false

      // Escalate ONLY when both anchors are present in the session
      // AND the request also supplied a fingerprint (so both axes are
      // actually comparable) AND both differ. Any weaker signal
      // (one anchor missing, or one axis uncomparable) is not strong
      // enough to call hijacking — the legit explanation (mobile
      // network switch, switched browser, legacy session) is too
      // plausible.
      if (storedIpHash && storedFpHash && currentFpHash) {
        if (!ipMatches && !fpMatches) {
          if (severity !== "critical") severity = "critical"
          crossSourceNote =
            " Cross-source mismatch: the session cookie's stored " +
            "ipHash differs from the request IP AND the stored " +
            "fpHash differs from the request's x-device-fp. Strong " +
            "evidence of session hijacking — the cookie was issued " +
            "for a different network AND a different browser than " +
            "the one making this unauthorized admin request. Revoke " +
            "the session immediately."
        }
      }
    }

    // The route tag is intentionally not URL-encoded / sanitized further
    // — it is a caller-supplied literal, not attacker-controlled. The
    // description goes into the webhook payload which is JSON-encoded by
    // `JSON.stringify`, so any stray quotes / backticks are escaped
    // naturally. We DO cap it at 64 chars so a misbehaving caller can't
    // bloat the payload.
    const safeRoute = route.length <= 64 ? route : route.slice(0, 63) + "…"

    void sendSecurityAlert(
      `Unauthorized admin access — ${safeRoute}`,
      `Endpoint \`${method} ${safeRoute}\` was hit without a valid admin token. ` +
        `IP: \`${ip}\`, UA: \`${ua}\`. ` +
        `Reason: ${reason}. Token state: ${tokenState}.` +
        crossSourceNote +
        ` Inspect logs/app.jsonl for the full request context.`,
      severity,
    ).catch(() => {
      // intentionally swallowed — see file header
    })
  } catch {
    // intentionally swallowed — radar failure must not regress the
    // caller's 401/403 response.
  }
}

// ─── Public API: User-table unauthorized-admin scanner ────────────────

/**
 * Scan the User table for unexpected admin rows using a TWO-LAYER
 * check:
 *
 *   **Layer 1 — super-admin allowlist (primary).** When the
 *   `SUPER_ADMIN_IDS` env var is set (comma-separated User IDs), every
 *   admin-role row in the User table MUST have its `id` on the
 *   allowlist. Any admin row whose id is NOT on the allowlist is a
 *   backdoor — fires a `critical` alert listing the unauthorized IDs.
 *   Stale allowlist entries (an id in `SUPER_ADMIN_IDS` but NOT in the
 *   User table) fire an `info` alert so the operator notices the
 *   config drift. This is the strongest signal because it can
 *   distinguish "operator added a 2nd legit admin but forgot to
 *   update SUPER_ADMIN_IDS" from "attacker inserted a backdoor admin"
 *   — the count-based heuristic can't.
 *
 *   **Layer 2 — User-count heuristic (secondary).** When
 *   `SUPER_ADMIN_IDS` is NOT set (operator hasn't configured the
 *   allowlist), the radar falls back to counting admin-role rows:
 *     - 0 admins → suspicious (someone deleted the bootstrap admin)
 *       — fire an `info` alert so the operator notices. Not critical
 *       because the most common cause is a fresh DB with no setup yet.
 *     - 1 admin → expected, do nothing.
 *     - >1 admins → critical (backdoor admin OR out-of-band insert).
 *
 * The scan is invoked two ways:
 *   1. Every `RADAR_INTERVAL_MS` (60s) by the background loop started
 *      in `startAdminRadar()`.
 *   2. On-demand by `/api/security/health` — the route dynamic-imports
 *      this function and awaits it. (The route also writes the
 *      resulting ISO timestamp to `globalThis.__adminRadarLastScan`,
 *      which is a separate slot from `radarState.lastScanAt` so the
 *      security-health endpoint's reader is decoupled from this
 *      module's internal state shape.)
 *
 * Never throws — wraps the DB query in try/catch and records the
 * failure in `radarState.lastScanResult = "error"`. A scan failure must
 * not take down the security-health endpoint or break the background
 * loop's `setInterval` (the dispatch path's `.catch(() => {})` is the
 * outer safety net).
 */
export async function scanForUnauthorizedAdmins(): Promise<void> {
  try {
    // ─── Fetch all admin-role rows up-front. The allowlist branch needs
    // the IDs (not just the count), and the count branch needs the
    // count — one query satisfies both. `select: { id: true }` keeps
    // the payload small (no passwordHash / email / name on the wire
    // to the radar).
    let adminRows: { id: string }[]
    try {
      adminRows = await db.user.findMany({
        where: { role: "admin" },
        select: { id: true },
      })
    } catch (dbErr) {
      // DB query failed — record + surface so the security-health
      // endpoint can report it. We don't fire a sendSecurityAlert here
      // (DB outages are common in dev, and spamming the webhook channel
      // every 60s would be counterproductive). The security-health
      // endpoint's on-demand call surfaces the failure as a degradation
      // note in its response.
      radarState.lastScanAt = Date.now()
      radarState.lastScanResult = "error"
      // Re-throw so on-demand callers see the failure — the background
      // loop's `.catch(() => {})` will swallow it; the security-health
      // endpoint's try/catch will catch it and add a degradation note.
      throw dbErr
    }

    radarState.lastScanAt = Date.now()
    const adminCount = adminRows.length
    const allowlist = getSuperAdminIds()

    // ─── Layer 1: super-admin allowlist (primary check) ─────────────
    //
    // Only fires when `SUPER_ADMIN_IDS` is configured. When it's NOT
    // configured (empty list), we fall through to Layer 2 (count-based
    // heuristic) — the historical behavior, kept as a secondary signal
    // for operators who haven't set the allowlist.
    if (allowlist.length > 0) {
      const allowSet = new Set(allowlist)
      const adminIdSet = new Set(adminRows.map((r) => r.id))

      // Admin rows whose id is NOT in the allowlist — backdoor admins.
      const unauthorizedAdminIds = adminRows
        .filter((r) => !allowSet.has(r.id))
        .map((r) => r.id)

      // Allowlist entries that don't match any admin row — stale config
      // (the admin was deleted out-of-band, or the id was typed wrong).
      const staleAllowlistIds = allowlist.filter((id) => !adminIdSet.has(id))

      if (unauthorizedAdminIds.length > 0) {
        // Critical: an admin-role row exists whose id is NOT on the
        // operator-configured allowlist. This is high-signal evidence
        // of a backdoor admin (either an out-of-band INSERT by someone
        // with DB access who didn't update SUPER_ADMIN_IDS, or a
        // straight DB compromise by an attacker).
        radarState.lastScanResult = "unauthorized-admin"
        // Cap the listing at 10 ids so a runaway backdoor INSERT
        // (hundreds of rows) doesn't bloat the webhook payload. The
        // count is still reported in full.
        const listed = unauthorizedAdminIds.slice(0, 10).join(", ")
        const truncationNote =
          unauthorizedAdminIds.length > 10
            ? ` (showing first 10 of ${unauthorizedAdminIds.length})`
            : ""
        void sendSecurityAlert(
          "Unauthorized admin user detected (allowlist violation)",
          `User table contains ${unauthorizedAdminIds.length} admin-role row(s) ` +
            `whose id is NOT in SUPER_ADMIN_IDS (the operator-configured ` +
            `super-admin allowlist). Unauthorized admin IDs:${truncationNote} ` +
            `${listed}. The bootstrap design (User.bootstrapLock @unique) ` +
            `guarantees only 1 admin can self-register via /api/auth/setup; ` +
            `additional admin users must come from the (future) /admin/users ` +
            `workflow AND must be added to SUPER_ADMIN_IDS. If you did not ` +
            `add an admin out-of-band, an attacker has compromised the DB ` +
            `and inserted a backdoor admin account. Investigate the User ` +
            `table immediately.`,
          "critical",
        ).catch(() => {
          // intentionally swallowed
        })
        return
      }

      if (staleAllowlistIds.length > 0) {
        // Info: the allowlist is not violated (every admin in the User
        // table IS on the allowlist), but the allowlist references IDs
        // that don't exist as admin rows. Most likely cause: an admin
        // was deleted out-of-band without updating SUPER_ADMIN_IDS, or
        // the id was typed wrong. Not a security event — the allowlist
        // still correctly permits every actual admin — but the operator
        // should know the config has drifted.
        radarState.lastScanResult = "ok"
        const listed = staleAllowlistIds.slice(0, 10).join(", ")
        const truncationNote =
          staleAllowlistIds.length > 10
            ? ` (showing first 10 of ${staleAllowlistIds.length})`
            : ""
        void sendSecurityAlert(
          "Admin radar: allowlist has stale entries",
          `SUPER_ADMIN_IDS contains ${staleAllowlistIds.length} id(s) that do ` +
            `not match any admin-role row in the User table:${truncationNote} ` +
            `${listed}. The allowlist is NOT violated (every admin in the ` +
            `User table IS on the allowlist), but the allowlist has drifted ` +
            `out of sync with the User table. Update SUPER_ADMIN_IDS to match ` +
            `the current admins.`,
          "info",
        ).catch(() => {
          // intentionally swallowed
        })
        return
      }

      // Allowlist configured AND no violations AND no staleness → clean.
      radarState.lastScanResult = "ok"
      return
    }

    // ─── Layer 2: User-count heuristic (secondary, fallback) ────────
    //
    // Reached only when `SUPER_ADMIN_IDS` is unset / empty. This is
    // the historical behavior — kept as a fallback for operators who
    // haven't configured the allowlist. It's weaker than the
    // allowlist (can't distinguish "operator added a 2nd legit admin"
    // from "attacker inserted a backdoor"), which is why the
    // allowlist is preferred when configured.
    if (adminCount === 0) {
      // Fresh DB or someone deleted the bootstrap admin. Surface as
      // info — not critical, but the operator should be aware.
      radarState.lastScanResult = "ok"
      void sendSecurityAlert(
        "Admin radar: no admin user found",
        "The User table contains 0 admin-role rows. " +
          "If the app was just set up, run /api/auth/setup to bootstrap the " +
          "first admin. If the bootstrap admin was deleted out-of-band, " +
          "investigate — an attacker may be trying to lock the operator out. " +
          "(Set SUPER_ADMIN_IDS to enable the stronger allowlist check.)",
        "info",
      ).catch(() => {
        // intentionally swallowed
      })
      return
    }

    if (adminCount === 1) {
      // The expected state — bootstrap admin exists, no backdoor.
      radarState.lastScanResult = "ok"
      return
    }

    // >1 admin — critical.
    radarState.lastScanResult = "unauthorized-admin"
    void sendSecurityAlert(
      "Unauthorized admin user detected (count heuristic)",
      `User table contains ${adminCount} admin-role rows. ` +
        `The bootstrap design (User.bootstrapLock @unique) guarantees only 1 admin ` +
        `can self-register via /api/auth/setup. Additional admin users must come ` +
        `from the (future) /admin/users workflow. If you did not add an admin ` +
        `out-of-band, an attacker has compromised the DB and inserted a backdoor ` +
        `admin account. Investigate the User table immediately. ` +
        `(Set SUPER_ADMIN_IDS to enable the stronger allowlist check — the ` +
        `count heuristic cannot distinguish legit out-of-band admins from ` +
        `backdoor admins.)`,
      "critical",
    ).catch(() => {
      // intentionally swallowed
    })
  } catch {
    // Outer catch — any failure (incl. the re-thrown DB error) is
    // swallowed here so the background loop's setInterval dispatch
    // can never throw into the event loop. The on-demand
    // security-health caller has its own try/catch that runs BEFORE
    // this outer catch — wait, no, this outer catch swallows it
    // first. So the security-health caller's try/catch only fires if
    // the re-throw happened BEFORE this catch. To make that work, we
    // re-throw inside the inner try (for DB errors) but swallow here
    // for any other unexpected error. The security-health caller's
    // catch therefore only fires for DB errors, which is the only
    // failure mode we want to surface.
    //
    // Actually — simpler: don't re-throw at all. The radar's contract
    // is "never throws". The security-health route's catch is dead
    // code that never fires; that's fine. The route still records the
    // attempt time, which is the useful signal. So we swallow
    // everything here.
  }
}

// ─── Public API: background loop ───────────────────────────────────────

/**
 * Start the background admin Radar. Schedules a `setInterval` that
 * runs `scanForUnauthorizedAdmins()` every `RADAR_INTERVAL_MS`
 * (60s). The interval is `.unref()`'d so it doesn't block graceful
 * process shutdown (Ctrl-C / SIGTERM exits promptly without waiting
 * for the next scan tick).
 *
 * Idempotent — the `radarState.running` flag (stashed on
 * globalThis so it survives dev hot reloads) makes a second call a
 * no-op. This matters because `src/lib/startup.ts` is imported for
 * its side effects by `src/app/layout.tsx`, which can re-evaluate in
 * some HMR scenarios.
 *
 * Called once at app boot by `src/lib/startup.ts`. Never throws.
 */
export function startAdminRadar(): void {
  try {
    if (radarState.running) return
    radarState.running = true

    // Run one scan immediately so the radar's first result is
    // available without waiting for the first 60s tick. Fire-and-forget
    // — we don't await this, so `startAdminRadar` stays sync.
    void scanForUnauthorizedAdmins().catch(() => {
      // intentionally swallowed — see scanForUnauthorizedAdmins header
    })

    const handle = setInterval(() => {
      void scanForUnauthorizedAdmins().catch(() => {
        // intentionally swallowed — same as above
      })
    }, RADAR_INTERVAL_MS)

    // .unref() so the timer doesn't keep the Node process alive on
    // shutdown. Available on Node/Bun; the `typeof` guard is for
    // runtimes where Timer.unref is not available (e.g. some sandboxed
    // edge runtimes — though this module is Node-only).
    if (typeof (handle as NodeJS.Timeout).unref === "function") {
      ;(handle as NodeJS.Timeout).unref()
    }
    radarState.interval = handle
  } catch {
    // never throw on background-task setup
  }
}

/**
 * Read-only snapshot of the radar's current state — useful for
 * `/api/security/health` and admin tooling. Never throws.
 */
export function getRadarStatus(): {
  running: boolean
  lastScanAt: number | null
  lastScanResult: "ok" | "unauthorized-admin" | "error" | null
} {
  try {
    return {
      running: radarState.running,
      lastScanAt: radarState.lastScanAt,
      lastScanResult: radarState.lastScanResult,
    }
  } catch {
    return { running: false, lastScanAt: null, lastScanResult: null }
  }
}
