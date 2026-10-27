# Changelog

All notable changes to **Insight Replay** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> Section ordering per release: **Added · Changed · Deprecated · Removed · Fixed · Security**.
> Dates are `YYYY-MM-DD` (ISO 8601). Linkable headers use kebab-case anchors.

---

## [Unreleased]

### Added
- `.gitmessage` — Conventional Commits template (types, scopes, subject/body/footer rules, 3 worked examples).
- `scripts/setup-git.sh` — one-time repo-local git config script (commit template, LF line endings, rebase-on-pull, push.default=current, rerere, aliases).
- `docs/git-workflow.md` — trunk-based branching strategy, atomic-commit guidelines, PR process, branch protection, semantic versioning, changelog discipline, rebase + squash-merge policy, and links to the CI workflows under `.github/workflows/`.

### Changed
- Repository now has an explicit commit-message contract; future commits follow `<type>(<scope>): <subject>` with a wrapped body and a typed footer.

### Security
- Documented the policy that security-sensitive fixes use `security` or `fix(security)` with a `Security:` changelog entry so they are auditable retroactively.

---

## [0.7.0] — 2025-10-26 — Security-hardened bundle

This is a packaging-only release that snapshots the post-v0.6.0
security-hardening work into a single, deliverable bundle. All 34
defense layers below are live in `src/lib/` and `src/middleware.ts`.

### Security — 34 layers (post-v0.6.0 hardening)

**Foundational 6 layers (from v0.3.0, retained):**
1. API key auth (`src/lib/auth.ts`)
2. IP anonymization (`src/lib/ua.ts#anonymizeIP`)
3. Rate limiting (`src/lib/rate-limit.ts`)
4. Security headers + input sanitization (`src/middleware.ts` + `src/lib/sanitize.ts`)
5. Audit log (`src/lib/audit.ts`)
6. CSRF guard (`src/lib/csrf.ts`)

**10× stronger features added post-v0.6.0:**
7. scrypt-based password hashing (`src/lib/crypto.ts`)
8. Login lockout after N failed attempts (`src/lib/login-lockout.ts`)
9. IP-bound HMAC session tokens (`src/lib/session.ts`)
10. Hash-chained audit log (`src/lib/audit.ts`)
11. Honeypot endpoint trap (`src/lib/security-alerts.ts`)
12. Strict Content-Type enforcement on mutating routes
13. Body-size limit + JSON-schema validation (`src/lib/validate.ts`)
14. CSP with per-request nonce (`src/middleware.ts`)
15. CORS allowlist (no `*`)
16. `X-XSS-Protection` + `X-Content-Type-Options: nosniff`

**10 intrusion-scenario fixes added post-v0.6.0:**
17. IDOR protection on every project-scoped route (`src/lib/project-auth.ts`)
18. SQL-injection defense via Prisma parameterized queries + `src/lib/sanitize.ts`
19. XSS defense via `src/lib/sanitize-html.ts` (DOMPurity-equivalent)
20. SSRF guard (`src/lib/ssrf-guard.ts`) — blocks private-range IPs in URL fetchers
21. Race-condition guards (single-writer locks on counters)
22. Information-leak plugs (no stack traces in production, generic error envelopes)
23. Path-traversal defense (`src/lib/sanitize.ts` normalizes paths)
24. Session-fixation defense (session ID rotated on login + privilege change)
25. Dependency vulnerability scan in CI (`.github/workflows/security.yml`)
26. DoS defense — per-IP ban escalation (`src/lib/ip-ban.ts`)

**Final 10× hardening layer:**
27. Admin Radar (`src/lib/admin-radar.ts`) — watchdog timer + super-admin allowlist + cross-source verification
28. Per-user rate limit on top of per-IP (`src/lib/rate-limit.ts`)
29. Proof-of-Work on sensitive endpoints (`src/lib/pow.ts` + `src/lib/pow-client.ts`)
30. File-integrity monitoring (`src/lib/file-integrity.ts`) — hash-snapshot every cold start
31. IP-ban escalation ladder (warn → throttle → 429 → 403) (`src/lib/ip-ban.ts`)
32. Request signer (`src/lib/request-signer.ts`) — HMAC body signature on mutating routes
33. Security health endpoint + static-at-rest encryption (`src/lib/db-encryption.ts`)
34. Webhook alert bridge (`src/lib/security-alerts.ts`) — Telegram/email on critical events

### Notes

- No behavior changes vs. v0.6.0 — only the security posture is strengthened.
- This bundle is fully isolated from qaorders: separate DB (SQLite vs. Supabase/Turso), separate auth (independent HMAC sessions), separate env vars, separate deployment target (localhost:81 via Caddy vs. Vercel cloud).
- The 34 layers are non-overlapping; each guards a distinct attack surface.

