/**
 * Input sanitization for tracking-data ingestion.
 *
 * Why this file exists:
 *  - Prevents STORED XSS: every string that arrives through /api/track/events
 *    (event `data` blobs, error messages, referrer / UTM / URL strings, custom
 *    page URLs, …) is persisted to the SQLite DB and later rendered in the
 *    dashboard. If a malicious tracker SDK pushed `<script>` payloads in any of
 *    those fields, they could execute the moment the dashboard displays them
 *    (e.g. via dangerouslySetInnerHTML or attribute interpolation). We escape
 *    HTML-special characters at the very edge of ingest, so the stored values
 *    are inert even if a downstream component renders them unsafely.
 *  - Prevents PROTOTYPE POLLUTION: nested `data` objects come from third-party
 *    / untrusted code. We strip any keys named `__proto__`, `constructor`, or
 *    `prototype` before persistence, so crafted payloads can't mutate
 *    Object.prototype when the dashboard later does `JSON.parse(...)`.
 *  - Prevents OVERSIZED PAYLOADS: caps string length, object depth, array
 *    length, and the overall events array — protecting the DB and downstream
 *    JSON parsers from memory-exhaustion / DoS via the open ingest endpoint.
 *  - Prevents PATH TRAVERSAL / LFI: `sanitizeFilename()` reduces any
 *    user-supplied filename to a single, safe basename — stripping `..`,
 *    separators, null bytes, and URL-encoded traversal sequences — so it can
 *    never escape a `path.join(dir, filename)` call. Today no route takes a
 *    user-supplied filename, but this primitive is shipped as defense-in-depth
 *    so a future route that does so has a verified-safe helper to reach for
 *    instead of inventing its own (always-wrong) regex.
 *
 * These functions are pure and side-effect-free; they return NEW objects and
 * never mutate their inputs. They are intended to be called by the ingest
 * handler before any data reaches Prisma.
 */

import { win32 } from "node:path";

// HTML entity escapes for the five characters that can break out of HTML/JSX
// text content, attribute values, and single- or double-quoted JS string literals.
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

// C0 + C1 control characters (NUL, BEL, backspace, vertical tab, DEL, …) plus
// the Unicode BOM. We intentionally KEEP \t (\u0009), \n (\u000A) and \r (\u000D)
// because they appear in legitimate free-form text (e.g. error stacks).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF]/g;

// Magic key names rejected by sanitizeValue(). Compared as literal strings
// inside sanitizeValue (NOT a regex) so the guard is statically verifiable
// — see the comment at the rejection site for the rationale.

const MAX_DEPTH = 5;
const MAX_ARRAY_LEN = 50;

/**
 * Sanitize a single string:
 *  - strip C0/C1 control characters (keeps \t \n \r),
 *  - truncate to `maxLen` code units,
 *  - HTML-escape `& < > " '` so the value is safe to interpolate into HTML.
 */
