/**
 * Insight Replay — Field-level encryption-at-rest for the SQLite database.
 *
 * WHY THIS EXISTS
 * ---------------
 * The application stores sensitive PII / credentials (user emails, password
 * hashes, API key hashes, etc.) in `custom.db` (SQLite). SQLite is a single
 * file on disk — anyone with filesystem access can read every column in
 * cleartext. SQLCipher would solve this transparently but breaks Prisma's
 * SQLite driver pipeline. Instead we encrypt sensitive fields at the
 * application layer BEFORE they hit the DB, and decrypt them on the way out.
 *
 * CIPHER: AES-256-GCM — authenticated encryption. GCM produces both a
 * ciphertext AND an authentication tag; on decrypt, the tag is verified
 * before any plaintext is released. Tampering with the ciphertext, IV, or
 * auth tag (e.g. by editing the SQLite file directly) causes
 * `decryptField` to return "" rather than yield corrupted output. This
 * gives us both:
 *   - Confidentiality: the ciphertext is meaningless without the key.
 *   - Integrity: any tampering is detected (auth-tag mismatch) and
 *     rejected, so an attacker cannot silently flip bits to swap one
 *     stored hash for another.
 *
 * KEY DERIVATION: PBKDF2 with HMAC-SHA256, 100,000 iterations, on the
 * application secret `SESSION_SECRET` with the fixed salt
 * `"insight-replay-salt"`, producing a 32-byte AES-256 key. PBKDF2 is
 * deliberately slow (~50–100ms on commodity hardware for 100k iterations)
 * which makes brute-forcing the key from a stolen DB + a known-plaintext
 * guess far more expensive than a single SHA-256 pass. The key is derived
 * ONCE at module load — PBKDF2 is the slow step, and re-deriving per call
 * would dominate CPU and serialise every DB write.
 *
 * ─────────────────────────────────────────────────────────────────────
 * SECRET SOURCE — NO SILENT HARDCODED FALLBACK (P1-A FIX)
 * ─────────────────────────────────────────────────────────────────────
 * Previous versions of this module derived the master key from a hardcoded
 * string ("dev-only-secret-do-not-use-in-prod") when `SESSION_SECRET` was
 * absent. That string is committed to the public repo, so any operator who
 * deployed without setting `SESSION_SECRET` got an encryption key that was
 * KNOWN TO THE WORLD — the encryption was theatre, not protection.
 *
 * We now refuse that failure mode:
 *   - In production (`NODE_ENV === "production"`), an unset / empty /
 *     placeholder `SESSION_SECRET` THROWS at module load. The server will
 *     not boot. This is loud-by-design: a deployment with no real secret
 *     has zero security and should fail fast instead of silently
 *     persisting "encrypted" data that anyone with the source can read.
 *   - Outside production (local dev, test), we no longer fall back to a
 *     hardcoded constant either — instead we generate an EPHEMERAL
 *     per-process random key via `crypto.randomBytes(32)`. This means:
 *       * Dev DBs are still usable for the lifetime of one process.
 *       * Any encrypted value written under the ephemeral key becomes
 *         UNREADABLE after the next restart — which forces developers to
 *         notice the misconfiguration rather than ship a "works on my
 *         machine" database to prod. (Setting `SESSION_SECRET` in
 *         `.env.local` makes the dev key stable across restarts.)
 *       * The key is never publicly known, so a dev DB dump does not
 *         match any value an attacker could compute from the source.
 *   - `startup.ts` independently asserts `SESSION_SECRET` at boot via
 *     `assertSecret` — defense in depth so the failure is caught at TWO
 *     layers (startup assertion + module-load derivation) and a regression
 *     in either layer does not silently re-enable a public key.
 *
 * STORAGE FORMAT (legacy single-key — kept for backward compatibility with
 * existing DB rows): every encrypted value is stored as the string
 * `"iv:ciphertext:authTag"` with each part hex-encoded. The IV is 12 bytes
 * (GCM standard nonce size), freshly random for every call. The auth tag
 * is 16 bytes (GCM default). The random IV means the SAME plaintext
 * encrypts to a DIFFERENT ciphertext on every call — so two users with the
 * same email do NOT produce matching ciphertexts, and a DB dump reveals
 * nothing about plaintext equality.
 *
 * ─────────────────────────────────────────────────────────────────────
 * ENVELOPE ENCRYPTION (P1-A ADDITION)
 * ─────────────────────────────────────────────────────────────────────
 * The legacy format above encrypts every row under the SAME master key
 * (the KEK, derived from `SESSION_SECRET`). That has two operational
 * drawbacks:
 *   1. Key rotation requires re-encrypting EVERY row's ciphertext with
 *      the new master key — an O(N) full-DB rewrite that is slow on
 *      large tables and risky (a partial failure leaves the DB half-
 *      migrated and unreadable).
 *   2. Every row shares a single key, so a single crypto primitive slip
 *      (e.g. a side-channel on one row's GCM tag check) effectively
 *      compromises the entire column.
 *
 * Envelope encryption fixes both: each row gets its OWN fresh random
 * Data Encryption Key (DEK, 32 bytes) used to encrypt that row's
 * plaintext. The DEK is then WRAPPED (encrypted) under the master KEK
 * and stored alongside the ciphertext. To decrypt a row, you unwrap the
 * DEK with the KEK, then decrypt the ciphertext with the DEK. This gives:
 *   - Per-row key isolation — compromising one row's DEK does NOT reveal
 *     any other row's plaintext.
 *   - Cheap key rotation — to rotate the master KEK, you only need to
 *     UNWRAP each row's DEK with the old KEK and RE-WRAP it with the new
 *     KEK. The bulk ciphertext (the expensive part for large fields like
 *     blobs) is never re-encrypted; only the small (32-byte) DEK is.
 *   - Future KMS integration — a managed KMS can wrap/unwrap DEKs while
 *     the bulk ciphertext stays in the application's DB; rotating the
 *     KMS master key is then a metadata-only migration.
 *
 * Envelope storage format:
 *   `v2:<wrapIV>:<wrappedDEK>:<wrapAuthTag>:<iv>:<ciphertext>:<authTag>`
 * all parts hex-encoded. The leading `v2:` prefix and the 7-part shape
 * make it trivially distinguishable from the legacy 3-part
 * `iv:ciphertext:authTag` format — callers can use `isEnvelopeField` /
 * `isEncryptedField` to route a stored value to the right decryptor and
 * to handle legacy plaintext rows uniformly during a gradual rollout.
 *
 * The wrapped DEK is exactly 32 bytes (256 bits) because the DEK is
 * 32 bytes of AES-256 key material and GCM does not expand ciphertext
 * (it only appends a 16-byte auth tag). `isEnvelopeField` checks this
 * fixed length to reject malformed values up-front without entering a
 * try/catch.
 *
 * RANDOM IV + UNIQUE CONSTRAINTS: because the same plaintext encrypts
 * differently each time, a `@unique` DB constraint on an encrypted column
 * no longer enforces plaintext uniqueness at the DB level. The application
 * layer is responsible for ensuring plaintext uniqueness (e.g. the setup
 * route refuses to create a second admin via `count() === 0` + a
 * `bootstrapLock @unique` mutex on a separate column). For login lookups
 * the email column becomes un-searchable by direct equality, so the login
 * route fetches all users (small N — single-admin system) and runs a
 * decrypt-then-compare loop.
 *
 * ERROR HANDLING: `decryptField` / `decryptFieldEnvelope` return `""` on
 * ANY failure (wrong key, tampered ciphertext, malformed format,
 * non-encrypted legacy value). Returning an empty string rather than
 * throwing matches the requested contract: failed decrypts do not crash
 * the request, they yield an empty value that downstream validation can
 * reject (`verifyPassword` returns false on a stored hash of `""`; an
 * email comparison against `""` fails). `encryptField` /
 * `encryptFieldEnvelope` likewise return `""` on failure — a failure here
 * surfaces as an authentication error rather than a silent plaintext leak
 * to disk.
 */
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from "crypto"

