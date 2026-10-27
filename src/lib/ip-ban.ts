// In-memory IP ban list with escalation — IPs that hit honeypot traps get
// banned with progressively longer windows:
//
//   1st ban:    1 hour
//   2nd ban:    24 hours
//   3rd ban:    7 days
//   4th+ ban:   permanent (999 days)
//
// The ban count is tracked per IP *inside the ban entry itself* (per the
// escalation design), so repeat offenders escalate even after a previous
// ban has expired. Uses globalThis to persist the Map across hot reloads
// in dev (same pattern as src/lib/rate-limit.ts and login-lockout.ts).
//
// --- Webhook alerting (10x+: Security webhook alerts) -------------------
// `banIP` is the choke-point for every IP-banning path in the codebase
// today (the only caller is `src/app/api/trap/[...path]/route.ts`, the
// honeypot trap). We fire a `sendSecurityAlert("high", ...)` here so the
// operator is pinged the moment a scanner trips a trap — long before they
// would otherwise notice the ban entry in `logs/app.jsonl`. The alert
// runs AFTER the ban has been persisted to the banMap, so a webhook
// failure cannot weaken the ban. The alert is rate-limited inside
// `sendSecurityAlert` (10/min), so a 100-IP distributed scanner sweeping
// every trap endpoint simultaneously won't spam the webhook channel past
// the cap. The alert description includes the escalation tier so the
// operator can tell at a glance whether this is a fresh probe or a
// repeat offender escalating to permanent ban.

import { boundMapSize } from "@/lib/rate-limit"
import { sendSecurityAlert } from "@/lib/security-alerts"

interface BanEntry {
  ip: string
  reason: string
  bannedUntil: number
  /**
   * Total number of times this IP has been banned (1-based). Survives past
   * ban expiry so a re-offense inside the history retention window
   * escalates instead of resetting to a 1st-time ban. Swept eventually
   * by `cleanupIPBans()` once the entry is stale.
   */
  banCount: number
  /**
   * Wall-clock timestamp of the most recent `banIP()` call for this IP.
   * Distinct from `bannedUntil` (which is `lastBannedAt + duration`) so
   * callers can surface "last banned at" without re-deriving it.
   */
  lastBannedAt: number
}

// ─── Escalation schedule ───────────────────────────────────────────────────
//
// Indexed by (banCount - 1):
//   banCount = 1 → BAN_DURATIONS_MS[0]   = 1 hour     (1st ban)
//   banCount = 2 → BAN_DURATIONS_MS[1]   = 24 hours    (2nd ban)
//   banCount = 3 → BAN_DURATIONS_MS[2]   = 7 days      (3rd ban)
//   banCount ≥ 4 → BAN_DURATIONS_MS[3]   = 999 days    (permanent)
//
// Any banCount past the last index falls through to the permanent bucket.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const BAN_DURATIONS_MS: readonly number[] = [
  HOUR_MS, // 1st ban: 1 hour
  DAY_MS, // 2nd ban: 24 hours
  7 * DAY_MS, // 3rd ban: 7 days
  999 * DAY_MS, // 4th+ ban: permanent (999 days)
] as const

// How long to keep an entry AFTER its ban has expired, so a re-offense
// inside this window escalates rather than starting over at a 1st-time
// ban. Entries whose ban expired longer ago than this get swept by
// `cleanupIPBans()`. 30 days captures the "attacker comes back next
// weekend" long tail without unbounded memory growth — the hard size cap
// in `boundMapSize` is still the ultimate ceiling.
const HISTORY_RETENTION_MS = 30 * DAY_MS

/**
 * Escalation policy, exported so tests / admin UIs can read the configured
 * thresholds without hardcoding the magic numbers (mirrors the
 * `LOCKOUT_POLICY` pattern in login-lockout.ts).
 */
export const BAN_ESCALATION_POLICY = {
  /** Ban duration (ms) for each escalation tier; index = banCount - 1. */
  durationsMs: BAN_DURATIONS_MS,
  /** Ms after expiry an entry is kept for history before being swept. */
  historyRetentionMs: HISTORY_RETENTION_MS,
} as const

