/**
 * Security regression tests — Output-side HTML Sanitizer.
 *
 * These tests verify the SECURITY PROPERTIES of the output-side sanitizer in
 * `src/lib/sanitize-html.ts`. The sanitizer is used to harden
 * `dangerouslySetInnerHTML` sites (currently only `src/components/ui/chart.tsx`
 * → `<style>` element). The input-side sanitizer `src/lib/sanitize.ts` is
 * tested separately in `tests/security/sanitization.test.ts`.
 *
 * Security properties under test:
 *   O1. `sanitizeHtml` strips `<script>…</script>` blocks (reflected-XSS
 *       primitive #1).
 *   O2. `sanitizeHtml` strips `on*=…` event-handler attributes
 *       (reflected-XSS primitive #2).
 *   O3. `sanitizeHtml` neutralizes `javascript:`, `vbscript:`,
 *       `data:text/html` URI schemes (reflected-XSS primitive #3).
 *   O4. `sanitizeHtml` strips `</style>`, `</script>`, etc. raw-text-element
 *       breakouts so a payload cannot escape a `<style>`/`<script>`/
 *       `<textarea>` context (reflected-XSS primitive #4).
 *   O5. `stripAllHtml` returns ONLY text — every tag is gone.
 *   O6. `escapeHtml` mirrors React's JSX auto-escape for the five
 *       HTML-special characters.
 *   O7. `sanitizeCssForStyle` strips `</style>` and `<style` and `<script`
 *       breakouts inside a `<style>` block (the specific vector that
 *       `chart.tsx` is hardened against).
 *   O8. `sanitizeCssForStyle` neutralizes `url(javascript:…)` and
 *       `expression(…)` CSS payloads.
 *   O9. All sanitizers handle non-string input gracefully (return "").
 *   O10. All sanitizers are pure (do not mutate shared regex state / do not
 *        throw on edge-case inputs).
 */
import { test, expect, describe } from "bun:test"
import {
  escapeHtml,
  sanitizeHtml,
  stripAllHtml,
  sanitizeCssForStyle,
} from "../src/lib/sanitize-html"

// ─── O1. <script> block stripping ───────────────────────────────────────
describe("O1: sanitizeHtml strips <script> blocks", () => {
  test("strips a basic <script>alert(1)</script>", () => {
    expect(sanitizeHtml("<script>alert(1)</script>")).toBe("")
  })

  test("strips a <script> block but keeps surrounding text", () => {
    expect(sanitizeHtml("hello<script>alert(1)</script>world")).toBe(
      "helloworld",
    )
  })

  test("strips a self-closing <script src='evil.js'/>", () => {
    expect(sanitizeHtml("<script src='https://evil.example/xss.js'/>")).toBe("")
  })

  test("strips a <script> with attributes", () => {
    expect(
      sanitizeHtml("<script type='text/javascript' src='x.js'>alert(1)</script>"),
    ).toBe("")
  })

  test("strips a <SCRIPT> with uppercase tag (case-insensitive)", () => {
    expect(sanitizeHtml("<SCRIPT>alert(1)</SCRIPT>")).toBe("")
  })

  test("strips multiple <script> blocks", () => {
    expect(
      sanitizeHtml("<script>a</script>x<script>b</script>y"),
    ).toBe("xy")
  })

  test("strips a <script> whose body contains '</script>' substring via nested escape", () => {
    // The greedy [\s\S]*? stops at the FIRST `</script>`, so a payload that
    // tries to break out with `</script><script>alert(2)</script>` loses
    // both <script> blocks.
    expect(
      sanitizeHtml("<script>x</script><script>alert(2)</script>"),
    ).toBe("")
  })
})