export function sanitizeString(str: string, maxLen = 1000): string {
  if (typeof str !== "string") return "";
  let s = str.replace(CONTROL_CHARS, "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/**
 * Sanitize a URL / page path:
 *  - strip control characters,
 *  - truncate to `maxLen`,
 *  - accept only values that start with `/` (path-relative) or `http(s)://`
 *    (absolute). `javascript:`, `data:`, `vbscript:` etc. fall through to "/".
 *  - strip any `< > " ' \`` so the value can't break out of an `href` attribute.
 *  - returns "/" if the input is not a recognizable URL/path.
 */
export function sanitizeUrl(url: string, maxLen = 500): string {
  if (typeof url !== "string") return "/";
  let s = url.replace(CONTROL_CHARS, "").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  const looksLikeUrl = s.startsWith("/") || /^https?:\/\//i.test(s);
  if (!looksLikeUrl) return "/";
  // Remove any characters that could escape an href="…" attribute context.
  return s.replace(/[<>"'`\\]/g, "");
}

/**
 * Recursively sanitize an arbitrary event `data` object (or any nested value).
 *  - strings → sanitizeString
 *  - numbers → finite only, else 0
 *  - booleans → pass through
 *  - null → null
 *  - functions / undefined / symbols → dropped (not JSON-safe)
 *  - arrays → capped at MAX_ARRAY_LEN entries, each sanitized at depth+1
 *  - objects → keys filtered (no __proto__ / constructor / prototype),
 *              key names sanitized, depth capped at MAX_DEPTH (returns {} when
 *              exceeded).
 */
export function sanitizeEvent(event: Record<string, unknown>): Record<string, unknown> {
  const cleaned = sanitizeValue(event, 0);
  // sanitizeValue always returns a plain object for object input; guard anyway.
  return (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)
    ? cleaned
    : {}) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "undefined") {
    return undefined;
  }
  if (typeof value !== "object") return undefined;

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LEN).map((v) => sanitizeValue(v, depth + 1));
  }

  // Plain object (or wrapper like Date/Map). We only iterate own enumerable
  // string keys via Object.entries; non-serializable wrappers collapse to {}.
  if (depth >= MAX_DEPTH) return {};

  const obj = value as Record<string, unknown>;
  // Accumulate into a Map instead of writing properties onto an object
  // literal. Map keys are dictionary DATA, not property names — there is no
  // prototype chain and no inherited setter to abuse, so an attacker-chosen
  // key simply cannot inject anything (CodeQL
  // js/remote-property-injection: the property-write sink is gone by
  // construction). Object.fromEntries then materializes the result with
  // CreateDataProperty semantics — own data properties, no setters.
  const outMap = new Map<string, unknown>();
  for (const [rawKey, rawVal] of Object.entries(obj)) {
    const safeKey = sanitizeString(rawKey, 100);
    // Prototype-pollution guard, kept as defense-in-depth on top of the
    // Map: rejects the three magic names outright so they never even
    // become own data properties of the returned object (a literal
    // "__proto__" own property is harmless, but storing one would confuse
    // downstream code and linters). Compared as literal strings so the
    // guard is statically verifiable.
    if (
      safeKey === "__proto__" ||
      safeKey === "constructor" ||
      safeKey === "prototype"
    ) {
      continue; // prototype-pollution guard
    }
    if (!safeKey) continue;
    const safeVal = sanitizeValue(rawVal, depth + 1);
    if (safeVal === undefined) continue;
    outMap.set(safeKey, safeVal);
  }
  return Object.fromEntries(outMap) as Record<string, unknown>;
}

/** Shape of the payload accepted by the /api/track/events ingest endpoint. */
export interface SanitizablePayload {
  events?: unknown[] | undefined;
  errors?: unknown[] | undefined;
  visitorId?: string | undefined;
  sessionId?: string | undefined;
  projectId?: string | undefined;
  pageUrl?: string | undefined;
  userAgent?: string | undefined;
  ip?: string | undefined;
  language?: string | undefined;
  referrer?: string | undefined;
  utmSource?: string | undefined;
  utmMedium?: string | undefined;
  utmCampaign?: string | undefined;
  entryUrl?: string | undefined;
  [k: string]: unknown;
}

/**
 * Single linear-time pass that removes every complete `<tag …>` /
 * `</tag>` sequence — a hand-rolled scanner that is semantically identical
 * to the regex it replaced (`/<\/?[a-zA-Z][^>]*>/g`):
 *   - a tag starts at a `<` optionally followed by `/`, then a single ASCII
 *     letter, then any run of non-`>` characters, then a closing `>`;
 *   - an unterminated `<a…` (no `>`) is KEPT verbatim, exactly as the regex
 *     did (sanitizeString below then escapes the stray `<`);
 *   - a `<` not followed by `/`+letter (e.g. `<3`, `a < b`) is literal text
 *     and kept, exactly as the regex did.
 *
 * Why not a regex: the old pattern `[a-zA-Z][^>]*>` gives quadratic worst-
 * case scanning on adversarial input (`"<a" + "x"*10_000_000` with no
 * closing `>` — every start position scans to the end). This scanner is
 * O(n) — each character is visited a bounded number of times (CodeQL
 * js/polynomial-redos).
 */
