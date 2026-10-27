// File integrity monitoring — detect modifications to source files and
// fire a security alert the moment a hash diverges from the baseline.
//
// ## Why this file exists
//
// The project's audit log (`src/lib/audit.ts`) is already tamper-evident
// via a SHA-256 hash chain. But that chain only protects the audit log
// itself — it does not catch an attacker who edits:
//
//   - `src/lib/session.ts`        (to weaken session signing)
//   - `src/lib/auth.ts`            (to bypass API-key validation)
//   - `prisma/schema.prisma`       (to drop a UNIQUE constraint)
//   - `next.config.ts`             (to neuter security headers)
//   - `src/middleware.ts`          (to disable the rate-limit / CSP layers)
//
// … or any of the other load-bearing security files. The audit log chain
// would not flag those edits because the audit log itself is unchanged.
//
// This module closes that gap. At server boot, `src/instrumentation.ts`
// calls `captureIntegrityBaseline()` — which walks `src/` and stores the
// SHA-256 of every `.ts` / `.tsx` file on `globalThis.__fileIntegrityState`.
// `startIntegrityMonitor()` then schedules `verifyIntegrity()` on a 5-min
// `setInterval` (`.unref()`'d, no-op in dev) that re-walks `src/` and
// compares. ANY diff (modified / missing / new file) flips a STICKY
// `compromised` flag on `globalThis.__fileIntegrityState` — the Edge
// middleware reads that flag on every request and short-circuits with
// 503 "System maintenance" the moment it's set (see `src/middleware.ts`
// Layer -2). A `sendSecurityAlert("critical", ...)` is fired in parallel
// so the operator is pinged on Discord/Slack/Teams.
//
// The flag is intentionally STICKY — once tripped, every subsequent
// request gets 503 until the process restarts. This is fail-closed by
// design: an attacker who tampered with one file may have tampered with
// the verifier itself, so we cannot trust any further verification. The
// operator must restart with a verified-clean source tree.
//
// ## Threat model & limits
//
//   - **State location.** The baseline is stashed on `globalThis` (same
//     pattern as `src/lib/rate-limit.ts`, `login-lockout.ts`, `ip-ban.ts`)
//     so it survives dev hot reloads. It does NOT survive a process
//     restart — an attacker who can restart the process can clear the
//     baseline and then make undetected edits. For production hardening,
//     persist the baseline to a write-once file (chmod 400) outside the
//     app tree; the in-memory Map is the demo-scoped v1.
//   - **TOCTOU.** Between the baseline snapshot and a verify call, an
//     attacker can edit a file, run their attack, and revert the file.
//     Mitigated by the 5-min verify interval — the window of invisibility
//     shrinks with the poll interval. An operator who wants tighter
//     detection can lower `DEFAULT_INTEGRITY_INTERVAL_MS`.
//   - **Hash collision.** SHA-256 collisions are not, as of 2024,
//     practically findable. We do not salt the hash (the file content is
//     not a secret); a second-preimage attack is the relevant threat, and
//     SHA-256 is resistant.
//   - **Dev mode is a no-op.** HMR rewrites .ts/.tsx files on every code
//     change, so a verify tick during dev would constantly trip. The
//     monitor therefore no-ops when `NODE_ENV !== "production"`. The
//     baseline is still captured in dev (so the security checklist at
//     `/api/security/health` can verify the module loaded), but the
//     periodic verifier is not scheduled.
//   - **Read errors.** A file that becomes unreadable (permission change,
//     deleted) is treated as a tamper event — the `compromised` flag
//     flips and a `critical` alert fires. This is fail-closed: a missing
//     security-critical file is more alarming than a hash mismatch.

import { createHash } from "crypto"
import { readdirSync, readFileSync, statSync, type Stats } from "fs"
import { join, relative } from "path"
import { sendSecurityAlert } from "@/lib/security-alerts"

// ─── State ──────────────────────────────────────────────────────────────

interface BaselineEntry {
  /** SHA-256 hex of the file content at baseline time. */
  hash: string
  /** File size in bytes at baseline time. */
  size: number
}

interface IntegrityState {
  /** path → baseline entry. Populated by `captureIntegrityBaseline`. */
  baseline?: Map<string, BaselineEntry>
  /**
   * Sticky tamper flag. Set to `true` by `verifyIntegrity` when any diff
   * is detected. NEVER reset to `false` here — only `captureIntegrityBaseline`
   * (an explicit operator re-baseline) clears it. Read by the Edge
   * middleware (inlined as `isCompromised()` in `src/middleware.ts`) to
   * short-circuit every request with 503 once tripped.
   */
  compromised?: boolean
  /** Wall-clock ms of the most recent `verifyIntegrity` run. */
  lastVerifiedAt?: number
  /** Whether `startIntegrityMonitor` has already scheduled its interval. */
  monitorStarted?: boolean
}