// ─── O2. on*= event-handler stripping ────────────────────────────────────
describe("O2: sanitizeHtml strips on*= event-handler attributes", () => {
  test("strips onerror= with unquoted value", () => {
    expect(sanitizeHtml("<img src=x onerror=alert(1)>")).toBe(
      "<img src=x>",
    )
  })

  test("strips onerror= with double-quoted value", () => {
    expect(sanitizeHtml('<img src=x onerror="alert(1)">')).toBe(
      "<img src=x>",
    )
  })

  test("strips onerror= with single-quoted value", () => {
    expect(sanitizeHtml("<img src=x onerror='alert(1)'>")).toBe(
      "<img src=x>",
    )
  })

  test("strips onload=, onmouseover=, onclick=, ontoggle= (any on* handler)", () => {
    expect(
      sanitizeHtml("<div onload='a' onmouseover='b' onclick='c' ontoggle='d'>x</div>"),
    ).toBe("<div>x</div>")
  })

  test("strips ONERROR= with uppercase attribute name (case-insensitive)", () => {
    expect(sanitizeHtml("<img src=x ONERROR='alert(1)'>")).toBe("<img src=x>")
  })

  test("preserves non-event-handler attributes (class, alt, href)", () => {
    expect(
      sanitizeHtml('<a class="link" href="/foo" alt="x">go</a>'),
    ).toBe('<a class="link" href="/foo" alt="x">go</a>')
  })
})

// ─── O3. Dangerous URI scheme neutralization ─────────────────────────────
describe("O3: sanitizeHtml neutralizes dangerous URI schemes", () => {
  test("neutralizes href='javascript:alert(1)'", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>')
    expect(out).not.toContain("javascript:")
    expect(out).toContain(":#")
  })

  test("neutralizes src='javascript:alert(1)' on an iframe", () => {
    const out = sanitizeHtml('<iframe src="javascript:alert(1)"></iframe>')
    expect(out).not.toContain("javascript:")
  })

  test("neutralizes href='vbscript:msgbox(1)' (IE-specific)", () => {
    const out = sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')
    expect(out).not.toContain("vbscript:")
  })

  test("neutralizes href='data:text/html,<script>...'", () => {
    const out = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(out).not.toContain("data:text/html")
  })

  test("preserves a legitimate http(s) href", () => {
    expect(
      sanitizeHtml('<a href="https://example.com/path">x</a>'),
    ).toBe('<a href="https://example.com/path">x</a>')
  })
})

// ─── O4. Raw-text-element breakout stripping ────────────────────────────
describe("O4: sanitizeHtml strips raw-text-element breakouts", () => {
  test("strips a bare </style> tag", () => {
    expect(sanitizeHtml("</style>")).toBe("")
  })

  test("strips a bare </script> tag", () => {
    expect(sanitizeHtml("</script>")).toBe("")
  })

  test("strips the classic </style><script>alert(1)</script> payload", () => {
    // Both the closing </style> and the <script>...</script> block are gone.
    expect(
      sanitizeHtml("</style><script>alert(1)</script>"),
    ).toBe("")
  })

  test("strips </textarea> and </title> breakouts", () => {
    expect(
      sanitizeHtml("</textarea><script>alert(1)</script>"),
    ).toBe("")
    expect(
      sanitizeHtml("</title><script>alert(1)</script>"),
    ).toBe("")
  })
})

// ─── O5. stripAllHtml returns only text ──────────────────────────────────
describe("O5: stripAllHtml returns only text", () => {
  test("drops <b> tags but keeps inner text", () => {
    expect(stripAllHtml("<b>hello</b>")).toBe("hello")
  })

  test("drops nested tags but keeps inner text", () => {
    expect(stripAllHtml("<div><p>hi <b>there</b></p></div>")).toBe("hi there")
  })

  test("drops <script> body as well as tags", () => {
    expect(
      stripAllHtml("<b>hello</b><script>alert(1)</script>world"),
    ).toBe("helloworld")
  })

  test("drops attribute values inside stripped tags", () => {
    expect(
      stripAllHtml('<a href="javascript:alert(1)" onclick="x()">click</a>'),
    ).toBe("click")
  })
})