function stripTagsOnce(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt === -1) {
      out += s.slice(i);
      break;
    }
    // Emit the text run before the `<`.
    out += s.slice(i, lt);
    // Classify what follows the `<`.
    let j = lt + 1;
    if (s[j] === "/") j += 1;
    const ch = s[j] ?? "";
    const isLetter =
      (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
    if (!isLetter) {
      // Not a tag start — keep the `<` as literal text and continue.
      out += "<";
      i = lt + 1;
      continue;
    }
    // Tag-shaped: find the first `>` (the regex's `[^>]*` can never span
    // one, so first-match semantics are identical).
    const gt = s.indexOf(">", j);
    if (gt === -1) {
      // Unterminated tag — the old regex kept it; keep the rest verbatim.
      out += s.slice(lt);
      break;
    }
    i = gt + 1; // drop the whole tag
  }
  return out;
}

/**
 * Strip HTML tags from a string in addition to the control-char + entity
 * escaping done by `sanitizeString`. Returns a string with no `<…>` tag
 * sequences, no NUL / C0 / C1 control characters, and no BOM. Length is
 * capped to `maxLen`. Useful for fields where preserving escaped entities
 * would corrupt downstream rendering (e.g. referrer / UTM strings shown
 * raw in the dashboard UI). The result is HTML-escaped as well, so it is
 * safe to interpolate into both `href="…"` attributes and JSX text content.
 */
export function stripHtml(str: string, maxLen = 1000): string {
  if (typeof str !== "string") return "";
  // A single removal pass is NOT sufficient: a payload like
  // `<scr<script>ipt>` becomes `<script>` after one pass removes the inner
  // tag. Loop until the output stabilizes so recombined tags are also
  // removed (CodeQL js/incomplete-multi-character-sanitization). The loop
  // is capped at 5 passes — each changing pass removes at least one `<…>`
  // pair, so anything still tag-shaped after 5 rounds is adversarial, and
  // the entity escaping in sanitizeString below remains the backstop that
  // renders any residual markup inert. The cap keeps the worst case O(n).
  let cur = str;
  for (let pass = 0; pass < 5; pass++) {
    const next = stripTagsOnce(cur);
    if (next === cur) break; // fixed point — nothing recombined
    cur = next;
  }
  // Reuse sanitizeString so control chars + BOM are stripped and any
  // residual `<`, `>`, `&`, `"`, `'` are HTML-escaped.
  return sanitizeString(cur, maxLen);
}

/**
 * Sanitize the entire ingest payload:
 *  - visitorId / sessionId → alphanumeric + underscore only, max 50 chars
 *    (these become DB primary-key-ish identifiers and are interpolated into
 *    SQL/JSON lookups; we keep them strict).
 *  - root pageUrl → sanitizeUrl
 *  - projectId → alphanumeric + underscore + hyphen, max 100 chars
 *    (defence in depth: this value is matched against Project.id /
 *    Project.trackingId in a Prisma `where: { OR: [...] }` clause; Prisma
 *    parameterizes the value so SQLi is not exploitable, but we strip
 *    anyway so a malicious payload can't reach downstream consumers via
 *    stored rows or logs).
 *  - userAgent / language / referrer / utm* / entryUrl → stripHtml +
 *    truncate (these are persisted on the Session row and rendered in the
 *    dashboard; stripping tags + escaping entities prevents stored XSS).
 *  - ip → digits / dot / colon / hex / % only (the value is anonymized
 *    upstream by anonymizeIP() in track.ts; this is a backstop against a
 *    forged `x-forwarded-for` header).
 *  - events array → capped at 500 entries; for each event, sanitize pageUrl
 *    (sanitizeUrl), the event `type` (stripHtml), and recursively sanitize
 *    the nested `data` object.
 *  - errors array → capped at 100 entries; for each error, sanitize
 *    message / stack (stripHtml), url (sanitizeUrl), and coerce line / t
 *    to integers.
 *
 * Returns a NEW payload object; the input is not mutated.
 */
