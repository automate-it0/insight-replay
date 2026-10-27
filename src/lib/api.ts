import { CSRF_HEADER_NAME } from "@/lib/csrf"
import {
  deviceFingerprintHeader,
  DEVICE_FP_HEADER,
} from "@/lib/device-fp"

// Frontend API helper. Wraps `fetch` with:
//   - JSON content-type by default
//   - Automatic CSRF token attachment on mutating requests (POST/PUT/PATCH/DELETE)
//     using the double-submit cookie pattern. The token is fetched lazily
//     from `/api/csrf-token` on first use, cached in-memory, and refreshed
//     transparently if the server returns 403 "CSRF token invalid" (e.g.
//     because the cookie expired past its 1-hour maxAge).
//   - Automatic `x-device-fp` (device fingerprint) attachment on EVERY
//     request (GET + mutating). The fingerprint is computed once per page
//     load (see src/lib/device-fp.ts) and cached, so the canvas/WebGL/
//     sha-256 cost is paid once. The server uses it in `getSession()`
//     (see src/lib/session.ts) as the second binding axis alongside the
//     IP hash — together they let a mobile network switch (IP changes,
//     fingerprint same) survive without forcing a re-login, while still
//     rejecting a stolen cookie replayed from a different browser (both
//     change). Middleware Layer 4c additionally REQUIRES the header on
//     mutating requests; missing → 401. So we attach on GETs too so the
//     server can do the augmented binding check on read-only loads (the
//     alternative would be the server degrading to IP-only on every GET,
//     which defeats the purpose for users on mobile networks).
//
// Callers don't need to know CSRF or device-fp exists —
// `api("/api/projects", { method: "POST", ... })` just works, same as
// before.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

let cachedCsrfToken: string | null = null
let csrfFetchPromise: Promise<string> | null = null

/**
 * Fetch a CSRF token from `/api/csrf-token`. Cached in-memory after the first
 * successful call. Pass `force: true` to bypass the cache (used after a 403
 * to recover from an expired cookie).
 *
 * The server also sets the token as a cookie, so subsequent mutating requests
 * carry the cookie automatically — but we ALSO need the token in the
 * `x-csrf-token` header (which the browser does NOT auto-attach), which is
 * why we cache the body value here.
 */
export async function fetchCsrfToken(force = false): Promise<string> {
  if (cachedCsrfToken && !force) return cachedCsrfToken
  if (csrfFetchPromise && !force) return csrfFetchPromise

  csrfFetchPromise = fetch("/api/csrf-token", { credentials: "same-origin" })
    .then((r) => {
      if (!r.ok) throw new Error(`CSRF token fetch failed: ${r.status}`)
      return r.json() as Promise<{ token: string }>
    })
    .then((body) => {
      cachedCsrfToken = body.token
      csrfFetchPromise = null
      return cachedCsrfToken
    })
    .catch((e) => {
      // Reset the promise so a subsequent call can retry.
      csrfFetchPromise = null
      throw e
    })

  return csrfFetchPromise
}

/**
 * Build the headers for a request, merging in:
 *   - The CSRF token (mutating methods only, via double-submit)
 *   - The `x-device-fp` device fingerprint (every request, when available)
 *
 * Both are merged into the incoming caller-provided headers so explicit
 * caller values win (rare — only the login form sets `x-device-fp`
 * explicitly before `getDeviceFingerprint` has cached a value). Returns
 * the merged header object.
 */
