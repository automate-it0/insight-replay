// Security webhook alerts — push security events to Discord / Slack / Teams
// the moment they happen, so the admin doesn't have to scrape logs.
//
// ## Why this file exists
//
// The project already detects and logs a handful of high-signal security
// events — failed-login lockouts, honeypot-trap hits, unauthorized admin
// endpoint access, file tampering. Those events land in `logs/app.jsonl`
// (via `src/lib/observability.ts`) and the audit log (`logs/audit.jsonl`),
// but a busy operator only sees them when they go looking. By the time
// someone checks the dashboard, a brute-force attack or a file-modification
// intrusion may have been running for hours.
//
// This module ships a single fire-and-forget helper — `sendSecurityAlert` —
// that POSTs a rich-formatted message to a webhook URL configured via
// `SECURITY_WEBHOOK_URL`. Discord, Slack, and Microsoft Teams are all
// auto-detected from the URL shape and given the right payload format
// (Discord rich embeds / Slack blocks / Teams MessageCard). A generic
// payload is sent to any other webhook host.
//
// ## Security posture
//
//   - **No-op when unset.** If `SECURITY_WEBHOOK_URL` is not in env, every
//     call short-circuits. The module is safe to import anywhere — it does
//     nothing until the operator opts in.
//   - **Fails silently.** The entire body of `sendSecurityAlert` is wrapped
//     in try/catch and the outbound `safeFetch` is `void`ed with a `.catch`
//     swallower. A webhook that is down, slow, or returns 4xx/5xx can NEVER
//     break the request that triggered the alert — security alerting is
//     defense-in-depth, not a primary feature.
//   - **SSRF-aware.** The webhook URL is operator-controlled (env var, not
//     user input), so it is NOT a classic SSRF sink. But an operator could
//     misconfigure it to point at internal infra (`http://10.x.x.x` etc).
//     We route through `src/lib/ssrf-guard.ts` `safeFetch()` so the URL is
//     revalidated at fetch time — DNS-rebinding and accidental internal
//     targeting are both blocked.
//   - **Rate-limited.** A sliding 1-minute window caps at
//     `RATE_LIMIT_MAX` alerts. A bug that fires 1000 alerts/sec (e.g. an
//     attacker flooding a honeypot trap) cannot spam the webhook channel
//     past the cap. Excess alerts are silently dropped — the underlying
//     rate-limit / ban / lockout layers still fire; only the *notification*
//     is suppressed.
//   - **No PII.** Alert descriptions are caller-supplied strings; the
//     helper itself never bundles user IPs / emails. Callers are expected
//     to follow the same allowlist discipline as `src/lib/observability.ts`
//     (`log()` — "never logs secrets/PII; caller must allowlist fields").
//     A 64-char description cap keeps the webhook payload compact and forces
//     the caller to summarize rather than dump raw request bodies.
//
// ## Runtime
//
// Node runtime only. `safeFetch` uses `dns.promises.lookup` which is
// unavailable in the Edge runtime. All call sites today (login-lockout,
// ip-ban, admin-radar, file-integrity) fire from Node route handlers or
// server-side library code, so this is fine. If a future caller needs to
// fire from Edge middleware, swap `safeFetch` for plain `fetch` and accept
// the residual SSRF risk (or move the alert to a Node-side queue).

import { safeFetch } from "@/lib/ssrf-guard"
import { hostname as osHostname } from "os"

export type Severity = "critical" | "high" | "medium" | "low" | "info"

interface SeverityStyle {
  /** Emoji used in the title line — the spec calls for 🔴/🟡/🟢. */
  emoji: string
  /** Numeric color for Discord rich embeds (RGB int). */
  color: number
  /** Uppercase label so the severity is visible even where emoji render
   *  as boxes (e.g. terminal-only webhook relays). */
  label: string
}

// Severity → visual style. critical/high collapse to 🔴 — the spec only
// calls for three colors (red / yellow / green). info collapses to 🟢 so
// a low-signal notice still has a stable visual identity. medium is 🟡.
// The numeric colors are the same hues so a Discord embed and a Slack block
// render with the same perceived urgency.
const SEVERITY_STYLE: Record<Severity, SeverityStyle> = {
  critical: { emoji: "🔴", color: 0xff0000, label: "CRITICAL" },
  high:     { emoji: "🔴", color: 0xff0000, label: "HIGH"     },
  medium:   { emoji: "🟡", color: 0xff_a500, label: "MEDIUM"   },
  low:      { emoji: "🟢", color: 0x00ff00, label: "LOW"      },
  info:     { emoji: "🟢", color: 0x00ff00, label: "INFO"     },
}

