/**
 * @file src/lib/auth.ts
 *
 * API-key authentication for the dashboard's protected project endpoints
 * (`/api/projects/[id]/*`). This module is the single source of truth for:
 *
 *   1. **Key extraction** — `getApiKey(req)` pulls the bearer token from the
 *      `Authorization` header (preferred) or the `?apikey=` query fallback
 *      (for browser/curl testing).
 *   2. **At-rest key storage** — `hashApiKey()` returns a per-key salted
 *      SHA-256 digest (`"<hash>:<salt>"`); `verifyApiKey()` does a
 *      length-checked byte-wise compare to avoid an early-exit timing leak.
 *      Legacy plaintext keys (pre-hardening) are matched by direct equality
 *      via `keyMatches` during the rotation window documented in
 *      `docs/security-audit.md`.
 *   3. **Request validation** — `validateApiKey(req, projectId)` looks the
 *      project's keys up in the DB (bounded to 100 rows), decrypts each
 *      row if it's in the AES-256-GCM envelope format (see
 *      `src/lib/db-encryption`), and runs `keyMatches` against the
 *      provided key. On a hit it fire-and-forget-updates `lastUsed` and
 *      returns `{ valid: true, keyId }`.
 *   4. **Dev-mode enforcement policy** — `shouldEnforceApiKeyAuth()` is the
 *      canonical replacement for the inline `process.env.NODE_ENV ===
 *      "production"` check that route handlers used to (and still do,
 *      until the follow-up migration) duplicate. It returns `true` when
 *      either:
 *        - `process.env.NODE_ENV === "production"` (auth always enforced in
 *          prod, regardless of any flag — production must never be left
 *          open by accident), OR
 *        - `ENFORCE_AUTH_IN_DEV === "true"` (opt-in dev enforcement — see
 *          below).
 *      Default in dev: `false` (dashboard open for local testing without
 *      keys). Set `ENFORCE_AUTH_IN_DEV=true` in `.env` to test auth flows
 *      against a dev server without building for prod — useful when
 *      reproducing a production auth bug or running the security test
 *      suite (`tests/security/auth.test.ts`) against a dev runtime.
 *
 * `ENFORCE_AUTH_IN_DEV` flag (env var, default false / unset):
 *   - `false` (default)  → dev keeps the historical open-access behaviour;
 *     route handlers' existing `if (NODE_ENV === "production")` block
 *     skips auth, and `shouldEnforceApiKeyAuth()` returns `false` so any
 *     future caller that consults the helper also skips auth.
 *   - `true`             → auth is enforced even in dev. Operators can flip
 *     this per-environment to verify API-key flows without a prod deploy.
 *     Recovery from an accidental `true` is a one-line env-var change +
 *     process restart (no redeploy required — flag is read at module
 *     load time, same pattern as `src/lib/feature-flags.ts`).
 *
 * Migration note (Task ID P4-A): this commit only touches
 * `src/lib/auth.ts` per the spec's "don't touch other files" constraint.
 * The ~20 route handlers under `src/app/api/projects/[id]/*` still inline
 * the `process.env.NODE_ENV === "production"` gate; a follow-up task
 * will migrate them to call `shouldEnforceApiKeyAuth()` so the bypass
 * decision is centralized here (config-driven instead of NODE_ENV-only).
 * Until that migration, the helper is exported and ready but not yet
 * wired in.
 *
 * Related docs:
 *   - `docs/security-audit.md`  — rotation procedure for legacy plaintext
 *                                  keys (Task ID A, Phase 4).
 *   - `docs/adr/0004-security-hardening-layers.md` — the 6-layer model.
 *   - `src/lib/feature-flags.ts` — sibling feature-flag pattern (FF_*
 *                                  env vars, same opt-in/opt-out
 *                                  conventions used here for
 *                                  `ENFORCE_AUTH_IN_DEV`).
 */
import { db } from "@/lib/db"
import { NextResponse } from "next/server"
import { createHash, randomBytes } from "crypto"
import {
  decryptField,
  isEncryptedField,
} from "@/lib/db-encryption"