const ALGORITHM = "aes-256-gcm"
const PBKDF2_ITERATIONS = 100_000
const KEY_LENGTH = 32 // 256-bit key for AES-256
const SALT = "insight-replay-salt"
const IV_LENGTH = 12 // GCM standard nonce size
const AUTH_TAG_LENGTH = 16 // GCM default auth tag length
const DEK_LENGTH = 32 // 256-bit per-row Data Encryption Key

// Publicly-known placeholder values that must NEVER silently become the
// encryption key. These are the strings that previous versions of this
// module (and its sibling crypto.ts) hardcoded as dev fallbacks, so a
// careless operator could set `SESSION_SECRET=dev-only-secret-do-not-use-in-prod`
// in their prod env and still "boot" with a publicly-known key. Rejecting
// them at module load closes that regression window.
const FORBIDDEN_SECRET_PLACEHOLDERS = new Set([
  "dev-only-secret-do-not-use-in-prod",
  "dev-only-key-do-not-use-in-prod",
  "changeme",
  "change-me",
  "secret",
  "placeholder",
])

/**
 * Resolve the master-key source material from `SESSION_SECRET`.
 *
 * - Production: throw if unset / empty / placeholder / too short. The
 *   server must not boot with a publicly-known or trivially-guessable
 *   master key, because that defeats the entire purpose of field-level
 *   encryption (anyone with the source can derive the same key and read
 *   the DB).
 * - Non-production: when `SESSION_SECRET` is unset, generate an EPHEMERAL
 *   32-byte random key (NOT a hardcoded constant). This key is held only
 *   in memory for the lifetime of this process — it is never persisted,
 *   never committed, and never the same across restarts. Any encrypted
 *   value written under it becomes unreadable after the next restart,
 *   which forces developers to notice the misconfiguration rather than
 *   ship a "works on my machine" database to prod. Setting
 *   `SESSION_SECRET` in `.env.local` makes the dev key stable.
 *
 * The warning is logged ONCE at module load (not per-call) so the dev
 * console is not spammed but the operator still sees the notice.
 *
 * This function is the SINGLE chokepoint for secret resolution; both the
 * legacy `ENCRYPTION_KEY` derivation and the envelope `MASTER_KEY`
 * derivation flow through it, so a future tightening (e.g. requiring a
 * min entropy) only needs to happen here.
 */