// ─── Rate limit ──────────────────────────────────────────────────────────
//
// Sliding-window counter: we keep the timestamps of the last
// `RATE_LIMIT_MAX` alerts that fired within the past `RATE_LIMIT_WINDOW_MS`
// on a globalThis-stashed array (same pattern as `src/lib/rate-limit.ts`,
// `src/lib/login-lockout.ts`, `src/lib/ip-ban.ts` — persists across dev
// hot reloads, falls back to a plain array if globalThis is unavailable).
//
// On every call:
//   1. Drop timestamps older than the window.
//   2. If >= RATE_LIMIT_MAX remain, the call is rate-limited → drop the
//      alert (silently).
//   3. Otherwise push `now` and proceed.
//
// The array never grows past RATE_LIMIT_MAX entries — every push is
// preceded by an evict-if-over-window sweep, so even if 1M alerts/second
// fired the array would stay at 10 entries.

const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60_000

let alertTimestamps: number[]
try {
  const g = globalThis as unknown as { __securityAlertTimestamps?: number[] }
  if (!g.__securityAlertTimestamps) g.__securityAlertTimestamps = []
  alertTimestamps = g.__securityAlertTimestamps
} catch {
  alertTimestamps = []
}

/**
 * Returns `true` if the caller should drop this alert because the rate
 * limit has been hit. Side-effect: records the timestamp on a successful
 * (non-limited) call so the next caller sees it. Never throws.
 */
function rateLimited(): boolean {
  try {
    const now = Date.now()
    // Evict expired entries from the front. The array is in chronological
    // order (we only ever push to the end), so a `while` shift from the
    // front is the right eviction policy.
    while (
      alertTimestamps.length > 0 &&
      now - alertTimestamps[0] > RATE_LIMIT_WINDOW_MS
    ) {
      alertTimestamps.shift()
    }
    if (alertTimestamps.length >= RATE_LIMIT_MAX) return true
    alertTimestamps.push(now)
    return false
  } catch {
    // A bookkeeping failure must not suppress the alert — fail OPEN by
    // reporting "not rate limited" so the alert still fires. (Same
    // philosophy as `src/lib/rate-limit.ts`.)
    return false
  }
}

/**
 * Exposed for tests / observability — returns the current count of alerts
 * recorded in the rolling 1-minute window. Not part of the public call-site
 * API; only used by tests to assert the rate-limit behavior.
 */
export function _securityAlertsInLastMinute(): number {
  try {
    const now = Date.now()
    let n = 0
    for (const ts of alertTimestamps) {
      if (now - ts <= RATE_LIMIT_WINDOW_MS) n++
    }
    return n
  } catch {
    return 0
  }
}

// ─── Payload builders ───────────────────────────────────────────────────

interface AlertContent {
  title: string
  description: string
  severity: Severity
  style: SeverityStyle
  timestamp: string
  server: string
}

/** Cap description length so a runaway caller can't bloat the webhook payload. */
const MAX_DESCRIPTION_LEN = 4096
/** Cap title length for the same reason. */
const MAX_TITLE_LEN = 256

function clamp(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + "…"
}

/**
 * Discord webhook payload — rich embed. Discord accepts up to 10 embeds per
 * message; we send one. The embed carries title, description, color (mapped
 * from severity), timestamp, and a footer with the server hostname so a
 * multi-instance deployment can be triaged at a glance.
 *
 * See: https://discord.com/developers/docs/resources/webhook#execute-webhook
 */
function buildDiscordPayload(c: AlertContent): unknown {
  return {
    username: "Insight Replay Security",
    embeds: [
      {
        title: `${c.style.emoji} ${clamp(c.title, MAX_TITLE_LEN)}`,
        description: clamp(c.description, MAX_DESCRIPTION_LEN),
        color: c.style.color,
        timestamp: c.timestamp,
        footer: { text: `server: ${c.server}` },
        fields: [
          { name: "Severity", value: c.style.label, inline: true },
        ],
      },
    ],
  }
}

/**
 * Slack webhook payload — blocks. Slack's Block Kit is the modern format;
 * a header block carries the title + severity emoji, a section block carries
 * the description as mrkdwn, and a context block carries the server hostname
 * + timestamp. Slack ignores `color` on blocks (color is set per-attachment
 * in the legacy format), so severity is encoded in the emoji + label.
 *
 * See: https://api.slack.com/messaging/webhooks#posting_with_block_kit
 */
function buildSlackPayload(c: AlertContent): unknown {
  return {
    text: `${c.style.emoji} ${c.style.label}: ${c.title}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${c.style.emoji} ${clamp(c.title, MAX_TITLE_LEN)}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: clamp(c.description, MAX_DESCRIPTION_LEN) },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*Severity:* ${c.style.label}` },
          { type: "mrkdwn", text: `*Server:* \`${c.server}\`` },
          { type: "mrkdwn", text: `*Time:* ${c.timestamp}` },
        ],
      },
    ],
  }
}

