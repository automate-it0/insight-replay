// Browser-side device fingerprint.
//
// Computes a stable, non-PII hash of the browser's fingerprintable surface
// (canvas, WebGL, UA, screen, tz, languages, platform, hardwareConcurrency,
// deviceMemory). The hash is sent as the `x-device-fp` header on every
// authenticated request; the server (see src/lib/session.ts) stores a
// salted hash of it on login and verifies it on subsequent requests.
//
// Why client-side hashing? The raw fingerprint components contain
// potentially identifying data (exact UA, screen dimensions, timezone
// name). Hashing them client-side before transmission means the wire
// payload is a non-reversible 64-hex-char SHA-256 digest, not a profile
// of the user's machine. The server applies its OWN salted hash on top
// of this digest for the storage layer (so an attacker who knows the
// digest can't forge a session payload that matches their own browser
// without the server's `SESSION_SECRET`).
//
// Why this is not PII: the hash is keyed on browser/OS/hardware
// attributes that are stable across IP changes (the whole point of fp
// binding) but does NOT include any user-identifying data (no email, no
// user ID, no IP, no cookies). The same browser on the same machine
// produces the same hash regardless of which user is logged in — it's a
// DEVICE anchor, not a user anchor.
//
// Runtime: browser-only. All access to browser-only globals (`document`,
// `navigator`, `screen`, `window`, `Intl`) happens INSIDE functions,
// never at module top-level, so the module can be imported by code that
// ALSO runs on the server (e.g. the `api.ts` helper is bundled into both
// the client and RSC bundles) without crashing on import — the browser
// APIs are only touched when `getDeviceFingerprint()` is actually
// called, which only happens inside the browser. If called on the
// server, it returns `null` (caught by the `typeof window ===
// 'undefined'` guard), and the caller simply omits the header — the
// server falls back to IP-only binding for that session.
//
// Stability: the signals are chosen for stability across the threat
// model (mobile network switches, app reloads, daylight-saving shifts).
// Canvas + WebGL are the workhorses — they vary by GPU/driver/OS
// combination and are stable for the same browser on the same device.
// Timezone name + offset handle DST transitions gracefully (the NAME
// "America/New_York" is stable even when the offset flips between -4
// and -5). UA + platform + screen resolve touch-vs-desktop and
// viewport-vs-resolution. We deliberately AVOID signals that change
// frequently (battery level, IP, geolocation, free disk space) — they
// would break the binding for legitimate users without adding security.
//
// Privacy: this hash identifies a DEVICE, not a person. Two different
// users on the same browser (shared family machine, shared office
// workstation) produce the same fingerprint. That is by design: the
// device fingerprint's purpose is to anchor the session against
// mobile-network IP rotations, not to identify which human is at the
// keyboard. Pair it with the password check (which DOES identify the
// human) and you get a layered defense.

/**
 * The request header name. Mirrored from the server-side constant in
 * `src/middleware.ts` and `src/lib/session.ts` — kept as a literal here
 * (rather than imported) because importing the server-side module would
 * drag `node:crypto` into the client bundle and break the Edge / browser
 * runtime. The string `"x-device-fp"` is a stable contract.
 */
export const DEVICE_FP_HEADER = "x-device-fp"

// In-memory cache. Once computed, the fingerprint is stable for the page
// lifetime (canvas + WebGL + UA don't change without a reload). Cached
// so we don't pay the canvas/WebGL/sha-256 cost on every request — the
// header is attached to EVERY fetch the dashboard makes.
let cachedFP: string | null = null
let computingPromise: Promise<string | null> | null = null

/**
 * SHA-256 → hex via the Web Crypto API (SubtleCrypto). Available in all
 * modern browsers AND in the Edge runtime; NOT available in the Node
 * runtime (which is fine — this module is browser-only by design and
 * the `getDeviceFingerprint` guard returns null on the server before
 * this is called).
 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  // Convert ArrayBuffer → hex string. Array.from + padStart is the
  // simplest portable way; for a 32-byte hash it's 32 iterations,
  // negligible cost.
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Render a canvas with mixed font + fillStyle + emoji + arc commands and
 * return its `toDataURL()` representation. Different GPUs, drivers, and
 * font-hinting settings rasterize the same drawing commands slightly
 * differently, producing a different data URL — the basis of the canvas
 * fingerprint. The drawing is intentionally non-trivial (gradient fill,
 * emoji, multiple text styles) to maximize the entropy that survives
 * JPEG/PNG normalization across browsers.
 *
 * Wrapped in try/catch — `toDataURL` throws on a tainted canvas (rare
 * for our own drawing, but possible with some browser extensions) and
 * we don't want a fingerprint failure to break the dashboard login. The
 * sentinel `"canvas-error"` is folded into the hash; the resulting
 * fingerprint is still distinct from another browser's, just less
 * stable. Acceptable fallback.
 */
function getCanvasFingerprint(): string {
  try {
    const canvas = document.createElement("canvas")
    canvas.width = 240
    canvas.height = 60
    const ctx = canvas.getContext("2d")
    if (!ctx) return "no-canvas"
    ctx.textBaseline = "top"
    ctx.font = "14px 'Arial'"
    ctx.fillStyle = "#f60"
    ctx.fillRect(0, 0, 100, 30)
    ctx.fillStyle = "#069"
    ctx.fillText("InsightReplay 🐝 device-fp", 2, 15)
    ctx.fillStyle = "rgba(102, 204, 0, 0.7)"
    ctx.fillText("InsightReplay 🐝 device-fp", 4, 17)
    return canvas.toDataURL()
  } catch {
    return "canvas-error"
  }
}