/**
 * Whether the dev-mode API-key bypass should be turned off — i.e. whether
 * `validateApiKey` should actually be consulted for the current request.
 *
 * Returns `true` when:
 *   - `process.env.NODE_ENV === "production"` (auth is always enforced in
 *     production, regardless of `ENFORCE_AUTH_IN_DEV` — fail-closed), OR
 *   - `process.env.ENFORCE_AUTH_IN_DEV === "true"` (opt-in dev enforcement).
 *
 * Returns `false` otherwise — i.e. in dev when the operator hasn't opted
 * into enforcement, preserving the historical open-access behaviour so
 * the dashboard works without API keys during local testing.
 *
 * This helper is the canonical replacement for the inline
 * `if (process.env.NODE_ENV === "production")` block duplicated across
 * the ~20 route handlers under `src/app/api/projects/[id]/*`. It is
 * config-driven (env var) instead of NODE_ENV-only, so an operator can
 * flip auth enforcement on in dev to test API-key flows without building
 * for prod.
 *
 * Env: `ENFORCE_AUTH_IN_DEV` — default: false (unset / any non-`"true"`
 *   value). Set to the literal string `"true"` to enforce auth in dev.
 * Failure mode if wrong (left false in prod): impossible — production
 *   always enforces regardless of this flag.
 * Failure mode if wrong (set `true` accidentally in dev): the local
 *   dashboard starts returning 401 on protected endpoints until a valid
 *   API key is supplied. Recovery is a one-line env-var change + process
 *   restart.
 *
 * @example
 *   // In a route handler (replaces `if (NODE_ENV === "production")`):
 *   if (shouldEnforceApiKeyAuth()) {
 *     const auth = await validateApiKey(req, id)
 *     if (!auth.valid) return unauthorizedResponse()
 *   }
 */
export const ENFORCE_AUTH_IN_DEV: boolean =
  process.env.ENFORCE_AUTH_IN_DEV === "true"

export function shouldEnforceApiKeyAuth(): boolean {
  return process.env.NODE_ENV === "production" || ENFORCE_AUTH_IN_DEV
}

/**
 * Extract an API key from a request. Supports two transport mechanisms:
 *   1. `Authorization: Bearer <key>` header (preferred)
 *   2. `?apikey=<key>` query parameter (fallback for browser/curl testing)
 *
 * Returns null when no key is present.
 */
export function getApiKey(req: Request): string | null {
  // 1. Authorization: Bearer <key>
  const auth =
    req.headers.get("authorization") || req.headers.get("Authorization")
  if (auth) {
    const m = auth.match(/^Bearer\s+(.+)$/i)
    if (m && m[1]) {
      const k = m[1].trim()
      if (k) return k
    }
  }

  // 2. ?apikey=<key>
  try {
    const url = new URL(req.url)
    const q = url.searchParams.get("apikey")
    if (q) return q.trim()
  } catch {
    // req.url may be unavailable in some runtimes — ignore.
  }

  return null
}

/**
 * Hash an API key with SHA-256 + per-key random salt for storage at rest.
 * Returns the string `"<hash>:<salt>"` (both hex-encoded). The plaintext key
 * is intentionally unrecoverable from this value.
 *
 * Storage strategy (no schema change required):
 *   - On CREATE: generate plaintext `ir_<random>`, store `hashApiKey(plaintext)`
 *     in the existing `key` column, return the plaintext to the caller ONCE.
 *   - On VALIDATE: fetch all apikeys for the project (small N — usually <10),
 *     loop through, and call `verifyApiKey(providedKey, stored.key)` for each.
 *   - On GET (list): return `keyMasked` only — we no longer have the plaintext.
 *
 * Legacy plaintext keys (created before this hardening) are detected by the
 * absence of the `:` separator and matched by direct equality — see
 * `keyMatches` below. They should be rotated out via the workflow documented
 * in the worklog (Task ID A, Phase 4).
 */
export function hashApiKey(key: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = createHash("sha256").update(salt + key).digest("hex")
  return `${hash}:${salt}`
}

