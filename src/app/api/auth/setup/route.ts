import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { createSession, hashPassword } from "@/lib/session"
import { rateLimit, getClientIP } from "@/lib/rate-limit"
import { sanitizeError, getRequestId } from "@/lib/observability"
import { encryptField } from "@/lib/db-encryption"

// POST /api/auth/setup
//
// One-time first-admin bootstrap. Succeeds ONLY when zero users exist in the
// database; once any user exists, this endpoint always returns 409 (so it
// can't be used to create additional admins — that's a future /admin/users
// workflow, out of scope here).
//
// After creating the user, we immediately issue a session cookie so the
// freshly-provisioned admin lands on the dashboard without a separate login
// step.
//
// Race-safety: the count-then-create sequence is wrapped in a Prisma
// interactive transaction, AND the User table carries a `bootstrapLock @unique`
// constraint (see prisma/schema.prisma). The first request that commits sets
// `bootstrapLock = "TAKEN"`; any concurrent setup that also passed the
// count === 0 check before the first one committed will then fail its
// `user.create` with Prisma error code P2002 (unique constraint violation),
// which we translate into a clean 409. The DB constraint is the source of
// truth — even a buggy future caller cannot escape it.
//
// Rate limited at 5/min/IP — generous for legit first-time setup, tight
// enough that an attacker probing the endpoint can't enumerate or hammer
// the DB before a real admin provisions the account.

const SETUP_LIMIT = { max: 5, windowMs: 60_000 }

// Sentinel value written to User.bootstrapLock on first-admin creation. Any
// second setup request that tries to insert a row with this same non-null
// value is rejected by the `@unique` constraint at the DB level.
const BOOTSTRAP_LOCK_VALUE = "TAKEN"

// Prisma's unique-constraint-violation error code. Used to distinguish
// "concurrent setup won" (→ 409) from genuine DB errors (→ 500).
const PRISMA_UNIQUE_VIOLATION = "P2002"

// Sentinel error thrown from inside the transaction when the count check
// detects an existing user. Lets us branch in the outer catch without
// inspecting error messages.
class SetupAlreadyExists extends Error {
  constructor() {
    super("SETUP_ALREADY_EXISTS")
    this.name = "SetupAlreadyExists"
  }
}

// GET /api/auth/setup
//
// Returns `{ ok: true, setupAvailable: boolean }` — lets the login page
// decide whether to render the "Create admin account" link. Does NOT create
// anything; safe to call repeatedly. The count query is cheap (single row,
// indexed by primary key) and uncached so the UI always reflects the true
// state.
export async function GET() {
  try {
    const count = await db.user.count()
    return NextResponse.json({ ok: true, setupAvailable: count === 0 })
  } catch (e) {
    const { status, body } = sanitizeError(e, undefined, "auth_setup_status")
    return NextResponse.json(body, { status })
  }
}