function resolveSessionSecret(): string {
  const envValue = process.env.SESSION_SECRET
  const trimmed =
    typeof envValue === "string" ? envValue.trim() : ""
  const isProduction = process.env.NODE_ENV === "production"

  // Reject empties.
  if (trimmed.length === 0) {
    if (isProduction) {
      throw new Error(
        "FATAL: SESSION_SECRET is not set in production. Refusing to " +
          "derive the database master encryption key from a publicly-known " +
          "fallback. Set SESSION_SECRET (>= 32 chars of high-entropy random " +
          "data; see scripts/generate-secret.sh) before booting the server.",
      )
    }
    // Dev/test only: ephemeral per-process random key. NOT a hardcoded
    // constant — so the value is never publicly known and a dev DB dump
    // cannot be matched against any value an attacker could compute from
    // the public source.
    console.warn(
      "[db-encryption] WARNING: SESSION_SECRET is unset in non-production. " +
        "Generating an EPHEMERAL in-memory master key for this process. " +
        "Any encrypted value written under it will be UNREADABLE after the " +
        "next restart. Set SESSION_SECRET in .env.local to make the dev " +
        "key stable.",
    )
    return randomBytes(32).toString("hex")
  }

  // Reject publicly-known placeholders regardless of NODE_ENV — a
  // placeholder value is publicly known and breaks the threat model in
  // any environment where the DB is sensitive.
  if (FORBIDDEN_SECRET_PLACEHOLDERS.has(trimmed)) {
    throw new Error(
      `FATAL: SESSION_SECRET is set to a publicly-known placeholder ` +
        `("${trimmed}"). Refusing to derive the database master ` +
        `encryption key from a value present in the public repo. Generate ` +
        `a real secret (see scripts/generate-secret.sh) and set it in ` +
        `the environment before booting.`,
    )
  }

  // Reject secrets that are too short to provide meaningful entropy.
  // 16 is a floor — operators are nudged toward 32 in the error message.
  if (trimmed.length < 16) {
    if (isProduction) {
      throw new Error(
        `FATAL: SESSION_SECRET is too short (${trimmed.length} < 16 chars) ` +
          `for production use. Use a high-entropy secret of at least 32 ` +
          `characters (see scripts/generate-secret.sh).`,
      )
    }
    console.warn(
      `[db-encryption] WARNING: SESSION_SECRET is short ` +
        `(${trimmed.length} < 16 chars). Accepting in non-production only.`,
    )
  }

  return trimmed
}

