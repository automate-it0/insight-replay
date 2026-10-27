/**
 * App startup — bootstrap server-side background tasks AND assert that
 * required runtime secrets are present before the server starts handling
 * requests.
 *
 * Imported for its side effects by `src/app/layout.tsx`. Because ES
 * module evaluation is cached per process, the body below runs ONCE per
 * Node.js server process (not per request), which is exactly when we
 * want to (a) start long-running background jobs and (b) fail fast on
 * missing secrets — a misconfigured secret would otherwise let the
 * server boot and start serving requests with a publicly-known or empty
 * crypto key, which is the failure mode this module exists to prevent.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY BOOT-TIME SECRET ASSERTIONS (P1-A FIX)
 * ─────────────────────────────────────────────────────────────────────
 * Before this change, `src/lib/db-encryption.ts` derived its master
 * encryption key from `process.env.SESSION_SECRET || "dev-only-secret-..."`.
 * That fallback string is committed to the public repo, so any operator
 * who deployed without setting `SESSION_SECRET` got a master key that
 * was KNOWN TO THE WORLD — the field-level "encryption" was theatre, not
 * protection.
 *
 * `db-encryption.ts` now refuses that fallback (see its file header for
 * the in-module assertion). This `startup.ts` is the SECOND layer of
 * defense in depth: even if a future refactor of `db-encryption.ts`
 * accidentally re-introduced a silent fallback, the server boot would
 * STILL crash here on `assertSecret("SESSION_SECRET", ...)`. Two layers
 * must both regress before the original bug silently returns.
 *
 * We enforce unconditionally in production (the missing-secret case is
 * fatal — refuse to start the server) and LOG A WARNING in non-production
 * so local dev / test still boots without a `SESSION_SECRET` (using an
 * ephemeral in-memory key — see `db-encryption.ts`'s `resolveSessionSecret`
 * for how the dev path stays safe without a hardcoded constant).
 */

import { startAdminRadar } from "@/lib/admin-radar"

/**
 * Minimum acceptable length for any secret asserted via `assertSecret`.
 * 16 is a floor (not a recommendation) — operators are nudged toward 32+
 * in the error message and in `.env.example` / `scripts/generate-secret.sh`.
 * Below 16 the secret's entropy is too low to be a credible AES-256
 * master-key source even after PBKDF2 stretching.
 */
const MIN_SECRET_LENGTH = 16

/**
 * Publicly-known placeholder values that must NEVER be accepted as a
 * real secret, regardless of environment. These are the strings that
 * previous versions of this codebase hardcoded as dev fallbacks (so a
 * careless operator could set `SESSION_SECRET=dev-only-secret-do-not-use-in-prod`
 * in their prod env and still "boot" with a publicly-known key) plus a
 * few obvious placeholder sentinels. Rejecting them at boot closes that
 * regression window.
 *
 * Mirrored from `db-encryption.ts`'s `FORBIDDEN_SECRET_PLACEHOLDERS` —
 * deliberately duplicated (not imported) so that a regression in either
 * module cannot disable the check in the other. (DRY is the wrong
 * principle here; the threat model wants redundant, independent gates.)
 */
const FORBIDDEN_PLACEHOLDERS = new Set([
  "dev-only-secret-do-not-use-in-prod",
  "dev-only-key-do-not-use-in-prod",
  "changeme",
  "change-me",
  "secret",
  "placeholder",
])

/**
 * Assert that a required secret environment variable is set, non-empty,
 * non-placeholder, and long enough to provide meaningful entropy.
 *
 * Throws synchronously (no return value) on any failure — the caller
 * runs this at server boot, and a throw here crashes the boot before
 * any request is served. That is intentional: a server with no real
 * `SESSION_SECRET` has zero confidentiality for its DB at rest, and
 * failing fast is the only safe behavior.
 *
 * Behavior by NODE_ENV:
 *   - Production (`NODE_ENV === "production"`): always enforce — throw
 *     on missing / empty / placeholder / too-short. The server must
 *     not start with a broken crypto config.
 *   - Non-production: log a loud warning if the secret is missing or
 *     empty, but DO NOT throw — local dev / test workflows may not
 *     have `SESSION_SECRET` set in the environment, and crashing the
 *     dev server on every boot would make the dev experience hostile.
 *     The downstream modules (`db-encryption.ts`) handle the
 *     no-secret case in non-prod by generating an EPHEMERAL in-memory
 *     key per process (NOT a hardcoded constant) so the dev path is
 *     still safe.
 *
 * Placeholder values (the hardcoded "dev-only-..." strings and obvious
 * "changeme" sentinels) are rejected in ALL environments — a
 * placeholder is publicly known and breaks the threat model in any
 * environment where the DB is sensitive, including local dev DBs that
 * may contain real-looking test data.
 *
 * @param name  the env var name, e.g. "SESSION_SECRET" — used in error
 *              messages so the operator knows WHICH secret to fix.
 * @param value the env var value (typically `process.env.NAME`).
 *
 * @throws Error if production and the secret is missing / empty /
 *         placeholder / too short. In non-production, throws only on
 *         placeholder values (those are unsafe in any environment);
 *         missing/short secrets in non-production produce a warning.
 */
