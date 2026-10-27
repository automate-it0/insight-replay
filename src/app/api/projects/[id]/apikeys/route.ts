import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { db } from "@/lib/db"
import { hashApiKey, validateApiKey, unauthorizedResponse } from "@/lib/auth"
import { auditLog, AUDIT_ACTIONS } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import { sanitizeError } from "@/lib/observability"
import {
  decryptField,
  encryptField,
  isEncryptedField,
} from "@/lib/db-encryption"

function maskKey(key: string): string {
  if (!key) return ""
  const tail = key.length >= 4 ? key.slice(-4) : key
  return `ir_••••${tail}`
}

/**
 * GET — list API keys for a project.
 *
 * Returns ONLY the masked form of each key (we no longer store the plaintext,
 * so we cannot return it even if we wanted to). Requires a valid API key in
 * production (keys are sensitive — leaking them would allow unbounded data
 * access). Open in dev for dashboard testing.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (process.env.NODE_ENV === "production") {
    const auth = await validateApiKey(req, id)
    if (!auth.valid) return unauthorizedResponse()
  }
  try {
    const keys = await db.apiKey.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 100,
    })
    const masked = keys.map((k) => {
      // Encryption-at-rest: the `key` column stores an AES-256-GCM
      // ciphertext (`iv:ciphertext:authTag`) wrapping the underlying
      // `hashApiKey` output (`<hash>:<salt>`). Decrypt here to inspect
      // the inner format; legacy rows (pre-hardening, un-encrypted)
      // fall through to `k.key` itself.
      const inner = isEncryptedField(k.key) ? decryptField(k.key) : k.key
      // If `inner` has a colon it's a `<hash>:<salt>` pair — we cannot
      // recover the plaintext, show the generic mask. If `inner` is
      // empty (decryption failed for a tampered/corrupt row), also show
      // the generic mask rather than risk leaking the ciphertext prefix.
      // Otherwise `inner` is a legacy plaintext key — mask its last 4.
      const keyMasked =
        inner && !inner.includes(":") ? maskKey(inner) : "ir_••••••••"
      return {
        id: k.id,
        projectId: k.projectId,
        name: k.name,
        keyMasked,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
      }
    })
    return NextResponse.json({ apiKeys: masked })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "apikeys_list")
    return NextResponse.json(body, { status })
  }
}

/**
 * POST — mint a new API key.
 *
 * Generates a plaintext `ir_<32 hex>` key, stores `hashApiKey(plaintext)` in
 * the `key` column (so the plaintext is unrecoverable from the DB), and
 * returns the plaintext to the caller EXACTLY ONCE. The caller MUST persist
 * the plaintext client-side; subsequent GET requests will only return a mask.
 *
 * Auth policy:
 *   - In production: a valid existing API key is required to mint a new one
 *     (bootstrapping the first key is handled out-of-band — see worklog Task
 *     ID A, Phase 4 for the rotation procedure).
 *   - In dev: open access to make local testing ergonomic.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params
  if (process.env.NODE_ENV === "production") {
    const auth = await validateApiKey(req, id)
    if (!auth.valid) return unauthorizedResponse()
  }
  try {
    const body = await req.json().catch(() => ({}))
    const { name } = body as { name?: string }
    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 })
    }

    // Generate plaintext `ir_<32 hex>`. randomUUID provides sufficient entropy
    // (122 bits) — combined with the per-key salt this is well above the
    // brute-force threshold for an API key.
    const plaintext = `ir_${randomUUID().replace(/-/g, "")}`
    // Store the salted hash (NOT the plaintext), then ENCRYPT the hash at
    // rest (defense-in-depth — an attacker who steals the DB file gets
    // neither the plaintext key NOR the unsalted hash to brute-force).
    // `encryptField` produces a fresh `iv:ciphertext:authTag` blob with a
    // random 12-byte IV, so the same input hash yields a different stored
    // value every write — meaning the `key @unique` DB constraint no longer
    // enforces plaintext-hash uniqueness at the DB level. That's OK: the
    // per-key random salt already makes collisions vanishingly unlikely,
    // and the `@@unique([projectId, name])` constraint still guards against
    // duplicate (project, name) pairs.
    let stored = encryptField(hashApiKey(plaintext))
    if (!stored) {
      // Fail closed: if encryption failed (should never happen with valid
      // inputs + derived key, but defensive), refuse to write plaintext —
      // surface as a 500 so the operator knows the encryption layer is
      // misconfigured.
      return NextResponse.json(
        { error: "Failed to secure API key — try again." },
        { status: 500 },
      )
    }
    const trimmedName = name.trim()

    // Race-safety: the (projectId, name) pair has a `@@unique` constraint
    // (see prisma/schema.prisma ApiKey model). Two concurrent POSTs with the
    // same `name` would otherwise each create a key — one with the legit
    // plaintext returned to its caller, the other silently persisted as a
    // hidden duplicate. With the constraint, the second request's `create`
    // throws P2002 inside the transaction; we translate that into a clean
    // 409 so the caller knows to pick a different name. The transaction
    // also makes the key create + the audit-log entry atomic — no orphan
    // audit entries for failed key creates.
    const clientIP = getClientIP(req as unknown as Request)
    let apiKey
    try {
      apiKey = await db.$transaction(async (tx) => {
        const created = await tx.apiKey.create({
          data: {
            projectId: id,
            name: trimmedName,
            key: stored,
          },
        })
        await auditLog({
          action: AUDIT_ACTIONS.APIKEY_CREATED,
          projectId: id,
          actor: "api",
          ip: clientIP,
          details: { name: trimmedName, keyId: created.id, keyMasked: maskKey(plaintext) },
        })
        return created
      })
    } catch (e) {
      const code = (e as { code?: string })?.code
      // P2002 = unique-constraint violation. (projectId, name) already taken.
      if (code === "P2002") {
        return NextResponse.json(
          {
            error: `An API key named "${trimmedName}" already exists in this project. Pick a different name.`,
          },
          { status: 409 },
        )
      }
      throw e
    }
    // Return the FULL plaintext key only once on creation so the client can
    // show + copy it. After this response, the plaintext is gone for good.
    return NextResponse.json({
      apiKey: {
        id: apiKey.id,
        projectId: apiKey.projectId,
        name: apiKey.name,
        key: plaintext,
        keyMasked: maskKey(plaintext),
        createdAt: apiKey.createdAt,
        lastUsed: apiKey.lastUsed,
      },
    })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "apikey_create")
    return NextResponse.json(body, { status })
  }
}