async function buildHeaders(
  init: RequestInit | undefined,
  isMutating: boolean,
): Promise<Record<string, string>> {
  const incoming = (init?.headers as Record<string, string> | undefined) || {}
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...incoming,
  }

  // Device fingerprint — attached on EVERY request (GET + mutating).
  // On the server / SSR (no window), `deviceFingerprintHeader()` returns
  // `{}` so this is a no-op; the server's getSession() then falls back
  // to IP-only binding for that request. Non-fatal.
  //
  // We don't `await` a `Promise.all` with the CSRF fetch below because the
  // fingerprint is already cached after the first call (compute-once
  // semantics in device-fp.ts), so this is a microtask-cost cache hit on
  // every subsequent request.
  try {
    if (!headers[DEVICE_FP_HEADER]) {
      const fpHeaders = await deviceFingerprintHeader()
      // `fpHeaders` is `Record<string, string>` per `deviceFingerprintHeader`'s
      // return type. The `as [string, string][]` cast is defensive — it
      // documents and pins the entry-pair shape so a future refactor of
      // `deviceFingerprintHeader`'s return type that loosens it (e.g. to
      // `Record<string, string | undefined>`) surfaces at THIS call site
      // rather than silently producing a `string | undefined` assignment
      // into a `string`-typed headers map.
      for (const [k, v] of Object.entries(fpHeaders) as [string, string][]) {
        // Only set if not already provided by the caller — caller wins.
        if (v && !headers[k]) headers[k] = v
      }
    }
  } catch {
    // ignore — fingerprint computation failure; server falls back to
    // IP-only binding for this request. Non-fatal.
  }

  if (isMutating) {
    // Try to attach the cached token; if none, lazily fetch one. If the
    // fetch fails (e.g. server down), proceed without — the server will
    // return 403 and the caller surfaces the real error. Don't throw here
    // because that would mask the actual API response.
    try {
      const token = cachedCsrfToken || (await fetchCsrfToken())
      if (token) headers[CSRF_HEADER_NAME] = token
    } catch {
      // ignore — server will reject with 403 and the caller will see it
    }
  }

  return headers
}

/**
 * Check whether a 403 response body indicates a CSRF rejection (so we know
 * to retry after refreshing the token). Reads the cloned body so the original
 * response stays consumable by the caller's error path.
 */
async function isCsrfRejection(res: Response): Promise<boolean> {
  if (res.status !== 403) return false
  try {
    const body = (await res.clone().json()) as { error?: unknown }
    if (typeof body.error === "string" && /csrf/i.test(body.error)) {
      return true
    }
  } catch {
    // Not JSON or malformed — not a CSRF rejection we can recover from.
  }
  return false
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase()
  const isMutating = MUTATING_METHODS.has(method)

  const headers = await buildHeaders(init, isMutating)
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" })

  // If the server rejected with a CSRF error, the cached token likely
  // expired (1-hour maxAge). Re-fetch once and retry. This recovers
  // transparently from cookie expiry without surfacing a confusing 403 to
  // the user. Only retry once to avoid infinite loops on a misconfigured
  // server.
  if (isMutating && (await isCsrfRejection(res))) {
    try {
      const freshToken = await fetchCsrfToken(true)
      const retryHeaders = { ...headers, [CSRF_HEADER_NAME]: freshToken }
      const retryRes = await fetch(path, { ...init, headers: retryHeaders, credentials: "same-origin" })
      if (!retryRes.ok) {
        const txt = await retryRes.text().catch(() => "")
        throw new Error(`${retryRes.status} ${txt}`)
      }
      return retryRes.json() as Promise<T>
    } catch {
      // Refresh failed — fall through to surface the original 403.
    }
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    throw new Error(`${res.status} ${txt}`)
  }
  return res.json() as Promise<T>
}

export function fmtDuration(s: number) {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}m ${sec}s`
}

export function fmtTime(d: string | Date) {
  const date = typeof d === "string" ? new Date(d) : d
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function fmtRelative(d: string | Date) {
  const date = typeof d === "string" ? new Date(d) : d
  const diff = Date.now() - date.getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  return `${days}d ago`
}

export function fmtNumber(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k"
  return String(n)
}

export function deviceIcon(d: string) {
  if (d === "mobile") return "Smartphone"
  if (d === "tablet") return "Tablet"
  return "Monitor"
}
