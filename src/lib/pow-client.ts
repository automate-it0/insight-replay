"use client"

// Browser-side PoW solver. Mirrors the contract of src/lib/pow.ts (server):
// find a nonce such that SHA-256(challenge + nonce) starts with `difficulty`
// zero hex chars. Uses Web Crypto SubtleCrypto (available in all modern
// browsers and in Next.js client components) — NOT `node:crypto`, which is
// unavailable in the browser bundle.
//
// Performance note: SubtleCrypto.digest is async, with ~10–50 µs of
// promise overhead per call. To hit a reasonable solve time at difficulty 4
// (16 zero bits, expected 65 536 attempts), we batch B=64 concurrent hashes
// per round-trip and Promise.all them — a modern browser typically solves
// in 1–4 s. The login button surfaces a "Computing…" state during this
// window so the UX is clear.
//
// If `crypto.subtle` is unavailable (insecure-context page, very old
// browser) we throw — the login form will surface a friendly error. We do
// NOT fall back to a pure-JS SHA-256 here because shipping one would bloat
// the client bundle; a secure context is already required for the
// SameSite=strict CSRF cookie, so any browser that can use the dashboard
// at all also has SubtleCrypto.

export interface ClientPoWChallenge {
  /** 32-char hex challenge string issued by the server. */
  challenge: string
  /** Number of leading zero hex chars the SHA-256 hash must start with. */
  difficulty: number
  /** Optional issuance timestamp (ms epoch) — for diagnostics only. */
  timestamp?: number | undefined
  /** Optional challenge TTL (seconds) — for diagnostics only. */
  expiresIn?: number | undefined
}

/**
 * Solve the PoW: find a nonce such that
 *   SHA-256(challenge + nonce)
 * starts with `difficulty` zero hex chars.
 *
 * Returns the nonce as a decimal string (the simplest, smallest-on-the-wire
 * encoding — typical nonces are < 10^7, so 7 chars vs 8 hex chars for a
 * fixed-width encoding).
 *
 * Throws if SubtleCrypto is unavailable or `difficulty` is invalid.
 */
export async function solvePoW(challenge: string, difficulty: number): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("Web Crypto SubtleCrypto API unavailable — cannot solve PoW")
  }
  if (!challenge || typeof challenge !== "string") {
    throw new Error("Invalid PoW challenge")
  }
  if (!Number.isInteger(difficulty) || difficulty <= 0 || difficulty > 16) {
    throw new Error(`Invalid PoW difficulty: ${difficulty}`)
  }

  const target = "0".repeat(difficulty)
  const encoder = new TextEncoder()

  // Batch size — tuned so each Promise.all round-trip keeps SubtleCrypto's
  // internal worker saturated without blowing the JS heap. 64 is a sweet
  // spot on Chrome/Firefox/Safari (empirical — adjust if needed).
  const BATCH = 64

  let nonce = 0
  // Hard ceiling to defend against a runaway loop (e.g. difficulty accidentally
  // bumped server-side without a client-side limit). At difficulty 4 the
  // expected attempts are 2^16 ≈ 65k; we cap at 2^24 ≈ 16M (~256x headroom).
  const MAX_ATTEMPTS = 16_777_216

  while (nonce < MAX_ATTEMPTS) {
    // Issue BATCH concurrent hashes. Each call is async; Promise.all fans
    // them out and the underlying SubtleCrypto implementation typically
    // dispatches them on its worker pool.
    const nonces: number[] = []
    for (let i = 0; i < BATCH; i++) nonces.push(nonce + i)
    const hashes = await Promise.all(
      nonces.map((n) =>
        crypto.subtle.digest("SHA-256", encoder.encode(challenge + n)),
      ),
    )
    for (let i = 0; i < hashes.length; i++) {
      const hex = bufToHex(hashes[i] as ArrayBuffer)
      if (hex.startsWith(target)) {
        return String(nonces[i])
      }
    }
    nonce += BATCH
  }

  throw new Error("PoW solve exceeded max attempts — try refreshing the page")
}

/**
 * ArrayBuffer → lowercase hex string. Only the first `difficulty` chars
 * technically need to be inspected, but converting the full 32-byte hash is
 * cheap and simpler than slicing + zero-padding.
 */
function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Fetch a fresh PoW challenge from the dedicated endpoint
 * (GET /api/auth/login/pow). Returns the challenge info needed to call
 * `solvePoW`.
 *
 * Throws on any non-OK response — the caller (login form) catches and
 * surfaces a friendly error to the user.
 */
export async function fetchPoWChallenge(): Promise<ClientPoWChallenge> {
  const r = await fetch("/api/auth/login/pow", { cache: "no-store" })
  if (!r.ok) {
    throw new Error(`Failed to fetch PoW challenge (${r.status})`)
  }
  const data = (await r.json().catch(() => null)) as {
    ok?: boolean
    challenge?: string
    difficulty?: number
    timestamp?: number
    expiresIn?: number
  } | null
  if (!data?.ok || !data.challenge || typeof data.difficulty !== "number") {
    throw new Error("Malformed PoW challenge response")
  }
  return {
    challenge: data.challenge,
    difficulty: data.difficulty,
    timestamp: data.timestamp,
    expiresIn: data.expiresIn,
  }
}

/**
 * Pull a PoW challenge out of an error response body (the 403 / 401 paths on
 * the login route attach a fresh `pow` object so the client can retry without
 * an extra GET round-trip). Returns null if the body doesn't carry one.
 */
export function extractPoWFromBody(body: unknown): ClientPoWChallenge | null {
  if (!body || typeof body !== "object") return null
  const pow = (body as { pow?: unknown }).pow
  if (!pow || typeof pow !== "object") return null
  const p = pow as {
    challenge?: unknown
    difficulty?: unknown
    timestamp?: unknown
    expiresIn?: unknown
  }
  if (typeof p.challenge !== "string" || typeof p.difficulty !== "number") {
    return null
  }
  return {
    challenge: p.challenge,
    difficulty: p.difficulty,
    ...(typeof p.timestamp === "number" ? { timestamp: p.timestamp } : {}),
    ...(typeof p.expiresIn === "number" ? { expiresIn: p.expiresIn } : {}),
  }
}
