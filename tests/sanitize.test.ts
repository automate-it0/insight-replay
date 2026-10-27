import { test, expect, describe } from "bun:test"
import {
  sanitizeString,
  sanitizeUrl,
  sanitizeEvent,
  sanitizePayload,
} from "../src/lib/sanitize"

// ─── sanitizeString ───────────────────────────────────────────────────────
describe("sanitizeString", () => {
  describe("HTML escaping", () => {
    test("escapes <script> tags", () => {
      expect(sanitizeString("<script>alert(1)</script>")).toBe(
        "&lt;script&gt;alert(1)&lt;/script&gt;",
      )
    })

    test("escapes all five HTML-special characters", () => {
      expect(sanitizeString(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;")
    })

    test("escapes an ampersand that's part of an entity-like string", () => {
      // & not part of a real entity — should still be escaped to &amp;.
      expect(sanitizeString("a & b")).toBe("a &amp; b")
    })

    test("leaves plain text unchanged", () => {
      expect(sanitizeString("Hello, World!")).toBe("Hello, World!")
    })
  })

  describe("truncation", () => {
    test("truncates to the default maxLen of 1000", () => {
      const long = "a".repeat(2000)
      expect(sanitizeString(long)).toHaveLength(1000)
    })

    test("honours a custom maxLen", () => {
      expect(sanitizeString("abcdefghij", 5)).toBe("abcde")
    })

    test("does not pad short strings to maxLen", () => {
      expect(sanitizeString("hi", 100)).toBe("hi")
    })

    test("truncates BEFORE escaping (so escaped output may exceed maxLen)", () => {
      // 5 chars of "<", each becomes 4 chars "&lt;" → 20 chars out.
      const out = sanitizeString("<<<<", 4)
      expect(out).toBe("&lt;&lt;&lt;&lt;")
      expect(out.length).toBeGreaterThan(4)
    })
  })

  describe("control character stripping", () => {
    test("strips NUL (U+0000)", () => {
      expect(sanitizeString("a\u0000b")).toBe("ab")
    })

    test("strips BEL (U+0007) and DEL (U+007F)", () => {
      expect(sanitizeString("a\u0007b\u007F")).toBe("ab")
    })

    test("preserves \\t, \\n, \\r (legitimate whitespace)", () => {
      expect(sanitizeString("a\tb\nc\rd")).toBe("a\tb\nc\rd")
    })

    test("strips the Unicode BOM (U+FEFF)", () => {
      expect(sanitizeString("\uFEFFhello")).toBe("hello")
    })
  })

  describe("non-string inputs", () => {
    test("returns empty string for undefined", () => {
      // @ts-expect-error — testing runtime guard against non-strings
      expect(sanitizeString(undefined)).toBe("")
    })

    test("returns empty string for null", () => {
      // @ts-expect-error — testing runtime guard against non-strings
      expect(sanitizeString(null)).toBe("")
    })

    test("returns empty string for a number", () => {
      // @ts-expect-error — testing runtime guard against non-strings
      expect(sanitizeString(12345)).toBe("")
    })
  })
})

// ─── sanitizeUrl ──────────────────────────────────────────────────────────
describe("sanitizeUrl", () => {
  describe("accepted inputs", () => {
    test("accepts a relative path", () => {
      expect(sanitizeUrl("/products/42")).toBe("/products/42")
    })

    test("accepts an http URL", () => {
      expect(sanitizeUrl("http://example.com/path")).toBe(
        "http://example.com/path",
      )
    })

    test("accepts an https URL", () => {
      expect(sanitizeUrl("https://example.com/path?q=1")).toBe(
        "https://example.com/path?q=1",
      )
    })

    test("accepts a root path", () => {
      expect(sanitizeUrl("/")).toBe("/")
    })
  })

  describe("rejected inputs", () => {
    test("rejects javascript: scheme and returns /", () => {
      expect(sanitizeUrl("javascript:alert(1)")).toBe("/")
    })

    test("rejects data: scheme and returns /", () => {
      expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("/")
    })

    test("rejects vbscript: scheme and returns /", () => {
      expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("/")
    })

    test("rejects a bare hostname (no scheme, no leading /)", () => {
      expect(sanitizeUrl("example.com")).toBe("/")
    })

    test("returns / for non-string inputs", () => {
      // @ts-expect-error — testing runtime guard
      expect(sanitizeUrl(null)).toBe("/")
      // @ts-expect-error — testing runtime guard
      expect(sanitizeUrl(undefined)).toBe("/")
    })
  })

  describe("attribute-breakout stripping", () => {
    test("strips <, >, \", ', ` so the URL can't escape an href attribute", () => {
      // Path-relative URL with attempted breakout chars.
      expect(sanitizeUrl('/path?x="onmouseover=alert(1)`')).toBe(
        "/path?x=onmouseover=alert(1)",
      )
    })

    test("truncates extremely long URLs to maxLen", () => {
      const long = "/" + "a".repeat(2000)
      expect(sanitizeUrl(long, 500)).toHaveLength(500)
    })
  })
})

// ─── sanitizeEvent ────────────────────────────────────────────────────────
describe("sanitizeEvent", () => {
  describe("prototype pollution prevention", () => {
    test("removes a top-level __proto__ key", () => {
      const out = sanitizeEvent({ __proto__: { polluted: true }, safe: 1 })
      expect(out).toEqual({ safe: 1 })
      // Verify Object.prototype was NOT actually polluted.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })

    test("removes a top-level constructor key", () => {
      const out = sanitizeEvent({
        constructor: { prototype: { polluted: true } },
        safe: 1,
      })
      expect(out).toEqual({ safe: 1 })
    })

    test("removes a top-level prototype key", () => {
      const out = sanitizeEvent({ prototype: { x: 1 }, safe: 1 })
      expect(out).toEqual({ safe: 1 })
    })

    test("removes nested __proto__ keys", () => {
      const out = sanitizeEvent({
        nested: { __proto__: { polluted: true }, keep: 2 },
      })
      expect(out).toEqual({ nested: { keep: 2 } })
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    })
  })

  describe("value-type handling", () => {
    test("sanitizes strings inside nested objects", () => {
      const out = sanitizeEvent({ msg: "<script>x</script>" })
      expect(out).toEqual({ msg: "&lt;script&gt;x&lt;/script&gt;" })
    })

    test("passes through finite numbers", () => {
      expect(sanitizeEvent({ a: 1, b: -2, c: 3.5 })).toEqual({
        a: 1,
        b: -2,
        c: 3.5,
      })
    })

    test("replaces NaN with 0", () => {
      expect(sanitizeEvent({ x: NaN })).toEqual({ x: 0 })
    })

    test("replaces Infinity with 0", () => {
      expect(sanitizeEvent({ x: Infinity })).toEqual({ x: 0 })
    })

    test("passes through booleans", () => {
      expect(sanitizeEvent({ t: true, f: false })).toEqual({
        t: true,
        f: false,
      })
    })

    test("preserves null", () => {
      expect(sanitizeEvent({ x: null })).toEqual({ x: null })
    })

    test("drops functions and undefined", () => {
      const out = sanitizeEvent({
        fn: () => 1,
        u: undefined,
        keep: 1,
      })
      expect(out).toEqual({ keep: 1 })
    })
  })

  describe("depth and array caps", () => {
    test("caps array length at MAX_ARRAY_LEN (50)", () => {
      const bigArr = Array.from({ length: 100 }, (_, i) => i)
      const out = sanitizeEvent({ arr: bigArr }) as {
        arr: number[]
      }
      expect(out.arr).toHaveLength(50)
      expect(out.arr[0]).toBe(0)
      expect(out.arr[49]).toBe(49)
    })

    test("caps object nesting at MAX_DEPTH (5) by returning {}", () => {
      // Build a deeply nested object: { a: { a: { a: ... } } } (7 levels).
      let nested: Record<string, unknown> = { leaf: 1 }
      for (let i = 0; i < 6; i++) nested = { a: nested }
      const out = sanitizeEvent(nested) as Record<string, unknown>
      // Walk down — at depth 5 the rest collapses to {}.
      let cur: Record<string, unknown> = out
      for (let i = 0; i < 5; i++) {
        expect(typeof cur).toBe("object")
        cur = cur.a as Record<string, unknown>
      }
      // At depth 5 we should hit the empty-object collapse.
      expect(cur).toEqual({})
    })

    test("never mutates the input", () => {
      const input = { __proto__: { x: 1 }, arr: [1, 2, 3], s: "<b>" }
      const snapshot = JSON.parse(JSON.stringify(input)) as Record<
        string,
        unknown
      >
      sanitizeEvent(input)
      // The original object's own enumerable keys + values must be unchanged.
      expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
    })
  })
})

// ─── sanitizePayload ──────────────────────────────────────────────────────
describe("sanitizePayload", () => {
  describe("visitorId / sessionId cleaning", () => {
    test("strips non-alphanumeric/underscore chars from visitorId", () => {
      const out = sanitizePayload({ visitorId: "abc-123!@#_xyz" })
      expect(out.visitorId).toBe("abc123_xyz")
    })

    test("strips non-alphanumeric/underscore chars from sessionId", () => {
      const out = sanitizePayload({ sessionId: "sess/1?2=3" })
      expect(out.sessionId).toBe("sess123")
    })

    test("truncates visitorId to 50 characters", () => {
      const out = sanitizePayload({ visitorId: "a".repeat(100) })
      expect(out.visitorId).toHaveLength(50)
    })

    test("preserves an already-clean visitorId", () => {
      const out = sanitizePayload({ visitorId: "Visitor_42" })
      expect(out.visitorId).toBe("Visitor_42")
    })
  })

  describe("events array cap", () => {
    test("caps events array at 500 entries", () => {
      const events = Array.from({ length: 1000 }, (_, i) => ({
        type: "click",
        data: { n: i },
      }))
      const out = sanitizePayload({ events })
      expect(out.events).toHaveLength(500)
    })

    test("preserves event order (first 500 kept)", () => {
      const events = Array.from({ length: 600 }, (_, i) => ({
        type: "click",
        data: { n: i },
      }))
      const out = sanitizePayload({ events })
      expect(out.events?.[0]).toMatchObject({ type: "click", data: { n: 0 } })
      expect(out.events?.[499]).toMatchObject({
        type: "click",
        data: { n: 499 },
      })
    })

    test("sanitizes the data object inside each event", () => {
      const out = sanitizePayload({
        events: [{ type: "click", data: { html: "<script>" } }],
      })
      expect(out.events?.[0].data).toEqual({ html: "&lt;script&gt;" })
    })

    test("sanitizes the pageUrl inside each event", () => {
      const out = sanitizePayload({
        events: [{ type: "pageview", pageUrl: "javascript:alert(1)" }],
      })
      expect(out.events?.[0].pageUrl).toBe("/")
    })
  })

  describe("root pageUrl", () => {
    test("sanitizes the root-level pageUrl", () => {
      const out = sanitizePayload({ pageUrl: "javascript:alert(1)" })
      expect(out.pageUrl).toBe("/")
    })

    test("preserves a valid root-level pageUrl", () => {
      const out = sanitizePayload({ pageUrl: "/dashboard" })
      expect(out.pageUrl).toBe("/dashboard")
    })
  })

  describe("non-mutation", () => {
    test("does not mutate the input payload", () => {
      const input = {
        visitorId: "bad!chars",
        events: [{ type: "click", data: { x: "<b>" } }],
      }
      const snapshot = JSON.parse(JSON.stringify(input))
      sanitizePayload(input)
      expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
    })

    test("returns a new object (different reference)", () => {
      const input = { visitorId: "abc" }
      const out = sanitizePayload(input)
      expect(out).not.toBe(input)
    })
  })
})