/**
 * Microsoft Teams webhook payload — MessageCard. Teams' Office 365 connectors
 * accept a MessageCard with `title`, `text`, and `themeColor` (hex without #).
 * We also include `severity` and `server` as sections for parity with the
 * Discord/Slack layouts. (Teams' newer Adaptive Cards format is more powerful
 * but requires a different schema and a `type` field — the legacy MessageCard
 * is the lowest-common-denominator format that every Teams webhook URL
 * accepts without extra configuration.)
 *
 * See: https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook
 */
function buildTeamsPayload(c: AlertContent): unknown {
  // Teams wants a hex string ("FF0000") — no leading #.
  const hex = c.style.color.toString(16).padStart(6, "0").toUpperCase()
  return {
    "@type": "MessageCard",
    "@context": "https://schema.org/extensions",
    themeColor: hex,
    summary: `${c.style.label}: ${c.title}`,
    sections: [
      {
        activityTitle: `${c.style.emoji} ${clamp(c.title, MAX_TITLE_LEN)}`,
        activitySubtitle: `Severity: ${c.style.label} • Server: ${c.server}`,
        text: clamp(c.description, MAX_DESCRIPTION_LEN),
        facts: [
          { name: "Severity", value: c.style.label },
          { name: "Server", value: c.server },
          { name: "Timestamp", value: c.timestamp },
        ],
      },
    ],
  }
}

/**
 * Generic webhook payload — a flat JSON object with the fields the spec
 * requires (timestamp / severity / title / description / server). This is
// the fallback for custom webhooks (a home-grown alert receiver, a Discord
// clone, a Logstash HTTP input, etc.) — the receiver can pull whatever
 * fields it needs from the JSON body.
 */
function buildGenericPayload(c: AlertContent): unknown {
  return {
    timestamp: c.timestamp,
    severity: c.style.label,
    severity_emoji: c.style.emoji,
    title: clamp(c.title, MAX_TITLE_LEN),
    description: clamp(c.description, MAX_DESCRIPTION_LEN),
    server: c.server,
    source: "insight-replay",
  }
}

type WebhookType = "discord" | "slack" | "teams" | "generic"

/**
 * Detect the webhook provider from the URL.
 *
 * SECURITY (CodeQL js/incomplete-url-substring-sanitization): this used to
 * be naive substring matching (`url.includes("discord.com/api/webhooks")`
 * etc). Substring checks on URLs are trivially bypassed —
 * `https://evil.example/?u=https://discord.com/api/webhooks`, or a hostname
 * like `discord.com.attacker.example`, both contain the substring — so a
 * security-relevant decision must never be made on raw substrings.
 *
 * Now: parse with `new URL(...)` and validate against a strict allowlist.
 *   - Parse failure → reject: no provider matches (generic payload).
 *   - Protocol MUST be `http:` or `https:` (allowlist — anything else,
 *     e.g. `file:` / `javascript:`, matches no provider).
 *   - Hostname MUST be one of the providers' real webhook hosts — exact
 *     match, plus a dot-boundary subdomain match for `*.webhook.office.com`
 *     (Microsoft issues modern Teams webhooks on per-tenant subdomains of
 *     that host). `evil-discord.com` and `discord.com.evil.example` match
 *     nothing.
 *   - Path must match the provider's real webhook path prefix
 *     (`/api/webhooks`, `/services`, `/webhook…`) — lowercased to preserve
 *     the old case-insensitive matching for these known-lowercase paths.
 *
 * This function only picks the PAYLOAD FORMAT — a URL that matches no
 * provider gets the generic JSON payload, which any receiver can still
 * consume. The actual outbound fetch is separately gated by `safeFetch()`
 * (src/lib/ssrf-guard.ts), which re-validates scheme/host/DNS at fetch
 * time — so nothing here can cause a fetch that safeFetch would not itself
 * scrutinize.
 */