---

## [0.6.0] — 2025-10-24

### Added
- **Accessibility (WCAG 2.1 AA)**: 63 violations fixed across 21 components — icon-only buttons labeled, WAI-ARIA tablist/tab/tabpanel on the project-view tab strip, `role="dialog"` + Escape handling on the demo-site modal, `aria-live` regions on alert bell + history, recordings count, AI insights status, AI search filters/errors, heatmaps data-points, project-view live indicator, form `<label htmlFor>` associations on every dialog (settings, goals, funnels, alerts, experiments, dashboards), accessible names on charts and canvas, skip-to-content link in `src/app/layout.tsx`. Full audit at `docs/accessibility-audit.md`.
- **CI/CD pipeline**: 3 GitHub Actions workflows under `.github/workflows/` — `ci.yml` (lint + type-check + test, build on main), `security.yml` (audit + secrets scan), `quality-gate.yml` (merge gate). Local runner `scripts/check-quality.sh`. Runbook at `docs/ci-cd.md`.
- **Code simplification**: `recording-player.tsx` 768 → 544 lines (helpers extracted to `recording-player-helpers.ts`, 223 lines); `live-tab.tsx` 463 → 314 lines (helpers extracted to `live-tab-helpers.ts`, 283 lines); behavior preserved. Report at `docs/simplification.md`.
- **Standardized API layer**: `src/lib/api-response.ts` (standardized envelopes + 8 error shortcuts + pagination), `src/lib/validate.ts` (zero-dep validators), `docs/api-style-guide.md` (480 lines, 4-phase migration plan).

### Changed
- Recording-player and live-tab now delegate state math to pure helper modules — components are smaller and the extracted functions are unit-testable.
- API responses are moving toward the standardized envelope; migration plan documented in `docs/api-style-guide.md`.

### Fixed
- Two parser errors introduced during the accessibility pass (template-literal typo in `filter-bar.tsx`, stray quote in `alerts-tab.tsx`) — caught by ESLint and fixed immediately.

### Security
- All 6 security layers (see `v0.3.0`) remain in effect; no regressions introduced by the UI refactor.

---

## [0.5.0] — 2025-10-24

### Added
- **Test-driven development**: 138 passing tests across 5 files (`tests/ua.test.ts`, `tests/sanitize.test.ts`, `tests/rate-limit.test.ts`, `tests/observability.test.ts`, `tests/api-contracts.test.ts`) — 220 `expect()` calls. The 9 API-contract tests auto-skip when the dev server is unreachable so CI stays green.
- **Code-review pass**: dead code removed, defensive guards added on hot paths, error-handling consistency sweep. Report at `docs/code-review.md`.
- **Performance optimization**: in-memory TTL cache (`src/lib/cache.ts`) on the stats API (~22× speedup on cache hit, ~87.5% DB-load reduction steady-state at 8 s polling / 60 s TTL), 10 `useMemo` calls on the Overview tab, `React.memo` on `WidgetRenderer` + memoized widget grid on the Dashboards tab. Report at `docs/performance.md`.
- **Documentation + ADRs**: 6 ADRs under `docs/adr/` (Prisma+SQLite, socket.io mini-service, LLM-powered AI features, security-hardening layers, in-memory cache for stats, agent-skills unified workflow), `docs/architecture.md`, `docs/api-reference.md`, `docs/README.md`.

### Changed
- Stats API response now includes `cached` and `cachedAt` fields (additive — frontend unchanged).
- Overview tab chart data is memoized; Recharts subtrees receive referentially-stable `data` props.

---

## [0.4.0] — 2025-10-24

### Added
- **agent-skills workflow**: cloned addyosmani/agent-skills (25 skills) into `.agent-skills/`; `AGENTS.md` maps every task type to a skill and sets the verification bar (`bun run lint` exit 0, dev compiles, agent-browser verification for UI, curl for API, no console errors).
- **Observability skill applied**:
  - `src/lib/observability.ts` — structured JSONL logger (`logs/app.jsonl`), in-memory RED metrics (counters + histograms with bucket labels), correlation IDs, health checks (database, log_writable, memory), log reader.
  - `/api/observability` endpoint — status + uptime + health + metrics + recent logs.
  - `/api/health` endpoint — 200 ok / 503 degraded-down (for load balancers).
  - `src/middleware.ts` upgraded — stamps `x-request-id` on all API routes, records edge metrics for 429s, matcher widened to `/api/:path*`.
  - `/api/track/events` POST instrumented with structured logs (`ingest_success` / `unknown_project` / `origin_blocked` / `error`) + `recordHttpRequest` on every path.

### Changed
- All future work now follows the skill lifecycle: define → plan → build → verify → review → ship. `.agent-skills/` and `logs/` are gitignored.

