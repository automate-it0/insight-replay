/**
 * Security regression tests — SSRF (Server-Side Request Forgery).
 *
 * Lib-level (no dev server required) — ALWAYS RUN. These tests pin the
 * security properties of `src/lib/ssrf-guard.ts`:
 *
 *   S1. Scheme allowlist — only `http:` and `https:` are accepted.
 *   S2. Private-IP blocking — RFC 1918, loopback, link-local, ULA,
 *       IPv4-mapped IPv6, and 0.0.0.0 are all rejected.
 *   S3. Hostname label rules — `localhost`, bare `0.0.0.0`, and
 *       single-label hostnames (no dot) are rejected.
 *   S4. userinfo / fragment stripping — anything that does parse is
 *       returned without embedded credentials or fragments.
 *   S5. Latent-vector coverage — the URLs an attacker would plant in
 *       `Alert.webhookUrl` or `Project.siteUrl` to later exfiltrate
 *       cloud metadata or pivot to internal services are all blocked
 *       at WRITE time, so they never enter the DB even if delivery is
 *       not yet implemented.
 *
 * These tests do NOT exercise `safeFetch` end-to-end (that needs DNS +
 * a live network target and a Node runtime) — they cover the synchronous
 * guards (`validateUserUrl`, `isPrivateIP`) which are the security
 * invariant. A separate integration test would be needed for the
 * async DNS-resolve path; left as a TODO.
 */
import { test, expect, describe } from "bun:test"
import { isPrivateIP, validateUserUrl, isValidUserUrl } from "@/lib/ssrf-guard"

// ─── S1. Scheme allowlist ────────────────────────────────────────────────
describe("SSRF S1 — scheme allowlist", () => {
  test("accepts https://", () => {
    const v = validateUserUrl("https://example.com/hooks")
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.url.protocol).toBe("https:")
  })

  test("accepts http://", () => {
    const v = validateUserUrl("http://example.com/hooks")
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.url.protocol).toBe("http:")
  })

  test("rejects javascript: scheme", () => {
    expect(validateUserUrl("javascript:alert(1)").ok).toBe(false)
  })

  test("rejects data: scheme", () => {
    expect(validateUserUrl("data:text/plain,hello").ok).toBe(false)
  })

  test("rejects file: scheme", () => {
    expect(validateUserUrl("file:///etc/passwd").ok).toBe(false)
  })

  test("rejects ftp: scheme", () => {
    expect(validateUserUrl("ftp://example.com/x").ok).toBe(false)
  })

  test("rejects gopher: scheme (classic SSRF primitive)", () => {
    expect(validateUserUrl("gopher://127.0.0.1:6379/_INFO").ok).toBe(false)
  })
})