// Persist the state across dev hot reloads via globalThis — same trick
// as rate-limit / login-lockout / ip-ban / security-alerts. The
// `__fileIntegrityState` slot is the one the Edge middleware reads
// (`src/middleware.ts` `isCompromised()`), so the property name is part
// of the module's public contract — do NOT rename.
let state: IntegrityState
try {
  const g = globalThis as unknown as { __fileIntegrityState?: IntegrityState }
  if (!g.__fileIntegrityState) g.__fileIntegrityState = {}
  state = g.__fileIntegrityState
} catch {
  // Fallback — module-local state if globalThis is unavailable. The
  // Edge middleware's `isCompromised()` reader will return false in
  // this case (it reads globalThis, not this local `state`), which is
  // the documented fail-OPEN posture for a sandboxed runtime.
  state = {}
}

/**
 * Default verify interval — 5 minutes. Mirrors the value documented in
 * `src/instrumentation.ts` and `src/middleware.ts`. The interval is a
 * tradeoff: shorter → tighter detection but more CPU on every tick;
 * longer → cheaper but a tamper window of up to `interval` between
 * attack and detection. 5 min was chosen to match industry norms for
 * file-integrity monitors (e.g. AIDE's default cron schedule).
 */
export const DEFAULT_INTEGRITY_INTERVAL_MS = 5 * 60 * 1000

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hex of a file's contents. SYNC version — used at
 * baseline-capture and verify time. The instrumentation hook calls these
 * from the Node runtime at boot, and a sync walk is simpler to reason
 * about than an async one for a one-shot scan. Returns `null` on read
 * failure (caller decides how to surface that — we treat it as a tamper
 * event, fail-closed). Never throws.
 */
function hashFileSync(absPath: string): { hash: string; size: number } | null {
  try {
    const buf = readFileSync(absPath)
    const hash = createHash("sha256").update(buf).digest("hex")
    return { hash, size: buf.byteLength }
  } catch {
    return null
  }
}

/**
 * Recursively walk a directory and yield every file path whose name
 * matches one of the `extensions` (e.g. `[".ts", ".tsx"]`). SYNC. Yields
 * absolute paths. Never throws — a directory that cannot be read is
 * silently skipped (a tamper event would show up as a "missing file"
 * when the baseline says it should exist).
 *
 * Implementation note: we use `readdirSync({ withFileTypes: true })` to
 * avoid a `stat` syscall per entry (the dirent already knows if it's a
 * directory). On platforms that don't support `withFileTypes` (very old
 * Node), we fall back to `statSync` per entry.
 */
function* walkDir(
  root: string,
  extensions: readonly string[],
): Generator<string> {
  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    const raw = readdirSync(root, { withFileTypes: true })
    entries = raw.map((d) => ({
      name: d.name,
      isDirectory: () => d.isDirectory(),
    }))
  } catch {
    // Fallback for runtimes that don't support `withFileTypes`.
    try {
      const names = readdirSync(root)
      entries = names.map((name) => ({
        name,
        isDirectory: () => {
          try {
            const s: Stats = statSync(join(root, name))
            return s.isDirectory()
          } catch {
            return false
          }
        },
      }))
    } catch {
      return
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue // skip dotfiles (.next, .git, …)
    const abs = join(root, entry.name)
    if (entry.isDirectory()) {
      // Skip node_modules + build artifacts — they're not source code.
      if (entry.name === "node_modules" || entry.name === ".next") continue
      yield* walkDir(abs, extensions)
    } else {
      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        yield abs
      }
    }
  }
}

// ─── Public API: high-level (instrumentation + middleware contract) ────

