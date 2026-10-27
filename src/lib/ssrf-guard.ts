/**
 * SSRF guard — defense-in-depth for any outbound HTTP fetch the server makes
 * to a URL that originated (directly or transitively) from user input.
 *
 * ## Why this file exists
 *
 * The dashboard stores two user-supplied URL-shaped fields today:
 *
 *   1. `Project.siteUrl`  — set when a project is created via
 *      `POST /api/projects`. It is parsed with `new URL(siteUrl)` for CORS
 *      origin matching on `/api/track/*`, but it is NOT currently fetched
 *      server-side. A future feature could fetch it (e.g. to validate the
 *      site exists before activation).
 *
 *   2. `Alert.webhookUrl` — set when an alert is created/updated via
 *      `POST /api/projects/[id]/alerts` or `PATCH .../[aid]`. It is stored
 *      but not yet fetched (delivery not implemented, per the A10 advisory
 *      in `src/lib/security-checklist.ts`). When delivery is implemented,
 *      it MUST route through `safeFetch()` so the URL is re-validated at
 *      request time (the stored value may have been tampered with via a
 *      DB-level compromise, and DNS may have been re-bound since storage).
 *
 * The LLM routes (`/api/projects/[id]/ai`, `/ai-search`, `/ai/session`)
 * call `z-ai-web-dev-sdk` whose endpoint is configured by env var, NOT by
 * user input — so they are out of scope here.
 *
 * ## What the guard does
 *
 *   - `validateUserUrl(url)` — synchronous, edge-safe. Validates scheme is
 *     `http:` or `https:`, hostname is not `localhost` / `0.0.0.0` / a
 *     private IP literal. Use this at WRITE time (validate before storing
 *     `siteUrl` / `webhookUrl`) so bad URLs never enter the DB.
 *
 *   - `safeFetch(url, init?)` — async, Node-only (uses `dns`). Resolves
 *     the hostname and blocks any resolved address that is private /
 *     loopback / link-local. Then issues `fetch()` with:
 *       - `redirect: "error"`  — never silently follow a 3xx to an
 *         internal host (a public site could 302 → 169.254.169.254).
 *       - `AbortSignal.timeout(5000)` — 5s hard cap so a stalling internal
 *         endpoint can't hang the request thread.
 *     Use this at FETCH time (validate again right before any outbound
 *     request) so DNS-rebinding and DB tampering are both covered.
 *
 * ## Known limits (documented, not ignored)
 *
 *   - TOCTOU: between `safeFetch`'s DNS resolution and the actual TCP
 *     connect, an attacker controlling a DNS server could re-bind the A
 *     record to a private IP. Mitigation: do the resolution ourselves and
 *     pass a resolved IP literal to `fetch` by rewriting the URL — the
 *     Node 18+ fetch honors the URL's hostname as the connect target.
 *     This file does NOT do that rewrite today (it would break TLS SNI /
 *     Host header validation), so the residual TOCTOU is documented. For
 *     most webhook delivery use cases this is acceptable; if you need
 *     belt-and-suspenders, fetch via a hardened proxy that pins the
 *     resolved IP.
 *
 *   - Edge runtime: `safeFetch` will throw if invoked from an Edge route
 *     handler because `dns` is unavailable. Keep webhook delivery (the
 *     only legitimate caller of `safeFetch`) in a Node runtime route.
 */
import { promises as dns } from "dns"

/**
 * True if `ip` is a private / loopback / link-local / unspecified address.
 *
 * Covers:
 *   - IPv4 loopback          127.0.0.0/8        (incl. 127.0.0.1)
 *   - IPv4 private           10.0.0.0/8
 *   - IPv4 private           172.16.0.0/12
 *   - IPv4 private           192.168.0.0/16
 *   - IPv4 link-local        169.254.0.0/16     (cloud metadata endpoint!)
 *   - IPv4 unspecified       0.0.0.0/8          (incl. 0.0.0.0)
 *   - IPv6 loopback          ::1
 *   - IPv6 unique-local      fc00::/7           (fc.. and fd..)
 *   - IPv6 link-local        fe80::/10
 *   - IPv4-mapped IPv6       ::ffff:v4 (the v4 part is checked too)
 *
 * The regex is anchored and case-insensitive; it matches by prefix so it
 * also catches `127.0.0.53` (systemd-resolved stub) and the like.
 */
export function isPrivateIP(ip: string): boolean {
  if (!ip || typeof ip !== "string") return true
  const v = ip.trim().toLowerCase()

  // IPv4-mapped IPv6 (::ffff:1.2.3.4) → unwrap the IPv4 part.
  const mapped = v.match(/^::ffff:([0-9.]+)$/)
  if (mapped) return isPrivateIPv4(mapped[1])

  // Pure IPv4 dotted-quad.
  if (/^[0-9.]+$/.test(v) && v.split(".").length === 4) {
    return isPrivateIPv4(v)
  }

  // IPv6 prefixes.
  if (v === "::1") return true
  if (v.startsWith("fc") || v.startsWith("fd")) return true // ULA fc00::/7
  if (v.startsWith("fe80:") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")) {
    return true
  }

  return false
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    // Not a clean dotted quad — be conservative and refuse.
    return true
  }
  const [a, b] = parts
  if (a === 0) return true // 0.0.0.0/8 "this network" / unspecified
  if (a === 10) return true // 10.0.0.0/8 private
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10 CGNAT (RFC 6598)
  return false
}