// Derive the 32-byte AES master key (KEK) from `SESSION_SECRET` once at
// module load. PBKDF2 is intentionally slow; deriving per-call would
// dominate CPU and serialise all DB writes. If the secret changes
// (e.g. operator rotates `SESSION_SECRET`), all previously-encrypted DB
// values become undecryptable — by design (key rotation requires a
// re-encrypt migration, which is the operator's responsibility; for
// envelope-encrypted rows, only the DEK wraps need re-encryption, see
// `encryptFieldEnvelope`).
const SECRET = resolveSessionSecret()
const ENCRYPTION_KEY = pbkdf2Sync(
  SECRET,
  SALT,
  PBKDF2_ITERATIONS,
  KEY_LENGTH,
  "sha256",
)

// The envelope master key is the SAME 32-byte derived key as the legacy
// single-key path. We expose it under a distinct name here purely for
// readability at the envelope call sites — `MASTER_KEY` makes the
// envelope/wrapping intent obvious in a way `ENCRYPTION_KEY` does not.
// Both refer to the same underlying buffer; PBKDF2 is run ONCE.
const MASTER_KEY = ENCRYPTION_KEY

/**
 * Encrypt a plaintext string for storage in the DB. Returns the string
 * `"iv:ciphertext:authTag"` (all parts hex). Each call produces a unique
 * ciphertext for the same plaintext because a fresh 12-byte IV is drawn
 * from `crypto.randomBytes` every time.
 *
 * Legacy single-key format — kept for backward compatibility with
 * existing DB rows. New call sites that want per-row key isolation +
 * cheap key rotation should prefer `encryptFieldEnvelope`.
 *
 * Safe to call with an empty string — produces a valid (non-empty)
 * encrypted blob that round-trips through `decryptField` back to "".
 *
 * Returns "" on any internal failure (extremely unlikely with valid inputs
 * and a derived key, but we fail closed so a never-happen error does NOT
 * silently persist plaintext to disk — callers that detect a "" stored
 * value will reject the row at the validation step).
 */
export function encryptField(plaintext: string): string {
  if (typeof plaintext !== "string") return ""
  try {
    const iv = randomBytes(IV_LENGTH)
    // authTagLength pinned explicitly — the same value Node would default
    // to and the exact length decryptField's `AUTH_TAG_LENGTH * 2` hex
    // check expects. Declarative only; output format is unchanged.
    const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv, { authTagLength: AUTH_TAG_LENGTH })
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ])
    const authTag = cipher.getAuthTag()
    return `${iv.toString("hex")}:${ciphertext.toString("hex")}:${authTag.toString("hex")}`
  } catch {
    // Fail closed: an empty return causes the caller to write "" to the DB
    // rather than accidentally persist the plaintext. Downstream code
    // paths treat "" stored values as invalid and reject the row.
    return ""
  }
}

/**
 * Decrypt a value produced by `encryptField`. Returns the plaintext on
 * success, or "" on ANY failure (wrong key, tampered ciphertext, malformed
 * format, non-encrypted legacy value, etc.).
 *
 * The "return '' on failure" contract lets callers handle BOTH new
 * (encrypted) and legacy (plaintext) rows uniformly: try to decrypt; if
 * the result is "" the caller knows to fall back to treating the stored
 * value as legacy plaintext (see `isEncryptedField` for the up-front
 * format check that callers can use to avoid even attempting decrypt on
 * rows that obviously aren't encrypted).
 *
 * GCM integrity check: `decipher.final()` throws if the auth tag does not
 * verify — this is the integrity guarantee. Tampered ciphertext is
 * rejected, no partial plaintext is released.
 */
