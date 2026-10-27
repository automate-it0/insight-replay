# 📖 Insight Replay — Usage Guide

> How to install, run, and use Insight Replay — the self-hosted Microsoft Clarity clone.
>
> This is the **operator + user guide**. For the project overview, feature list, and architecture, see the main [README.md](./README.md). For every HTTP route, see [docs/api-reference.md](./docs/api-reference.md).

---

## 📑 Table of contents

- [1. Install](#1-install)
  - [1.1 macOS / Linux / WSL](#11-macos--linux--wsl)
  - [1.2 Windows (PowerShell)](#12-windows-powershell)
  - [1.3 Docker (any OS)](#13-docker-any-os)
  - [1.4 Vercel + a separate live-service host](#14-vercel--a-separate-live-service-host)
- [2. First-run checklist](#2-first-run-checklist)
- [3. The dashboard — every tab explained](#3-the-dashboard--every-tab-explained)
- [4. Track your first site](#4-track-your-first-site)
- [5. Common workflows](#5-common-workflows)
- [6. AI features](#6-ai-features)
- [7. Security features](#7-security-features)
- [8. Troubleshooting](#8-troubleshooting)
- [9. FAQ](#9-faq)
- [10. Where to get help](#10-where-to-get-help)

---

## 1. Install

Pick the path that matches your OS / preference. The fastest is Docker; the
most dev-friendly is Bun.

### 1.1 macOS / Linux / WSL

**Prerequisites**: [Bun](https://bun.sh) ≥ 1.3, [Git](https://git-scm.com) ≥ 2.30, a POSIX shell.

```bash
# 1. Install Bun (one-shot)
curl -fsSL https://bun.sh/install | bash
exec $SHELL  # reload so `bun` is on PATH

# 2. Clone
git clone https://github.com/automate-it0/insight-replay.git
cd insight-replay

# 3. Install deps
bun install

# 4. Copy the env template + generate two 32-byte hex secrets
cp .env.example .env
./scripts/generate-secret.sh   # → paste into .env as SESSION_SECRET
./scripts/generate-secret.sh   # → paste into .env as ADMIN_TOKEN
$EDITOR .env                    # set DATABASE_URL, ALLOWED_ORIGINS, NODE_ENV

# 5. Initialize the database
bun run db:generate    # generates the Prisma client (TS types)
bun run db:push        # creates db/custom.db + all 16 tables + indexes

# 6. Start the dashboard (terminal 1)
bun run dev            # → http://localhost:3000

# 7. Start the live-service (terminal 2, in a new shell)
bun mini-services/live-service/index.ts   # → :3004 (Socket.io)
```

### 1.2 Windows (PowerShell)

> Bun does not officially support Windows yet. Use **Docker** (recommended) or **WSL2** (the WSL path above works identically).

### 1.3 Docker (any OS)

```bash
# Build the image once
docker build -t insight-replay:0.7.1 .

# Run the dashboard + API container
docker run -d --name insight-replay \
  -p 3000:3000 \
  -e DATABASE_URL=file:/data/custom.db \
  -e SESSION_SECRET=$(./scripts/generate-secret.sh) \
  -e ADMIN_TOKEN=$(./scripts/generate-secret.sh) \
  -e ALLOWED_ORIGINS=http://localhost:3000 \
  -e NODE_ENV=production \
  -v insight-replay-db:/data \
  --restart unless-stopped \
  insight-replay:0.7.1

# Run the live-service container (separate)
docker run -d --name insight-replay-live \
  -p 3004:3004 \
  -e ALLOWED_ORIGINS=http://localhost:3000 \
  -e NODE_ENV=production \
  --restart unless-stopped \
  insight-replay:0.7.1 \
  bun mini-services/live-service/index.ts

# Push schema + create the admin (one-time)
docker exec insight-replay bun run db:push

curl -X POST http://localhost:3000/api/auth/setup \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"change-me-please","name":"Site Admin"}'
```

### 1.4 Vercel + a separate live-service host

Vercel cannot run a long-lived Socket.io server. Split the deploy:

1. Deploy the dashboard + API to **Vercel** (auto-detected as Next.js 16).
2. Deploy `mini-services/live-service/` to **Fly.io / Railway / a $5 VPS**.
3. Edit `src/components/app/use-tracker.ts` → point the WebSocket URL at the live-service host.
4. Set env vars under Vercel Project Settings → Environment Variables.

---

## 2. First-run checklist

After install, run through this 10-step checklist to confirm everything works:

| # | Step | Expected result |
|---|------|-----------------|
| 1 | Visit <http://localhost:3000> | Login page renders |
| 2 | Log in with the admin you created | Dashboard shell renders with empty state |
| 3 | Click **New Project** | New project modal opens |
| 4 | Fill name + tracked URLs + Save | Project appears in the sidebar |
| 5 | Click the project → **Settings** tab | Project API key visible, copy the `<script>` tag |
| 6 | Paste the `<script>` tag into a test HTML page | SDK loads (visible in DevTools Network) |
| 7 | Click around the test page | Events POST to `/api/track/events` with 200 |
| 8 | Open **Overview** tab | Live visitor count + sessions chart updates within ~8 s |
| 9 | Open **Live** tab | Your cursor appears (from the test page) within 1 s |
| 10 | Open **Recordings** tab → click a session | Replay player opens; timeline scrubs; playback speed works |

If any step fails, jump to [Troubleshooting](#8-troubleshooting).

---

## 3. The dashboard — every tab explained

Insight Replay ships with **15 dashboard tabs**. Each maps to a Microsoft
Clarity feature, implemented end-to-end (SDK → ingest → DB → query → UI).

### Overview

A single-page summary of project health: live visitor count, sessions today
vs yesterday, top rage-clicks, top URLs, top referrers, and a sessions chart.
Polls every 8 seconds. Annotated text under each chart explains what the
number means and what action to take.

**When to use it**: daily standup, weekly review, "is anything broken right now" pulse-check.

### Recordings

List of recorded sessions with: entry URL, referrer, device, country, duration,
session count, and an insights badge (rage clicks / dead clicks / errors /
quick-backs). Click a session → the **Replay Player** opens.

The replay player:
- Pixel-accurate reconstruction from the `Event` table
- Timeline with bookmark markers (rage clicks, dead clicks, JS errors)
- Playback speed: 0.5× / 1× / 2× / 4× / 8×
- Skip-to-bookmark buttons
- Analyst notes attached to timeline moments

**When to use it**: investigate a specific user complaint, find friction in a known-broken funnel step, share a "look at this" clip with engineering.

### Heatmaps

Per-URL heatmap rendered over a live iframe of the tracked page. Three layers:
- **Click density** — what users actually click (not what you think they click)
- **Mouse-move aggregation** — where attention lingers
- **Scroll depth** — viewport-relative buckets so responsive layout shifts don't poison the data

Toggle layers in the top-right. Switch URL with the dropdown. Coordinates are
viewport-relative (0–100%) so heatmaps survive page redesigns.

**When to use it**: redesign decisions ("are users clicking the CTA or the heading above it?"), dead-UI detection, mobile vs desktop behavior comparison.

### Live

Real-time cursors from tracked sites via the Socket.io mini-service on `:3004`.
Each project is a "room". Trackers register, viewers subscribe. Stale sessions
(60 s no movement) are pruned. Connection flooding is capped at 10 sockets/IP
and 30 msgs/socket/sec.

**When to use it**: live event monitoring (webinar, product launch, Black Friday), debugging a deploy in real time, customer-support co-browse.

### Insights

Auto-detected friction patterns surfaced per-session and per-project:
- **Rage clicks** — 5+ clicks in 1 s on the same element
- **Dead clicks** — clicks on elements with no handler
- **Quick-back navigation** — back button within 3 s of page load
- **Excessive scroll** — unusual vertical scrolling on a short page (suggests a missing target)
- **JS errors** — captured via `window.onerror` + `unhandledrejection`

**When to use it**: triage — "what's broken this week?". Sort by frequency × severity, fix the top 3.

### Funnels

Multi-step funnel definitions with per-step drop-off analytics. Define steps
as URL matchers or event-name matchers. The funnel renders a Sankey-style drop
chart + per-step conversion rate + time-on-step.

**When to use it**: checkout optimization, signup flow optimization, onboarding completion.

### Journeys

Visual journey graphs reconstructing the most common page-to-page paths per
visitor segment. Force-directed graph; node size = sessions, edge weight =
transition count. Filter by entry URL, exit URL, session count, duration.

**When to use it**: discover unexpected user behavior ("people are visiting /pricing then /blog/pricing — what?"), find the unexpected back-button patterns.

### Experiments

A/B experiments: variants with weighted allocation, hypothesis field, goal-based
conversion analysis, per-experiment results page with statistical significance
indicators (Wilson score interval at 95%).

**When to use it**: ship-or-skip decisions on a redesign, headline, CTA color, pricing page layout.

### Dashboards

Drag-and-drop widget grid (`@dnd-kit/sortable`) with persistent layouts in
the `Dashboard` table. Per-dashboard data API endpoint returns pre-aggregated
metrics so the grid renders in one round trip.

**When to use it**: stakeholder-specific dashboards (CEO wants revenue, PM wants funnel, support wants errors).

### Goals & Alerts

**Goals**: URL-match or event-name definitions. Define a "signup completed" goal
as `URL contains /welcome` or `event_name === 'signup_success'`.

**Alerts**: configure alerts on `sessions / rageClicks / errors / conversions / bounceRate / avgDuration`
with conditions `gt | lt | drops | spikes`, channels `in-app | webhook`, 60-second
evaluation window. Full `AlertHistory` audit trail.

**When to use it**: get paged when a deploy breaks the funnel, when traffic spikes, when rage-clicks surge on a landing page.

### Visitors

Per-visitor list with: first-seen / last-seen, session count, total events,
country, device, browser, OS, top URLs. GDPR-compliant: IPs anonymized
before storage; right-to-erasure creates a `VisitorTombstone` that race-safely
prevents the tracker from re-creating the visitor.

**When to use it**: identify a single user for support, see how a power user uses the product, honor an erasure request.

### Retention

Cohort retention table (D1 / D7 / D30). Visualization of returning-visitor
cohorts based on visitorId (which is `localStorage`-persisted, not
cookie-persisted, so it survives cookie-clearing and consent-banner fatigue).

**When to use it**: product-market fit indicator, churn detection, growth-stage benchmark.

### Errors

Aggregated JS errors per project: error message, first-seen / last-seen, session
count, browser, OS, stack trace (when available). Click an error → see the
sessions where it occurred.

**When to use it**: catch production bugs that aren't reported by users, prioritize the most-occurring errors.

### Annotations

Analyst-authored notes attached to specific timestamps on the project timeline.
Useful for: "deployed v0.7.0 here", "ran a marketing campaign here", "outage
from 14:00 to 14:15".

**When to use it**: explain anomalies in the Overview chart to future-you.

### Settings

Project-level settings: name, tracked URLs, API keys (create / rotate / revoke),
data retention period, danger zone (delete project).

---

## 4. Track your first site

### 4.1 Get the `<script>` tag

1. Log in → click your project in the sidebar.
2. Open the **Settings** tab.
3. The first card shows the **Project API Key** + a ready-to-paste `<script>` tag.
4. Copy the tag.

### 4.2 Paste on different site types

#### Plain HTML

```html
<!doctype html>
<html>
  <head>
    <title>My Site</title>
    <!-- Insight Replay tracker -->
    <script
      src="http://localhost:3000/api/track/script.js?pid=PROJECT_ID&port=3004"
      data-project-id="PROJECT_ID"
      async
    ></script>
  </head>
  <body>
    <h1>Hello world</h1>
    <button onclick="alert('hi')">Click me</button>
  </body>
</html>
```

#### Next.js (App Router)

```tsx
// app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          src="https://insight.example.com/api/track/script.js?pid=PROJECT_ID&port=3004"
          data-project-id="PROJECT_ID"
          async
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

#### WordPress

Add to `wp-content/themes/your-theme/functions.php`:

```php
add_action('wp_head', function () {
    $pid = 'PROJECT_ID';
    $host = 'https://insight.example.com';
    echo "<script src=\"{$host}/api/track/script.js?pid={$pid}&port=3004\" data-project-id=\"{$pid}\" async></script>";
}, 10);
```

#### Shopify

Add to `layout/theme.liquid` (inside `<head>`):

```liquid
<script
  src="https://insight.example.com/api/track/script.js?pid=PROJECT_ID&port=3004"
  data-project-id="PROJECT_ID"
  async
></script>
```

#### React SPA / Vite

```html
<!-- index.html -->
<!doctype html>
<html>
  <head>
    <script src="http://localhost:3000/api/track/script.js?pid=PROJECT_ID&port=3004" data-project-id="PROJECT_ID" async></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### 4.3 Send a custom event

The SDK exposes `window.InsightReplay` once loaded. Use it to track custom
conversions:

```js
// Track a signup conversion
window.InsightReplay.track('signup_success', { plan: 'pro', amount: 49 });

// Track a feature usage
window.InsightReplay.track('feature_used', { feature: 'export_csv' });
```

Custom events surface in the **Funnels**, **Goals**, and **Journeys** tabs
when configured with `event_name` matchers.

---

## 5. Common workflows

### Workflow A — Find and fix a rage-click pattern

1. Open the **Insights** tab.
2. Filter by `last 7 days`, sort by `sessions` descending.
3. Click the top rage-click insight → see the list of sessions where it occurred.
4. Open the first session in the **Replay Player**.
5. Scrub to the bookmark (rage-click moment).
6. Note the URL + the element selector.
7. Open the **Heatmaps** tab on that URL.
8. Toggle **Click density** → confirm the rage-click hot zone.
9. Fix the UI (likely the element is unclickable or the click handler is missing).
10. After deploy, watch the Insights tab — the rage-click count should drop.

### Workflow B — Diagnose a funnel drop-off

1. Open the **Funnels** tab.
2. Select your funnel (e.g., `Homepage → Pricing → Signup → Welcome`).
3. Identify the step with the highest drop-off %.
4. Click into that step → see the sessions that dropped at that step.
5. Open 3–5 of those sessions in the Replay Player.
6. Watch for: dead clicks, rage clicks, JS errors, quick-backs, excessive scroll.
7. Cross-reference the **Errors** tab for the same time window.
8. Form a hypothesis, ship a fix, watch the funnel conversion rate over the next 7 days.

### Workflow C — Set up a "traffic spike" alert

1. Open the **Alerts** tab → click **New Alert**.
2. **Metric**: `sessions`
3. **Condition**: `spikes`
4. **Threshold**: `150%` of rolling average
5. **Window**: `60 seconds`
6. **Channel**: `webhook` → paste your Slack/Discord/PagerDuty webhook URL
7. **Save**.
8. The alert evaluates every 60 s; on a spike, the webhook fires with the project ID, current value, baseline, and timestamp.

### Workflow D — Honor a GDPR erasure request

1. Visitor emails: "please delete my data, my visitorId is `abc123…`".
2. Open the **Visitors** tab.
3. Search for the visitorId.
4. Click the row → **Erase** button.
5. Confirm.
6. A `VisitorTombstone` row is created with `projectId + visitorId` (uniqueness-constrained).
7. The tracking pipeline checks the tombstone table before creating new sessions — so even if the SDK is still loaded on the visitor's browser, new sessions are refused.
8. Confirm the tombstone appears in the project's audit log.

### Workflow E — Generate weekly AI insights

1. Set `ZAI_API_KEY` in your `.env` (otherwise AI features fail-open to 200 with an `error` field).
2. Open the project → **Overview** tab.
3. Click **Generate weekly insights** (top-right).
4. The backend calls the LLM with structured prompts over the past 7 days of data:
   - Top friction patterns
   - Top converting paths
   - Drop-off points worth investigating
5. The result renders in-app as Markdown (headings, bullets, code blocks).

### Workflow F — Run the tests

```bash
# Unit + contract tests (138 tests across 5 files)
bun test tests/

# End-to-end tests (Playwright)
bunx playwright test

# The same quality gate CI runs
./scripts/check-quality.sh
```

The tests auto-skip when the dev server is unreachable, so CI stays green
even if the dashboard isn't running.

---

## 6. AI features

Insight Replay's AI features are **backend-only**, **lazy-imported**, and
**fail-open to 200 on error**. The LLM never sees raw PII — it sees
pre-aggregated metrics and structured summaries.

### 6.1 Natural-language search

Open the **AI Search** bar (top of every tab). Type:

> show me sessions from Firefox users who rage-clicked on the pricing page last week

The LLM emits a structured filter (JSON) that the existing API runs against
the DB. The filter — not the user's text — is what's audited.

### 6.2 Per-session analysis

Open any session in the Replay Player → click **AI Analysis** (top-right).
The LLM produces a qualitative summary:
- Entry context (where the user came from)
- Likely intent (homepage browse / pricing comparison / checkout)
- Friction points (rage clicks, dead clicks, errors)
- Exit context (where the user went)

### 6.3 Weekly project digest

See Workflow E above.

### 6.4 Privacy contract

- The LLM sees **no raw IPs** (anonymized before storage).
- The LLM sees **no cookies** (we don't use them).
- The LLM sees **no PII** — only aggregated session/event counts and metadata.
- The LLM call is **logged in the audit log** with the prompt template name + token count.
- On error, the response is `200 { error: 'ai_unavailable' }` — never a 500, never a silent failure.

---

## 7. Security features

Insight Replay ships with a **six-layer security stack**, all ON by default
in production.

### 7.1 API key auth

Every `/api/projects/[id]/*` route requires an `X-Api-Key` header matching
an `ApiKey` row tied to that project. Keys are project-scoped, rotatable,
and revocable from the Settings tab.

### 7.2 Edge rate limiting

`src/middleware.ts` enforces 100 req/min/IP across the API. On the 101st
request in 60 s, the response is `429` with `Retry-After: 60`.

### 7.3 CORS + origin validation

`ALLOWED_ORIGINS` is the only allowlist. In production (`NODE_ENV=production`),
the ingest endpoint additionally validates the `Origin` header against the
project's tracked-URL list.

### 7.4 IP anonymization

Before any IP touches the database, the last octet is zeroed. Geo is then
derived deterministically from the anonymized value, so a single visitor
appears in a single country (no leakage).

### 7.5 Audit logging

Every mutation (`POST / PUT / PATCH / DELETE`) writes a row to the `Audit`
table. The `/api/audit` endpoint exposes the log to admins.

### 7.6 Security headers

`next.config.ts` sets six headers on `/(.*)`:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Content-Security-Policy: default-src 'self'; ...` (loose in dev, strict in prod)

### 7.7 Power-of-work login

`/api/auth/login/pow` issues a PoW challenge the client must solve before
the password verify runs. Brute-force becomes economically infeasible.

### 7.8 SSRF guard

`src/lib/ssrf-guard.ts` blocks webhook/alert delivery to link-local,
loopback, and metadata-service IPs. Resolves DNS once and pins the socket
to the resolved IP to defeat DNS-rebinding.

---

## 8. Troubleshooting

### The dashboard shows 0 visitors but I'm definitely being tracked

1. Open DevTools → Network → filter by `/api/track/events`.
2. Click somewhere on the tracked page.
3. Confirm a POST to `/api/track/events` returns `200`.
4. If `429`: you're being rate-limited (100 req/min/IP). Wait 60 s.
5. If `403`: origin not in `ALLOWED_ORIGINS`. Add it to `.env` and restart `bun run dev`.
6. If `200` but the dashboard is still empty: check the **Overview** tab's time range (default: last 24 h).
7. If still empty: check `db/custom.db` exists and has rows — `sqlite3 db/custom.db "SELECT COUNT(*) FROM Event;"`.

### Live cursors don't appear

1. Confirm the live-service is running: `curl http://localhost:3004/health` → `200`.
2. Confirm `ALLOWED_ORIGINS` includes the tracked-site origin.
3. Open DevTools → Network → WS → confirm a WebSocket is open to `ws://localhost:3004`.
4. If the WS is closed immediately: the live-service is rejecting the handshake. Check the live-service logs.
5. If `FF_LIVE_TRACKING=false`: enable it in `.env` (it's ON by default).

### Replay player shows "no events"

1. Open the **Recordings** tab → find the session.
2. Confirm the row shows `events: >0`. If `0`, the events weren't ingested (see above).
3. If `>0` but the player is blank: confirm the SDK captured the initial DOM snapshot (it sends one on page load). The replay reconstructs from the snapshot + subsequent mutations.

### Login fails with "PoW challenge failed"

1. JavaScript is disabled or blocked in your browser. Enable it.
2. The PoW client (`src/lib/pow-client.ts`) failed to compute. Check the browser console.
3. If your browser is very old, the Web Crypto API may be missing. Use a modern browser.

### `bun install` fails with a registry error

1. Check your internet: `curl -I https://registry.npmjs.org/`.
2. If you're behind a corporate proxy: `bun config set registry https://your-proxy/`.
3. If `bun.lock` is out of sync: `rm bun.lock && bun install`.

### `bun run db:push` fails

1. Confirm `DATABASE_URL` is set in `.env`.
2. Confirm the directory `./db/` exists (or use an absolute path).
3. If SQLite file is locked: `lsof db/custom.db` → kill the process holding it.
4. Last resort: `bun run db:reset` (drops all data).

### Docker build is slow

1. Use BuildKit: `DOCKER_BUILDKIT=1 docker build ...`.
2. Cache `node_modules` in a named volume.
3. Use the multi-stage Dockerfile (already configured) — the runtime image is ~150 MB.

### Tests fail locally but pass in CI

1. CI runs `bun test tests/` (138 tests). Some auto-skip when the dev server is unreachable. Make sure `bun run dev` is running.
2. The Playwright E2E tests require the dev server on `:3000` + live-service on `:3004`.

---

## 9. FAQ

**Q: How is this different from Microsoft Clarity?**

A: Insight Replay is self-hosted. Your recordings, your IPs, your visitors —
all on your box. No data leaves your infrastructure. No SaaS metering. No
third-party cookies. The trade-off: you run the infra (one Docker container
or one VPS).

**Q: How is this different from PostHog / Plausible?**

A: PostHog is a full product-analytics platform (events, funnels, flags,
experiments, warehouses). Insight Replay is intentionally narrower:
session replay + heatmaps + live + insights. If you need feature flags
or warehouses, use PostHog. If you need replay + heatmaps and want it
self-hosted and lightweight (256 MB RAM), use Insight Replay.

Plausible is pageview analytics with a privacy-first stance. Insight Replay
shares the privacy stance but adds session replay + heatmaps + live cursors,
which Plausible doesn't have.

**Q: Can I track multiple sites from one Insight Replay instance?**

A: Yes. Create one project per site. Each project has its own API key, its
own dashboard, its own retention policy, and its own alert configuration.
The dashboard's project picker (top-left) switches between them.

**Q: Can I migrate from Clarity / PostHog to Insight Replay?**

A: There's no automatic importer yet — it's on the v0.9 roadmap. The SDK is
drop-in compatible with any site, so cut over by swapping the `<script>` tag.
Historical data stays in Clarity / PostHog; new data flows into Insight Replay.

**Q: How much RAM / disk does it need?**

A: 256 MB RAM is the floor (the standalone server + SQLite + Socket.io
mini-service). Disk: ~1 MB per 1k events stored. A 1 GB VPS handles
~10M events / month comfortably.

**Q: Can I use Postgres instead of SQLite?**

A: Not yet. ADR-0001 documents the choice; the Postgres adapter is on the
v1.0.0 roadmap. The data model is Prisma-managed, so the migration is
schema-only — no application code changes.

**Q: Is it production-ready?**

A: The current track is `0.7.x — security hardening`. v1.0.0 will be
"general availability." For internal / small-team use, it's stable today.
For enterprise / multi-team, wait for v1.0.0 (RBAC, signed-replay
integrity, SOC 2 self-assessment).

**Q: Can I use this without the AI features?**

A: Yes. Leave `ZAI_API_KEY` unset. The AI tabs render an empty state; the
LLM calls fail-open to 200 with `{ error: 'ai_unavailable' }`. No data
is sent anywhere.

**Q: How do I update to a new version?**

A: `git pull && bun install && bun run db:push && bun run build && restart the server`.
The SQLite schema migrations are forward-only and idempotent. Always read
[`CHANGELOG.md`](./CHANGELOG.md) before updating — breaking changes are
explicitly marked.

---

## 10. Where to get help

- **Bug? → [open an issue](https://github.com/automate-it0/insight-replay/issues/new?template=bug_report.md)**
- **Feature idea? → [open a discussion](https://github.com/automate-it0/insight-replay/discussions)**
- **Security vuln? → see [`SECURITY.md`](./SECURITY.md) for the responsible-disclosure policy**
- **Code question? → [open a discussion labelled `q&a`](https://github.com/automate-it0/insight-replay/discussions?discussions_q=label%3Aq%26a)**
- **Want to contribute? → read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first**

---

<p align="center">
  <sub>Something in this guide unclear? Open a PR — every paragraph is improvable.</sub><br/>
  <sub>⭐ Star the repo if this guide saved you an hour.</sub>
</p>
