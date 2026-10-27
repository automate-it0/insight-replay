import { PrismaClient } from '@prisma/client'

/**
 * ────────────────────────────────────────────────────────────────────────────
 * FIELD-LEVEL ENCRYPTION POLICY (read me before touching a route handler)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * We use SQLite via Prisma. Switching to SQLCipher would break Prisma's
 * SQLite driver pipeline (and the @prisma/client surface area we rely on).
 * Instead, sensitive PII fields are encrypted at the APPLICATION LAYER,
 * before they ever reach the DB.
 *
 * The crypto helpers live in `@/lib/crypto`:
 *   - `encrypt(plaintext)`  → "enc:<iv>:<authTag>:<ciphertext>" (AES-256-GCM)
 *   - `decrypt(ciphertext)` → plaintext, or null if not encrypted / tampered
 *   - `isEncrypted(value)`  → true/false — use to handle mixed-format rows
 *
 * WHY NOT $extends (Prisma client extension)?
 *   A Prisma extension could auto-encrypt on write and auto-decrypt on read
 *   for specific columns. We deliberately do NOT do this because:
 *     (1) it's fragile — every model+field combo needs explicit wiring,
 *         and a missed field silently stores plaintext;
 *     (2) it makes raw SQL / migrations / debugging harder (you can't tell
 *         from a Prisma query what shape you'll get back);
 *     (3) some columns are queried in WHERE clauses (e.g. Session.ip for
 *         analytics aggregates) — encrypting those columns would break
 *         every range/equality query on them;
 *     (4) the existing codebase already does IP anonymization upstream
 *         (see src/lib/ua.ts + FF_IP_ANON), so raw IPs shouldn't reach
 *         this layer in the first place.
 *
 * INSTEAD, route handlers that persist PII should call `encrypt()` on the
 * specific sensitive fields before `db.<model>.create/update/upsert`, and
 * `decrypt()` after `db.<model>.findUnique/findMany` when rendering. The
 * isEncrypted() helper lets you handle legacy plaintext rows during a
 * gradual rollout:
 *
 *   const ip = row.ip && isEncrypted(row.ip) ? decrypt(row.ip) : row.ip
 *
 * CURRENT PII FIELDS (per prisma/schema.prisma):
 *   - Session.ip         — anonymized upstream by default; encrypt only if
 *                          a route intentionally persists a raw IP.
 *   - Session.userAgent  — low-sensitivity but identifiable; encrypt if
 *                          stored raw.
 *   - Session.referrer   — may contain PII query params; encrypt if needed.
 *   - ErrorEvent.stack   — may contain user-supplied input; consider
 *                          encrypting on storage.
 *
 * Route handlers are owned by other agents — adopt the crypto lib
 * incrementally. This file (db.ts) is left as a plain PrismaClient so
 * that adding encryption is an OPT-IN per-field choice, not a global
 * breaking change.
 * ────────────────────────────────────────────────────────────────────────────
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