export async function POST(req: NextRequest) {
  const requestId = getRequestId(req as unknown as Request)
  try {
    const ip = getClientIP(req as unknown as Request)
    const rl = rateLimit(ip, SETUP_LIMIT)
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many setup attempts. Try again in a minute." },
        { status: 429, headers: { "Retry-After": "60" } },
      )
    }

    // 1. Parse + validate the request body BEFORE the transaction so we
    //    don't hold a DB write lock during body parsing. (We re-check the
    //    count inside the transaction below — the check here is just a fast
    //    path that returns 409 immediately when setup has long-since
    //    completed, without entering the transaction at all.)
    const body = (await req.json().catch(() => null)) as {
      email?: unknown
      password?: unknown
      name?: unknown
    } | null
    if (!body) {
      return NextResponse.json(
        { ok: false, error: "Invalid request body" },
        { status: 400 },
      )
    }
    const email = typeof body.email === "string" ? body.email.trim() : ""
    const password = typeof body.password === "string" ? body.password : ""
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : null
    if (!email || !password) {
      return NextResponse.json(
        { ok: false, error: "Email and password are required" },
        { status: 400 },
      )
    }
    // Basic email-shape guard. Not RFC-complete, but catches the obvious
    // typos (missing @, missing domain) without pulling in a validator dep.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { ok: false, error: "Invalid email format" },
        { status: 400 },
      )
    }
    if (password.length < 8) {
      return NextResponse.json(
        { ok: false, error: "Password must be at least 8 characters" },
        { status: 400 },
      )
    }

    // 2. Fast-path: refuse if any user already exists. This is the same
    //    gate we re-check inside the transaction below — duplicated here so
    //    the common case (setup already done) returns 409 without taking a
    //    DB write lock.
    const existingCount = await db.user.count()
    if (existingCount > 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Setup is disabled — an admin account already exists. Use /api/auth/login instead.",
        },
        { status: 409 },
      )
    }

    // 3. Race-safe create. The transaction + bootstrapLock @unique constraint
    //    together guarantee that at most one admin can be created even if two
    //    requests both passed the count check above before either committed:
    //      - The first request to commit sets bootstrapLock = "TAKEN".
    //      - The second request's `user.create` violates the unique
    //        constraint and throws P2002, which we translate into 409.
    //    The transaction also makes the count + create atomic so we don't
    //    leave the DB in a half-written state if the create fails.
    //
    //    Encryption-at-rest: the `email` and `passwordHash` fields are
    //    encrypted with AES-256-GCM (see src/lib/db-encryption.ts) BEFORE
    //    being written to the DB, so a raw filesystem read of `custom.db`
    //    reveals neither the email nor the password hash. The plaintext
    //    passwordHash is already a salted scrypt hash (one-way), but we
    //    encrypt it too for defense-in-depth — an attacker who steals the
    //    DB file does not get even the hash to mount an offline brute-force
    //    against. Because GCM uses a random IV per call, the same plaintext
    //    email produces a different ciphertext every write — meaning the
    //    `email @unique` DB constraint no longer enforces plaintext
    //    uniqueness, but that's fine here because setup refuses to create a
    //    second admin at the application layer (count === 0 + bootstrapLock).
    //    The `select` excludes `email`/`passwordHash` because the row's
    //    encrypted values are useless to the response — we use the local
    //    plaintext `email` variable for session creation and the response.
    let user: { id: string; name: string | null; role: string }
    try {
      user = await db.$transaction(async (tx) => {
        const count = await tx.user.count()
        if (count > 0) throw new SetupAlreadyExists()
        const encryptedEmail = encryptField(email)
        const encryptedPasswordHash = encryptField(hashPassword(password))
        // Fail closed: if encryption produced an empty string (should never
        // happen with valid inputs + derived key, but defensive), refuse to
        // write plaintext to disk — surface as a 500 to the caller so the
        // operator knows the encryption layer is misconfigured.
        if (!encryptedEmail || !encryptedPasswordHash) {
          throw new Error("ENCRYPTION_FAILED")
        }
        return await tx.user.create({
          data: {
            email: encryptedEmail,
            passwordHash: encryptedPasswordHash,
            name,
            role: "admin",
            // DB-level mutex: any concurrent setup that already committed
            // this same value will cause our create to throw P2002 below.
            bootstrapLock: BOOTSTRAP_LOCK_VALUE,
          },
          select: { id: true, name: true, role: true },
        })
      })
    } catch (e) {
      // Concurrent setup won the race — translate to 409.
      if (e instanceof SetupAlreadyExists) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Setup is disabled — an admin account already exists. Use /api/auth/login instead.",
          },
          { status: 409 },
        )
      }
      // Prisma unique-constraint violation: either the email was taken
      // (impossible here since count === 0, but defensive) OR the
      // bootstrapLock mutex fired because a concurrent setup committed first.
      // Either way, setup is no longer available.
      const code = (e as { code?: string })?.code
      if (code === PRISMA_UNIQUE_VIOLATION) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Setup is disabled — an admin account already exists. Use /api/auth/login instead.",
          },
          { status: 409 },
        )
      }
      throw e
    }

    // 4. Auto-login the new admin. Pass the client IP so the session is
    //    bound to this network — a stolen cookie replayed from a different
    //    IP will fail verification in `getSession()` (see src/lib/session.ts
    //    `hashIP` / `ipHash`). Use the local plaintext `email` variable
    //    (not `user.email`, which is the encrypted value the DB stored) — the
    //    session cookie payload needs the human-readable email so the
    //    dashboard UI can greet the user by name.
    //
    //    Also forward the device fingerprint (`x-device-fp` header) when
    //    the client sent one. `createSession` stores `fpHash` alongside
    //    `ipHash`; `getSession()` then uses the combined binding to allow
    //    mobile network switches (IP changed, fingerprint same) while still
    //    rejecting hijacked cookies replayed from a different browser (both
    //    changed). No header → no `fpHash` stored → session falls back to
    //    IP-only binding (non-breaking for clients that don't send it yet).
    const clientFP = req.headers.get("x-device-fp")?.trim() || undefined
    await createSession(user.id, email, ip, clientFP)

    return NextResponse.json(
      { ok: true, user: { ...user, email } },
      { status: 201 },
    )
  } catch (e) {
    const { status, body } = sanitizeError(e, requestId, "auth_setup")
    return NextResponse.json(body, { status })
  }
}
