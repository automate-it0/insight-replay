/**
 * Insight Replay — Field-level encryption + secret validation utilities.
 *
 * WHY THIS EXISTS
 * ---------------
 * We use SQLite via Prisma. Switching to SQLCipher would break Prisma's
 * SQLite driver pipeline. Instead, we encrypt sensitive fields (PII like
 * raw IPs, emails if ever stored, etc.) at the application layer BEFORE
 * they hit the DB, and decrypt them on the way out.
 *
 * The format "enc:<iv>:<authTag>:<ciphertext>" is intentionally easy to
 * detect with isEncrypted() so legacy plaintext rows and encrypted rows
 * can coexist during a gradual rollout.
 *
 * CIPHER: AES-256-GCM (authenticated — protects both confidentiality
 * and integrity; tampering with the ciphertext or auth tag will cause
 * decrypt() to return null rather than produce corrupted output).
 *
 * KEY: derived from ENCRYPTION_KEY (env) via scrypt with a fixed salt.
 * Fail-CLOSED: in production (`NODE_ENV === "production"`), if
 * ENCRYPTION_KEY is unset OR fails `validateSecretStrength` (length < 16
 * / missing lowercase / uppercase / digit / special char class) we
 * THROW at module load. A missing/weak key means the encryption is
 * worthless against any attacker who reads the source — better to
 * crash the boot than ship a false sense of confidentiality. Dev
 * (`NODE_ENV !== "production"`) still allows a fixed dev-only fallback
 * so `bun dev` works without a configured key (encrypted values are
 * reversible by anyone who reads the source, but at least the app
 * boots for local dev).
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "crypto"

const ALGORITHM = "aes-256-gcm"
const SALT = "insight-replay-salt"
const VERSION_PREFIX = "enc:"
const MIN_SECRET_LENGTH = 16

// Derive a 32-byte key from the env var (or a dev-only fallback).
// scrypt is intentionally slow — deriving once at module load is fine;
// we do NOT re-derive per call.
//
// Fail-CLOSED: in production, THROW if ENCRYPTION_KEY is unset OR fails
// `validateSecretStrength` (length >= 16 + lowercase + uppercase + digit
// + special char). A missing/weak key means the encryption is worthless
// against any attacker who reads the source — better to crash the boot
// than ship a false sense of confidentiality. Dev allows a fixed
// dev-only fallback so `bun dev` works without a configured key.
//
// `validateSecretStrength` is defined further down in this same file —
// function declarations are hoisted in JS/TS, so calling it from this
// early-executing resolver is safe. Keeping the helper where it is
// (next to `generateSecret` which also calls it) preserves the
// "secret-strength utilities" locality.
const ENCRYPTION_KEY = resolveEncryptionKey()

/**
 * Resolve the AES-256 key from `process.env.ENCRYPTION_KEY` —
 * fail-CLOSED, not fail-open. See the docstring on `ENCRYPTION_KEY`
 * above for the security rationale.
 *
 * Production: THROW if `ENCRYPTION_KEY` is unset OR fails
 * `validateSecretStrength`. Dev: fall back to a fixed dev-only string.
 * Returns the derived 32-byte Buffer (scrypt of the resolved input
 * with the fixed SALT).
 */
function resolveEncryptionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "ENCRYPTION_KEY is not set — refusing to boot in production without " +
          "a field-encryption key. Set ENCRYPTION_KEY in the environment " +
          "(see scripts/generate-secret.sh and .env.example).",
      )
    }
    // Dev-only fixed fallback — encrypted values are reversible by anyone
    // who reads the source, but at least the app boots for local dev.
    return scryptSync("dev-only-key-do-not-use-in-prod", SALT, 32)
  }
  if (process.env.NODE_ENV === "production") {
    const check = validateSecretStrength(raw)
    if (!check.valid) {
      throw new Error(
        "ENCRYPTION_KEY is too weak for production — must be at least " +
          "16 chars and contain lowercase + uppercase + digit + special-char " +
          `classes. Issues: ${check.issues.join("; ")}. Regenerate via ` +
          "scripts/generate-secret.sh.",
      )
    }
  }
  return scryptSync(raw, SALT, 32)
}

