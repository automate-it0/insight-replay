/**
 * Output-side HTML sanitizer for cases where `dangerouslySetInnerHTML` is
 * genuinely unavoidable (e.g. inlining CSS into a `<style>` element, which
 * React cannot render as raw CSS text content any other way).
 *
 * ───────────────────────────────────────────────────────────────────────
 * IMPLEMENTATION: REAL HTML TOKENIZER (not regex).
 * ───────────────────────────────────────────────────────────────────────
 * The previous version of this file used a stack of regex `.replace()`
 * calls (SCRIPT_BLOCK, ON_HANDLER, DANGEROUS_SCHEME, RAWTEXT_BREAKOUT,
 * ANY_TAG). Regex-based "HTML parsing" is fundamentally unsound because
 * HTML is not a regular language — quoted attribute values can contain
 * `<`, `>`, `</script>`, etc. and a regex has no way to know whether it
 * is "inside" a quoted value or a `<script>` body. This makes regex
 * sanitizers bypassable by novel payloads.
 *
 * This file replaces the regex stack with a small, dependency-free,
 * state-machine HTML TOKENIZER that walks the input character-by-character
 * and understands:
 *   - HTML comments `<!-- ... -->`
 *   - CDATA sections `<![CDATA[ ... ]]>`
 *   - DOCTYPE / processing-instruction bang-tags `<!doctype html>` `<?xml?>`
 *   - Start tags with quoted (single / double) AND unquoted attribute values
 *   - End tags `</name>`
 *   - Self-closing start tags `<img ... />`
 *   - The RAW-TEXT / RCDATA content model: content of `<script>`, `<style>`,
 *     `<textarea>`, `<title>`, etc. is NOT tokenized as HTML — the parser
 *     treats it as plain text until the matching closing tag.
 *
 * The tokenizer never enters a quoted attribute value as a tag terminator
 * (so `<a title="3 > 2">` parses as a single start tag, not as a partial
 * tag terminated at the first `>`), and it correctly consumes the entire
 * body of a `<script>...</script>` element as inert text.
 *
 * No external HTML parser (`linkedom`, `cheerio`, `dompurify`) is required
 * — the tokenizer is ~200 lines and zero-dependency.
 *
 * ───────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS ALONGSIDE `src/lib/sanitize.ts`:
 *  - `sanitize.ts` is the INPUT-side sanitizer: it escapes inbound strings
 *    at the ingest edge so stored DB values are inert. Defense in depth —
 *    but it only protects values that flow through `/api/track/events`.
 *    Application configuration, AI-generated content, future admin-
 *    configured strings, and library-provided values (e.g. shadcn
 *    `<ChartStyle>` colors) never pass through ingest, so they need an
 *    OUTPUT-side sanitizer here.
 *  - This module strips the four classic stored/reflected-XSS payloads:
 *      1. `<script>...</script>` blocks (entire element, including body)
 *      2. Inline event-handler attributes (`onerror=`, `onload=`, …)
 *      3. `javascript:`, `vbscript:`, `data:text/html` URI schemes
 *      4. Raw-text-element breakouts (`</style>`, `</script>`,
 *         `</textarea>`, …) so a payload cannot escape a raw-text context
 *  - It is intentionally SMALL and dependency-free. The trade-off vs. a
 *    full DOMPurify-style allow-list parser is documented: this sanitizer
 *    NEUTRALIZES the four primitives above; it does NOT enforce an
 *    allow-list of safe tags / attributes. We therefore ALSO recommend
 *    (and the project enforces via ESLint `react/no-danger`) that
 *    `dangerouslySetInnerHTML` is never used for arbitrary user-supplied
 *    HTML — only for narrow, structured payloads (CSS strings, well-known
 *    config) that this sanitizer can reason about.
 *
 * These functions are pure and side-effect-free; they return NEW strings
 * and never mutate their inputs. They are intended to be called
 * immediately before any `dangerouslySetInnerHTML={{ __html: ... }}` site.
 *
 * PUBLIC API (preserved from the regex version — no caller changes):
 *   - sanitizeHtml(input: string): string
 *   - stripAllHtml(input: string): string
 *   - sanitizeCssForStyle(input: string): string
 *   - escapeHtml(input: string): string
 */

