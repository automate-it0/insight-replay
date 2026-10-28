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
 *      HMAC-SHA256 under a server-side secret, stored version-prefixed
 *      as `"hmac:v1:<salt>:<mac>"` (CodeQL `js/insufficient-password-hash`
 *      fix — the previous fast `sha256(salt + key)` construction could be
 *      brute-forced offline from a stolen DB alone). `verifyApiKey()`
 *      dispatches on that version prefix: `hmac:v1:` values verify via the
 *      keyed HMAC; anything else falls back to the legacy
 *      `"<hash>:<salt>"` path so keys stored before the upgrade keep
 *      verifying (backward compatibility — existing API keys must NOT
 *      break). Legacy plaintext keys (pre-hardening) are matched by direct
 *      equality via `keyMatches` during the rotation window documented in
 *      `docs/security-audit.md`. When a legacy-format key authenticates and
 *      the HMAC secret is env-sourced (not the dev-ephemeral fallback),
 *      `validateApiKey` transparently rewrites the row in the v1 format.
 *      All comparisons are length-checked byte-wise compares to avoid an
 *      early-exit timing leak.
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
import { createHash, createHmac, randomBytes, scryptSync } from "crypto"
import {
  decryptField,
  encryptField,
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

// ─── Keyed-hash (v1) at-rest key storage ─────────────────────────────────
//
// CodeQL `js/insufficient-password-hash`: hashing API-key material with a
// single fast SHA-256 pass — even per-key salted — lets an attacker who
// exfiltrates the stored values test candidate keys offline at GPU speeds
// (billions of guesses/second). v1 replaces it with a KEYED construction:
// HMAC-SHA256 under a server-side secret. A stolen DB file alone is now
// useless for confirming guessed keys — the attacker additionally needs
// the server secret.
//
// (Why not scrypt, as `hashPassword` in src/lib/session.ts uses for user
// passwords? `validateApiKey` verifies the presented key against up to 100
// stored rows per request; 100 × scrypt (~50–100ms each) would make every
// authenticated request take seconds. API keys are high-entropy (122
// random bits from `randomUUID`), so the keyed construction is the right
// speed/security point: fast per-op, infeasible offline without the
// secret — the offline-guessing resistance a slow KDF buys for
// low-entropy passwords is unnecessary at 122 bits.)
//
// Secret resolution follows the fail-closed pattern already used by
// `src/lib/session.ts` (`SESSION_SECRET`) and `src/lib/db-encryption.ts`:
//   - prefer a dedicated `API_KEY_HMAC_SECRET` (rotate it independently of
//     session cookies / DB encryption),
//   - fall back to `SESSION_SECRET` (mandatory in production anyway —
//     startup.ts, session.ts and db-encryption.ts all refuse to boot
//     without it, so no currently-booting deployment can hit the throw
//     below),
//   - in non-production with neither set, use an EPHEMERAL per-process
//     random key (same dev-ergonomics tradeoff db-encryption documents:
//     values hashed under it stop verifying after a restart, which forces
//     developers to configure the secret instead of shipping an
//     unconfigured one).
//
// The resolved secret is stretched into a 32-byte HMAC key with scrypt + a
// fixed domain-separation salt (same derivation pattern as
// `ENCRYPTION_KEY` in src/lib/crypto.ts), so even when API-key hashing
// falls back to `SESSION_SECRET`, it derives a DIFFERENT key than session
// signing or field encryption — one leaked derived key does not
// compromise the other constructions.

/** scrypt salt for deriving the API-key HMAC key (domain separation). */
const API_KEY_HMAC_SALT = "insight-replay-apikey-hmac-v1"

/**
 * Publicly-known placeholder secrets that must never silently become the
 * HMAC key (mirrors `FORBIDDEN_SECRET_PLACEHOLDERS` in db-encryption.ts —
 * these exact strings are committed to the public repo, so an operator who
 * deploys with one of them gets no security at all).
 */
const FORBIDDEN_HMAC_SECRETS = new Set([
  "dev-only-secret-do-not-use-in-prod",
  "dev-only-key-do-not-use-in-prod",
  "changeme",
])

function resolveApiKeyHmacKey(): { key: Buffer; ephemeral: boolean } {
  const raw = process.env.API_KEY_HMAC_SECRET || process.env.SESSION_SECRET
  if (!raw || FORBIDDEN_HMAC_SECRETS.has(raw)) {
    if (process.env.NODE_ENV === "production") {
      // Fail-closed, loud by design — see the block comment above. This
      // is unreachable for any deployment that currently boots (they all
      // already require SESSION_SECRET at boot), so it adds no new
      // breakage — it only makes a misconfigured future deployment crash
      // at load instead of silently persisting fast-hashed credentials.
      throw new Error(
        "API_KEY_HMAC_SECRET (or SESSION_SECRET) is not set — refusing to " +
          "boot in production without an HMAC key for at-rest API-key " +
          "hashing. Set API_KEY_HMAC_SECRET in the environment (see " +
          "scripts/generate-secret.sh).",
      )
    }
    // Dev/test-only ephemeral fallback. `ephemeral: true` disables the
    // transparent legacy→v1 rewrite in `validateApiKey` — upgrading a row
    // under a key that changes on restart would brick a working key.
    return { key: randomBytes(32), ephemeral: true }
  }
  return { key: scryptSync(raw, API_KEY_HMAC_SALT, 32), ephemeral: false }
}

const API_KEY_HMAC = resolveApiKeyHmacKey()

/** Version prefix for the v1 keyed-hash storage format. */
const HMAC_V1_PREFIX = "hmac:v1:"

/**
 * Hash an API key for storage at rest — v1 keyed construction.
 *
 * Returns `"hmac:v1:<salt>:<mac>"` (both parts hex): a fresh 16-byte
 * per-key random salt plus HMAC-SHA256(serverSecret, salt + key). The
 * per-key salt is kept from the legacy scheme so identical keys never
 * produce identical stored values, and the keyed MAC means a DB dump
 * alone cannot be brute-forced offline. The plaintext key is
 * intentionally unrecoverable from this value.
 *
 * Storage strategy (no schema change required):
 *   - On CREATE: generate plaintext `ir_<random>`, store `hashApiKey(plaintext)`
 *     in the existing `key` column, return the plaintext to the caller ONCE.
 *   - On VALIDATE: fetch all apikeys for the project (small N — usually <10),
 *     loop through, and call `verifyApiKey(providedKey, stored.key)` for each.
 *   - On GET (list): return `keyMasked` only — we no longer have the plaintext.
 *
 * Legacy values (pre-v1) are still verified — see `verifyApiKey` — and are
 * transparently upgraded to this format by `validateApiKey` on the next
 * successful authentication (when the HMAC secret is env-sourced).
 */
export function hashApiKey(key: string): string {
  const salt = randomBytes(16).toString("hex")
  const mac = createHmac("sha256", API_KEY_HMAC.key)
    .update(salt + key, "utf8")
    .digest("hex")
  return `${HMAC_V1_PREFIX}${salt}:${mac}`
}

/**
 * Verify a plaintext key against a stored value produced by `hashApiKey`
 * (any version). Dispatches on the stored value's version prefix:
 *
 *   - `"hmac:v1:<salt>:<mac>"` → recompute the keyed HMAC and compare.
 *   - `"<hash>:<salt>"` (legacy, pre-v1) → recompute the legacy fast hash
 *     and compare. Kept so keys hashed before the upgrade keep verifying —
 *     existing API keys must not break (the CodeQL fix is backward
 *     compatible by contract); new values never take this path, and legacy
 *     rows are rewritten to v1 by `validateApiKey` on successful auth.
 *   - (Values without a `:` are legacy plaintext rows — handled by
 *     `keyMatches`, not here.)
 *
 * Returns false on malformed input.
 */
export function verifyApiKey(plaintextKey: string, stored: string): boolean {
  // v1 keyed format: "hmac:v1:<salt>:<mac>".
  if (stored.startsWith(HMAC_V1_PREFIX)) {
    const rest = stored.slice(HMAC_V1_PREFIX.length)
    const sep = rest.indexOf(":")
    if (sep <= 0 || sep >= rest.length - 1) return false
    const salt = rest.slice(0, sep)
    const mac = rest.slice(sep + 1)
    const computed = createHmac("sha256", API_KEY_HMAC.key)
      .update(salt + plaintextKey, "utf8")
      .digest("hex")
    return fixedTimeHexEqual(computed, mac)
  }

  // Legacy "<hash>:<salt>" format (verification-only compatibility path).
  const sep = stored.indexOf(":")
  if (sep <= 0 || sep >= stored.length - 1) return false
  const hash = stored.slice(0, sep)
  const salt = stored.slice(sep + 1)
  const computed = createHash("sha256").update(salt + plaintextKey).digest("hex")
  return fixedTimeHexEqual(computed, hash)
}

/**
 * Length-checked byte-wise compare (no early exit), shared by the v1 and
 * legacy verification paths. Constant-time is not strictly required here:
 * the salt is per-key random and the value under comparison is itself the
 * secret-derived digest an attacker would need to already know to exploit
 * a timing leak — but a constant-shape loop costs nothing, so we keep it.
 */
function fixedTimeHexEqual(computed: string, stored: string): boolean {
  if (computed.length !== stored.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ stored.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Match a plaintext key against a stored value, supporting ALL stored
 * formats: the v1 keyed `"hmac:v1:<salt>:<mac>"` format, the legacy
 * `"<hash>:<salt>"` format, and the legacy plaintext format (which
 * contains no colon). The first two both contain a colon and are routed
 * to `verifyApiKey`, which dispatches on the version prefix. Used by
 * `validateApiKey` for backward compatibility during the rotation window.
 */
function keyMatches(plaintext: string, stored: string): boolean {
  if (stored.startsWith(HMAC_V1_PREFIX) || stored.includes(":")) {
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
 * Implementation note: because keys are stored as one-way hashes — v1
 * `"hmac:v1:<salt>:<mac>"` for new rows, legacy `<hash>:<salt>` for
 * pre-upgrade rows — and NOW additionally wrapped in an `iv:ciphertext:
 * authTag` encryption envelope (see src/lib/db-encryption.ts), we cannot do
 * an indexed `findFirst` on the `key` column. Instead we fetch all keys for
 * the project (small N — usually
 * <10) and run `verifyApiKey` in a loop. The first match wins. For each row
 * we first decrypt the stored `key` (if it's in encrypted format) to recover
 * the underlying hash value (v1 or legacy), then call `keyMatches(providedKey, …)`.
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
      // v1 `hmac:v1:<salt>:<mac>` (or legacy `<hash>:<salt>`) value that
      // `keyMatches` then verifies against the provided plaintext. For
      // legacy rows created BEFORE this hardening (either plaintext or
      // already-hashed but un-encrypted), `k.key` passes through unchanged
      // so the same `keyMatches` path can handle them during the rotation
      // window.
      const stored = isEncryptedField(k.key) ? decryptField(k.key) : k.key
      // A failed decrypt yields "" — `keyMatches(providedKey, "")` returns
      // false (no `:` in "" and `providedKey !== ""`), so the row is
      // safely rejected. We still call `keyMatches` rather than `continue`
      // so the timing of the no-match branch is consistent with the
      // successful-decrypt no-match branch.
      if (keyMatches(providedKey, stored)) {
        // Transparent legacy→v1 upgrade: if the matched row is still in a
        // pre-v1 format (legacy hash OR pre-hardening plaintext) and the
        // HMAC key is stable (env-sourced, not the dev-ephemeral fallback),
        // rewrite the stored value as `encryptField(hashApiKey(providedKey))`
        // — the v1 keyed hash inside a fresh AES-256-GCM envelope. This
        // migrates the fleet one successful authentication at a time, with
        // no operator action and no public-signature change. It rides the
        // same fire-and-forget update as `lastUsed`; a failed upgrade must
        // never block or fail the request — the legacy value keeps
        // verifying on the next request anyway. Skipped when the HMAC key
        // is ephemeral (dev without a configured secret): an upgrade
        // written under a per-process random key would stop verifying after
        // restart — i.e. it would brick a previously-working key, violating
        // the "existing keys must keep verifying" contract. Likewise
        // `encryptField` returning "" (encryption failure) skips the
        // rewrite — never clobber a working stored value with garbage.
        const upgraded =
          !stored.startsWith(HMAC_V1_PREFIX) && !API_KEY_HMAC.ephemeral
            ? encryptField(hashApiKey(providedKey))
            : ""
        // Best-effort lastUsed update (+ one-time format upgrade); don't
        // block or fail the request on it.
        void db.apiKey
          .update({
            where: { id: k.id },
            data: {
              lastUsed: new Date(),
              ...(upgraded ? { key: upgraded } : {}),
            },
          })
          .catch(() => {
            /* swallow — lastUsed/upgrade are informational only */
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