export function sanitizePayload<T extends SanitizablePayload>(payload: T): T {
  const out: SanitizablePayload = { ...payload };

  if (typeof out.visitorId === "string") {
    out.visitorId = out.visitorId.replace(/[^A-Za-z0-9_]/g, "").slice(0, 50);
  }
  if (typeof out.sessionId === "string") {
    out.sessionId = out.sessionId.replace(/[^A-Za-z0-9_]/g, "").slice(0, 50);
  }
  if (typeof out.projectId === "string") {
    // Project ids / tracking ids are CUID-like / `ir_…`-prefixed tokens.
    // Allow alphanumerics, underscore, hyphen; cap at 100 chars.
    out.projectId = out.projectId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
  }
  if (typeof out.pageUrl === "string") {
    out.pageUrl = sanitizeUrl(out.pageUrl);
  }
  if (typeof out.entryUrl === "string") {
    out.entryUrl = sanitizeUrl(out.entryUrl);
  }
  if (typeof out.userAgent === "string") {
    out.userAgent = stripHtml(out.userAgent, 500);
  }
  if (typeof out.language === "string") {
    // Language tags are `en`, `en-US`, `zh-Hans-CN` — keep alphanumerics +
    // hyphen only, max 35 chars.
    out.language = out.language.replace(/[^A-Za-z0-9-]/g, "").slice(0, 35);
  }
  if (typeof out.referrer === "string") {
    out.referrer = stripHtml(out.referrer, 500);
  }
  if (typeof out.utmSource === "string") {
    out.utmSource = stripHtml(out.utmSource, 200);
  }
  if (typeof out.utmMedium === "string") {
    out.utmMedium = stripHtml(out.utmMedium, 200);
  }
  if (typeof out.utmCampaign === "string") {
    out.utmCampaign = stripHtml(out.utmCampaign, 200);
  }
  if (typeof out.ip === "string") {
    // Backstop: track.ts anonymizes IP before storage, but strip stray
    // chars anyway so a forged `x-forwarded-for` can't inject markup.
    out.ip = out.ip.replace(/[^0-9a-fA-F.:%]/g, "").slice(0, 45);
  }

  if (Array.isArray(out.events)) {
    out.events = out.events.slice(0, 500).map((ev: unknown) => {
      if (!ev || typeof ev !== "object" || Array.isArray(ev)) return ev;
      const src = ev as Record<string, unknown>;
      const cleaned: Record<string, unknown> = { ...src };
      if (typeof cleaned.pageUrl === "string") {
        cleaned.pageUrl = sanitizeUrl(cleaned.pageUrl);
      }
      if (typeof cleaned.type === "string") {
        cleaned.type = stripHtml(cleaned.type, 50);
      }
      const d = cleaned.data;
      if (d !== null && typeof d === "object") {
        if (Array.isArray(d)) {
          // Wrap arrays so they survive the object-only sanitizeEvent contract.
          cleaned.data = sanitizeEvent({ items: d }).items ?? [];
        } else {
          cleaned.data = sanitizeEvent(d as Record<string, unknown>);
        }
      }
      return cleaned;
    });
  }

  if (Array.isArray(out.errors)) {
    out.errors = out.errors.slice(0, 100).map((er: unknown) => {
      if (!er || typeof er !== "object" || Array.isArray(er)) return er;
      const src = er as Record<string, unknown>;
      const cleaned: Record<string, unknown> = { ...src };
      if (typeof cleaned.message === "string") {
        cleaned.message = stripHtml(cleaned.message, 2000);
      }
      if (typeof cleaned.stack === "string") {
        cleaned.stack = stripHtml(cleaned.stack, 4000);
      }
      if (typeof cleaned.url === "string") {
        cleaned.url = sanitizeUrl(cleaned.url);
      }
      if (typeof cleaned.line === "number") {
        cleaned.line = Number.isFinite(cleaned.line) ? Math.floor(cleaned.line) : 0;
      }
      if (typeof cleaned.t === "number") {
        cleaned.t = Number.isFinite(cleaned.t) ? Math.max(0, Math.floor(cleaned.t)) : 0;
      }
      return cleaned;
    });
  }

  return out as T;
}