---

## [0.3.0] — 2025-10-24

### Added
- **Security hardening — 6 layers**:
  1. **API key auth** (`src/lib/auth.ts`) — helper + `/api/projects/[id]/protected-test` demo; sensitive endpoints can require a valid key while the tracking ingest endpoint stays open.
  2. **IP anonymization** (`src/lib/ua.ts#anonymizeIP`) — IPv4 last-octet zeroed, IPv6 last 80 bits zeroed, invalid input → `0.0.0.0`.
  3. **Rate limiting** (`src/lib/rate-limit.ts`) — sliding-window counters keyed by IP + route, 429 with `Retry-After`.
  4. **Audit logging** (`src/lib/audit.ts` + `/api/audit`) — append-only JSONL of API-key + sensitive-endpoint access.
  5. **CORS + origin validation** (`src/middleware.ts`) — `/api/track/events` and `/api/track/script` accept only the project's `siteUrl`, the dashboard's own origin, and localhost. Closes cross-site data poisoning / CSRF.
  6. **Security headers + input sanitization** (`src/middleware.ts` + `src/lib/sanitize.ts`) — 6 standard headers on all routes including the open ingest endpoint; pure, framework-agnostic sanitization library (HTML-escape, forbidden-key filter, depth cap, string/array/object/events caps) ready to be wired into the ingest path. ADR at `docs/adr/0004-security-hardening-layers.md`.

### Changed
- Tracking ingest + SDK script endpoints no longer return `Access-Control-Allow-Origin: *`; origin allow-list enforced.

### Security
- Stored XSS, prototype pollution, oversized-payload DoS, CSRF / cross-site data poisoning, PII leakage via raw IPs, and missing audit trail all closed.

---

## [0.2.0] — 2025-10-24

### Added
- **10× stronger features** (schema expansion + parallel sub-agents):
  - Schema: `Funnel`, `Goal`, `Segment`, `Note`, `Tag`, `Bookmark`, `ErrorEvent` models; `Session` gained `utmSource/Medium/Campaign`, `entryUrl`, `exitUrl`, `isNewVisitor`, `hasError`, `convertedGoal`; indexes on `visitorId`, `isNewVisitor`, `ErrorEvent`, `Note/Tag/Bookmark`.
  - **Funnels**: builder + funnel-viz + dropoff; `/api/projects/[id]/funnels` CRUD + `/analyze` (single efficient event query + JS grouping + sequential URL matching + median time between steps).
  - **Journeys**: Sankey-style flow + top paths + entry/exit; `/api/projects/[id]/journeys` (Sankey-ready JSON with virtual Start/Exit nodes).
  - **Visitors**: list + profile drawer; `/api/projects/[id]/visitors` (groups by `visitorId`, mode-aggregates device/browser/os/country/city) + `/visitors/[vid]` (full profile with tags + notes across sessions).
  - **Retention**: cohort matrix heatmap; `/api/projects/[id]/retention` (visitor-bucket cohorting, period-0 = 100% by construction, average-retention roll-up).
  - **Goals**: CRUD + conversion stats + value; `/api/projects/[id]/goals` counts url/`convertedGoal` matches in-range.
  - **Errors**: chart + by-page + log; `/api/projects/[id]/errors` with daily buckets + by-type + by-url + affected-session set.
  - **Alerts**: rules CRUD + test/evaluate + history feed; `AlertBell` in header with popover (unread count, acknowledge); `/api/projects/[id]/alerts` + `/alerts/history` + `/alerts/[aid]/evaluate`.
  - **Dashboards**: dashboard switcher + widget grid (metric/chart/table renderer); `/api/projects/[id]/dashboards` CRUD + `/dashboards/[did]/data`.
  - **Experiments**: A/B test with significance banner, variant comparison, z-test / p-value / lift; `/api/projects/[id]/experiments` CRUD + `/experiments/[eid]/analyze`.
  - **AI natural-language search**: `/api/projects/[id]/ai-search` parses "mobile users who raged last week" → `{device:mobile, hasRageClick:true, rangeDays:7}` → matching sessions; `AiSearchBar` with example chips + filter badges + results.
  - **UTM builder**: live URL generation in Settings.
  - **API keys management**: create / reveal / revoke in Settings; `/api/projects/[id]/apikeys` CRUD.
  - **Segments**: CRUD; `/api/projects/[id]/segments` with JSON-stringified filters.
  - **Notes / Tags / Bookmark**: per-session — `/api/projects/[id]/sessions/[sid]/{notes,tags,bookmark}` CRUD.
  - **Export**: `/api/projects/[id]/export` returns CSV (19 columns, escaped) with `Content-Disposition: attachment`.
  - **Compare**: `/api/projects/[id]/compare` — two equal-length windows, per-metric deltas (`abs` + `pct`), daily series for the current period.
  - **AI insights**: per-session (`/ai/session` POST → markdown sections) + whole-project (`/ai` GET → markdown overview); lazy `z-ai-web-dev-sdk` import, always 200 with `{analysis, error}` fallback.
  - SDK upgrades: `window.onerror` + `unhandledrejection` capture, UTM parsing, `entryUrl`, `errors[]` array. Ingest lib auto-detects new vs returning visitor, sets entry/exit URLs, auto-detects goal conversions.
  - **Recording Player upgraded**: tabbed side panel (Info / AI / Notes / Timeline), AI session-analysis button, timestamped notes, tags, bookmark toggle, event timeline with seek, error markers.
  - **Overview upgraded**: 8 KPI cards, sessions chart, AI Insights card, new-vs-returning pie, device pie, referrers, browsers, top pages, entry/exit pages, countries, UTM campaigns.
  - 15 tabs total (added Dashboards, Experiments, Alerts) + `AlertBell` in header.
  - FilterBar: multi-dimensional filters (device / browser / country / new / returning / rage / dead / error / converted) with active-count clear.