/**
 * Walk `src/` and store the SHA-256 + size of every `.ts` / `.tsx` file
 * on `globalThis.__fileIntegrityState.baseline`. This is the snapshot
 * `verifyIntegrity()` will compare against on every 5-min tick.
 *
 * Called ONCE at server boot by `src/instrumentation.ts`'s `register()`.
 * Safe to call again — it overwrites the prior baseline (so an operator
 * can re-baseline after a legitimate deploy by restarting the server, or
 * by hitting `/api/security/health` which calls `verifyAuditIntegrity()`
 * — note: that re-verifies the audit chain, not the source baseline; a
 * future admin route could expose this function explicitly).
 *
 * This function CLEARS the sticky `compromised` flag — a fresh baseline
 * is the only legitimate way to acknowledge that the current source
 * tree is the new "known good" state. If `compromised` was true before
 * this call (i.e. the operator is re-baselining after investigating a
 * tamper alert), this is the moment the 503 maintenance mode lifts.
 *
 * Returns the number of files that were successfully hashed and stored.
 * Never throws — a baseline-capture failure must not crash the server
 * (the instrumentation hook has its own try/catch, but defense-in-depth).
 */
export function captureIntegrityBaseline(): number {
  try {
    const srcDir = join(process.cwd(), "src")
    const baseline = new Map<string, BaselineEntry>()
    let stored = 0
    for (const abs of walkDir(srcDir, [".ts", ".tsx"])) {
      const hashed = hashFileSync(abs)
      if (!hashed) continue // unreadable — skip; verify will flag if missing
      baseline.set(abs, { hash: hashed.hash, size: hashed.size })
      stored++
    }
    state.baseline = baseline
    // Clearing the sticky flag is the only legitimate way to lift 503
    // maintenance mode. An operator who calls this after a tamper alert
    // is implicitly saying "I have investigated and the current source
    // tree is the new known-good state."
    state.compromised = false
    return stored
  } catch {
    // Capture failed — leave `baseline` undefined. The next
    // `verifyIntegrity` call will see no baseline and trip immediately
    // (every file is "new" from a missing-baseline's perspective),
    // which is the documented fail-closed posture.
    return 0
  }
}

/**
 * Verify the integrity of every file in the baseline. Recomputes the
 * SHA-256 + size of each, compares to the baseline, and:
 *
 *   - On ANY diff (modified / missing / new file), sets the sticky
 *     `compromised` flag on `globalThis.__fileIntegrityState` (the
 *     Edge middleware reads this and 503s every subsequent request)
 *     AND fires `sendSecurityAlert("critical", ...)`.
 *   - On no diff, leaves `compromised` untouched (it stays at whatever
 *     it was — sticky-true does not auto-clear).
 *
 * Also detects NEW files in `src/` that were not in the baseline —
 * those flip `compromised` too (an attacker who adds a new file like
 * `src/lib/backdoor.ts` is just as dangerous as one who edits an
 * existing file).
 *
 * Never throws — wraps the entire body in try/catch. On internal error,
 * sets `compromised = true` (fail-closed: a verifier failure is treated
 * as a tamper event) so the middleware 503s until the operator
 * investigates.
 *
 * @returns A report with per-file results. Empty report if no baseline
 *          was ever captured.
 */
export interface IntegrityReport {
  ok: boolean
  checkedAt: number
  /** Number of files in the baseline that were checked. */
  checked: number
  /** Number of baseline files whose hash differs now. */
  modified: number
  /** Number of baseline files that no longer exist. */
  missing: number
  /** Number of files in src/ that were not in the baseline. */
  newFiles: number
  /** Number of files that errored on read. */
  errors: number
  /** Per-file detail (first 50 entries — keeps the report bounded). */
  results: IntegrityCheckResult[]
}

export interface IntegrityCheckResult {
  path: string
  status: "ok" | "modified" | "missing" | "new" | "error"
  currentHash: string | null
  baselineHash: string | null
  currentSize: number | null
  baselineSize: number | null
}

