/**
 * @file src/lib/safe-json.ts
 *
 * Defensive JSON.parse wrapper for untrusted / partially-trusted strings
 * persisted in the database. Every `Event.data` / `Insight.data` cell is
 * stored as a JSON string written by the ingest path, but a manual DB
 * edit or a partial migration could leave a malformed cell behind.
 *
 * Without this helper, the very first `JSON.parse` in an API response
 * path throws `SyntaxError`, which the outer `sanitizeError()` boundary
 * catches as a 500 — the user sees a generic error and the operator
 * sees noise in logs that does not correspond to a real bug.
 *
 * `safeParseJson(raw, fallback)` returns the parsed value on success,
 * or the provided fallback on any parse failure (logged once at debug
 * level). This converts a 500 into graceful degradation: the rest of
 * the response still renders, and the malformed cell shows as its
 * fallback rather than crashing the whole payload.
 *
 * Scope: pure, synchronous, side-effect-free apart from a debug log.
 */

import { log } from "@/lib/observability"

export function safeParseJson<T = unknown>(
  raw: string | null | undefined,
  fallback: T
): T {
  if (raw == null || raw === "") return fallback
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    // Log and degrade — do not throw. The ingest pipeline validates
    // structure before persisting, so a malformed cell here is either
    // a hand-edit or a migration artifact; either way the response
    // should still render.
    log({
      level: "warn",
      event: "json.parse_failed",
      snippet: raw.slice(0, 80),
      err: e instanceof Error ? e.message : String(e),
    })
    return fallback
  }
}