/**
 * Encrypt a string. Returns "enc:<iv>:<authTag>:<ciphertext>" format.
 * Used for PII fields (raw IPs if stored, emails, etc.).
 *
 * Each call produces a unique ciphertext for the same plaintext because
 * a fresh 12-byte IV is used every time (GCM standard nonce size).
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return `enc:${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`
}

/**
 * Decrypt a string produced by encrypt(). Returns null if decryption
 * fails (wrong key, tampered ciphertext, malformed format, etc.) so
 * callers can fall back to treating the stored value as plaintext.
 */
export function decrypt(ciphertext: string): string | null {
  try {
    const parts = ciphertext.split(":")
    if (parts.length !== 4 || parts[0] !== "enc") return null
    const iv = Buffer.from(parts[1], "hex")
    const authTag = Buffer.from(parts[2], "hex")
    const encrypted = Buffer.from(parts[3], "hex")
    const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv)
    decipher.setAuthTag(authTag)
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ])
    return decrypted.toString("utf8")
  } catch {
    return null
  }
}

/**
 * Check if a value is encrypted (starts with "enc:"). Use this before
 * calling decrypt() to avoid wasting cycles on plaintext rows.
 */
export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(VERSION_PREFIX)
}

/**
 * Secret validation — checks strength of a secret/password.
 * Returns { valid, score (0-5), issues[] }.
 *
 * The 5 checks (one point each): length >= 16, has lowercase, has
 * uppercase, has digit, has special char. A "valid" secret must pass
 * ALL 5. This is the bar for SESSION_SECRET / ENCRYPTION_KEY.
 */
export function validateSecretStrength(secret: string): {
  valid: boolean
  score: number
  issues: string[]
} {
  const issues: string[] = []
  if (secret.length < MIN_SECRET_LENGTH)
    issues.push(`Must be at least ${MIN_SECRET_LENGTH} characters`)
  if (!/[a-z]/.test(secret)) issues.push("Must contain lowercase letters")
  if (!/[A-Z]/.test(secret)) issues.push("Must contain uppercase letters")
  if (!/[0-9]/.test(secret)) issues.push("Must contain numbers")
  if (!/[^a-zA-Z0-9]/.test(secret)) issues.push("Must contain special characters")
  const score = 5 - issues.length
  return { valid: issues.length === 0, score, issues }
}

/**
 * Generate a cryptographically secure random secret guaranteed to pass
 * validateSecretStrength(). Uses base64url, retrying (max 10 attempts)
 * until the output contains at least one of each required character
 * class. 32 bytes by default → ~43 chars.
 *
 * The retry is necessary because base64url's only "special" characters
 * are `-` and `_` (2 of 64 alphabet entries), so a 43-char string has
 * roughly a 26% chance of containing neither — without the retry loop,
 * ~1 in 4 generated secrets would fail our own validator.
 *
 * The fallback (probability < 1e-6 after 10 attempts) appends a
 * guaranteed-mix suffix so the function NEVER returns an invalid secret.
 */
export function generateSecret(length = 32): string {
  for (let i = 0; i < 10; i++) {
    const candidate = randomBytes(length).toString("base64url")
    if (validateSecretStrength(candidate).valid) return candidate
  }
  // Fallback (vanishingly unlikely): append a guaranteed-mix suffix.
  return randomBytes(length).toString("base64url") + "-Aa1!"
}

/**
 * Hash a value with SHA-256 (for fingerprinting, NOT for passwords).
 * Use this when you need a stable, deterministic identifier for a
 * value (e.g.Visitor fingerprinting, dedup keys) without storing the
 * raw value itself.
 *
 * Passwords should use a real password-hash (bcrypt/scrypt/argon2) —
 * not this function.
 */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Constant-time string comparison. Use this for comparing secrets,
 * tokens, or hashes where a timing side-channel could leak info about
 * the expected value. Returns true if equal, false otherwise.
 *
 * Falls back to plain === if lengths differ (no secret info leaked by
 * length difference in practice for randomly-generated secrets).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