export function assertSecret(name: string, value: string | undefined): void {
  // Normalize: trim whitespace; treat undefined / empty-after-trim as
  // missing. Whitespace-only secrets are functionally missing and a
  // common copy-paste error (e.g. `SESSION_SECRET= ` in .env).
  const trimmed = typeof value === "string" ? value.trim() : ""
  const isProduction = process.env.NODE_ENV === "production"

  // ── Reject placeholder values in ALL environments ─────────────────
  // A placeholder is publicly known and provides zero security — there
  // is no environment in which accepting it is safe. This is the
  // strongest gate and fires before the missing/short checks so a
  // placeholder can't slip through as "present but weak".
  if (FORBIDDEN_PLACEHOLDERS.has(trimmed)) {
    throw new Error(
      `FATAL: ${name} is set to a publicly-known placeholder value ` +
        `("${trimmed}"). This string is committed to the public repo ` +
        `and provides zero security. Refusing to boot. Generate a real ` +
        `secret (see scripts/generate-secret.sh) and set it in the ` +
        `environment.`,
    )
  }

  // ── Missing / empty ──────────────────────────────────────────────
  if (trimmed.length === 0) {
    if (isProduction) {
      throw new Error(
        `FATAL: ${name} is not set in production. Refusing to boot ` +
          `with a missing secret. Set ${name} (>= 32 chars of ` +
          `high-entropy random data; see scripts/generate-secret.sh) ` +
          `in the environment before starting the server.`,
      )
    }
    // Non-production: warn but do not throw. Downstream modules
    // (db-encryption.ts) handle the no-secret case in non-prod by
    // generating an ephemeral in-memory key per process — which is
    // safe (never publicly known) but makes encrypted values unreadable
    // after restart. The warning surfaces the misconfiguration so the
    // operator notices before relying on the dev DB.
    console.warn(
      `[startup] WARNING: ${name} is not set in non-production. ` +
        `db-encryption.ts will use an EPHEMERAL in-memory key — encrypted ` +
        `DB values written under it will be UNREADABLE after the next ` +
        `restart. Set ${name} in .env.local to make the dev key stable.`,
    )
    return
  }

  // ── Too short ────────────────────────────────────────────────────
  if (trimmed.length < MIN_SECRET_LENGTH) {
    if (isProduction) {
      throw new Error(
        `FATAL: ${name} is too short (${trimmed.length} < ${MIN_SECRET_LENGTH} chars) ` +
          `for production use. Use a high-entropy secret of at least 32 ` +
          `characters (see scripts/generate-secret.sh).`,
      )
    }
    console.warn(
      `[startup] WARNING: ${name} is short ` +
        `(${trimmed.length} < ${MIN_SECRET_LENGTH} chars). Accepting in ` +
        `non-production only — strengthen before deploying.`,
    )
  }
}

// ─────────────────────────────────────────────────────────────────────
// Boot-time secret assertions. Runs ONCE per Node.js process because ES
// module evaluation is cached. Placed BEFORE the admin-radar start so
// that a missing production secret crashes the boot before any
// background timers are scheduled (cleaner failure mode — no orphaned
// timers to clean up on crash).
// ─────────────────────────────────────────────────────────────────────
assertSecret("SESSION_SECRET", process.env.SESSION_SECRET)

// The radar's own `_running` guard (see admin-radar.ts) makes
// startAdminRadar() idempotent — even if the module somehow evaluated
// twice (e.g. across a hot-reload in dev), the second call would no-op.
// All timers created by the radar are `.unref()`'d so they never keep
// the Node process alive on shutdown.
startAdminRadar()
