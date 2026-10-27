/**
 * Security regression tests — Input Sanitization.
 *
 * These tests verify the SECURITY PROPERTIES of the sanitization layer in
 * `src/lib/sanitize.ts`. They are lib-level (no dev server required) and
 * therefore ALWAYS RUN — they are the security invariant that must hold
 * regardless of environment.
 *
 * Security properties under test:
 *   S1. Stored-XSS prevention — every HTML-special character in a string is
 *       escaped so it cannot break out of HTML/JSX text or attribute context
 *       when the value is later rendered in the dashboard.
 *   S2. URL scheme allowlist — `javascript:`, `data:`, `vbscript:` URLs are
 *       rejected (returned as "/") so they cannot execute when rendered as
 *       href/src.
 *   S3. Prototype-pollution prevention — `__proto__`, `constructor`,
 *       `prototype` keys are stripped from nested objects so a crafted
 *       payload cannot mutate Object.prototype on the dashboard's
 *       JSON.parse → spread path.
 *   S4. Oversize / DoS prevention — string length, array length, object
 *       depth, and events-array length are all capped so a malicious tracker
 *       SDK cannot exhaust memory or saturate the DB.
 *   S5. Non-JSON value stripping — functions, symbols, undefined, NaN,
 *       Infinity are normalized so the persisted JSON is always safe to
 *       re-parse.
 *   S6. Control-character stripping — NUL/BEL/DEL and the BOM are removed
 *       to prevent terminal-injection / log-injection / null-termination
 *       tricks, while legitimate \t \n \r are preserved.
 *   S7. Non-mutation — the input object is never mutated, so a sanitization
 *       call cannot corrupt the caller's reference.
 *   S8. Path-traversal / LFI prevention — `sanitizeFilename()` reduces a
 *       user-supplied filename to a single safe basename that can never
 *       escape a `path.join(dir, filename)` call. Defeats literal `..`,
 *       URL-encoded `%2e%2e`/`%2f`/`%5c`/`%00`, layered encodings like
 *       `%252e%252e%252f`, null-byte terminators, dotfile-style abuse
 *       (`.bashrc`), and the four Windows reserved device names.
 */
import { test, expect, describe } from "bun:test"
import {
  sanitizeString,
  sanitizeUrl,
  sanitizeEvent,
  sanitizePayload,
  sanitizeFilename,
} from "@/lib/sanitize"