// ─── O6. escapeHtml ──────────────────────────────────────────────────────
describe("O6: escapeHtml escapes the five HTML-special characters", () => {
  test("escapes <, >, &, \", '", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;")
  })

  test("escapes a <script> tag", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    )
  })

  test("preserves plain text unchanged", () => {
    expect(escapeHtml("Hello, World! 123")).toBe("Hello, World! 123")
  })

  test("returns empty string for non-string input", () => {
    // @ts-expect-error — runtime guard
    expect(escapeHtml(null)).toBe("")
    // @ts-expect-error — runtime guard
    expect(escapeHtml(undefined)).toBe("")
    // @ts-expect-error — runtime guard
    expect(escapeHtml(42)).toBe("")
  })
})

// ─── O7. sanitizeCssForStyle breakout stripping ───────────────────────────
describe("O7: sanitizeCssForStyle strips <style> raw-text breakouts", () => {
  test("strips a bare </style> closing tag", () => {
    expect(sanitizeCssForStyle("a { color: red; } </style>")).toBe(
      "a { color: red; } ",
    )
  })

  test("strips the </style><script>alert(1)</script> payload (only the breakout is stripped)", () => {
    // The sanitizer's job is to keep the parser inside <style>. The literal
    // text `<script>alert(1)</script>` left behind is now inert CSS text
    // (the HTML parser never re-enters HTML mode, so it can't execute).
    const out = sanitizeCssForStyle("a { color: red; } </style><script>alert(1)</script>")
    expect(out).not.toContain("</style>")
    expect(out).toContain("a { color: red; }")
  })

  test("strips a fresh <style> opening tag (defense-in-depth)", () => {
    // Inside a CSS payload, a `<style>` opening tag is inert — the HTML
    // tokenizer's raw-text mode only exits on `</style>`. But strip it
    // anyway for defense-in-depth (an unclosed `<style` token without a
    // `>` is left alone — it is unambiguously just CSS text).
    expect(sanitizeCssForStyle("body { color: red } <style>"))
      .not.toContain("<style>")
    // The bare `<style` token without `>` is preserved because the
    // opening-tag regex requires a closing `>`.
    expect(sanitizeCssForStyle("body > div { color: red }"))
      .toContain("body > div")
  })

  test("strips a <script opening tag inside CSS", () => {
    expect(sanitizeCssForStyle("<script>alert(1)")).not.toContain("<script")
  })

  test("strips HTML comments inside CSS (legacy IE conditional-comment vector)", () => {
    expect(sanitizeCssForStyle("a { /* */ } <!-- bad -->")).not.toContain("<!--")
    expect(sanitizeCssForStyle("a { /* */ } <!-- bad -->")).not.toContain("-->")
  })
})