export function decryptField(encrypted: string): string {
  if (typeof encrypted !== "string" || encrypted.length === 0) return ""
  const parts = encrypted.split(":")
  if (parts.length !== 3) return ""
  const [ivHex, ciphertextHex, authTagHex] = parts
  // Hex-length sanity. 12-byte IV → 24 hex chars; 16-byte auth tag → 32
  // hex chars. Rejecting wrong lengths early avoids creating Buffers that
  // would throw inside `createDecipheriv` / `setAuthTag` and lets us
  // return "" cleanly without entering the try/catch.
  if (
    ivHex.length !== IV_LENGTH * 2 ||
    authTagHex.length !== AUTH_TAG_LENGTH * 2 ||
    ciphertextHex.length === 0 ||
    ciphertextHex.length % 2 !== 0
  ) {
    return ""
  }
  try {
    const iv = Buffer.from(ivHex, "hex")
    const ciphertext = Buffer.from(ciphertextHex, "hex")
    const authTag = Buffer.from(authTagHex, "hex")
    // authTagLength pinned: the decipher itself refuses auth tags of any
    // other length, so a truncated tag cannot be verified (GCM forgery /
    // CWE-310). Redundant with the `AUTH_TAG_LENGTH * 2` hex check above
    // by design — defense in depth at the primitive itself.
    const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    })
    decipher.setAuthTag(authTag)
    // `final()` throws if the auth tag does not verify — the integrity
    // guarantee. The catch below converts that to a "" return so callers
    // get the documented "fail closed" behavior on tampering.
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])
    return plaintext.toString("utf8")
  } catch {
    return ""
  }
}

/**
 * Check whether a stored value looks like an `encryptField` output
 * (three hex parts separated by colons, with IV and authTag at the
 * expected byte lengths). Used by code paths that need to handle BOTH
 * legacy plaintext rows and new encrypted rows during a gradual rollout
 * — e.g. `validateApiKey` in src/lib/auth.ts, which must decide whether
 * to decrypt `k.key` before calling `keyMatches`.
 *
 * This is a SHAPE check only — it does NOT verify the auth tag. A value
 * that passes `isEncryptedField` but fails `decryptField` is either
 * tampered or was encrypted under a different key.
 *
 * The ciphertext part may be empty (an encryptField("") produces
 * `<iv>::<authTag>` because GCM emits zero ciphertext bytes for a
 * zero-byte plaintext — that round-trips correctly through decryptField).
 * Allowing empty ciphertext lets isEncryptedField correctly recognize
 * encrypted empty-plaintext values while still rejecting malformed inputs
 * (the IV and authTag byte lengths are fixed and checked exactly).
 *
 * NOTE: this returns FALSE for envelope-format values (`v2:...`) — use
 * `isEnvelopeField` for those. The two formats are intentionally
 * distinguishable by shape so a caller can route a stored value to the
 * correct decryptor without parsing ambiguity.
 */
export function isEncryptedField(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  // Envelope values start with "v2:" — do not misclassify them as legacy
  // single-key outputs (they have a different part count and would fail
  // the 3-part split below anyway, but bailing early is clearer).
  if (value.startsWith("v2:")) return false
  const parts = value.split(":")
  if (parts.length !== 3) return false
  const [ivHex, ciphertextHex, authTagHex] = parts
  return (
    ivHex.length === IV_LENGTH * 2 &&
    authTagHex.length === AUTH_TAG_LENGTH * 2 &&
    ciphertextHex.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(ivHex) &&
    /^[0-9a-f]*$/i.test(ciphertextHex) &&
    /^[0-9a-f]+$/i.test(authTagHex)
  )
}

// ─────────────────────────────────────────────────────────────────────
// Envelope encryption (P1-A). Master key (KEK) wraps per-row data keys
// (DEKs). See the file header for the threat-model rationale.
// ─────────────────────────────────────────────────────────────────────

const ENVELOPE_PREFIX = "v2:"
const ENVELOPE_PART_COUNT = 7 // v2 + wrapIV + wrappedDEK + wrapAuthTag + iv + ciphertext + authTag