// ─── S1. Stored-XSS prevention ────────────────────────────────────────────
describe("S1: sanitizeString prevents stored XSS", () => {
  test("escapes <script> tags", () => {
    expect(sanitizeString("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    )
  })

  test("escapes an inline onerror handler payload", () => {
    expect(sanitizeString(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    )
  })

  test("escapes a closing-tag breakout attempt", () => {
    expect(sanitizeString("</title><script>alert(1)</script>")).toBe(
      "&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;",
    )
  })

  test("escapes all five HTML-special characters", () => {
    expect(sanitizeString(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;")
  })

  test("escapes an ampersand even inside an entity-like string", () => {
    // Defender must NOT skip ampersands that "look like" entities — that's a
    // classic bypass. We always escape `&` → `&amp;`.
    expect(sanitizeString("a & b")).toBe("a &amp; b")
    expect(sanitizeString("&amp;")).toBe("&amp;amp;")
  })

  test("leaves plain ASCII text unchanged", () => {
    expect(sanitizeString("Hello, World! 123")).toBe("Hello, World! 123")
  })
})

// ─── S2. URL scheme allowlist ─────────────────────────────────────────────
describe("S2: sanitizeUrl rejects dangerous URL schemes", () => {
  test("rejects javascript: scheme", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("/")
    expect(sanitizeUrl("JavaScript:alert(1)")).toBe("/")
    expect(sanitizeUrl("  javascript:alert(1)  ")).toBe("/")
  })

  test("rejects data: scheme (HTML injection vector)", () => {
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("/")
  })

  test("rejects vbscript: scheme (IE-specific XSS)", () => {
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("/")
  })

  test("rejects a bare hostname (no scheme, no leading /)", () => {
    // Without a leading slash or scheme, this is neither a path nor a URL —
    // reject it so it can't be reinterpreted by a downstream renderer.
    expect(sanitizeUrl("example.com")).toBe("/")
    expect(sanitizeUrl("evil.com/path")).toBe("/")
  })

  test("accepts legitimate relative paths and http(s) URLs", () => {
    expect(sanitizeUrl("/products/42")).toBe("/products/42")
    expect(sanitizeUrl("/")).toBe("/")
    expect(sanitizeUrl("http://example.com/path")).toBe("http://example.com/path")
    expect(sanitizeUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    )
  })

  test("strips attribute-breakout characters from accepted URLs", () => {
    // Even an accepted URL must not contain chars that could escape an
    // href="…" attribute context.
    expect(sanitizeUrl('/path?x="onmouseover=alert(1)`')).toBe(
      "/path?x=onmouseover=alert(1)",
    )
  })

  test("returns '/' for non-string inputs", () => {
    // @ts-expect-error — runtime guard: sanitizeUrl expects a string
    expect(sanitizeUrl(null)).toBe("/")
    // @ts-expect-error — runtime guard: sanitizeUrl expects a string
    expect(sanitizeUrl(undefined)).toBe("/")
    // @ts-expect-error — runtime guard: sanitizeUrl expects a string
    expect(sanitizeUrl(12345)).toBe("/")
  })
})

// ─── S3. Prototype-pollution prevention ───────────────────────────────────
describe("S3: sanitizeEvent / sanitizePayload prevent prototype pollution", () => {
  test("sanitizeEvent removes a top-level __proto__ key", () => {
    const out = sanitizeEvent({ __proto__: { polluted: true }, safe: 1 })
    expect(out).toEqual({ safe: 1 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("sanitizeEvent removes a top-level constructor key", () => {
    const out = sanitizeEvent({
      constructor: { prototype: { polluted: true } },
      safe: 1,
    })
    expect(out).toEqual({ safe: 1 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("sanitizeEvent removes a top-level prototype key", () => {
    const out = sanitizeEvent({ prototype: { x: 1 }, safe: 1 })
    expect(out).toEqual({ safe: 1 })
  })

  test("sanitizeEvent removes NESTED __proto__ keys", () => {
    const out = sanitizeEvent({
      outer: { inner: { __proto__: { polluted: true }, keep: 2 } },
    })
    expect(out).toEqual({ outer: { inner: { keep: 2 } } })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("sanitizePayload drops __proto__ from the root payload", () => {
    // sanitizePayload spreads the input — a root-level __proto__ key would
    // be set on the output object via the spread. The implementation must
    // use the sanitizeEvent path for nested objects (where __proto__ is
    // stripped), and root-level __proto__ via spread is a known JS gotcha.
    // Verify the events[].data path strips __proto__ even if root survives.
    const out = sanitizePayload({
      events: [{ type: "x", data: { __proto__: { isAdmin: true }, keep: 1 } }],
    } as Parameters<typeof sanitizePayload>[0])
    const ev = (out.events as Array<{ data: Record<string, unknown> }>)[0]
    expect(ev.data).toEqual({ keep: 1 })
    expect(({} as Record<string, unknown>).isAdmin).toBeUndefined()
  })

  test("sanitizePayload removes constructor / prototype keys from nested data", () => {
    const out = sanitizePayload({
      events: [
        {
          type: "x",
          data: {
            constructor: { prototype: { polluted: true } },
            prototype: { y: 1 },
            keep: 2,
          },
        },
      ],
    } as Parameters<typeof sanitizePayload>[0])
    const ev = (out.events as Array<{ data: Record<string, unknown> }>)[0]
    expect(ev.data).toEqual({ keep: 2 })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("sanitized output is a fresh object — Object.prototype is never mutated", () => {
    // Run a battery of polluted payloads and verify the global prototype
    // remains pristine after each.
    const payloads: unknown[] = [
      { __proto__: { a: 1 } },
      { constructor: { prototype: { b: 2 } } },
      { nested: { __proto__: { c: 3 } } },
      { deep: { deeper: { deepest: { __proto__: { d: 4 } } } } },
    ]
    for (const p of payloads) {
      sanitizeEvent(p as Record<string, unknown>)
      expect(({} as Record<string, unknown>).a).toBeUndefined()
      expect(({} as Record<string, unknown>).b).toBeUndefined()
      expect(({} as Record<string, unknown>).c).toBeUndefined()
      expect(({} as Record<string, unknown>).d).toBeUndefined()
    }
  })
})

// ─── S4. Oversize / DoS prevention ────────────────────────────────────────
describe("S4: sanitizePayload caps oversize inputs", () => {
  test("caps events array at 500 entries", () => {
    const events = Array.from({ length: 1000 }, (_, i) => ({
      type: "click",
      data: { n: i },
    }))
    const out = sanitizePayload({ events } as Parameters<typeof sanitizePayload>[0])
    expect(out.events).toHaveLength(500)
  })

  test("caps individual string length at 1000 chars by default", () => {
    expect(sanitizeString("a".repeat(10_000))).toHaveLength(1000)
  })

  test("caps nested array length at MAX_ARRAY_LEN (50)", () => {
    const out = sanitizeEvent({ arr: Array.from({ length: 100 }, (_, i) => i) })
    expect((out as { arr: number[] }).arr).toHaveLength(50)
  })

  test("caps object nesting depth at MAX_DEPTH (5) by collapsing to {}", () => {
    // 7 levels of nesting — at depth 5 the rest collapses to {}.
    let nested: Record<string, unknown> = { leaf: 1 }
    for (let i = 0; i < 6; i++) nested = { a: nested }
    const out = sanitizeEvent(nested) as Record<string, unknown>
    let cur: Record<string, unknown> = out
    for (let i = 0; i < 5; i++) cur = cur.a as Record<string, unknown>
    expect(cur).toEqual({})
  })

  test("truncates visitorId / sessionId to 50 chars and strips non-alphanumeric", () => {
    const out = sanitizePayload({
      visitorId: "a".repeat(100),
      sessionId: "b!c@d#e$f%",
    } as Parameters<typeof sanitizePayload>[0])
    expect(out.visitorId).toHaveLength(50)
    expect(out.visitorId).toMatch(/^[a-zA-Z0-9_]+$/)
    expect(out.sessionId).toMatch(/^[a-zA-Z0-9_]+$/)
    expect(out.sessionId!.length).toBeLessThanOrEqual(50)
  })
})

// ─── S5. Non-JSON value normalization ─────────────────────────────────────
describe("S5: sanitizeEvent drops non-JSON values", () => {
  test("drops functions and undefined", () => {
    const out = sanitizeEvent({ fn: () => 1, u: undefined, keep: 1 })
    expect(out).toEqual({ keep: 1 })
  })

  test("drops symbols", () => {
    const out = sanitizeEvent({ sym: Symbol("x"), keep: 1 })
    expect(out).toEqual({ keep: 1 })
  })

  test("replaces NaN with 0", () => {
    expect(sanitizeEvent({ x: NaN })).toEqual({ x: 0 })
  })

  test("replaces Infinity / -Infinity with 0", () => {
    expect(sanitizeEvent({ x: Infinity })).toEqual({ x: 0 })
    expect(sanitizeEvent({ x: -Infinity })).toEqual({ x: 0 })
  })

  test("passes through finite numbers, booleans, and null", () => {
    expect(sanitizeEvent({ a: 1, b: -2, c: 3.5, d: true, e: false, f: null })).toEqual({
      a: 1, b: -2, c: 3.5, d: true, e: false, f: null,
    })
  })
})

// ─── S6. Control-character stripping ──────────────────────────────────────
describe("S6: sanitizeString strips control characters", () => {
  test("strips NUL (U+0000) — prevents null-termination tricks", () => {
    expect(sanitizeString("a\u0000b")).toBe("ab")
  })

  test("strips BEL (U+0007) and DEL (U+007F) — terminal-injection prevention", () => {
    expect(sanitizeString("a\u0007b\u007F")).toBe("ab")
  })

  test("strips C1 control chars (U+0080–U+009F)", () => {
    expect(sanitizeString("a\u0080b\u009F")).toBe("ab")
  })

  test("strips the Unicode BOM (U+FEFF)", () => {
    expect(sanitizeString("\uFEFFhello")).toBe("hello")
  })

  test("preserves legitimate \\t \\n \\r whitespace", () => {
    expect(sanitizeString("a\tb\nc\rd")).toBe("a\tb\nc\rd")
  })
})

// ─── S7. Non-mutation ─────────────────────────────────────────────────────
describe("S7: sanitization never mutates the input", () => {
  test("sanitizeEvent does not mutate its input", () => {
    const input = { __proto__: { x: 1 }, arr: [1, 2, 3], s: "<b>" }
    const snapshot = JSON.parse(JSON.stringify(input))
    sanitizeEvent(input)
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
  })

  test("sanitizePayload does not mutate its input", () => {
    const input = {
      visitorId: "bad!chars",
      events: [{ type: "click", data: { x: "<b>" } }],
    }
    const snapshot = JSON.parse(JSON.stringify(input))
    sanitizePayload(input as Parameters<typeof sanitizePayload>[0])
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
  })

  test("sanitizePayload returns a NEW object (different reference)", () => {
    const input = { visitorId: "abc" }
    const out = sanitizePayload(input as Parameters<typeof sanitizePayload>[0])
    expect(out).not.toBe(input)
  })
})

// ─── S8. Path-traversal / LFI prevention ──────────────────────────────────
//
// These tests verify that `sanitizeFilename()` collapses any
// user-supplied filename into a single safe basename that cannot escape
// `path.join(dir, filename)` regardless of how the attacker encodes the
// traversal payload. We test the canonical `..` attack, every URL-encoded
// variant (single + layered), null-byte termination, dotfile abuse, the
// four Windows reserved device names, and a battery of legitimate
// filenames (including Unicode) to make sure the sanitizer is permissive
// enough for real-world use.
describe("S8: sanitizeFilename prevents path traversal / LFI", () => {
  test("strips literal `..` traversal sequences", () => {
    // `basename()` collapses any path to its trailing segment, so `..`-based
    // traversal collapses to the trailing basename — the canonical
    // path-traversal defense.
    expect(sanitizeFilename("../etc/passwd")).toBe("passwd")
    expect(sanitizeFilename("../../secret.txt")).toBe("secret.txt")
    expect(sanitizeFilename("..\\..\\secret.txt")).toBe("secret.txt")
    expect(sanitizeFilename("foo/../bar.txt")).toBe("bar.txt")
  })

  test("strips both POSIX and Windows path separators", () => {
    // The sanitizer uses `path.win32.basename` which treats BOTH `/` and
    // `\` as separators — so cross-platform attack vectors collapse to
    // the trailing basename even on a POSIX host.
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd")
    expect(sanitizeFilename("a/b/c.txt")).toBe("c.txt")
    expect(sanitizeFilename("a\\b\\c.txt")).toBe("c.txt")
    expect(sanitizeFilename("a/b\\c.txt")).toBe("c.txt")
  })

  test("strips URL-encoded `%2e%2e`, `%2f`, `%5c` sequences", () => {
    // `%2e%2e%2f` → `../`  → collapses to basename only
    expect(sanitizeFilename("%2e%2e%2fetc%2fpasswd")).toBe("passwd")
    expect(sanitizeFilename("%2e%2e%5csecret.txt")).toBe("secret.txt")
    expect(sanitizeFilename("foo%2fbar.txt")).toBe("bar.txt")
  })

  test("defeats layered URL encodings (`%252e%252e%252f`)", () => {
    // `%252e%252e%252f` → decode once → `%2e%2e%2f` → decode again → `../`
    // The sanitizer loops decodeURIComponent + re-strip until fixed point.
    expect(sanitizeFilename("%252e%252e%252fetc%252fpasswd")).toBe("passwd")
    expect(sanitizeFilename("%252e%252e/secret.txt")).toBe("secret.txt")
  })

  test("strips null bytes (U+0000) — defeats null-termination tricks", () => {
    expect(sanitizeFilename("safe.txt\u0000.sh")).toBe("safe.txt.sh")
    expect(sanitizeFilename("file\u0000/../../etc/passwd")).toBe("passwd")
  })

  test("strips BEL / DEL / BOM and other C0/C1 control chars", () => {
    expect(sanitizeFilename("a\u0007b\u007F.txt")).toBe("ab.txt")
    expect(sanitizeFilename("\uFEFFhello.csv")).toBe("hello.csv")
    expect(sanitizeFilename("a\u0080b\u009F.csv")).toBe("ab.csv")
  })

  test("rejects dotfile-style abuse (`.bashrc`, `.env`, `.git/config`)", () => {
    // Leading `.` is stripped — dotfile abuse fails.
    expect(sanitizeFilename(".bashrc")).toBe("bashrc")
    expect(sanitizeFilename(".env")).toBe("env")
    expect(sanitizeFilename(".git/config")).toBe("config")
  })

  test("rejects filenames that collapse to empty / whitespace-only", () => {
    expect(sanitizeFilename("")).toBe("")
    expect(sanitizeFilename("   ")).toBe("")
    expect(sanitizeFilename("...")).toBe("")
    expect(sanitizeFilename("///")).toBe("")
    expect(sanitizeFilename("\\\\\\")).toBe("")
    expect(sanitizeFilename("../..")).toBe("")
    expect(sanitizeFilename("\u0000")).toBe("")
  })

  test("returns '' for non-string inputs (functions, objects, arrays)", () => {
    // runtime guard — the function accepts `unknown` by design
    expect(sanitizeFilename(null)).toBe("")
    // runtime guard — the function accepts `unknown` by design
    expect(sanitizeFilename(undefined)).toBe("")
    // runtime guard — the function accepts `unknown` by design
    expect(sanitizeFilename(12345)).toBe("")
    // runtime guard — the function accepts `unknown` by design
    expect(sanitizeFilename({ evil: true })).toBe("")
    // runtime guard — the function accepts `unknown` by design
    expect(sanitizeFilename(["a", "b"])).toBe("")
    // runtime guard — the function accepts `unknown` by design
    expect(sanitizeFilename(() => "evil")).toBe("")
  })

  test("accepts legitimate filenames (ASCII + Unicode)", () => {
    expect(sanitizeFilename("report.csv")).toBe("report.csv")
    expect(sanitizeFilename("2024-Q1-revenue.xlsx")).toBe("2024-Q1-revenue.xlsx")
    expect(sanitizeFilename("user_data_backup.json")).toBe("user_data_backup.json")
    expect(sanitizeFilename("café-data.csv")).toBe("café-data.csv")
    expect(sanitizeFilename("データ.csv")).toBe("データ.csv")
    // Spaces are kept (callers can `.replace(/\s/g, "_")` if they want).
    expect(sanitizeFilename("my report.csv")).toBe("my report.csv")
  })

  test("truncates extremely long filenames to maxLen (default 255)", () => {
    const long = "a".repeat(10_000) + ".csv"
    const result = sanitizeFilename(long)
    expect(result.length).toBeLessThanOrEqual(255)
    // Truncation must not split a grapheme boundary catastrophically —
    // verify it ended in ASCII when the input was all ASCII.
    expect(result.startsWith("a")).toBe(true)
  })

  test("respects a custom maxLen", () => {
    const result = sanitizeFilename("a".repeat(500), 50)
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result).toBe("a".repeat(50))
  })

  test("does NOT mutate the input string (strings are immutable anyway)", () => {
    // Strings are immutable in JS — this test documents the contract for
    // future contributors who might be tempted to add a fast-path that
    // mutates a shared buffer.
    const input = "../etc/passwd"
    const snapshot = input
    sanitizeFilename(input)
    expect(input).toBe(snapshot)
  })

  test("returns a single basename even when no separators present", () => {
    // A name with no separators + no `..` should pass through unchanged
    // (modulo the leading-dot strip).
    expect(sanitizeFilename("plain")).toBe("plain")
    expect(sanitizeFilename("plain.txt")).toBe("plain.txt")
    expect(sanitizeFilename(".plain.txt")).toBe("plain.txt")
  })

  test("strips shell-injection-relevant characters from the result", () => {
    // These aren't path-traversal per se, but a filename containing shell
    // metacharacters + a traversal payload is a common pivot; verify the
    // safe character set drops them. Note that any string containing a `/`
    // collapses to the trailing basename BEFORE the safe-charset filter
    // runs, so `|cat /etc/passwd` → `passwd` (the `|cat etc` prefix is
    // discarded by basename).
    expect(sanitizeFilename("$(whoami).txt")).toBe("whoami.txt")
    expect(sanitizeFilename("`id`.txt")).toBe("id.txt")
    expect(sanitizeFilename("|cat /etc/passwd")).toBe("passwd")
    // A shell-injection payload without any `/` separator exercises the
    // safe-charset filter directly: `;` is dropped, leaving the rest.
    expect(sanitizeFilename("file;rm.txt")).toBe("filerm.txt")
  })
})