// ─── S2. Private-IP blocking ────────────────────────────────────────────
describe("SSRF S2 — private IP blocking", () => {
  const cases: Array<[string, boolean]> = [
    // [input, expectedIsPrivate]
    ["10.0.0.1", true],
    ["10.255.255.255", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["172.32.0.1", false], // outside the private range
    ["172.15.0.1", false], // below the private range
    ["192.168.1.1", true],
    ["192.168.0.0", true],
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["127.0.0.53", true], // systemd-resolved stub
    ["0.0.0.0", true],
    ["0.1.2.3", true],
    ["169.254.169.254", true], // AWS / GCP / Azure IMDS — primary SSRF target
    ["::1", true],
    ["fc00::1", true], // IPv6 unique-local
    ["fd00::1", true],
    ["fe80::1", true], // IPv6 link-local
    ["8.8.8.8", false],
    ["1.1.1.1", false],
    ["203.0.113.1", false], // TEST-NET-3 (documentation) but not private
    ["100.64.0.1", true], // CGNAT
  ]
  for (const [ip, expected] of cases) {
    test(`isPrivateIP(${ip}) === ${expected}`, () => {
      expect(isPrivateIP(ip)).toBe(expected)
    })
  }

  test("rejects webhook URL pointing at 10.x (private)", () => {
    expect(validateUserUrl("https://10.0.0.5/hook").ok).toBe(false)
  })
  test("rejects webhook URL pointing at 127.0.0.1 (loopback)", () => {
    expect(validateUserUrl("https://127.0.0.1/hook").ok).toBe(false)
  })
  test("rejects webhook URL pointing at 169.254.169.254 (IMDS)", () => {
    expect(validateUserUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false)
  })
  test("rejects webhook URL pointing at ::1 (IPv6 loopback)", () => {
    expect(validateUserUrl("https://[::1]/hook").ok).toBe(false)
  })
  test("rejects webhook URL pointing at fc00::1 (IPv6 ULA)", () => {
    expect(validateUserUrl("https://[fc00::1]/hook").ok).toBe(false)
  })
  test("accepts a public IPv4 webhook URL", () => {
    expect(validateUserUrl("https://203.0.113.10/hook").ok).toBe(true)
  })
})

// ─── S3. Hostname label rules ───────────────────────────────────────────
describe("SSRF S3 — hostname label rules", () => {
  test("rejects `localhost`", () => {
    expect(validateUserUrl("https://localhost:3000/hook").ok).toBe(false)
  })
  test("rejects `0.0.0.0` as hostname", () => {
    expect(validateUserUrl("https://0.0.0.0/hook").ok).toBe(false)
  })
  test("rejects single-label NetBIOS-style hostname (`intranet`)", () => {
    // A bare label with no dot would resolve via the host's resolver and
    // could land on an internal service. Require at least one dot.
    expect(validateUserUrl("https://intranet/hook").ok).toBe(false)
  })
  test("rejects `metadata` (no dot, classic SSRF)", () => {
    expect(validateUserUrl("http://metadata/latest/").ok).toBe(false)
  })
  test("accepts a multi-label FQDN", () => {
    expect(validateUserUrl("https://hooks.example.com/path").ok).toBe(true)
  })
})

// ─── S4. userinfo / fragment stripping ──────────────────────────────────
describe("SSRF S4 — userinfo + fragment stripping", () => {
  test("strips `user:pass@` userinfo", () => {
    const v = validateUserUrl("https://alice:secret@example.com/hook")
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.url.username).toBe("")
      expect(v.url.password).toBe("")
      expect(v.url.href).not.toContain("alice")
      expect(v.url.href).not.toContain("secret")
    }
  })

  test("strips fragment", () => {
    const v = validateUserUrl("https://example.com/hook#secret-anchor")
    expect(v.ok).toBe(true)
    if (v.ok) expect(v.url.hash).toBe("")
  })

  test("rejects missing url", () => {
    expect(validateUserUrl(null).ok).toBe(false)
    expect(validateUserUrl("").ok).toBe(false)
    expect(validateUserUrl(undefined).ok).toBe(false)
  })

  test("rejects non-URL string", () => {
    expect(validateUserUrl("not a url").ok).toBe(false)
    expect(validateUserUrl("://no-scheme").ok).toBe(false)
  })

  test("isValidUserUrl is the boolean alias", () => {
    expect(isValidUserUrl("https://example.com/hook")).toBe(true)
    expect(isValidUserUrl("https://169.254.169.254/")).toBe(false)
    expect(isValidUserUrl(null)).toBe(false)
  })
})

// ─── S5. Latent-vector coverage (alert webhookUrl / project siteUrl) ────
describe("SSRF S5 — latent write-time vectors", () => {
  // These mirror exactly the payloads an attacker would try to plant in
  // POST /api/projects (siteUrl) or POST /api/projects/[id]/alerts
  // (webhookUrl) to later be fetched by a delivery loop. They MUST be
  // rejected at WRITE time by the SYNCHRONOUS `validateUserUrl` guard
  // (scheme / IP-literal / hostname-label checks).
  //
  // NOTE — payloads that LOOK public but resolve to private IPs at fetch
  // time (e.g. `http://metadata.google.internal/...`, or any DNS-rebinding
  // hostname) are NOT catchable at write time without DNS resolution, and
  // are covered by `safeFetch`'s DNS-resolve-then-block step at FETCH time.
  // That async path needs a live network target and is not exercised here.
  const payloads = [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://127.0.0.1:6379/",
    "http://localhost:8080/admin",
    "http://0.0.0.0:80/",
    "https://10.0.0.1/",
    "https://192.168.1.1/router-admin",
    "https://172.16.4.4/internal-api",
    "https://[::1]/api",
    "https://[fc00::1]/api",
    "gopher://127.0.0.1:6379/_INFO",
    "file:///etc/passwd",
    "javascript:fetch('/api/secrets').then(r=>r.text())",
    "data:text/html,<script>fetch('/api/secrets')</script>",
    "http://intranet/secret", // single-label internal host
  ]
  for (const p of payloads) {
    test(`rejects ${p}`, () => {
      expect(validateUserUrl(p).ok).toBe(false)
    })
  }
})
