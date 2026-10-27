// Proof of Work (PoW) for the login endpoint.
//
// Why PoW on login?
//   Even with per-IP rate limiting (5 req/min) + per-email+IP lockout (5 fails
//   → 15 min), an attacker rotating across many IPs can still try ~5 passwords
//   per minute per IP. PoW adds a per-request computational cost: the client
//   must find a nonce such that SHA-256(challenge + nonce) starts with N zero
//   hex chars. At difficulty 4 (16 zero bits), that's ~65k hash attempts on
//   average — roughly 50–150 ms on a modern laptop CPU. An attacker who wants
//   to fire 1 000 attempts/min across rotating IPs must now spend 1 000 × 100 ms
//   = 100 s of CPU every minute, i.e. devote real hardware to the attack.
//   Legitimate users pay a one-time ~100 ms cost on each login submit, which is
//   imperceptible.
//
// Flow:
//   1. Client fetches a challenge (GET /api/auth/login/pow, or piggy-backed on
//      the existing GET /api/csrf-token response).
//   2. The server stores the challenge in the in-memory cache (single-use,
//      60 s TTL) so the client cannot reuse a precomputed nonce for arbitrary
//      challenges, and so a challenge issued more than 60 s ago is rejected.
//   3. Client brute-forces a nonce locally (~100 ms) and POSTs /api/auth/login
//      with x-pow-challenge + x-pow-nonce headers.
//   4. The login route consumes the challenge (verifies hash + deletes from
//      cache → single-use). If invalid/expired/missing → 403 with a fresh
//      challenge attached so the client can retry transparently.
//
// Runtime: this module uses `node:crypto` (`createHash`, `randomBytes`), so it
// is Node-only. The login route is a Node route (it imports Prisma), so this
// is fine. The browser-side solver lives in `src/lib/pow-client.ts` and uses
// the Web Crypto SubtleCrypto API instead.

import { createHash, randomBytes } from "crypto"
import { cacheGet, cacheSet, cacheDelete } from "@/lib/cache"

// 4 leading zero hex chars = 16 zero bits. Expected attempts ≈ 2^16 = 65 536.
// Tuned so a modern CPU pays ~100 ms per attempt — slows brute force ~100x
// without making legitimate login perceptibly slower.
export const POW_DIFFICULTY = 4

// Challenges are valid for 60 s. Long enough for a legit user's browser to
// solve (~100 ms) + account for slow connections; short enough that a
// sniffed challenge can't be replayed later.
export const POW_TTL_MS = 60_000

// Maximum length we'll accept for the client-supplied `nonce` header. We
// bound it to defend against pathological inputs (megabyte nonces). A real
// solution is found well under 2^16 attempts, so a 32-char nonce is more than
// enough — but we leave headroom for decimal-style counters up to ~10^12.
const MAX_NONCE_LENGTH = 64

export interface PoWChallenge {
  /** Random 32-char hex string (128 bits) the client must hash with a nonce. */
  challenge: string
  /** Number of leading zero hex chars the SHA-256 hash must start with. */
  difficulty: number
  /** Issuance time (ms since epoch) — client uses this only for diagnostics. */
  timestamp: number
}

/**
 * Generate a fresh PoW challenge. The challenge is stored in the in-memory
 * cache (single-use, TTL = POW_TTL_MS) so a subsequent `consumePoWChallenge`
 * call can verify the challenge was actually issued by us and not expired.
 *
 * Returns the public challenge object (no secrets — the difficulty is
 * intentionally published; security rests on the hash preimage search).
 *
 * Never throws; on internal error returns a fresh challenge without caching
 * it (the client will get a 403 on submit and retry — fail-open for issuance,
 * fail-closed for verification).
 */
export function generatePoWChallenge(): PoWChallenge {
  const challenge = randomBytes(16).toString("hex")
  const timestamp = Date.now()
  try {
    cacheSet(powCacheKey(challenge), { difficulty: POW_DIFFICULTY, timestamp }, POW_TTL_MS)
  } catch {
    // best-effort — cache write failure should never break issuance
  }
  return { challenge, difficulty: POW_DIFFICULTY, timestamp }
}

/**
 * Verify the SHA-256 PoW: hash(challenge + nonce) must start with `difficulty`
 * zero hex chars. Pure function — does NOT consume the challenge from the
 * cache; call `consumePoWChallenge` to do the single-use lookup.
 *
 * Returns false on any malformed input (empty challenge / nonce, oversized
 * nonce, non-positive difficulty). Never throws.
 */
export function verifyPoW(challenge: string, nonce: string, difficulty: number): boolean {
  try {
    if (!challenge || !nonce) return false
    if (typeof challenge !== "string" || typeof nonce !== "string") return false
    if (nonce.length > MAX_NONCE_LENGTH) return false
    if (!Number.isInteger(difficulty) || difficulty <= 0 || difficulty > 16) {
      // difficulty > 16 would force 64+ zero bits — DoS the verifier. Cap at 16.
      return false
    }
    const hash = createHash("sha256").update(challenge + nonce).digest("hex")
    const prefix = "0".repeat(difficulty)
    return hash.startsWith(prefix)
  } catch {
    return false
  }
}

/**
 * Consume a challenge: look it up in the cache, verify it exists + is
 * unexpired, and delete it (single-use). Returns the difficulty the challenge
 * was issued with so the caller can pass it to `verifyPoW`.
 *
 * Single-use semantics: once consumed, the same challenge cannot be replayed.
 * An attacker who solves the PoW for one challenge can submit it exactly once;
 * subsequent attempts must re-mint and re-solve. This is what makes PoW an
 * effective per-attempt cost — without single-use, an attacker could mint one
 * challenge, solve once, and reuse the nonce for every password guess.
 *
 * Returns `{ valid: false }` if the challenge was never issued, already
 * consumed, or expired. Returns `{ valid: true, difficulty }` on success.
 *
 * Never throws — fail-closed (invalid) on internal error so a cache bug
 * can't let a PoW-less request through.
 */
export function consumePoWChallenge(
  challenge: string,
): { valid: true; difficulty: number } | { valid: false } {
  try {
    if (!challenge || typeof challenge !== "string") return { valid: false }
    const key = powCacheKey(challenge)
    const entry = cacheGet<{ difficulty: number; timestamp: number }>(key)
    if (!entry) return { valid: false }
    // Single-use: delete immediately so a concurrent duplicate request racing
    // in the same event-loop tick sees the slot empty. (Node is single-
    // threaded per-process, but the explicit delete documents the contract
    // and prevents any accidental reuse if the cache layer ever becomes async.)
    cacheDelete(key)
    return { valid: true, difficulty: entry.difficulty }
  } catch {
    return { valid: false }
  }
}

/**
 * Best-effort deletion of a challenge from the cache. Idempotent. Used to
 * invalidate a challenge explicitly without consuming it (e.g. on a successful
 * login, although `consumePoWChallenge` already handles this — exported for
 * test hooks and future use).
 */
export function deletePoWChallenge(challenge: string): void {
  try {
    if (!challenge) return
    cacheDelete(powCacheKey(challenge))
  } catch {
    // ignore — best-effort
  }
}

/**
 * Namespaced cache key. The `pow:v1:` prefix isolates PoW challenges from
 * stats cache entries (which use `stats:...`) and any other cache user, so
 * cacheDelete on a PoW key can never accidentally clobber unrelated entries.
 */
function powCacheKey(challenge: string): string {
  return `pow:v1:${challenge}`
}
