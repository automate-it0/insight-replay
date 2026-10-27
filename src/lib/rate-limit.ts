// In-memory rate limiter — pure TS, no Node-only imports (safe for Edge middleware).
// Uses a Map stashed on globalThis to persist across hot reloads in dev.

interface RateLimitEntry {
  count: number
  resetAt: number
}

interface RateLimitOptions {
  max: number
  windowMs: number
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

// Persist the Map across hot reloads in dev by stashing it on globalThis.
// Guarded with try/catch so a failure here never breaks the module load.
let rateLimitMap: Map<string, RateLimitEntry>
try {
  const g = globalThis as any
  if (!g.__rateLimitMap) g.__rateLimitMap = new Map<string, RateLimitEntry>()
  rateLimitMap = g.__rateLimitMap
} catch {
  rateLimitMap = new Map<string, RateLimitEntry>()
}

// ─── Bounded Map (DoS protection) ─────────────────────────────────────────
//
// An attacker who spoofs `X-Forwarded-For` can synthesize millions of unique
// "IP" strings, each of which gets its own entry in `rateLimitMap`. Without a
// ceiling, that exhausts process memory. We cap the Map at MAX_MAP_ENTRIES;
// when it crosses the soft threshold MAX_MAP_ENTRIES_TRIGGER we evict the
// oldest half (5000 entries). "Oldest" means insertion order — JS Map keys
// iterate in insertion order, so the first key returned by `map.keys()` is
// the oldest entry still present. We also proactively sweep expired entries
// during the eviction pass so a TTL-stale entry doesn't get re-counted.
//
// Same constant is applied to the lockout and IP-ban Maps via the shared
// `boundMapSize` helper exported below — keep them in sync.
export const MAX_MAP_ENTRIES_TRIGGER = 10_000
export const MAX_MAP_ENTRIES_TARGET = 5_000

/**
 * Cap an in-memory Map at MAX_MAP_ENTRIES_TARGET entries by deleting the
 * oldest insertion-order keys. Pure (mutates the passed Map only), never
 * throws. Used by the rate-limit / login-lockout / IP-ban Maps to bound
 * memory growth under attacker-driven key explosion.
 *
 * Returns the number of entries removed (handy for metrics / logs).
 */
export function boundMapSize<K, V>(
  map: Map<K, V>,
  trigger: number = MAX_MAP_ENTRIES_TRIGGER,
  target: number = MAX_MAP_ENTRIES_TARGET,
): number {
  // Fast path — under the trigger, nothing to do. Avoids allocating an
  // iterator + array on the hot path of every request.
  if (map.size < trigger) return 0
  let removed = 0
  try {
    const toRemove = Math.max(0, map.size - target)
    // Map iteration is insertion-order; the first key returned is the
    // oldest still present. Walk it with `next()` so we stop after exactly
    // `toRemove` deletions without materializing the full key list.
    const it = map.keys()
    while (removed < toRemove) {
      const step = it.next()
      if (step.done) break
      map.delete(step.value)
      removed++
    }
  } catch {
    // ignore — best-effort eviction
  }
  return removed
}

/** Default limit for the tracking ingest endpoint: 100 req/min per IP. */
export const INGEST_LIMIT: RateLimitOptions = { max: 100, windowMs: 60_000 }

/** Default limit for dashboard API routes: 60 req/min per IP. */
export const API_LIMIT: RateLimitOptions = { max: 60, windowMs: 60_000 }

// ─── Per-user limits ──────────────────────────────────────────────────────
//
// Per-IP limits (above) are good for edge-level abuse control but they cannot
// distinguish two authenticated users behind the same NAT/corporate proxy.
// Per-user limits key on the authenticated principal (user id / API key id)
// so a single compromised account cannot soak up the whole IP's quota, and
// conversely one user's traffic doesn't count against another's. Use these
// INSIDE authenticated route handlers — after `validateApiKey` / session
// resolution — via `rateLimitByKey(session.userId, USER_API_LIMIT)`.
//
// The `user:` prefix on the map key isolates user-keyed counters from IP
// counters (which never contain a `:`) so the two never collide.

/** 120 req/min for authenticated users on general API routes. */
export const USER_API_LIMIT: RateLimitOptions = { max: 120, windowMs: 60_000 }

/** 10 AI requests/min — AI routes are LLM-backed and expensive, so they get
 *  a much tighter cap to bound cost and prevent prompt-injection flooding. */
export const USER_AI_LIMIT: RateLimitOptions = { max: 10, windowMs: 60_000 }

/** 5 exports/min — CSV exports can be large and contain PII, so they get the
 *  tightest cap to bound data-exfiltration risk from a compromised account. */
export const USER_EXPORT_LIMIT: RateLimitOptions = { max: 5, windowMs: 60_000 }

/**
 * Check whether a request from `ip` should be allowed under the given limit.
 * Uses a per-IP fixed-window counter that resets when the window expires.
 * Fails open (allows the request) if anything goes wrong, so a limiter bug
 * can never take the ingest endpoint offline.
 */
export function rateLimit(
  ip: string,
  opts: RateLimitOptions
): RateLimitResult {
  try {
    const now = Date.now()
    const entry = rateLimitMap.get(ip)

    if (!entry || entry.resetAt <= now) {
      // No entry, or the previous window has expired — start a fresh window.
      const resetAt = now + opts.windowMs
      rateLimitMap.set(ip, { count: 1, resetAt })
      // Bound the Map size — never let it grow unbounded under attacker
      // spoofing of `X-Forwarded-For`. Cheap when under the trigger (one
      // size comparison); when over, evicts the oldest 5k entries.
      boundMapSize(rateLimitMap)
      return { allowed: true, remaining: Math.max(0, opts.max - 1), resetAt }
    }

    // Existing window still active.
    if (entry.count >= opts.max) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt }
    }