export function verifyIntegrity(): IntegrityReport {
  const checkedAt = Date.now()
  // Always update lastVerifiedAt — even on error, this is useful for
  // /api/security/health to surface "we tried at <ts>".
  state.lastVerifiedAt = checkedAt

  const empty: IntegrityReport = {
    ok: true,
    checkedAt,
    checked: 0,
    modified: 0,
    missing: 0,
    newFiles: 0,
    errors: 0,
    results: [],
  }

  try {
    const baseline = state.baseline
    if (!baseline || baseline.size === 0) {
      // No baseline — every file is "new" from a missing-baseline's
      // perspective. Fail-closed: trip the flag so the operator
      // investigates (the most common cause is a standalone build that
      // didn't ship src/ — see instrumentation.ts catch block).
      state.compromised = true
      void sendSecurityAlert(
        "File integrity violation — no baseline",
        "verifyIntegrity() was called but no baseline was captured. " +
          "Either the server booted before captureIntegrityBaseline() ran, " +
          "or src/ is missing (common in standalone builds that didn't ship it). " +
          "The compromised flag has been tripped — every request will get 503 " +
          "until an operator restarts the server with src/ present.",
        "critical",
      ).catch(() => {
        // intentionally swallowed — see file header
      })
      return empty
    }

    // Walk src/ fresh and build the current-state map. We rebuild rather
    // than re-using the baseline's keys so we detect NEW files (a file
    // in src/ that's not in the baseline is suspicious — an attacker
    // adding src/lib/backdoor.ts).
    const srcDir = join(process.cwd(), "src")
    const current = new Map<string, BaselineEntry>()
    for (const abs of walkDir(srcDir, [".ts", ".tsx"])) {
      const hashed = hashFileSync(abs)
      if (!hashed) continue // unreadable — counted below
      current.set(abs, { hash: hashed.hash, size: hashed.size })
    }

    const results: IntegrityCheckResult[] = []
    let modified = 0
    let missing = 0
    let newFiles = 0
    let errors = 0
    const MAX_RESULTS = 50 // cap the report size so a 1000-file diff can't bloat memory

    // 1. Check every baseline file.
    for (const [abs, baselineEntry] of baseline) {
      const currentEntry = current.get(abs)
      if (!currentEntry) {
        // Baseline file is gone — tamper event (or operator deleted it).
        missing++
        state.compromised = true
        if (results.length < MAX_RESULTS) {
          results.push({
            path: abs,
            status: "missing",
            currentHash: null,
            baselineHash: baselineEntry.hash,
            currentSize: null,
            baselineSize: baselineEntry.size,
          })
        }
        void sendSecurityAlert(
          "File integrity violation — file deleted",
          `Baseline source file is missing: \`${relative(process.cwd(), abs) || abs}\`. ` +
            `Baseline hash: \`${baselineEntry.hash.slice(0, 16)}…\` ` +
            `(${baselineEntry.size} bytes at baseline). ` +
            `Either the file was deleted by an operator (re-baseline via restart) ` +
            `or by an attacker. The compromised flag has been tripped — every ` +
            `request will get 503 until restart.`,
          "critical",
        ).catch(() => {
          // intentionally swallowed
        })
        continue
      }
      if (currentEntry.hash !== baselineEntry.hash) {
        modified++
        state.compromised = true
        if (results.length < MAX_RESULTS) {
          results.push({
            path: abs,
            status: "modified",
            currentHash: currentEntry.hash,
            baselineHash: baselineEntry.hash,
            currentSize: currentEntry.size,
            baselineSize: baselineEntry.size,
          })
        }
        void sendSecurityAlert(
          "File integrity violation — file modified",
          `Baseline source file was modified: \`${relative(process.cwd(), abs) || abs}\`. ` +
            `Baseline: \`${baselineEntry.hash.slice(0, 16)}…\` (${baselineEntry.size}B). ` +
            `Current:   \`${currentEntry.hash.slice(0, 16)}…\` (${currentEntry.size}B). ` +
            `The compromised flag has been tripped — every request will get 503 ` +
            `until an operator restarts the server with a verified-clean source tree.`,
          "critical",
        ).catch(() => {
          // intentionally swallowed
        })
      }
    }

    // 2. Check for new files in src/ that weren't in the baseline.
    for (const [abs, currentEntry] of current) {
      if (baseline.has(abs)) continue
      newFiles++
      state.compromised = true
      if (results.length < MAX_RESULTS) {
        results.push({
          path: abs,
          status: "new",
          currentHash: currentEntry.hash,
          baselineHash: null,
          currentSize: currentEntry.size,
          baselineSize: null,
        })
      }
      void sendSecurityAlert(
        "File integrity violation — new file detected",
        `A new source file appeared in src/ that was not in the baseline: ` +
          `\`${relative(process.cwd(), abs) || abs}\` ` +
          `(${currentEntry.size}B, hash \`${currentEntry.hash.slice(0, 16)}…\`). ` +
          `If this was a legitimate deploy, restart the server to re-baseline. ` +
          `Otherwise an attacker has added a file (e.g. a backdoor route). ` +
          `The compromised flag has been tripped — every request will get 503 ` +
          `until restart.`,
        "critical",
      ).catch(() => {
        // intentionally swallowed
      })
    }

    return {
      ok: !state.compromised,
      checkedAt,
      checked: baseline.size,
      modified,
      missing,
      newFiles,
      errors,
      results,
    }
  } catch {
    // Any internal error in the verifier itself is treated as a tamper
    // event — fail-closed. (An attacker who tampered with the verifier
    // would want it to fail silently; we explicitly choose the opposite.)
    state.compromised = true
    void sendSecurityAlert(
      "File integrity violation — verifier error",
      "verifyIntegrity() threw an internal error. The compromised flag has " +
        "been tripped as a fail-closed measure. Restart the server and " +
        "investigate logs/app.jsonl for the verifier stack trace.",
      "critical",
    ).catch(() => {
      // intentionally swallowed
    })
    return empty
  }
}