// ─── O8. sanitizeCssForStyle CSS payloads ───────────────────────────────
describe("O8: sanitizeCssForStyle neutralizes dangerous CSS payloads", () => {
  test("neutralizes url(javascript:alert(1)) in a CSS value", () => {
    const out = sanitizeCssForStyle("body { background: url(javascript:alert(1)); }")
    expect(out).not.toContain("javascript:")
    expect(out).toContain("url(':#')")
  })

  test("neutralizes url('vbscript:msgbox(1)')", () => {
    const out = sanitizeCssForStyle("body { background: url('vbscript:msgbox(1)'); }")
    expect(out).not.toContain("vbscript:")
  })

  test("neutralizes url(data:text/html,...)", () => {
    const out = sanitizeCssForStyle("body { background: url(data:text/html,<script>alert(1)</script>); }")
    expect(out).not.toContain("data:text/html")
  })

  test("neutralizes expression(...) (legacy IE CSS expression execution)", () => {
    const out = sanitizeCssForStyle("div { width: expression(alert(1)); }")
    expect(out).not.toMatch(/expression\s*\(/)
    expect(out).toContain("expression-disabled(")
  })

  test("preserves legitimate CSS unchanged", () => {
    const css = ".dark [data-chart=chart-abc] {\n  --color-visits: oklch(0.66 0.2 22);\n}\n"
    expect(sanitizeCssForStyle(css)).toBe(css)
  })

  test("preserves a safe url(http://...) payload", () => {
    const css = "body { background: url(https://example.com/img.png); }"
    expect(sanitizeCssForStyle(css)).toBe(css)
  })
})

// ─── O9. Non-string input handling ──────────────────────────────────────
describe("O9: all sanitizers handle non-string input gracefully", () => {
  test("sanitizeHtml returns '' for null / undefined / number", () => {
    // @ts-expect-error — runtime guard
    expect(sanitizeHtml(null)).toBe("")
    // @ts-expect-error — runtime guard
    expect(sanitizeHtml(undefined)).toBe("")
    // @ts-expect-error — runtime guard
    expect(sanitizeHtml(42)).toBe("")
  })

  test("stripAllHtml returns '' for null / undefined / number", () => {
    // @ts-expect-error — runtime guard
    expect(stripAllHtml(null)).toBe("")
    // @ts-expect-error — runtime guard
    expect(stripAllHtml(undefined)).toBe("")
    // @ts-expect-error — runtime guard
    expect(stripAllHtml(42)).toBe("")
  })

  test("sanitizeCssForStyle returns '' for null / undefined / number", () => {
    // @ts-expect-error — runtime guard
    expect(sanitizeCssForStyle(null)).toBe("")
    // @ts-expect-error — runtime guard
    expect(sanitizeCssForStyle(undefined)).toBe("")
    // @ts-expect-error — runtime guard
    expect(sanitizeCssForStyle(42)).toBe("")
  })
})

// ─── O10. Purity / no-throw ──────────────────────────────────────────────
describe("O10: sanitizers are pure and never throw", () => {
  test("empty string in → empty string out", () => {
    expect(sanitizeHtml("")).toBe("")
    expect(stripAllHtml("")).toBe("")
    expect(sanitizeCssForStyle("")).toBe("")
    expect(escapeHtml("")).toBe("")
  })

  test("a giant string does not throw", () => {
    const big = "<b>" + "a".repeat(100_000) + "</b>"
    expect(() => sanitizeHtml(big)).not.toThrow()
    expect(() => stripAllHtml(big)).not.toThrow()
    expect(() => sanitizeCssForStyle(big)).not.toThrow()
  })

  test("regex-special-character payloads do not throw", () => {
    // The sanitizers' regexes are all global / case-insensitive; ensure
    // pathological inputs (backslashes, regex metacharacters, lots of
    // angle brackets) don't cause catastrophic backtracking or throws.
    const pathological = "<<<<<<>>>>>>\"\"\"'''\\\\\\\\\\"
    expect(() => sanitizeHtml(pathological)).not.toThrow()
    expect(() => stripAllHtml(pathological)).not.toThrow()
    expect(() => sanitizeCssForStyle(pathological)).not.toThrow()
    expect(() => escapeHtml(pathological)).not.toThrow()
  })
})

// ─── Integration: chart.tsx-style CSS payload ────────────────────────────
describe("integration: chart.tsx-style CSS payload is hardened", () => {
  test("a normal shadcn chart CSS payload is preserved verbatim", () => {
    const payload = `
.dark [data-chart=chart-1] {
  --color-visits: oklch(0.66 0.2 22);
  --color-clicks: oklch(0.78 0.18 70);
}
`
    expect(sanitizeCssForStyle(payload)).toBe(payload)
  })

  test("a payload with a `</style><script>` breakout in a color value is defanged", () => {
    // Simulate a malicious ChartConfig.color value: `red;</style><script>alert(1)</script><style>`
    const payload = `
.dark [data-chart=chart-1] {
  --color-evil: red;</style><script>alert(1)</script><style>;
}
`
    const out = sanitizeCssForStyle(payload)
    expect(out).not.toContain("</style>")
    expect(out).not.toContain("<script")
    expect(out).toContain("--color-evil")
  })

  test("a payload with javascript: in a url() is defanged", () => {
    const payload = `
.dark [data-chart=chart-1] {
  background: url(javascript:alert(1));
}
`
    const out = sanitizeCssForStyle(payload)
    expect(out).not.toContain("javascript:")
    expect(out).toContain("url(':#')")
  })
})