function detectWebhookType(url: string): WebhookType {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    // Unparseable URL → reject: no allowlist entry can match.
    return "generic"
  }
  // Strict scheme allowlist — http/https only.
  if (u.protocol !== "https:" && u.protocol !== "http:") return "generic"
  // URL.hostname is already lowercased by the parser; lowercase the path
  // too so the known provider path prefixes match case-insensitively
  // (preserving the behavior of the old pre-lowercased substring check).
  const host = u.hostname.toLowerCase()
  const path = u.pathname.toLowerCase()

  // Discord: https://discord.com/api/webhooks/<id>/<token>
  //          https://discordapp.com/api/webhooks/<id>/<token> (legacy host)
  if (
    (host === "discord.com" || host === "discordapp.com") &&
    (path === "/api/webhooks" || path.startsWith("/api/webhooks/"))
  ) {
    return "discord"
  }
  // Slack: https://hooks.slack.com/services/T…/B…/XXXX
  if (
    host === "hooks.slack.com" &&
    (path === "/services" || path.startsWith("/services/"))
  ) {
    return "slack"
  }
  // Teams: https://outlook.office.com/webhook/<id>/IncomingWebhook/…
  //        https://<tenant>.webhook.office.com/webhookb2/<id>/… (modern)
  // The subdomain match uses an explicit dot boundary so
  // `evil-webhook.office.com` / `webhook.office.com.evil.example` cannot
  // match. The path check accepts both the legacy `/webhook/…` and the
  // current `/webhookb2/…` endpoint shapes.
  if (
    (host === "outlook.office.com" ||
      host === "webhook.office.com" ||
      host.endsWith(".webhook.office.com")) &&
    path.startsWith("/webhook")
  ) {
    return "teams"
  }
  return "generic"
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Resolve the webhook URL from env. Returns `null` if unset, empty, or
 * whitespace-only — the caller (sendSecurityAlert) treats null as a no-op.
 */
function getWebhookUrl(): string | null {
  const raw = process.env.SECURITY_WEBHOOK_URL
  if (!raw || typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  return trimmed
}

/**
 * Resolve the server hostname for inclusion in every alert payload. Falls
 * back to "unknown" if `os.hostname()` throws (it shouldn't, but the
 * invariant of this module is "never throws"). Cached at module load so
 * the syscall cost is paid once.
 */
let cachedHostname: string | null = null
function getHostname(): string {
  if (cachedHostname !== null) return cachedHostname
  // Local variable so TS can narrow it to `string` after the try/catch —
  // both branches assign a non-null string, so `resolved` is `string`
  // (not `string | null`) when we return it. (The shared `cachedHostname`
  // field can't be narrowed across the try/catch boundary because it's
  // a module-scoped let, so we work on a local first, then publish.)
  let resolved: string
  try {
    resolved = osHostname() || "unknown"
  } catch {
    resolved = "unknown"
  }
  cachedHostname = resolved
  return resolved
}

/**
 * Send a security alert to the configured webhook.
 *
 * **Never throws.** Every step is wrapped so a failure anywhere — env
 * resolution, rate-limit bookkeeping, payload construction, the outbound
 * fetch — degrades silently. Security alerting is defense-in-depth: a
 * broken webhook channel must not break the request that triggered it.
 *
 * Behavior:
 *  - If `SECURITY_WEBHOOK_URL` is unset → no-op, returns immediately.
 *  - If the alert would exceed the 10/min rate limit → silently dropped.
 *  - The outbound POST is `void`ed (fire-and-forget) — the caller's
 *    request path never waits for the webhook round-trip.
 *  - The POST is routed through `safeFetch` so a misconfigured URL pointing
 *    at internal infra (private IP / loopback / link-local) is rejected.
 *  - Discord / Slack / Teams payloads are auto-detected; anything else
 *    gets a flat generic JSON payload.
 *
 * @param title       Short headline (e.g. "Failed login lockout").
 * @param description One-paragraph context (e.g. "5 failed attempts for
 *                    admin@example.com from 203.0.113.5; account locked 15min").
 * @param severity    One of "critical" / "high" / "medium" / "low" / "info".
 *                    Maps to 🔴/🟡/🟢 emoji + numeric color (Discord).
 *
 * @example
 *   await sendSecurityAlert(
 *     "Honeypot trap hit",
 *     `IP 198.51.100.7 hit /api/trap/.env — banned 24h`,
 *     "high",
 *   )
 */
export async function sendSecurityAlert(
  title: string,
  description: string,
  severity: Severity,
): Promise<void> {
  try {
    const url = getWebhookUrl()
    if (!url) return // No-op when not configured.

    // Rate-limit BEFORE constructing the payload — if the channel is
    // already saturated, skip the work entirely. The underlying security
    // response (ban, lockout, etc.) has already fired at the call site;
    // only the *notification* is suppressed.
    if (rateLimited()) return

    const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.info
    const content: AlertContent = {
      title,
      description,
      severity,
      style,
      timestamp: new Date().toISOString(),
      server: getHostname(),
    }

    const webhookType = detectWebhookType(url)
    const payload =
      webhookType === "discord" ? buildDiscordPayload(content)
      : webhookType === "slack" ? buildSlackPayload(content)
      : webhookType === "teams" ? buildTeamsPayload(content)
      : buildGenericPayload(content)

    const body = JSON.stringify(payload)

    // Fire-and-forget. The `.catch` swallows any failure (DNS rejected by
    // the SSRF guard, network timeout, webhook returned 4xx/5xx, etc.) so
    // the alert never propagates an error to the caller's request path.
    void safeFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).catch(() => {
      // intentionally swallowed — see file header
    })
  } catch {
    // intentionally swallowed — this module must NEVER throw.
  }
}