/**
 * Encrypt a plaintext string under a FRESH per-row data key, then wrap
 * (encrypt) that data key under the master key. Returns the string
 * `"v2:<wrapIV>:<wrappedDEK>:<wrapAuthTag>:<iv>:<ciphertext:<authTag>"`,
 * all parts hex.
 *
 * Threat-model benefits vs. the legacy `encryptField`:
 *   - Per-row DEK isolation: a compromise of one row's DEK (e.g. via a
 *     future GCM nonce-reuse bug or a side channel on that row's wrap
 *     call) does NOT reveal any other row's plaintext, because every
 *     row has its own fresh 32-byte DEK drawn from `crypto.randomBytes`.
 *   - Cheap key rotation: to rotate the master KEK you only need to
 *     unwrap each row's DEK with the old KEK and re-wrap it with the
 *     new KEK. The bulk ciphertext (the expensive part for large
 *     fields) is never re-encrypted — only the small 32-byte DEK is.
 *     See `unwrapDek` / `wrapDek` (not exported) for the building blocks
 *     a future migration script would use.
 *
 * The wrapped DEK is exactly 32 bytes (DEK_LENGTH) — AES-GCM does not
 * expand ciphertext, only appends a 16-byte auth tag. The wrap IV and
 * the data IV are BOTH freshly random per call; reusing either across
 * rows would be a GCM nonce-reuse disaster (key recovery), so each is
 * drawn independently from `crypto.randomBytes`.
 *
 * Returns "" on any internal failure so callers fail closed (an empty
 * stored value is rejected at the validation step downstream, rather
 * than silently persisting plaintext to disk). The catch is defensive —
 * with a valid derived MASTER_KEY and well-formed inputs, none of the
 * crypto primitives throw.
 */
export function encryptFieldEnvelope(plaintext: string): string {
  if (typeof plaintext !== "string") return ""
  try {
    // 1. Fresh per-row DEK (32 bytes of AES-256 key material).
    const dek = randomBytes(DEK_LENGTH)

    // 2. Wrap the DEK under the master KEK (AES-256-GCM). The wrap IV
    //    is freshly random — NEVER reused across rows, because GCM
    //    nonce reuse under the same key is catastrophic (key recovery
    //    via XOR of ciphertexts).
    const wrapIv = randomBytes(IV_LENGTH)
    // authTagLength pinned explicitly (Node's default and the length
    // decryptFieldEnvelope's hex check expects) — the stored envelope
    // format is unchanged.
    const wrapCipher = createCipheriv(ALGORITHM, MASTER_KEY, wrapIv, {
      authTagLength: AUTH_TAG_LENGTH,
    })
    const wrappedDek = Buffer.concat([
      wrapCipher.update(dek),
      wrapCipher.final(),
    ])
    const wrapAuthTag = wrapCipher.getAuthTag()

    // 3. Encrypt the row's plaintext under the per-row DEK (NOT under
    //    the master key). The data IV is freshly random and independent
    //    from the wrap IV.
    const dataIv = randomBytes(IV_LENGTH)
    // authTagLength pinned explicitly, matching the wrap cipher above —
    // no format change (Node's default is 16).
    const dataCipher = createCipheriv(ALGORITHM, dek, dataIv, { authTagLength: AUTH_TAG_LENGTH })
    const ciphertext = Buffer.concat([
      dataCipher.update(plaintext, "utf8"),
      dataCipher.final(),
    ])
    const dataAuthTag = dataCipher.getAuthTag()

    // 4. Zero the DEK buffer. Node's Buffer is not zeroed on GC, so an
    //    in-memory snapshot of the process could otherwise recover DEKs
    //    for rows long after the encrypt call returned. Best-effort —
    //    a determined heap-snapshot attacker can still race the write,
    //    but this raises the bar.
    dek.fill(0)

    return (
      `v2:${wrapIv.toString("hex")}:${wrappedDek.toString("hex")}:` +
      `${wrapAuthTag.toString("hex")}:${dataIv.toString("hex")}:` +
      `${ciphertext.toString("hex")}:${dataAuthTag.toString("hex")}`
    )
  } catch {
    // Fail closed — see encryptField's catch for the rationale. An empty
    // stored value is rejected downstream rather than leaking plaintext.
    return ""
  }
}

