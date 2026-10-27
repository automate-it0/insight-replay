// Playwright configuration for the Insight Replay E2E suite.
//
// Scope:
//   - testDir: ./e2e   (the three specs: login / ingest / alerts)
//   - baseURL: http://localhost:3000 (matches `next dev -p 3000` from package.json)
//   - Chromium-only — the dashboard is server-rendered React + standard DOM;
//     Firefox/WebKit would only multiply CI minutes without surfacing
//     additional defects. Add a 2nd project here when cross-browser coverage
//     is actually required.
//   - workers: 1, fullyParallel: false — the specs hit a shared dev database
//     (SQLite) and shared project state; running them serially prevents
//     flaky collisions on Alert rows / visitor IDs.
//
// The `webServer` block is declared but NOT auto-started in CI: the task
// spec says "Don't run them (server is down) — just write the specs". The
// `reuseExistingServer: true` flag means if a server is already running on
// :3000 (e.g. a developer's `bun run dev`) the suite will attach to it
// instead of spawning a second one. When the server is down, `npx playwright
// test` will fail at the webServer-start step — which is the desired
// behaviour for a CI gate (no silent skip).
//
// `@playwright/test` is used (not `playwright-test` or bun:test) so the
// specs can run via the official `npx playwright test` CLI without any
// custom runner glue, and so the `test.describe` / `test.beforeEach` /
// `expect(...).toBeVisible()` API surface matches the docs.

import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  // Where the specs live. Absolute path is resolved relative to this file.
  testDir: "./e2e",

  // Files matching this glob are treated as spec files. We only pick up
  // *.spec.ts so the security/sanitize/csrf/etc. *.test.ts files under
  // tests/ are NOT swept into the Playwright run (they use bun:test).
  testMatch: /.*\.spec\.ts/,

  // Serial execution against a shared dev DB. See header comment.
  fullyParallel: false,
  workers: 1,

  // No retries on first pass — flakiness should be fixed at the source,
  // not papered over. (If a spec is genuinely flaky, bump THIS spec's
  // `test.retry` instead of the global default.)
  retries: 0,

  // 30s per test — generous enough for the login PoW solve (~1–4s) plus
  // network round-trips on a cold dev server start. Individual specs can
  // override with `test.setTimeout(ms)`.
  timeout: 30_000,
  expect: { timeout: 5_000 },

  // list = concise CI output; html = post-run report for local dev.
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:3000",
    // Trace + screenshot + video on failure — enough forensics to debug
    // a red CI run without re-running locally. `on-first-retry` keeps
    // the artifact size small (we set retries:0, so this degrades to
    // "always-on" effectively, but stays correct if retries are bumped).
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Realistic desktop viewport — the dashboard's responsive grid only
    // shows the 3-col layout at ≥1280px, so the KPI cards are guaranteed
    // to render in their full-width form (not the mobile stack).
    viewport: { width: 1280, height: 720 },
    // Persist a single Playwright storage state across runs so a logged-in
    // session from login.spec.ts CAN be reused by alerts.spec.ts via
    // `test.use({ storageState: 'e2e/.auth/admin.json' })`. Not used
    // by the initial specs but documented here for future expansion.
    storageState: undefined,
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    // `bun run dev` runs `next dev -p 3000` (see package.json scripts.dev).
    command: "bun run dev",
    url: "http://localhost:3000",
    // 60s headroom for Next.js to compile the first route on a cold cache.
    timeout: 60_000,
    // Attach to an already-running dev server if one is present — this is
    // what lets a developer run `bun run dev` in one terminal and
    // `npx playwright test` in another without a port conflict.
    reuseExistingServer: true,
    // Don't auto-spawn a server when running with PLAYWRIGHT_SKIP_WEBSERVER
    // (used by the verifier to run the suite against an externally-managed
    // server, e.g. a Docker container or a staging URL).
    env: {
      NODE_ENV: "development",
    },
  },
})