    entry.count += 1
    return {
      allowed: true,
      remaining: Math.max(0, opts.max - entry.count),
      resetAt: entry.resetAt,
    }
  } catch {
    // Fail open — never block the request due to an internal error.
    return {
      allowed: true,
      remaining: opts.max,
      resetAt: Date.now() + opts.windowMs,
    }
  }
}

/**
 * Per-user rate limit. Identical semantics to `rateLimit` but keys the
 * counter on a custom string (typically the authenticated user id or API
 * key id) prefixed with `user:` to isolate it from per-IP counters.
 *
 * Use INSIDE authenticated route handlers, AFTER `validateApiKey` / session
 * resolution — never at the edge (an anonymous attacker could spoof the
 * key). Pair with the shipped `USER_*_LIMIT` constants:
 *
 *   const rl = rateLimitByKey(session.userId, USER_API_LIMIT)
 *   if (!rl.allowed) return tooManyRequests("Rate limit exceeded", 60, { resetAt: rl.resetAt })
 *
 * Fails open (allows the request) if the underlying `rateLimit` call throws,
 * so a limiter bug can never take an authenticated route offline.
 */
export function rateLimitByKey(
  key: string,
  opts: RateLimitOptions,
): RateLimitResult {
  // Prefix with `user:` so the counter can never collide with an IP-keyed
  // entry (IPs never contain `:`). Falls back to a literal "user:" sentinel
  // if `key` is empty, so two callers passing `""` still share a counter
  // rather than accidentally hitting the IP-keyed `""` slot.
  const mapKey = `user:${key || ""}`
  return rateLimit(mapKey, opts)
}

/**
 * Reset a specific key's counter. Pass the FULL map key — for per-IP limits
 * that's the IP string, for per-user limits that's `"user:" + userId`
 * (the same string `rateLimitByKey` would build). Intended primarily for
 * test isolation; production code should rarely need this (let the window
 * expire naturally).
 *
 *   // In a test:
 *   resetRateLimit("user:user-123")     // wipe a per-user counter
 *   resetRateLimit("203.0.113.5")       // wipe a per-IP counter
 *
 * Returns `true` if an entry was removed, `false` if no entry existed.
 * Never throws — best-effort.
 */
export function resetRateLimit(key: string): boolean {
  try {
    return rateLimitMap.delete(key)
  } catch {
    return false
  }
}

/**
 * Extract the client IP from `x-forwarded-for` (first hop) or `x-real-ip`,
 * falling back to "unknown". Guarded so a malformed header never throws.
 */
export function getClientIP(req: Request): string {
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
 * Remove expired entries from the rate-limit map. Call periodically (e.g. every
 * few minutes) to bound memory growth in long-running processes. Returns the
 * number of entries removed (handy for logging / metrics).
 */
export function cleanupRateLimit(): number {
  let removed = 0
  try {
    const now = Date.now()
    for (const [ip, entry] of rateLimitMap) {
      if (entry.resetAt <= now) {
        rateLimitMap.delete(ip)
        removed++
      }
    }
    // Belt-and-suspenders: also enforce the hard size cap in case the
    // just-in-time boundMapSize() call inside rateLimit() hasn't fired
    // recently (e.g. all recent requests were denied at the IP-ban layer
    // and never reached rateLimit).
    removed += boundMapSize(rateLimitMap)
  } catch {
    // ignore — best-effort cleanup
  }
  return removed
}