// ─── Character classes (no regex) ───────────────────────────────────────
function isAsciiLetter(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}
function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isWordChar(c: string): boolean {
  return isAsciiLetter(c) || isDigit(c) || c === "_";
}
function isWhitespace(c: string): boolean {
  // HTML whitespace: space, tab, LF, CR, form feed, vertical tab.
  return (
    c === " " ||
    c === "\t" ||
    c === "\n" ||
    c === "\r" ||
    c === "\f" ||
    c === "\v"
  );
}
function isTagNameChar(c: string): boolean {
  // HTML tag-name characters: letters, digits, -, _, :, .
  return isWordChar(c) || c === "-" || c === ":" || c === ".";
}

// ─── HTML entity escape (char-by-char, no regex) ───────────────────────
/** Standard HTML entity escapes for the five HTML-special characters. */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escape HTML-special characters in a string so it is safe to interpolate
 * into HTML text content or an attribute value. Equivalent to React's own
 * JSX-text auto-escaping — exported so `dangerouslySetInnerHTML` consumers
 * can opt back into the safe default when they don't actually need HTML.
 *
 * Implementation: char-by-char scan (no regex).
 */
export function escapeHtml(input: string): string {
  if (typeof input !== "string") return "";
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    out += HTML_ESCAPES[ch] ?? ch;
  }
  return out;
}

// ─── Raw-text / RCDATA element set ─────────────────────────────────────
// Content of these elements is plain text — the HTML parser does NOT
// tokenize tags inside them. The OUTPUT sanitizer therefore strips their
// opening AND closing tags wherever they appear (as breakout protection)
// and treats `<script>` bodies as inert (drop the entire element).
//
// This set mirrors the HTML5 "raw text" and "escapable raw text" element
// list, plus a few legacy RCDATA elements.
const RAWTEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "style",
  "script",
  "template",
  "textarea",
  "title",
  "noscript",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
]);

// ─── Token types ───────────────────────────────────────────────────────
type Attr = {
  name: string;
  value: string | null; // null = boolean attribute (no value)
  quote: '"' | "'" | null; // null = unquoted value
};

type Token =
  | { kind: "text"; text: string }
  | { kind: "comment" } // <!-- ... -->  → dropped
  | { kind: "cdata" } // <![CDATA[ ... ]]>  → dropped
  | { kind: "bangTag"; raw: string } // <!doctype html> / <?xml?>  → preserved
  | { kind: "scriptElement" } // entire <script>...</script> or <script/>  → dropped
  | { kind: "rawtextBreakout" } // opening/closing tag of a non-script rawtext element  → dropped
  | { kind: "startTag"; name: string; attrs: Attr[]; selfClosing: boolean; raw: string }
  | { kind: "endTag"; name: string; raw: string };

// ─── Tokenizer scanning helpers ────────────────────────────────────────

/**
 * Scan from `start` until a `>` outside of any quoted string. Returns the
 * index AFTER `>` (i.e. one past the closing `>`), or `-1` if no closing
 * `>` exists in the rest of the input. Handles `"` and `'` quoted attribute
 * values — a `>` inside a quoted value does NOT terminate the tag.
 */