export type UrlValidation =
  | { ok: true; url: URL }
  | { ok: false; reason: string }

/**
 * Validate a user-supplied URL at WRITE time (before persistence).
 *
 * Edge-safe — uses only `URL` parsing, no `dns`. Returns `ok: true` with
 * the parsed `URL` (rewritten to drop any userinfo / fragment / trailing
 * junk) or `ok: false` with a reason string.
 *
 * Rules:
 *   - Must parse as a URL.
 *   - Scheme MUST be `http:` or `https:`.
 *   - Hostname MUST NOT be `localhost`, `0.0.0.0`, `::1`, or any IP
 *     literal that `isPrivateIP` blocks.
 *   - Hostname MUST contain at least one `.` (rejects bare TLDs / NetBIOS
 *     names like `internal-api`).
 *   - userinfo (`user:pass@`) is stripped — never persisted alongside a
 *     URL we might later fetch.
 *
 * Pass the returned `url.href` to Prisma, NOT the raw input.
 */
export function validateUserUrl(raw: string | null | undefined): UrlValidation {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "missing url" }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, reason: "invalid url" }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "scheme not http/https" }
  }
  // Strip userinfo — never persist credentials embedded in a URL field.
  u.username = ""
  u.password = ""
  // Drop fragment — irrelevant to a fetch target.
  u.hash = ""
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "") // strip IPv6 brackets

  if (!host) return { ok: false, reason: "empty host" }
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") {
    return { ok: false, reason: "host is localhost / unspecified" }
  }
  if (isPrivateIP(host)) return { ok: false, reason: "host is private ip" }
  // Require a dot — this rejects NetBIOS / single-label hostnames like
  // `intranet` or `metadata` which would resolve via the host's resolver
  // and could land on internal infrastructure.
  if (!host.includes(".")) return { ok: false, reason: "host must be fqdn" }
  return { ok: true, url: u }
}

/**
 * Convenience boolean wrapper around `validateUserUrl`.
 */
export function isValidUserUrl(raw: string | null | undefined): boolean {
  return validateUserUrl(raw).ok
}

/**
 * Issue a fetch to `url` with SSRF defenses applied at request time.
 *
 * NODE RUNTIME ONLY — uses `dns.promises.lookup`. Do not call from an Edge
 * route handler; the call will throw `dns is not available`.
 *
 * Defenses:
 *   1. Re-parse + scheme/host allowlist (same as `validateUserUrl`).
 *   2. Resolve the hostname via DNS and reject if any resolved address is
 *      private / loopback / link-local. Catches DNS-rebinding where a
 *      public-looking domain points at 169.254.169.254.
 *   3. Set `redirect: "error"` — never silently follow a 3xx. A
 *      redirect from a benign public URL to an internal host is a classic
 *      SSRF bypass; we make the fetch throw instead.
 *   4. Hard 5s timeout via `AbortSignal.timeout` — so a stalled internal
 *      endpoint can't hang the request thread.
 *
 * The caller is expected to have already validated the URL at storage
 * time via `validateUserUrl`; this function re-validates at fetch time
 * because DNS and the stored value may have changed between write and read.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  // 1. Parse + scheme / IP-literal allowlist.
  const v = validateUserUrl(url)
  if (!v.ok) {
    throw new Error(`ssrf: ${v.reason}`)
  }
  const u = v.url
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")

  // 2. DNS resolution — block if ANY A/AAAA record is private. We don't
  //    pin the IP for the actual fetch (that would break TLS SNI and Host
  //    header), so a TOCTOU between resolve and connect is still possible;
  //    documented in the file header.
  try {
    const records = await dns.lookup(host, { all: true })
    if (records.length === 0) throw new Error("ssrf: no dns records")
    for (const r of records) {
      if (isPrivateIP(r.address)) {
        throw new Error(`ssrf: resolved private ip ${r.address}`)
      }
    }
  } catch (e) {
    // Re-throw our own "ssrf:" errors verbatim; wrap DNS lookup failures.
    if (e instanceof Error && e.message.startsWith("ssrf:")) throw e
    throw new Error(`ssrf: dns lookup failed (${(e as Error).message})`)
  }

  // 3. + 4. Issue the fetch with no-redirect + timeout. We use
  // AbortSignal.timeout(5000) so a stalled internal endpoint can't hang
  // the request thread. If the caller passed their own AbortSignal (e.g.
  // for a cancellation token from an outer request), honor it instead —
  // the caller is then responsible for any timeout.
  try {
    const signal = init.signal ?? AbortSignal.timeout(5000)
    return await fetch(u.href, {
      ...init,
      redirect: "error",
      signal,
    })
  } catch (e) {
    // Distinguish "took too long" from a thrown fetch error so the
    // caller gets a useful message rather than an opaque AbortError.
    if (e instanceof Error && e.name === "TimeoutError") {
      throw new Error("ssrf: fetch timeout (5s)")
    }
    if (e instanceof Error && e.name === "AbortError") {
      // Caller-supplied signal aborted — rethrow as-is so they see their
      // own abort reason, not our "ssrf:" prefix.
      throw e
    }
    throw e
  }
}