/**
 * Compute the ban duration (ms) for the given 1-based ban count.
 * Tier 4+ falls through to the permanent (999-day) bucket.
 *
 *   computeBanDurationMs(1) // → 3_600_000          (1 hour)
 *   computeBanDurationMs(2) // → 86_400_000         (24 hours)
 *   computeBanDurationMs(3) // → 604_800_000        (7 days)
 *   computeBanDurationMs(4) // → 86_313_600_000     (999 days, permanent)
 *   computeBanDurationMs(7) // → 86_313_600_000     (still permanent)
 */
export function computeBanDurationMs(banCount: number): number {
  const idx = Math.min(Math.max(0, banCount - 1), BAN_DURATIONS_MS.length - 1)
  return BAN_DURATIONS_MS[idx]
}

/**
 * True iff the given duration corresponds to the permanent (999-day) tier.
 * Used by `getBanHistory` so admin UIs can distinguish "retry in 3 days"
 * from "this IP is permanently banned".
 */
export function isPermanentBanDuration(durationMs: number): boolean {
  return durationMs >= BAN_DURATIONS_MS[BAN_DURATIONS_MS.length - 1]
}

// Persist the Map across hot reloads in dev by stashing it on globalThis.
// Guarded with try/catch so a failure here never breaks the module load.
let banMap: Map<string, BanEntry>
try {
  const g = globalThis as any
  if (!g.__ipBanMap) g.__ipBanMap = new Map<string, BanEntry>()
  banMap = g.__ipBanMap
} catch {
  banMap = new Map()
}

/**
 * Ban `ip` with an escalating duration based on how many times it has
 * been banned before:
 *
 *   1st ban    → 1 hour
 *   2nd ban    → 24 hours
 *   3rd ban    → 7 days
 *   4th+ ban   → permanent (999 days)
 *
 * If `ip` has an existing entry — active OR recently expired (within
 * `HISTORY_RETENTION_MS`) — the ban count is incremented and the
 * duration escalates. Otherwise the count starts at 1 (a 1-hour ban).
 *
 * NOTE: the previous `durationSec` parameter has been removed — duration
 * is now purely a function of ban count. Call sites that previously
 * passed a fixed duration (e.g. the honeypot trap route) should drop it
 * and rely on the escalation schedule above.
 *
 * Best-effort; never throws — a ban-path failure would let an attacker
 * through, which is worse than a missed escalation.
 */
export async function banIP(ip: string, reason: string): Promise<void> {
  try {
    const now = Date.now()
    const existing = banMap.get(ip)
    // Re-offender: increment the prior count. First-timer: start at 1.
    // The `?.` chain handles both `existing === undefined` (never seen)
    // and a malformed entry without a `banCount` field (defensive).
    const banCount = (existing?.banCount ?? 0) + 1
    const durationMs = computeBanDurationMs(banCount)
    const permanent = isPermanentBanDuration(durationMs)
    banMap.set(ip, {
      ip,
      reason,
      bannedUntil: now + durationMs,
      banCount,
      lastBannedAt: now,
    })
    // Bound the Map size — an attacker who hits honeypot traps from many
    // spoofed-IP X-Forwarded-For values could otherwise grow this Map
    // without limit. Best-effort; never throws.
    boundMapSize(banMap)

    // Fire the webhook alert AFTER the ban has been persisted, so a
    // webhook failure cannot leave the IP un-banned. Severity escalates
    // with tier: a permanent ban is `critical` (this IP is almost
    // certainly a persistent attacker), everything else is `high`.
    // The IP is already in `logs/app.jsonl` via the trap route, so
    // including it in an operator-only webhook is fine.
    const durationLabel = permanent
      ? "permanent (999d)"
      : `${Math.round(durationMs / 1000 / 60)}min`
    const tierLabel =
      banCount === 1 ? "1st ban"
      : banCount === 2 ? "2nd ban"
      : banCount === 3 ? "3rd ban"
      : `${banCount}th ban (permanent tier)`
    void sendSecurityAlert(
      "Honeypot trap hit — IP banned",
      `IP \`${ip}\` banned by trap with reason \`${reason}\`. ` +
        `Escalation: ${tierLabel} → ${durationLabel}. ` +
        `This IP has now been banned ${banCount} time${banCount === 1 ? "" : "s"} total.`,
      permanent ? "critical" : "high",
    ).catch(() => {
      // intentionally swallowed — see file header
    })
  } catch {
    // ignore — best-effort ban path
  }
}