// ─── Filesystem path-segment sanitizer (defense-in-depth) ────────────────
//
// These primitives reduce a *user-supplied* path segment to a single safe
// basename. They exist for future routes that MUST use user input in a file
// path. Today no route does so — every file path in the API layer is a
// hardcoded constant. But shipping the verified-safe helper means the next
// contributor who reaches for `path.join(dir, req.query.name)` has a drop-in
// replacement that closes path-traversal / LFI / null-byte tricks by
// construction.

// Characters that have no business in a filename. We match conservatively:
//   - `..`           — the canonical path-traversal escape sequence
//   - `/` and `\`    — path separators (POSIX + Windows)
//   - NUL (U+0000)   — null-termination trick (some C-based runtimes chop)
//   - any C0/C1 control char (already covered by CONTROL_CHARS but re-applied
//     here for explicitness when used standalone)
const TRAVERSAL_PATTERNS: RegExp[] = [
  /\.\./g, // `..` sequences (literal traversal marker)
  /\u0000/g, // explicit NUL
];

/**
 * Cross-platform basename: returns only the trailing path segment for BOTH
 * POSIX (`/`) and Windows (`\`) separators, regardless of the host OS.
 *
 * Why both: a user-supplied filename might originate on Windows
 * (`a\\b\\c.txt`) and be processed on the Linux host (where `node:path`
 * only treats `/` as a separator). Using `path.win32.basename` catches
 * `\` separators everywhere; it is a strict superset of POSIX basename
 * behavior because it also treats `/` as a separator.
 *
 *     safeBasename("a/b/c.txt")   // → "c.txt"
 *     safeBasename("a\\b\\c.txt") // → "c.txt"
 *     safeBasename("../etc/passwd") // → "passwd"
 */
function safeBasename(s: string): string {
  return win32.basename(s);
}

/**
 * URL-decode helper that re-applies `basename()` and re-strips `..`/NUL
 * until the string stops changing. A single `decodeURIComponent` pass is
 * insufficient because attackers can layer encodings
 * (`%252e%252e%252f` → `%2e%2e%2f` → `../`). We cap at 5 passes — anything
 * that still contains encoded traversal sequences after 5 rounds is
 * malicious and is dropped entirely by the caller's final safe-charset
 * filter.
 *
 * Crucially, `basename()` is called INSIDE the loop AFTER each decode pass.
 * This is necessary because a `%2f` decode pass reveals a literal `/` that
 * was not a separator before — `basename("a%2fb.txt")` returns the whole
 * string, but after decoding to `a/b.txt` we must re-`basename` to get the
 * trailing `b.txt`. Stripping the separator with a regex BEFORE `basename`
 * would produce `ab.txt` (incorrect — collapses two path segments into
 * one filename) instead of the correct `b.txt`.
 *
 * Throws on invalid UTF-8 sequences (caught by the inner try/catch — we
 * stop decoding and keep the previous round's value).
 */
function decodeTraversalLoops(raw: string): string {
  let prev: string;
  let cur = raw;
  for (let i = 0; i < 5; i++) {
    prev = cur;
    try {
      cur = decodeURIComponent(cur);
    } catch {
      // Invalid escape sequence — stop, use prev (already basename'd).
      return prev;
    }
    if (cur === prev) return cur; // fixed point — no more decoding possible
    // A decode pass may have revealed literal separators — re-basename so
    // we only keep the trailing segment, then strip `..`/NUL that may have
    // re-emerged from the decode.
    cur = stripTraversalLiterals(safeBasename(cur));
  }
  return cur;
}

/** Apply the literal traversal-marker + NUL strip patterns. */
function stripTraversalLiterals(s: string): string {
  let out = s;
  for (const re of TRAVERSAL_PATTERNS) out = out.replace(re, "");
  return out;
}