/**
 * Decrypt a value produced by `encryptFieldEnvelope`. Two-layer unwrap:
 *   1. Unwrap the per-row DEK with the master KEK (AES-256-GCM).
 *   2. Decrypt the row's ciphertext with the unwrapped DEK.
 *
 * Both layers verify their own GCM auth tag — `final()` throws on any
 * tampering, and the catch converts that to a "" return so callers get
 * the documented "fail closed" behavior. A tampered wrap tag, a tampered
 * data tag, or a tampered ciphertext all produce "" rather than partial
 * or corrupted plaintext.
 *
 * Returns "" on ANY failure (wrong master key, tampered wrap or data
 * ciphertext, malformed format, non-envelope legacy value, etc.). The
 * "return '' on failure" contract matches `decryptField` so callers can
 * handle envelope, legacy single-key, and plaintext rows uniformly: try
 * `isEnvelopeField` / `isEncryptedField` to route, then call the
 * matching decryptor, and treat "" as "not decryptable, fall back to
 * plaintext handling".
 */
export function decryptFieldEnvelope(encrypted: string): string {
  if (typeof encrypted !== "string" || encrypted.length === 0) return ""
  if (!encrypted.startsWith(ENVELOPE_PREFIX)) return ""
  const parts = encrypted.split(":")
  if (parts.length !== ENVELOPE_PART_COUNT) return ""
  // parts[0] === "v2" — already verified by the startsWith check above.
  const [
    ,
    wrapIvHex,
    wrappedDekHex,
    wrapAuthTagHex,
    dataIvHex,
    ciphertextHex,
    dataAuthTagHex,
  ] = parts

  // Hex-length sanity. All IVs are 12 bytes → 24 hex chars. Both auth
  // tags are 16 bytes → 32 hex chars. The wrapped DEK is exactly 32
  // bytes (DEK_LENGTH) → 64 hex chars (AES-GCM does not expand the
  // 32-byte DEK plaintext; only appends a 16-byte tag). Rejecting wrong
  // lengths early avoids creating Buffers that would throw inside the
  // GCM primitives and lets us return "" cleanly without entering the
  // try/catch.
  if (
    wrapIvHex.length !== IV_LENGTH * 2 ||
    wrapAuthTagHex.length !== AUTH_TAG_LENGTH * 2 ||
    wrappedDekHex.length !== DEK_LENGTH * 2 ||
    dataIvHex.length !== IV_LENGTH * 2 ||
    dataAuthTagHex.length !== AUTH_TAG_LENGTH * 2 ||
    ciphertextHex.length === 0 ||
    ciphertextHex.length % 2 !== 0
  ) {
    return ""
  }
  if (
    !/^[0-9a-f]+$/i.test(wrapIvHex) ||
    !/^[0-9a-f]+$/i.test(wrappedDekHex) ||
    !/^[0-9a-f]+$/i.test(wrapAuthTagHex) ||
    !/^[0-9a-f]+$/i.test(dataIvHex) ||
    !/^[0-9a-f]*$/i.test(ciphertextHex) ||
    !/^[0-9a-f]+$/i.test(dataAuthTagHex)
  ) {
    return ""
  }

  let dek: Buffer | null = null
  try {
    // 1. Unwrap the per-row DEK with the master KEK. `final()` throws
    //    if the wrap auth tag does not verify — i.e. the wrapped DEK
    //    was tampered with, or the master key is wrong. Either way we
    //    must NOT proceed to step 2 with a garbage DEK.
    const wrapIv = Buffer.from(wrapIvHex, "hex")
    const wrappedDek = Buffer.from(wrappedDekHex, "hex")
    const wrapAuthTag = Buffer.from(wrapAuthTagHex, "hex")
    // authTagLength pinned: the decipher rejects tags of any other
    // length, so a truncated wrap tag cannot be verified (GCM forgery /
    // CWE-310). Redundant with the hex-length check above on purpose —
    // the primitive enforces its own invariant too.
    const wrapDecipher = createDecipheriv(ALGORITHM, MASTER_KEY, wrapIv, {
      authTagLength: AUTH_TAG_LENGTH,
    })
    wrapDecipher.setAuthTag(wrapAuthTag)
    dek = Buffer.concat([wrapDecipher.update(wrappedDek), wrapDecipher.final()])
    if (dek.length !== DEK_LENGTH) {
      // Defensive: AES-GCM does not expand plaintext, so the unwrapped
      // DEK must be exactly 32 bytes. A different length means the row
      // was written by a future version with a different DEK size —
      // refuse to use it (we'd be encrypting under a key of the wrong
      // length, which createCipheriv would reject anyway).
      return ""
    }

    // 2. Decrypt the row's ciphertext with the unwrapped per-row DEK.
    //    `final()` throws if the data auth tag does not verify —
    //    tampered ciphertext is rejected, no partial plaintext released.
    const dataIv = Buffer.from(dataIvHex, "hex")
    const ciphertext = Buffer.from(ciphertextHex, "hex")
    const dataAuthTag = Buffer.from(dataAuthTagHex, "hex")
    // authTagLength pinned, same rationale as the wrap decipher above —
    // a truncated data tag is rejected rather than verified (CWE-310).
    const dataDecipher = createDecipheriv(ALGORITHM, dek, dataIv, {
      authTagLength: AUTH_TAG_LENGTH,
    })
    dataDecipher.setAuthTag(dataAuthTag)
    const plaintext = Buffer.concat([
      dataDecipher.update(ciphertext),
      dataDecipher.final(),
    ])
    return plaintext.toString("utf8")
  } catch {
    return ""
  } finally {
    // Zero the unwrapped DEK as soon as we're done with it, regardless
    // of success or failure. The DEK is the per-row secret that the
    // master key is supposed to gate; leaving it in heap memory after
    // use would weaken the envelope model (a heap snapshot taken later
    // could recover DEKs for rows already decrypted). Best-effort
    // cleanup — see encryptFieldEnvelope's dek.fill(0) for the same
    // pattern on the encrypt path.
    if (dek !== null) {
      dek.fill(0)
    }
  }
}