/**
 * Verify a plaintext key against a stored `"<hash>:<salt>"` value produced by
 * `hashApiKey`. Constant-time comparison is intentionally not used here
 * because the salt is per-key random and the hash itself is the secret under
 * test — an attacker without the plaintext cannot mount a timing attack on the
 * comparison since they would need to already know `hash` (which is what they
 * are trying to extract). Returns false on malformed input.
 */
export function verifyApiKey(plaintextKey: string, stored: string): boolean {
  const sep = stored.indexOf(":")
  if (sep <= 0 || sep >= stored.length - 1) return false
  const hash = stored.slice(0, sep)
  const salt = stored.slice(sep + 1)
  const computed = createHash("sha256").update(salt + plaintextKey).digest("hex")
  // Length-check then byte-by-byte compare to avoid early-exit timing leak.
  if (computed.length !== hash.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Match a plaintext key against a stored value, supporting BOTH the new
 * `"<hash>:<salt>"` format and the legacy plaintext format (which contains no
 * colon). Used by `validateApiKey` for backward compatibility during the
 * rotation window.
 */
function keyMatches(plaintext: string, stored: string): boolean {
  if (stored.includes(":")) {
    return verifyApiKey(plaintext, stored)
  }
  // Legacy plaintext key (pre-hardening). Direct equality is the only option.
  return plaintext === stored
}

/**
 * Validate that the request carries an API key that exists in the database
 * and belongs to the given project. On a successful match, updates the key's
 * `lastUsed` timestamp (fire-and-forget — never blocks the response).
 *
 * Implementation note: because keys are stored as `hash:salt` (not plaintext)
 * and NOW additionally wrapped in an `iv:ciphertext:authTag` encryption envelope
 * (see src/lib/db-encryption.ts), we cannot do an indexed `findFirst` on the
 * `key` column. Instead we fetch all keys for the project (small N — usually
 * <10) and run `verifyApiKey` in a loop. The first match wins. For each row
 * we first decrypt the stored `key` (if it's in encrypted format) to recover
 * the underlying `<hash>:<salt>` value, then call `keyMatches(providedKey, …)`.
 * Legacy rows (pre-hardening, un-encrypted) fall through to `k.key` as-is.
 *
 * Returns `{ valid: false }` when missing / unknown / project-mismatched, or
 * `{ valid: true, keyId }` on match.
 */
export async function validateApiKey(
  req: Request,
  projectId: string,
): Promise<{ valid: boolean; keyId?: string }> {
  const providedKey = getApiKey(req)
  if (!providedKey) return { valid: false }

  try {
    // Bounded query — a project should have <10 keys, but cap to prevent
    // an attacker who somehow inserts many keys from exhausting memory.
    const keys = await db.apiKey.findMany({
      where: { projectId },
      select: { id: true, key: true },
      take: 100,
    })
    for (const k of keys) {
      // Decrypt the stored key if it's in the encryption envelope format.
      // For rows created AFTER this hardening, `k.key` is the AES-256-GCM
      // blob (`iv:ciphertext:authTag`); decryption recovers the inner
      // `<hash>:<salt>` value that `keyMatches` then verifies against the
      // provided plaintext. For legacy rows created BEFORE this hardening
      // (either plaintext or already-hashed but un-encrypted), `k.key`
      // passes through unchanged so the same `keyMatches` path can handle
      // them during the rotation window.
      const stored = isEncryptedField(k.key) ? decryptField(k.key) : k.key
      // A failed decrypt yields "" — `keyMatches(providedKey, "")` returns
      // false (no `:` in "" and `providedKey !== ""`), so the row is
      // safely rejected. We still call `keyMatches` rather than `continue`
      // so the timing of the no-match branch is consistent with the
      // successful-decrypt no-match branch.
      if (keyMatches(providedKey, stored)) {
        // Best-effort lastUsed update; don't block or fail the request on it.
        void db.apiKey
          .update({
            where: { id: k.id },
            data: { lastUsed: new Date() },
          })
          .catch(() => {
            /* swallow — lastUsed is informational only */
          })
        return { valid: true, keyId: k.id }
      }
    }
    return { valid: false }
  } catch {
    return { valid: false }
  }
}

/**
 * Standard 401 response for protected endpoints.
 */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: "Unauthorized: valid API key required" },
    { status: 401 },
  )
}