function findGtEnd(input: string, start: number): number {
  const n = input.length;
  let i = start;
  let quote: string | null = null;
  while (i < n) {
    const c = input[i];
    if (quote !== null) {
      if (c === quote) quote = null;
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
      i++;
    } else if (c === ">") {
      return i + 1;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Scan from `start` until the literal substring `-->`. Returns the index
 * AFTER `-->`, or `-1` if not found.
 */
function findCommentEnd(input: string, start: number): number {
  const n = input.length;
  let i = start;
  while (i + 2 < n) {
    if (input[i] === "-" && input[i + 1] === "-" && input[i + 2] === ">") {
      return i + 3;
    }
    i++;
  }
  // Tail check: if the remaining input is exactly "-->" or a prefix of it,
  // we still need to confirm "-->" was fully present.
  if (i + 2 === n - 0 && n - i >= 3 && input[i] === "-" && input[i + 1] === "-" && input[i + 2] === ">") {
    return i + 3;
  }
  return -1;
}

/**
 * Scan from `start` until the literal substring `]]>`. Returns the index
 * AFTER `]]>`, or `-1` if not found.
 */
function findCDataEnd(input: string, start: number): number {
  const n = input.length;
  let i = start;
  while (i + 2 < n) {
    if (input[i] === "]" && input[i + 1] === "]" && input[i + 2] === ">") {
      return i + 3;
    }
    i++;
  }
  return -1;
}

/**
 * Case-insensitive comparison of `input[pos : pos + target.length]` against
 * the lowercase `target`. Returns false if `input` is too short.
 */
function lcEqAt(input: string, pos: number, target: string): boolean {
  for (let t = 0; t < target.length; t++) {
    const c = input[pos + t];
    if (c === undefined) return false;
    const lc =
      c >= "A" && c <= "Z" ? String.fromCharCode(c.charCodeAt(0) + 32) : c;
    if (lc !== target[t]) return false;
  }
  return true;
}

/**
 * Scan from `start` for `</script` (case-insensitive) followed by optional
 * whitespace then `>` — i.e. the canonical closing-tag form matched by the
 * original regex `<\/script\s*>`. Returns the index AFTER `>`, or `-1` if
 * no closing `</script>` exists in the rest of the input.
 *
 * (Real HTML5 also allows attributes on a closing tag — `</script foo>`.
 * We deliberately do NOT accept those: matching the original regex's
 * behavior keeps the sanitizer's contract identical to the previous
 * version.)
 */
function findScriptClose(input: string, start: number): number {
  const n = input.length;
  const target = "</script";
  const tl = target.length;
  for (let k = start; k + tl <= n; k++) {
    if (lcEqAt(input, k, target)) {
      let j = k + tl;
      while (j < n && isWhitespace(input[j])) j++;
      if (j < n && input[j] === ">") {
        return j + 1;
      }
    }
  }
  return -1;
}

/**
 * Parse attributes from `input[bodyStart : bodyEnd]` — the portion of a
 * start tag AFTER the tag name and INCLUDING the closing `>`. Returns the
 * parsed attribute list and whether the tag is self-closing (`/>`).
 *
 * Stops at `>` (which must be present in the body). Understands:
 *   - Whitespace separation between attributes
 *   - Quoted values: `attr="..."`, `attr='...'`
 *   - Unquoted values: `attr=value` (terminated by whitespace, `>`, or `/`)
 *   - Boolean attributes: `attr` (no `=`)
 *   - Self-closing marker: `/>` (also `/ >` with whitespace)
 */
function parseStartTagAttrs(
  input: string,
  bodyStart: number,
  bodyEnd: number,
): { attrs: Attr[]; selfClosing: boolean } {
  const attrs: Attr[] = [];
  let selfClosing = false;
  let i = bodyStart;
  while (i < bodyEnd) {
    const c = input[i];
    if (isWhitespace(c)) {
      i++;
      continue;
    }
    if (c === ">") {
      // end of tag
      break;
    }
    if (c === "/") {
      // Possibly the self-closing marker. Confirm by looking for `>` after
      // any whitespace. If not, treat the lone `/` as a stray char.
      let k = i + 1;
      while (k < bodyEnd && isWhitespace(input[k])) k++;
      if (k < bodyEnd && input[k] === ">") {
        selfClosing = true;
        break;
      }
      i++;
      continue;
    }
    // Attribute name: read until `=`, whitespace, `>`, or `/`.
    const nameStart = i;
    while (i < bodyEnd) {
      const cc = input[i];
      if (cc === "=" || isWhitespace(cc) || cc === ">" || cc === "/") break;
      i++;
    }
    const name = input.slice(nameStart, i);
    if (name.length === 0) {
      // Defensive: no progress — skip one char to avoid an infinite loop.
      i++;
      continue;
    }
    // Skip whitespace before potential `=`.
    let j = i;
    while (j < bodyEnd && isWhitespace(input[j])) j++;
    if (j < bodyEnd && input[j] === "=") {
      j++; // consume `=`
      while (j < bodyEnd && isWhitespace(input[j])) j++;
      const qChar = input[j];
      if (j < bodyEnd && (qChar === '"' || qChar === "'")) {
        const quote: '"' | "'" = qChar;
        const valStart = j + 1;
        let valEnd = valStart;
        while (valEnd < bodyEnd && input[valEnd] !== quote) valEnd++;
        const value = input.slice(valStart, valEnd);
        attrs.push({ name, value, quote });
        i = valEnd < bodyEnd ? valEnd + 1 : bodyEnd;
      } else {
        // Unquoted value: terminated by whitespace, `>`, or `/`.
        const valStart = j;
        let valEnd = valStart;
        while (valEnd < bodyEnd) {
          const v = input[valEnd];
          if (isWhitespace(v) || v === ">" || v === "/") break;
          valEnd++;
        }
        const value = input.slice(valStart, valEnd);
        attrs.push({ name, value, quote: null });
        i = valEnd;
      }
    } else {
      // Boolean attribute (no `=`).
      attrs.push({ name, value: null, quote: null });
      i = j;
    }
  }
  return { attrs, selfClosing };
}

/**
 * The HTML tokenizer. Walks `input` character-by-character and emits a
 * stream of tokens. See the `Token` type above for the kinds.
 *
 * Notable behavior:
 *   - A lone `<` not followed by a valid tag-start char (`!`, `?`, `/`,
 *     ASCII letter) is treated as literal text. This matches the HTML5
 *     tokenizer's "less-than sign" handling.
 *   - Unterminated start / end / bang tags (no closing `>` anywhere in the
 *     rest of the input) are treated as text. This matches the original
 *     regex behavior, which required a closing `>` on every tag pattern.
 *   - Unterminated `<!--` and `<![CDATA[` are also treated as text.
 *   - `<script>...</script>` is consumed as a single `scriptElement` token
 *     (entire element dropped by the emitter). An unterminated `<script>`
 *     (no closing `</script>`) is treated as a `rawtextBreakout` (drop just
 *     the opening tag, leave the body as text) — matching the original
 *     regex's fallback to RAWTEXT_BREAKOUT.
 */
function tokenizeHtml(input: string): Token[] {
  const tokens: Token[] = [];
  const n = input.length;
  let i = 0;
  let textBuf = "";
  const flushText = () => {
    if (textBuf.length > 0) {
      tokens.push({ kind: "text", text: textBuf });
      textBuf = "";
    }
  };

  while (i < n) {
    const c = input[i];
    if (c !== "<") {
      textBuf += c;
      i++;
      continue;
    }
    // c === "<"
    const c2 = input[i + 1];

    // 1. Comment <!-- ... -->
    if (c2 === "!" && input[i + 2] === "-" && input[i + 3] === "-") {
      const end = findCommentEnd(input, i + 4);
      if (end === -1) {
        // Unterminated comment → treat `<` as text.
        textBuf += c;
        i++;
        continue;
      }
      flushText();
      tokens.push({ kind: "comment" });
      i = end;
      continue;
    }

    // 2. CDATA <![CDATA[ ... ]]>
    if (c2 === "!" && lcEqAt(input, i, "<![CDATA[")) {
      const end = findCDataEnd(input, i + 9);
      if (end === -1) {
        textBuf += c;
        i++;
        continue;
      }
      flushText();
      tokens.push({ kind: "cdata" });
      i = end;
      continue;
    }

    // 3. Other bang-tag / processing-instruction: <!doctype html> / <?xml?>
    if (c2 === "!" || c2 === "?") {
      const end = findGtEnd(input, i + 2);
      if (end === -1) {
        textBuf += c;
        i++;
        continue;
      }
      flushText();
      tokens.push({ kind: "bangTag", raw: input.slice(i, end) });
      i = end;
      continue;
    }

    // 4. End tag </name ...>
    if (c2 === "/") {
      let j = i + 2;
      while (j < n && isWhitespace(input[j])) j++;
      const nameStart = j;
      while (j < n && isTagNameChar(input[j])) j++;
      const name = input.slice(nameStart, j).toLowerCase();
      const end = findGtEnd(input, j);
      if (end === -1) {
        textBuf += c;
        i++;
        continue;
      }
      flushText();
      if (RAWTEXT_ELEMENTS.has(name)) {
        tokens.push({ kind: "rawtextBreakout" });
      } else {
        tokens.push({ kind: "endTag", name, raw: input.slice(i, end) });
      }
      i = end;
      continue;
    }

    // 5. Start tag — first char after `<` must be an ASCII letter.
    if (c2 !== undefined && isAsciiLetter(c2)) {
      let j = i + 1;
      const nameStart = j;
      while (j < n && isTagNameChar(input[j])) j++;
      const name = input.slice(nameStart, j).toLowerCase();
      const tagEnd = findGtEnd(input, j);
      if (tagEnd === -1) {
        // No closing `>` anywhere → treat `<` as text (matches original
        // regex behavior which required `>` on every tag pattern).
        textBuf += c;
        i++;
        continue;
      }
      const raw = input.slice(i, tagEnd);

      // <script>...</script> — consume the entire element.
      if (name === "script") {
        const { selfClosing } = parseStartTagAttrs(input, j, tagEnd);
        if (selfClosing) {
          flushText();
          tokens.push({ kind: "scriptElement" });
          i = tagEnd;
          continue;
        }
        const closeEnd = findScriptClose(input, tagEnd);
        if (closeEnd === -1) {
          // Unterminated <script> — drop just the opening tag, leave body
          // as text (matches original regex fallback).
          flushText();
          tokens.push({ kind: "rawtextBreakout" });
          i = tagEnd;
          continue;
        }
        flushText();
        tokens.push({ kind: "scriptElement" });
        i = closeEnd;
        continue;
      }

      // Other start tag.
      flushText();
      const { attrs, selfClosing } = parseStartTagAttrs(input, j, tagEnd);
      if (RAWTEXT_ELEMENTS.has(name)) {
        // Opening tag of a non-script rawtext element (style, textarea,
        // title, …) — drop the opening tag, leave any body as text.
        tokens.push({ kind: "rawtextBreakout" });
      } else {
        tokens.push({ kind: "startTag", name, attrs, selfClosing, raw });
      }
      i = tagEnd;
      continue;
    }

    // 6. Lone `<` not followed by a valid tag-start char → literal text.
    textBuf += c;
    i++;
  }
  flushText();
  return tokens;
}

// ─── Attribute filtering helpers ────────────────────────────────────────

/**
 * Returns true if `name` looks like an inline event-handler attribute
 * (`onerror`, `onload`, `onclick`, `ontoggle`, …): starts with `on`
 * (case-insensitive) followed by AT LEAST ONE word char (`[a-zA-Z0-9_]`).
 *
 * Matches the original regex `on\w+\s*=` behavior — the regex required at
 * least one word char between `on` and `=, so `on=...` (no word chars)
 * was not stripped. We preserve that behavior.
 */
function isEventHandlerName(name: string): boolean {
  if (name.length < 3) return false;
  const a = name[0];
  const b = name[1];
  if (!(a === "o" || a === "O")) return false;
  if (!(b === "n" || b === "N")) return false;
  for (let k = 2; k < name.length; k++) {
    if (!isWordChar(name[k])) return false;
  }
  return true;
}

/**
 * Attribute names whose values may carry a URI. If the value starts with a
 * dangerous URI scheme (`javascript:`, `vbscript:`, `data:text/html`), the
 * value is replaced with the inert placeholder `:#`.
 */
const URL_ATTRS: ReadonlySet<string> = new Set([
  "href",
  "src",
  "xlink:href",
  "formaction",
  "action",
  "data",
  "poster",
]);

/**
 * Returns true if `value` starts (after optional leading whitespace) with
 * a dangerous URI scheme: `javascript:`, `vbscript:`, or
 * `data:text/html`. Case-insensitive. Allows optional internal whitespace
 * around the `:` and the `/` (matching the original regex
 * `data\s*:\s*text\/html`).
 */
function startsWithDangerousScheme(value: string): boolean {
  const n = value.length;
  let i = 0;
  // Skip leading whitespace.
  while (i < n && isWhitespace(value[i])) i++;
  // Read scheme name (letters only).
  const schemeStart = i;
  while (i < n) {
    const c = value[i];
    if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) i++;
    else break;
  }
  const scheme = value.slice(schemeStart, i).toLowerCase();
  if (scheme !== "javascript" && scheme !== "vbscript" && scheme !== "data") {
    return false;
  }
  // Optional whitespace before `:`.
  while (i < n && isWhitespace(value[i])) i++;
  if (i >= n || value[i] !== ":") return false;
  i++; // consume `:`
  if (scheme === "javascript" || scheme === "vbscript") return true;
  // For `data:`, must be followed by `text/html` (with optional internal
  // whitespace around `/`).
  while (i < n && isWhitespace(value[i])) i++;
  if (!lcEqAt(value, i, "text")) return false;
  i += 4;
  while (i < n && isWhitespace(value[i])) i++;
  if (i >= n || value[i] !== "/") return false;
  i++;
  while (i < n && isWhitespace(value[i])) i++;
  if (!lcEqAt(value, i, "html")) return false;
  return true;
}

// ─── CSS text scanner (for sanitizeCssForStyle) ───────────────────────

/**
 * Neutralize CSS-side XSS payloads inside a raw-text token:
 *   - `url(javascript:…)`, `url('vbscript:…')`, `url(data:text/html…)` →
 *     replaced with `url(':#')` (inert placeholder).
 *   - `expression(…)` (legacy IE CSS expression execution) → replaced
 *     with `expression-disabled(`.
 *
 * Safe `url(https://…)` payloads are preserved verbatim.
 *
 * Implementation: char-by-char scan, no regex.
 */
function sanitizeCssText(input: string): string {
  const n = input.length;
  let out = "";
  let i = 0;
  while (i < n) {
    // Try `url(` (case-insensitive, with optional whitespace before `(`).
    if (lcEqAt(input, i, "url")) {
      let p = i + 3;
      while (p < n && isWhitespace(input[p])) p++;
      if (p < n && input[p] === "(") {
        const result = parseUrlFunction(input, p + 1);
        if (result.schemeDangerous) {
          out += "url(':#')";
        } else {
          // Preserve the original `url(...)` text verbatim.
          out += input.slice(i, result.end);
        }
        i = result.end;
        continue;
      }
    }
    // Try `expression(` (case-insensitive, with optional whitespace
    // before `(`).
    if (lcEqAt(input, i, "expression")) {
      let p = i + "expression".length;
      while (p < n && isWhitespace(input[p])) p++;
      if (p < n && input[p] === "(") {
        out += "expression-disabled(";
        i = p + 1;
        continue;
      }
    }
    out += input[i];
    i++;
  }
  return out;
}

/**
 * Parse the contents of a CSS `url(...)` function starting just after the
 * opening `(`. Returns:
 *   - `schemeDangerous`: whether the URL value starts with a dangerous
 *     scheme (and should be replaced with `url(':#')`).
 *   - `end`: the index AFTER the closing `)` (or after the value if no
 *     closing `)` was found — the caller advances by this much).
 */
function parseUrlFunction(
  input: string,
  start: number,
): { schemeDangerous: boolean; end: number } {
  const n = input.length;
  let j = start;
  // Skip leading whitespace inside the parens.
  while (j < n && isWhitespace(input[j])) j++;
  // Optional quote.
  let quote: string | null = null;
  if (j < n && (input[j] === '"' || input[j] === "'")) {
    quote = input[j];
    j++;
  }
  const valStart = j;
  while (j < n) {
    const c = input[j];
    if (quote !== null) {
      if (c === quote) break;
      j++;
    } else {
      if (c === ")" || isWhitespace(c)) break;
      j++;
    }
  }
  const valEnd = j;
  const value = input.slice(valStart, valEnd);
  // Advance past optional closing quote + whitespace, then expect `)`.
  let k = valEnd;
  if (quote !== null && k < n && input[k] === quote) k++;
  while (k < n && isWhitespace(input[k])) k++;
  const end = k < n && input[k] === ")" ? k + 1 : k;
  return { schemeDangerous: startsWithDangerousScheme(value), end };
}

// ─── Emitters ──────────────────────────────────────────────────────────

/** Emit a single attribute as `name`, `name=value`, `name="value"`, etc. */
function emitAttr(attr: Attr): string {
  if (attr.value === null) return attr.name; // boolean attribute
  if (attr.quote === null) return `${attr.name}=${attr.value}`; // unquoted
  return `${attr.name}=${attr.quote}${attr.value}${attr.quote}`; // quoted
}

/**
 * Emit a start-tag with attribute filtering applied:
 *   - Drop `on*` event-handler attributes that have a value.
 *   - Replace URI-attribute values that start with a dangerous scheme with
 *     the inert placeholder `:#` (preserving the original quote style, or
 *     unquoted if originally unquoted).
 *   - Preserve all other attributes verbatim.
 */
function emitFilteredStartTag(token: {
  name: string;
  attrs: Attr[];
  selfClosing: boolean;
}): string {
  let s = "<" + token.name;
  for (const attr of token.attrs) {
    // Drop on*=... event handlers.
    if (attr.value !== null && isEventHandlerName(attr.name)) continue;
    // Neutralize dangerous URI schemes.
    if (
      attr.value !== null &&
      URL_ATTRS.has(attr.name.toLowerCase()) &&
      startsWithDangerousScheme(attr.value)
    ) {
      const q = attr.quote ?? "";
      s += ` ${attr.name}=${q}:#${q}`;
      continue;
    }
    // Preserve verbatim.
    s += " " + emitAttr(attr);
  }
  if (token.selfClosing) s += " /";
  s += ">";
  return s;
}

type EmitMode = "sanitizeHtml" | "stripAllHtml" | "css";

function emitTokens(tokens: Token[], mode: EmitMode): string {
  let out = "";
  for (const t of tokens) {
    switch (t.kind) {
      case "text":
        out += mode === "css" ? sanitizeCssText(t.text) : t.text;
        break;
      case "bangTag":
        // `<!doctype html>` / `<?xml?>`: preserved by sanitizeHtml and css,
        // dropped by stripAllHtml (matches the original ANY_TAG rule).
        if (mode !== "stripAllHtml") out += t.raw;
        break;
      case "startTag":
        if (mode === "stripAllHtml") {
          // drop all tags
        } else if (mode === "css") {
          out += t.raw; // preserve as-is
        } else {
          out += emitFilteredStartTag(t);
        }
        break;
      case "endTag":
        if (mode !== "stripAllHtml") out += t.raw;
        break;
      case "comment":
      case "cdata":
      case "scriptElement":
      case "rawtextBreakout":
        // Always dropped.
        break;
    }
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Sanitize an HTML string for safe insertion via `dangerouslySetInnerHTML`.
 *
 * Performs (via a real HTML tokenizer, NOT regex):
 *   1. Strip `<script>…</script>` elements entirely (opening tag, body, and
 *      closing tag). Self-closing `<script/>` is also stripped.
 *   2. Strip `<!--…-->` comments and `<![CDATA[…]]>` sections.
 *   3. Strip `on*=…` event-handler attributes from surviving start tags.
 *   4. Replace `javascript:`/`vbscript:`/`data:text/html` URI schemes (in
 *      `href` / `src` / `xlink:href` / `formaction` / `action` / `data` /
 *      `poster` attributes) with the inert placeholder `:#`, preserving
 *      the attribute's syntactic validity.
 *   5. Strip any `</style>` / `</script>` / `</template>` / `</textarea>`
 *      / `</title>` / etc. raw-text closing tags AND their opening
 *      counterparts, so a payload cannot break out of a raw-text element.
 *
 * Other tags (and their non-event-handler, non-dangerous-scheme attributes)
 * are preserved — this is the right call when the input is a TRUSTED HTML
 * fragment (e.g. generated by a server-side template that the application
 * controls) and you only want to neutralize the four XSS primitives above.
 * For UNTRUSTED HTML, prefer `stripAllHtml` (drops all tags) or — better —
 * don't render it as HTML at all.
 *
 * @example
 *   sanitizeHtml('<a href="javascript:alert(1)" onerror="alert(1)">x</a>')
 *   // → '<a href=":#">x</a>'
 */
export function sanitizeHtml(input: string): string {
  if (typeof input !== "string") return "";
  return emitTokens(tokenizeHtml(input), "sanitizeHtml");
}

/**
 * Strict sanitizer: drop ALL HTML tags from the input, returning only the
 * textual content. Use this when the input is UNTRUSTED and you only need
 * the text — this is the safest possible `dangerouslySetInnerHTML` payload
 * because there are no tags left to interpret.
 *
 * `<script>` bodies are dropped along with their tags (the tokenizer
 * consumes the entire `<script>...</script>` element as a single inert
 * token). After that, every remaining tag (start, end, bang, comment,
 * CDATA, raw-text breakout) is removed, leaving only text.
 *
 * @example
 *   stripAllHtml('<b>hello</b><script>alert(1)</script>')
 *   // → 'hello'
 */
export function stripAllHtml(input: string): string {
  if (typeof input !== "string") return "";
  return emitTokens(tokenizeHtml(input), "stripAllHtml");
}

/**
 * Sanitize a CSS string for safe insertion into a `<style>` element via
 * `dangerouslySetInnerHTML`.
 *
 * The HTML parser treats the content of `<style>` as RAW TEXT — it does
 * not decode entities or parse tags inside it until it sees `</style>`. The
 * only XSS vector inside a `<style>` block is therefore a `</style>`
 * closing tag (optionally followed by `<script>` etc.), which breaks the
 * parser back into normal HTML mode and lets the attacker inject tags.
 *
 * This function:
 *   1. Strips any `</style>` closing tag (case-insensitive).
 *   2. Strips any `<style` opening tag (defense-in-depth).
 *   3. Strips any other raw-text-element breakouts (`</script>`,
 *      `<script>`, `</textarea>`, etc.) so the value can be safely
 *      interpolated into other raw-text contexts too.
 *   4. Strips HTML comments `<!-- … -->` (legacy IE conditional-comment
 *      vector inside `<style>`).
 *   5. Strips `url(javascript:…)`, `url(vbscript:…)`, `url(data:text/html…)`
 *      CSS function payloads — these were historically executable in IE
 *      and remain a parser-confusion vector.
 *   6. Strips CSS `expression(…)` payloads (legacy IE CSS expression
 *      execution — no longer executes in modern browsers, but defense in
 *      depth).
 *
 * @example
 *   sanitizeCssForStyle('a { color: red; } </style><script>alert(1)</script>')
 *   // → 'a { color: red; } <script>alert(1)</script>'
 *   // (the `</style>` is stripped, so the parser never re-enters HTML mode
 *   //  and the `<script>` text is treated as inert CSS text inside <style>)
 */
export function sanitizeCssForStyle(input: string): string {
  if (typeof input !== "string") return "";
  return emitTokens(tokenizeHtml(input), "css");
}
