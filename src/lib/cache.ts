/**
 * In-memory TTL cache for expensive query results.
 *
 * Design notes (per performance-optimization skill):
 *  - Cache key includes every input the response varies on (caller's job — see
 *    `cacheSet`/`cacheGet` call sites in `stats/route.ts`: key = `stats:${projectId}:${range}`).
 *  - Single invalidation strategy: TTL (default 60s). Acceptable staleness window
 *    is stated at each call site (e.g. "stats don't need to be real-time" → 60s).
 *  - `cacheDelete(prefix)` enables tag/prefix invalidation when data changes.
 *  - Backed by `globalThis` so it survives Next.js dev hot reloads and shares
 *    entries across route handler invocations in the same Node.js process.
 *  - Cache failures MUST NEVER break the app — every read/write is wrapped in
 *    try/catch and degrades to a miss / no-op. Caching is an optimization, not
 *    a correctness dependency.
 *  - Unbounded growth is bounded by (a) TTL expiry + `cacheDelete`,
 *    `cacheGet` auto-prunes expired entries on every read, and (b) a hard
 *    size cap via `boundMapSize` in `rate-limit.ts` — when the Map exceeds
 *    MAX_MAP_ENTRIES_TRIGGER (10_000) the oldest insertion-order entries are
 *    evicted down to MAX_MAP_ENTRIES_TARGET (5_000). For a multi-process
 *    production deployment, swap this for Redis (the API surface is identical).
 */

import { boundMapSize } from "@/lib/rate-limit"

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

type CacheMap = Map<string, CacheEntry<unknown>>

function getStore(): CacheMap {
  try {
    const g = globalThis as unknown as { __appCache?: CacheMap }
    if (!g.__appCache) {
      g.__appCache = new Map<string, CacheEntry<unknown>>()
    }
    return g.__appCache
  } catch {
    // Should never happen, but never throw from the cache layer.
    return new Map<string, CacheEntry<unknown>>()
  }
}

/**
 * Returns the cached value if present and unexpired, else null.
 * Auto-prunes the expired entry on read so memory is reclaimed lazily.
 */
export function cacheGet<T>(key: string): T | null {
  try {
    const store = getStore()
    const entry = store.get(key) as CacheEntry<T> | undefined
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      store.delete(key)
      return null
    }
    return entry.value
  } catch {
    return null
  }
}

/**
 * Stores `value` under `key` with a TTL of `ttlMs` milliseconds.
 * Never throws — on any failure the write is silently dropped.
 */
export function cacheSet<T>(key: string, value: T, ttlMs: number): void {
  try {
    if (!key || ttlMs <= 0) return
    const store = getStore()
    store.set(key, { value, expiresAt: Date.now() + ttlMs })
    // Enforce the hard size cap — TTL eviction only fires on read, so a
    // key never read again would otherwise linger forever. An attacker
    // who varies the cache key (e.g. `range` query param) could grow
    // this Map without bound; this cap is the backstop.
    boundMapSize(store)
  } catch {
    // no-op — cache failures must never break the app
  }
}

/**
 * Deletes every cache entry whose key starts with `prefix`.
 * Used for invalidation when the underlying data changes
 * (e.g. delete `stats:` to invalidate all stats entries for a project,
 * or `stats:${projectId}:` to invalidate just that project's stats).
 * Returns the number of entries deleted (0 if none matched).
 */
export function cacheDelete(prefix: string): number {
  try {
    if (!prefix) return 0
    const store = getStore()
    let removed = 0
    for (const key of Array.from(store.keys())) {
      if (key.startsWith(prefix)) {
        store.delete(key)
        removed++
      }
    }
    return removed
  } catch {
    return 0
  }
}

/**
 * Observability helper — returns the current size + key list.
 * Used by /api/observability or for debugging cache hit rate.
 * NOTE: this does not prune expired entries; size is the raw map size.
 */
export function cacheStats(): { size: number; keys: string[] } {
  try {
    const store = getStore()
    return { size: store.size, keys: Array.from(store.keys()) }
  } catch {
    return { size: 0, keys: [] }
  }
}