### Changed
- Demo loop now works end-to-end through the Caddy gateway: open Demo Site → real session ingested → live cursor streams via websocket → replay in Recordings.

### Fixed
- Critical ingestion bug: tracking URL had `XTransformPort=3004` (POSTs were being sent to the socket service instead of Next.js on :3000). Removed `XTransformPort`.
- Seeder UA strings now match the device field (desktop/mobile/tablet).
- API-keys response shape mismatch (`apiKeys` vs `keys`, `keyMasked`) fixed.

---

## [0.1.0] — 2025-10-24

### Added
- **Initial build — session replay + heatmaps + live analytics** (Microsoft Clarity clone):
  - **Prisma schema**: `Project`, `Session`, `Event`, `Insight` models. `Event` stores pointer coords, scroll, viewport, JSON data. `Insight` tracks `rage_click` / `dead_click` / `quick_back` / `excessive_scroll`. SQLite via Prisma.
  - **Lib**: `ua.ts` (UA parsing + geo), `track.ts` (ingest + rage-click detection).
  - **API routes**: `/api/track/events` (ingest, CORS open), `/api/track/script` (standalone SDK), `/api/projects` (CRUD), `/api/projects/[id]/stats` (aggregates + daily + breakdowns), `/sessions`, `/sessions/[sid]` (events + insights), `/heatmap` (click/move points + scroll buckets), `/insights`, `/api/seed` (realistic demo data: 90 sessions, mouse paths, clicks, scrolls, rage/dead clicks).
  - **Realtime mini-service**: `mini-services/live-service` (port 3004) socket.io — registers trackers, viewers subscribe per project, broadcasts live events + cursor snapshots every 1 s, prunes stale sessions.
  - **Frontend (6 tabs)**: dashboard, overview (KPIs + area chart + device pie + browser bar + top pages + countries), recordings + player (cursor, ripples, page mock, seek bar, speed control, side panel), heatmaps (density-mapped rainbow canvas 1280×2400 + scroll-depth bars), live (simulated cursors + click ripples via websocket), insights (frustration feed with severity → opens player), settings (tracking snippet with copy + delete project), demo site.
  - **Responsive layout**: mobile sidebar (Sheet) + mobile top bar; desktop sidebar unchanged. Sticky footer verified at 390×844 and full viewport.
  - **Seeder**: 90 realistic demo sessions with mouse paths, clicks, scrolls, rage/dead clicks. Verified end-to-end through the Caddy gateway.

### Fixed
- Tracking ingest URL `XTransformPort` bug (see `v0.2.0`) — discovered and fixed in the same session.

---

## Versioning policy

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR** — incompatible API or behaviour changes (signaled with `BREAKING CHANGE:` in the commit footer).
- **MINOR** — new features, backward-compatible.
- **PATCH** — bug fixes, backward-compatible.

Releases are tagged as `v0.1.0`, `v0.2.0`, … (annotated git tags). The next planned release is **v1.0.0**, cut when the API surface stabilizes after the standardized-envelope migration documented in `docs/api-style-guide.md`.

## How to update this file

1. Add your change to the **[Unreleased]** section in the same PR that introduces it.
2. Pick the right subsection (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`).
3. One bullet per change — imperative mood, lowercase first letter, no trailing period. Link to issues / PRs / ADRs where relevant.
4. On release: rename `[Unreleased]` → `[X.Y.Z] — YYYY-MM-DD`, add a new empty `[Unreleased]` block at the top, tag the release as `vX.Y.Z`.