/**
 * Check whether a stored value looks like an `encryptFieldEnvelope`
 * output: starts with `v2:` and has the 7-part envelope shape with IV,
 * wrapped-DEK, and auth-tag byte lengths at their fixed sizes.
 *
 * SHAPE check only — it does NOT verify either GCM auth tag. A value
 * that passes `isEnvelopeField` but fails `decryptFieldEnvelope` is
 * either tampered or was encrypted under a different master key.
 *
 * The wrapped-DEK part is exactly 64 hex chars (32 bytes) because the
 * DEK is 32 bytes and AES-GCM does not expand ciphertext. The data
 * ciphertext part may be empty (an `encryptFieldEnvelope("")` produces
 * `v2:<wrapIV>:<wrappedDEK>:<wrapAuthTag>:<dataIV>::<dataAuthTag>` — GCM
 * emits zero ciphertext bytes for a zero-byte plaintext, and that
 * round-trips correctly through `decryptFieldEnvelope`).
 */
export function isEnvelopeField(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false
  if (!value.startsWith(ENVELOPE_PREFIX)) return false
  const parts = value.split(":")
  if (parts.length !== ENVELOPE_PART_COUNT) return false
  const [
    ,
    wrapIvHex,
    wrappedDekHex,
    wrapAuthTagHex,
    dataIvHex,
    ciphertextHex,
    dataAuthTagHex,
  ] = parts
  return (
    wrapIvHex.length === IV_LENGTH * 2 &&
    wrapAuthTagHex.length === AUTH_TAG_LENGTH * 2 &&
    wrappedDekHex.length === DEK_LENGTH * 2 &&
    dataIvHex.length === IV_LENGTH * 2 &&
    dataAuthTagHex.length === AUTH_TAG_LENGTH * 2 &&
    ciphertextHex.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(wrapIvHex) &&
    /^[0-9a-f]+$/i.test(wrappedDekHex) &&
    /^[0-9a-f]+$/i.test(wrapAuthTagHex) &&
    /^[0-9a-f]+$/i.test(dataIvHex) &&
    /^[0-9a-f]*$/i.test(ciphertextHex) &&
    /^[0-9a-f]+$/i.test(dataAuthTagHex)
  )
}