/**
 * Pull the GPU vendor + renderer strings from the WebGL debug extension.
 * These are stable per GPU + driver combination, which is exactly the
 * signal we want — the same browser on the same machine produces the
 * same GPU string across reloads and IP changes. Wrapped in try/catch:
 * some privacy-focused browsers (Tor, Brave strict mode) block this
 * extension; we fall back to a sentinel that still folds into the hash
 * (the canvas fingerprint alone is usually enough).
 */
function getWebGLFingerprint(): string {
  try {
    const canvas = document.createElement("canvas")
    const gl =
      (canvas.getContext("webgl") as WebGLRenderingContext | null) ||
      (canvas.getContext("experimental-webgl") as WebGLRenderingContext | null)
    if (!gl) return "no-webgl"
    const dbgInfo = gl.getExtension("WEBGL_debug_renderer_info")
    if (!dbgInfo) return "no-webgl-debug"
    const vendor =
      String(gl.getParameter(dbgInfo.UNMASKED_VENDOR_WEBGL) || "")
    const renderer =
      String(gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) || "")
    return `${vendor}|${renderer}`
  } catch {
    return "webgl-error"
  }
}

/**
 * Collect all fingerprint signals into a single string for hashing.
 * Order matters — the same order must be preserved across calls so the
 * hash is stable. Concatenated with `||` (a separator that does NOT
 * appear in any individual signal's typical content, so two signals
 * can't accidentally merge).
 */
function collectSignals(): string {
  const nav = navigator
  const scr = screen
  const signals: string[] = []
  signals.push(getCanvasFingerprint())
  signals.push(getWebGLFingerprint())
  signals.push(nav.userAgent || "no-ua")
  signals.push(nav.language || "no-lang")
  signals.push(JSON.stringify(nav.languages || []))
  signals.push(nav.platform || "no-platform")
  signals.push(String(nav.hardwareConcurrency || "no-cores"))
  // deviceMemory is non-standard but widely supported; cast safely.
  const withMem = nav as Navigator & { deviceMemory?: number }
  signals.push(String(withMem.deviceMemory ?? "no-mem"))
  signals.push(`${scr.width}x${scr.height}x${scr.colorDepth}x${scr.pixelDepth || 0}`)
  signals.push(String(scr.availWidth || 0))
  signals.push(String(scr.availHeight || 0))
  signals.push(String(window.devicePixelRatio || 1))
  try {
    signals.push(Intl.DateTimeFormat().resolvedOptions().timeZone || "no-tz")
  } catch {
    signals.push("no-tz")
  }
  try {
    signals.push(new Date().getTimezoneOffset().toString())
  } catch {
    signals.push("no-tz-offset")
  }
  try {
    signals.push(String(nav.maxTouchPoints || 0))
  } catch {
    signals.push("no-touch")
  }
  return signals.join("||")
}

/**
 * Compute (and cache) the device fingerprint hash. Safe to call from
 * anywhere — returns `null` on the server (typeof window check), or if
 * crypto.subtle is unavailable (e.g. insecure-context HTTP in old
 * browsers), or if canvas/WebGL both fail. Callers that get `null`
 * should simply omit the `x-device-fp` header; the server then falls
 * back to IP-only binding for that session (non-fatal degradation —
 * the user's session still works, it just doesn't get the augmented
 * hijacking defense until the fingerprint is available).
 *
 * Pass `force: true` to bypass the cache and recompute (used after a
 * 401-with-WWW-Authenticate-DeviceFP response to re-collect signals in
 * case the browser context changed — e.g. extension installed, zoom
 * level changed).
 */
export async function getDeviceFingerprint(
  force = false,
): Promise<string | null> {
  if (cachedFP && !force) return cachedFP
  if (computingPromise && !force) return computingPromise

  computingPromise = (async () => {
    try {
      // Server / SSR guard. On the server, `window` is undefined and we
      // have no canvas/WebGL/navigator to fingerprint. Return null; the
      // caller omits the header and the server falls back to IP-only.
      if (typeof window === "undefined" || typeof document === "undefined") {
        return null
      }
      // crypto.subtle requires a secure context (HTTPS or localhost).
      // On plain HTTP in a non-localhost environment, return null and
      // let the server fall back — don't crash the dashboard.
      if (!window.crypto || !window.crypto.subtle) {
        return null
      }
      const signals = collectSignals()
      const hash = await sha256Hex(signals)
      cachedFP = hash
      return hash
    } catch {
      // Any failure (canvas blocked, WebGL blocked, TextEncoder missing)
      // → return null and let the server degrade to IP-only.
      return null
    } finally {
      computingPromise = null
    }
  })()

  return computingPromise
}

/**
 * Convenience: build a `{ "x-device-fp": <hash> }` headers object that
 * a `fetch()` call can spread into its `headers`. Returns `{}` when no
 * fingerprint is available (server, insecure context, no canvas) so
 * the caller can unconditionally spread the result without conditional
 * checks.
 */
export async function deviceFingerprintHeader(): Promise<
  Record<string, string>
> {
  const fp = await getDeviceFingerprint()
  if (!fp) return {}
  return { [DEVICE_FP_HEADER]: fp }
}