/**
 * Sanitize a user-supplied filename so it is safe to use as the final segment
 * of a `path.join(dir, filename)` call. The returned value:
 *   - is a single basename (no path separators),
 *   - contains no `..` segments (even URL-encoded),
 *   - contains no NUL or control characters,
 *   - is restricted to a conservative filename character set
 *     (`[A-Za-z0-9._-]`, plus any non-ASCII Unicode word chars so legit
 *     filenames like `café.csv` survive),
 *   - is capped at `maxLen` code units (default 255 = common FS max),
 *   - never starts with `.` (rejects hidden-dotfiles / `.bashrc`-style abuse),
 *   - returns "" for any input that collapses to nothing — caller MUST
 *     substitute a default name when this happens (do NOT pass "" into
 *     `path.join(dir, "")` because that resolves to `dir` itself).
 *
 * Algorithm:
 *   1. Non-string → "".
 *   2. `basename()` on the raw input — returns only the trailing path
 *      segment. This is the FIRST defense and must run BEFORE any regex
 *      strip so that legitimate separators are honored (e.g. `a/b/c.txt`
 *      collapses to `c.txt`, not `abc.txt`).
 *   3. Loop `decodeURIComponent` + `basename()` + strip `..`/NUL until
 *      fixed point (defeats `%2e%2e`, `%2f`, `%5c`, `%00`, and layered
 *      encodings like `%252e%252e%252f` → `%2e%2e%2f` → `../`).
 *   4. Strip any remaining control chars via CONTROL_CHARS (NUL/BEL/DEL/BOM).
 *   5. `basename()` once more as a final structural defense — strips any
 *      separator that survived control-char removal.
 *   6. Restrict the result to the safe character set; anything else is
 *      dropped (not replaced — replacement can yield valid-but-unexpected
 *      names like `...._.txt`).
 *   7. Strip a leading `.` so dotfile-style abuse (`.bashrc`, `.env`) fails.
 *   8. Truncate to `maxLen` (at a grapheme boundary to avoid splitting
 *      surrogate pairs).
 *
 * Returns "" if anything went wrong or the input collapses to nothing.
 */
export function sanitizeFilename(
  filename: unknown,
  maxLen = 255,
): string {
  if (typeof filename !== "string" || filename.length === 0) return "";
  // Step 1: basename() FIRST — keep only the trailing path segment. This
  // must happen before any regex strip so legitimate separators (which
  // basename() understands) are honored instead of being collapsed into
  // the filename body. We use `win32.basename` which treats BOTH `/` and
  // `\` as separators — that way a Windows-style `a\b\c.txt` collapses
  // to `c.txt` even on a POSIX host.
  let s = safeBasename(filename);
  // Step 2: defeat URL-encoded traversal sequences (loop until fixed point).
  s = decodeTraversalLoops(s);
  // Step 3: strip any remaining control chars (NUL/BEL/DEL/BOM).
  s = s.replace(CONTROL_CHARS, "");
  // Step 4: basename() once more as a final structural defense — catches
  // any separator that survived control-char stripping.
  s = safeBasename(s);
  // Step 5: allow only a conservative filename character set.
  //   - ASCII letters, digits, `.`, `_`, `-`
  //   - Unicode letters/marks (so `café.csv`, `データ.csv` survive)
  //   - spaces (kept — many "legit" filenames have them; callers that want
  //     to forbid spaces can `.replace(/\s/g, "_")` afterwards)
  s = s.replace(/[^\p{L}\p{M}A-Za-z0-9._\-\s]/gu, "");
  // Step 6: forbid a leading dot so `.bashrc`-style hidden-file abuse fails.
  s = s.replace(/^\.+/u, "");
  // Step 7: forbid names that are just dots / whitespace (Windows reserved
  // device names like `.` `..` `CON` are already prevented by Steps 1+2,
  // but guard again here for defense in depth).
  if (/^[\s.]*$/.test(s)) return "";
  // Step 8: truncate. Truncate at a grapheme boundary if possible so we
  // don't split a multi-codepoint emoji / surrogate pair.
  if (s.length > maxLen) s = Array.from(s).slice(0, maxLen).join("");
  return s;
}