export function isIPBanned(ip: string): { banned: boolean; reason?: string; retryAfterSec?: number } {
  const entry = banMap.get(ip)
  if (!entry) return { banned: false }
  const now = Date.now()
  if (now >= entry.bannedUntil) {
    // Ban has expired — DO NOT delete the entry. We keep it so a future
    // `banIP()` call sees the prior `banCount` and escalates. The entry
    // is eventually swept by `cleanupIPBans()` once it has been expired
    // for longer than `HISTORY_RETENTION_MS`.
    return { banned: false }
  }
  return {
    banned: true,
    reason: entry.reason,
    retryAfterSec: Math.ceil((entry.bannedUntil - now) / 1000),
  }
}

/**
 * Return the ban history for `ip` plus its current ban status. Useful for
 * admin tooling that wants to surface "this is the Nth time this IP has
 * been banned" and the remaining window without poking at the internal
 * Map shape.
 *
 *   const h = getBanHistory(ip)
 *   if (h.currentlyBanned) {
 *     // h.banCount, h.retryAfterSec, h.permanent
 *   }
 *
 * `banCount` is always returned (even when the IP isn't currently banned)
 * so callers can decide whether to display "previously banned N times" in
 * an admin view. `permanent` is `true` only when the current ban sits at
 * the permanent (999-day) tier.
 *
 * Never throws — returns `{ banCount: 0, currentlyBanned: false,
 * permanent: false }` on any internal error so a stats path can't take
 * down a request (fail-open, same philosophy as `isIPBanned`).
 */
export function getBanHistory(ip: string): {
  banCount: number
  currentlyBanned: boolean
  permanent: boolean
  reason?: string | undefined
  bannedUntil?: number | undefined
  retryAfterSec?: number | undefined
  lastBannedAt?: number | undefined
} {
  try {
    const entry = banMap.get(ip)
    if (!entry) {
      return { banCount: 0, currentlyBanned: false, permanent: false }
    }
    const now = Date.now()
    const currentlyBanned = now < entry.bannedUntil
    const durationMs = computeBanDurationMs(entry.banCount)
    const permanent = isPermanentBanDuration(durationMs)
    return {
      banCount: entry.banCount,
      currentlyBanned,
      permanent,
      reason: currentlyBanned ? entry.reason : undefined,
      bannedUntil: currentlyBanned ? entry.bannedUntil : undefined,
      retryAfterSec: currentlyBanned ? Math.ceil((entry.bannedUntil - now) / 1000) : undefined,
      lastBannedAt: entry.lastBannedAt,
    }
  } catch {
    return { banCount: 0, currentlyBanned: false, permanent: false }
  }
}

/**
 * Sweep expired-and-stale entries from the ban Map and enforce the hard
 * size cap. Mirrors `cleanupRateLimit` in rate-limit.ts. Call periodically
 * from the same cron / interval that sweeps the rate-limit Map. Returns
 * the number of entries removed (handy for metrics). Never throws.
 *
 * An entry is eligible for sweep when:
 *   - its ban has expired (`bannedUntil <= now`), AND
 *   - it has been expired for longer than `HISTORY_RETENTION_MS`, so a
 *     re-offense inside that window still escalates rather than starting
 *     over at a 1st-time ban.
 *
 * Even with the retention window, the hard size cap from `boundMapSize()`
 * remains the ultimate ceiling on memory growth — under an
 * attacker-driven key explosion (spoofed `X-Forwarded-For`) the oldest
 * entries — whether still active or not — are evicted first.
 */
export function cleanupIPBans(): number {
  let removed = 0
  try {
    const now = Date.now()
    for (const [ip, entry] of banMap) {
      if (entry.bannedUntil <= now && now - entry.bannedUntil > HISTORY_RETENTION_MS) {
        banMap.delete(ip)
        removed++
      }
    }
    // Enforce the hard cap as well — same rationale as rate-limit.
    removed += boundMapSize(banMap)
  } catch {
    // ignore — best-effort cleanup
  }
  return removed
}