/**
 * Start the periodic verifier on a `setInterval` that's `.unref()`'d so
 * it doesn't block graceful process shutdown. Idempotent — calling it
 * twice is a no-op (the second call sees `state.monitorStarted === true`
 * and returns without scheduling a second interval).
 *
 * No-op in dev (`NODE_ENV !== "production"`) — HMR rewrites .ts/.tsx
 * files on every code change, so a verify tick during dev would
 * constantly trip the compromised flag. The baseline is still captured
 * in dev (see `captureIntegrityBaseline`), so the security checklist at
 * `/api/security/health` can verify the module loaded.
 *
 * Called once at server boot by `src/instrumentation.ts`. Never throws.
 *
 * @param intervalMs How often to verify. Defaults to
 *                   `DEFAULT_INTEGRITY_INTERVAL_MS` (5 minutes).
 */
export function startIntegrityMonitor(
  intervalMs: number = DEFAULT_INTEGRITY_INTERVAL_MS,
): void {
  try {
    if (state.monitorStarted) return
    if (process.env.NODE_ENV !== "production") {
      // Dev mode — no-op. The baseline was captured (so /api/security/health
      // can verify the module loaded), but HMR would constantly trip a real
      // verifier. Flag the monitor as "started" so a second call is still
      // idempotent.
      state.monitorStarted = true
      return
    }
    state.monitorStarted = true
    const handle = setInterval(() => {
      try {
        verifyIntegrity()
      } catch {
        // intentionally swallowed — the verifier's own try/catch handles
        // internal errors; this outer catch is for the setInterval
        // dispatch path itself (which should never throw, but
        // defense-in-depth).
      }
    }, intervalMs)
    // .unref() so the timer doesn't keep the Node process alive on
    // shutdown (e.g. `next start` ctrl-C should exit promptly, not wait
    // for the next verify tick).
    if (typeof (handle as NodeJS.Timeout).unref === "function") {
      ;(handle as NodeJS.Timeout).unref()
    }
  } catch {
    // never throw on background-task setup
  }
}

/**
 * Read the sticky `compromised` flag. This is the canonical Edge-safe
 * reader for the file-integrity posture — it reads only a primitive
 * boolean off `globalThis`, no `fs` / `crypto` imports, so it can be
 * inlined into the Edge middleware without crashing the Edge bundle.
 *
 * The Edge middleware (src/middleware.ts) inlines an identical reader
 * rather than calling this function — it cannot `import` this module
 * because the top-level `fs` / `crypto` imports would crash the Edge
 * runtime. The two readers MUST stay in sync (same globalThis slot,
 * same fallback semantics).
 *
 * @returns `true` iff the monitor has detected a tamper event and
 *          the flag is still sticky-set. Never throws (fail-OPEN
 *          returns false on globalThis read failure — see file header
 *          for the rationale).
 */
export function isCompromised(): boolean {
  try {
    return state.compromised === true
  } catch {
    return false
  }
}

/**
 * Read-only snapshot of the baseline (path → entry). Returned as a plain
 * object so callers (tests, admin tooling) can inspect the baseline
 * without mutating it. Never throws.
 */
export function getFileBaseline(): Record<string, BaselineEntry> {
  try {
    const out: Record<string, BaselineEntry> = {}
    if (!state.baseline) return out
    for (const [k, v] of state.baseline) out[k] = { ...v }
    return out
  } catch {
    return {}
  }
}

/**
 * Read-only metadata about the monitor's current state — useful for
 * `/api/security/health` and admin tooling. Never throws.
 */
export function getIntegrityStatus(): {
  baselineSize: number
  compromised: boolean
  lastVerifiedAt: number | null
  monitorStarted: boolean
} {
  try {
    return {
      baselineSize: state.baseline?.size ?? 0,
      compromised: state.compromised === true,
      lastVerifiedAt: typeof state.lastVerifiedAt === "number" ? state.lastVerifiedAt : null,
      monitorStarted: state.monitorStarted === true,
    }
  } catch {
    return {
      baselineSize: 0,
      compromised: false,
      lastVerifiedAt: null,
      monitorStarted: false,
    }
  }
}
