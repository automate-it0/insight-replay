// Simple user-agent parser (no external deps)
export interface UAInfo {
  browser: string
  os: string
  device: string // desktop | mobile | tablet
}

export function parseUA(ua: string): UAInfo {
  const u = ua || ""
  let browser = "Chrome"
  if (/Edg\//.test(u)) browser = "Edge"
  else if (/OPR\//.test(u)) browser = "Opera"
  else if (/Firefox\//.test(u)) browser = "Firefox"
  else if (/Chrome\//.test(u)) browser = "Chrome"
  else if (/Safari\//.test(u) && !/Chrome\//.test(u)) browser = "Safari"

  let os = "Windows"
  if (/Windows NT 10/.test(u)) os = "Windows"
  else if (/Windows/.test(u)) os = "Windows"
  else if (/Mac OS X/.test(u)) os = "macOS"
  else if (/Android/.test(u)) os = "Android"
  else if (/iPhone|iPad|iPod/.test(u)) os = "iOS"
  else if (/Linux/.test(u)) os = "Linux"

  let device: UAInfo["device"] = "desktop"
  if (/iPad|Tablet/.test(u)) device = "tablet"
  else if (/Mobi|Android|iPhone/.test(u)) device = "mobile"

  return { browser, os, device }
}

const COUNTRIES = [
  { country: "United States", city: "New York" },
  { country: "United States", city: "San Francisco" },
  { country: "United Kingdom", city: "London" },
  { country: "Germany", city: "Berlin" },
  { country: "France", city: "Paris" },
  { country: "Japan", city: "Tokyo" },
  { country: "India", city: "Mumbai" },
  { country: "Brazil", city: "São Paulo" },
  { country: "Canada", city: "Toronto" },
  { country: "Australia", city: "Sydney" },
  { country: "Egypt", city: "Cairo" },
  { country: "Netherlands", city: "Amsterdam" },
  { country: "Singapore", city: "Singapore" },
  { country: "Spain", city: "Madrid" },
  { country: "Italy", city: "Rome" },
]

export function fakeGeo(ip: string) {
  // Deterministic-ish pseudo geo from ip hash
  let h = 0
  for (let i = 0; i < ip.length; i++) h = (h * 31 + ip.charCodeAt(i)) >>> 0
  const c = COUNTRIES[h % COUNTRIES.length]
  return c
}

/**
 * GDPR: anonymize an IP address before storage.
 *  - IPv4: zero the last octet  ("192.168.1.42" -> "192.168.1.0")
 *  - IPv6: zero the last 4 groups / 80 bits  ("2001:db8:85a3::8a2e:370:7334" -> "2001:db8:85a3::")
 *  - "unknown" / invalid / empty: returns "0.0.0.0"
 *  - Handles edge cases: leading/trailing whitespace, IPv4 with port ("1.2.3.4:80"),
 *    IPv6 in brackets ("[::1]") and IPv6 in brackets with port ("[::1]:443").
 */
export function anonymizeIP(ip: string): string {
  if (!ip || ip === "unknown") return "0.0.0.0"

  let s = ip.trim()

  // Strip IPv6 brackets: "[::1]" or "[::1]:443"
  if (s.startsWith("[")) {
    const close = s.indexOf("]")
    if (close > 0) s = s.slice(1, close)
  }

  // IPv4 with optional port:  "1.2.3.4"  or  "1.2.3.4:80"
  const v4 = s.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?::\d+)?$/)
  if (v4) {
    const parts = v4[1].split(".")
    const valid = parts.every((p) => {
      const n = Number(p)
      return n >= 0 && n <= 255 && String(n) === p
    })
    if (!valid) return "0.0.0.0"
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`
  }

  // IPv6: must contain at least one ":" and no decimal port suffix dangling.
  // (A bare trailing ":port" without brackets is ambiguous for IPv6, so we
  //  only handle bracketed form above — RFC 5952 recommends brackets when
  //  a port is present.)
  if (s.includes(":")) {
    const hasDoubleColon = s.includes("::")
    let groups: number[]

    if (hasDoubleColon) {
      // Only one "::" allowed per address.
      if (s.indexOf("::") !== s.lastIndexOf("::")) return "0.0.0.0"
      const [leftStr = "", rightStr = ""] = s.split("::")
      const left = leftStr ? leftStr.split(":") : []
      const right = rightStr ? rightStr.split(":") : []
      const missing = 8 - left.length - right.length
      if (missing < 0) return "0.0.0.0"
      groups = [
        ...left.map((g) => parseInt(g || "0", 16)),
        ...Array(missing).fill(0),
        ...right.map((g) => parseInt(g || "0", 16)),
      ]
    } else {
      groups = s.split(":").map((g) => parseInt(g || "0", 16))
    }

    if (
      groups.length !== 8 ||
      groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)
    ) {
      return "0.0.0.0"
    }

    // Zero the last 4 groups (80 bits) for GDPR anonymization.
    groups[4] = 0
    groups[5] = 0
    groups[6] = 0
    groups[7] = 0

    const hex = groups.map((g) => g.toString(16))
    // Re-compress the longest run of >=2 consecutive zero groups into "::".
    let bestStart = -1
    let bestLen = 0
    let curStart = -1
    let curLen = 0
    for (let i = 0; i < hex.length; i++) {
      if (hex[i] === "0") {
        if (curStart === -1) curStart = i
        curLen++
        if (curLen > bestLen) {
          bestLen = curLen
          bestStart = curStart
        }
      } else {
        curStart = -1
        curLen = 0
      }
    }
    if (bestLen >= 2) {
      const before = hex.slice(0, bestStart).join(":")
      const after = hex.slice(bestStart + bestLen).join(":")
      return `${before}::${after}`
    }
    return hex.join(":")
  }

  return "0.0.0.0"
}

/**
 * GDPR data-retention helper.
 * Returns a Date cutoff: anything older than `days` should be purged.
 *
 *   const cutoff = retentionCutoff(90)   // 90 days ago
 *   await db.session.deleteMany({ where: { lastActiveAt: { lt: cutoff } } })
 *
 * Pass `now` for deterministic tests.
 */
export function retentionCutoff(days: number, now: Date = new Date()): Date {
  const ms = Math.max(0, Math.floor(days)) * 86_400_000
  return new Date(now.getTime() - ms)
}
