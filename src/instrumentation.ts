// Next.js instrumentation hook — runs ONCE at server startup, BEFORE the
// first request is served. This is the canonical Next.js 15+/16 hook for
// boot-time work that needs to happen in the Node.js runtime.
//
// Why this file exists (10x+: File integrity monitor):
//   - The Edge middleware reads the `compromised` flag (stashed at
//     `globalThis.__fileIntegrityState.compromised`) on every request, but
//     SOMETHING has to populate the baseline + start the 5-minute
//     verifier, and that something must run in the Node.js runtime (the
//     monitor uses `fs.readdirSync`, `fs.readFileSync`, and
//     `crypto.createHash` — Node-only APIs that crash the Edge bundle).
//     This file is that something.
//
// What it does, in order:
//   1. Guards against the Edge runtime — `NEXT_RUNTIME === "nodejs"` check
//      is the canonical Next.js way to keep instrumentation work in the
//      Node process only. Next.js calls `register()` once per runtime
//      (Node for SSR + route handlers, Edge for middleware if it's a
//      separate runtime). Without this guard, `register()` would also
//      execute in the Edge runtime and crash on the first `fs` import.
//   2. Calls `captureIntegrityBaseline()` — walks `src/` and stores the
//      SHA-256 of every .ts/.tsx file on `globalThis.__fileIntegrityState`.
//      This is the snapshot the verifier will compare against every 5 min.
//   3. Calls `startIntegrityMonitor(5 * 60 * 1000)` — schedules the
//      periodic `verifyIntegrity()` check on a `setInterval` that's
//      `.unref()`-ed so it doesn't block graceful process exit.
//
// Failure handling:
//   - The whole body is wrapped in try/catch. A failure to capture the
//     baseline (e.g., `src/` directory doesn't exist in a container that
//     shipped only the standalone build) MUST NOT crash the server — it
//     logs a warning and the monitor degrades to "no baseline = always
//     compromised on first verify", which is the fail-closed posture we
//     want anyway. The next deploy with a `src/` dir present will capture
//     a real baseline.
//
// Dev mode:
//   - The baseline is captured in both dev and prod (so the security
//     checklist can verify the module loaded). The periodic monitor is a
//     no-op in dev — see `file-integrity.ts`'s `startIntegrityMonitor`
//     for rationale (HMR would constantly trip a real verifier).
//
// Why not put this in `src/app/layout.tsx`?
//   - The root layout is rendered on every page navigation in dev (HMR
//     re-runs module top-level code), so importing `file-integrity.ts`
//     from layout.tsx would re-capture the baseline on every HMR — useless
//     work, and would also re-`setInterval` on every render in some
//     scenarios. `instrumentation.ts` is the only Next.js hook that is
//     GUARANTEED to run exactly once per process lifetime, in the Node
//     runtime, before the first request. That's what we want.

export async function register(): Promise<void> {
  // Guard: instrumentation runs in BOTH the Node.js server runtime AND the
  // Edge runtime (if used). The Edge runtime cannot import `node:fs` /
  // `node:crypto` — importing `@/lib/file-integrity` from Edge would
  // crash with "The edge runtime does not support Node.js 'crypto' module".
  // `process.env.NEXT_RUNTIME` is the canonical Next.js signal for which
  // runtime is currently loading this module: `"nodejs"` or `"edge"`.
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return
  }

  try {
    // Lazy import — keeps the Edge runtime from pulling the Node-only
    // `fs` / `crypto` modules even if the guard above ever regresses.
    // (Defensive: the guard SHOULD be enough, but bundlers sometimes
    // statically resolve a top-level `import` before the runtime check
    // can short-circuit. A dynamic `await import()` inside the guarded
    // branch guarantees the Node-only modules are only ever resolved in
    // the Node runtime.)
    const {
      captureIntegrityBaseline,
      startIntegrityMonitor,
      DEFAULT_INTEGRITY_INTERVAL_MS,
    } = await import("@/lib/file-integrity")

    // Step 1: capture the baseline. This walks `src/` (relative to
    // `process.cwd()`, which is the project root in both `next dev` and
    // `next start` standalone builds) and stores SHA-256 of every .ts /
    // .tsx file on globalThis. Even in dev (where the monitor is a
    // no-op), this is useful — the security checklist at
    // `/api/observability` can verify the module loaded.
    captureIntegrityBaseline()

    // Step 2: start the periodic verifier. The interval is `.unref()`-ed
    // inside `startIntegrityMonitor` so it doesn't block graceful shutdown.
    // No-op in dev (see module header for rationale: HMR would trip it).
    startIntegrityMonitor(DEFAULT_INTEGRITY_INTERVAL_MS)
  } catch (e) {
    // CRITICAL not because the monitor is broken, but because the integrity
    // posture is now reduced to "blind" — an attacker could tamper files
    // and we'd have no baseline to compare against. Log at error so it
    // surfaces in logs/app.jsonl + stderr; do NOT crash the server (the
    // rest of the app is still functional, just without integrity monitoring).
    //
    // The most common cause of this catch is a standalone build that didn't
    // ship `src/` alongside `server.js`. In that case the operator should
    // either: (a) ship `src/` to the deployment, or (b) accept that
    // file-integrity monitoring is disabled for this deployment (and rely
    // on the file-system audit hash chain alone).
    try {
      console.error(
        "[file-integrity] instrumentation failed — monitor NOT started:",
        e instanceof Error ? e.message : String(e),
      )
    } catch {
      // console may be unavailable in some sandboxed runtimes
    }
  }
}
