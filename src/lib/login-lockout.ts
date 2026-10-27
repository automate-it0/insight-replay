// Failed login lockout — 5 attempts → 15min lockout, keyed on email+IP.
// Uses an in-memory Map stashed on globalThis so the counter persists across
// dev hot reloads (same pattern as src/lib/rate-limit.ts).
//
// This complements the per-IP rate limit (5 req/min): the rate limit caps
// *throughput* on a single IP, while the lockout caps *accumulated failures*
// for a specific email+IP pair. An attacker who spaces their guesses out
// across many IPs / many minutes still hits the 5-failure ceiling per target.
//
// Not a substitute for a real backing store in a multi-instance deployment —
// the counter is per-process. For this single-instance app that's fine; if we
// ever scale horizontally, swap the Map for a Redis hash with TTL.
//
// --- Webhook alerting (10x+: Security webhook alerts) -------------------
// When `recordFailedAttempt` tips the counter past MAX_FAILURES and triggers
// a lockout, we fire `sendSecurityAlert("high", ...)` so the operator is
// pinged on Discord/Slack/Teams instead of finding the brute-force attack
// hours later in `logs/app.jsonl`. The alert is fire-and-forget — it runs
// AFTER the lockout has already been recorded, so a webhook outage never
// weakens the lockout itself. The alert is also rate-limited inside
// `sendSecurityAlert` (10/min), so a 50-IP botnet triggering 50 lockouts
// back-to-back won't spam the webhook channel past the cap.

import { boundMapSize } from "@/lib/rate-limit"
import { sendSecurityAlert } from "@/lib/security-alerts"

interface LockoutEntry {
  failCount: number
  lockedUntil: number
}

const MAX_FAILURES = 5
const LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes
// Unused today but kept here so the policy is documented in one place: once a
// counter has gone 15min without a new failure, a stale entry can be evicted.
// `cleanupRateLimit` in rate-limit.ts handles the analogous sweep; the same
// periodic caller can sweep this map too.
const COUNTER_TTL_MS = 15 * 60 * 1000

// Re-exported so tests / callers can read the configured thresholds without
// hardcoding the magic numbers.
export const LOCKOUT_POLICY = {
  maxFailures: MAX_FAILURES,
  lockoutMs: LOCKOUT_MS,
  counterTtlMs: COUNTER_TTL_MS,
} as const

// Persist the Map across hot reloads in dev by stashing it on globalThis.
// Guarded with try/catch so a failure here never breaks the module load.
let lockoutMap: Map<string, LockoutEntry>
try {
  const g = globalThis as any
  if (!g.__loginLockoutMap) g.__loginLockoutMap = new Map<string, LockoutEntry>()
  lockoutMap = g.__loginLockoutMap
} catch {
  lockoutMap = new Map()
}

/**
 * Is the given key currently locked out?
 *
 * Returns `{ locked: true, retryAfterSec }` while the lockout window is
 * active. Once the window expires the entry is deleted (best-effort) so a
 * subsequent failed attempt starts a fresh counter — i.e. the user gets a
 * clean slate after serving their 15 minutes.
 *
 * Never throws; on any internal error returns `{ locked: false }` so a
 * lockout bug can never lock a legitimate user out of their account (fail
 * open, same philosophy as `rateLimit`).
 */
export function isLocked(key: string): { locked: boolean; retryAfterSec: number } {
  try {
    const entry = lockoutMap.get(key)
    if (!entry) return { locked: false, retryAfterSec: 0 }
    if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
      const retryAfterSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000)
      return { locked: true, retryAfterSec }
    }
    // Expired — clean up so a fresh failure window starts at 1, not at the
    // pre-lockout failCount.
    if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
      lockoutMap.delete(key)
    }
    return { locked: false, retryAfterSec: 0 }
  } catch {
    return { locked: false, retryAfterSec: 0 }
  }
}

/**
 * Record a failed login attempt for `key`. When the accumulated failure count
 * hits MAX_FAILURES the key is locked for LOCKOUT_MS and the returned object
 * reports `locked: true` with the retry-after window.
 *
 * Idempotent per-call (each call increments by 1); the caller is responsible
 * for only calling this on actual auth failures, not on every request.
 *
 * Never throws; on internal error returns `{ locked: false }` (fail open).
 *
 * Webhook alert: when this call is the one that tips the counter past
 * MAX_FAILURES, we fire a `sendSecurityAlert("high", ...)` so the operator
 * is pinged on Discord/Slack/Teams. The alert is fire-and-forget; the lockout
 * itself has already been persisted to the Map before the alert fires, so a
 * webhook outage cannot weaken the lockout. The `key` carries the email
 * (lowercased) + IP — we pass it through to the alert description verbatim.
 * The email is the *submitted* email (which may not correspond to a real
 * user account — see src/app/api/auth/login/route.ts), so leaking it in an
 * operator-only webhook is fine; the IP is also already available to the
 * operator via the audit log. No new PII is exposed.
 */
export function recordFailedAttempt(key: string): { locked: boolean; retryAfterSec: number } {
  try {
    const existing = lockoutMap.get(key) || { failCount: 0, lockedUntil: 0 }
    existing.failCount += 1

    if (existing.failCount >= MAX_FAILURES) {
      existing.lockedUntil = Date.now() + LOCKOUT_MS
      lockoutMap.set(key, existing)
      // Bound the Map — an attacker probing many distinct email+IP combos
      // could otherwise grow the lockout Map without limit. Eviction is
      // best-effort and never blocks the request path.
      boundMapSize(lockoutMap)

      // Fire the webhook alert AFTER the lockout has been persisted, so a
      // webhook failure cannot leave the user unlocked. The `void` + `.catch`
      // pattern means the alert can never throw into the caller's request
      // path; if `sendSecurityAlert` itself were synchronous and threw, the
      // outer try/catch would still swallow it. Belt-and-suspenders.
      void sendSecurityAlert(
        "Failed-login lockout triggered",
        `Lockout fired for \`${key}\` after ${MAX_FAILURES} failed attempts. ` +
          `Locked for ${Math.ceil(LOCKOUT_MS / 1000)}s. ` +
          `Inspect logs/app.jsonl and src/lib/login-lockout.ts for the counter state.`,
        "high",
      ).catch(() => {
        // intentionally swallowed — see file header
      })

      return { locked: true, retryAfterSec: Math.ceil(LOCKOUT_MS / 1000) }
    }

    lockoutMap.set(key, existing)
    // Bound the Map on every fresh insert as well — same rationale as above.
    boundMapSize(lockoutMap)
    return { locked: false, retryAfterSec: 0 }
  } catch {
    return { locked: false, retryAfterSec: 0 }
  }
}

/**
 * Clear the failure counter for `key`. Call on a SUCCESSFUL login so a
 * forgetful user who fails 4 times and then succeeds doesn't carry a
 * half-full counter into their next session.
 *
 * Best-effort; never throws.
 */
export function clearAttempts(key: string): void {
  try {
    lockoutMap.delete(key)
  } catch {
    // ignore — best-effort
  }
}

/**
 * Build the map key for a login attempt. Lowercases the email so
 * "Admin@x.com" and "admin@x.com" share a counter (the User table is
 * case-sensitive on email but an attacker typoing capitalization shouldn't
 * get a free extra 5 attempts). Combines with the IP so a single source IP
 * brute-forcing multiple accounts is locked per-target, not globally.
 */
export function getLockoutKey(email: string, ip: string): string {
  return `login:${email.toLowerCase()}:${ip}`
}
