# Launch Checklist

Pre-launch checklist for **Insight Replay**. Every item has an owner, a
verification command (or steps), and a status. The launch is a **GO** only
when every blocking item is green and signed off in the **Go / No-Go** section
at the bottom.

> Scope: this checklist assumes the app is being launched as a self-hosted
> Next.js 16 deployment (Next standalone build + Prisma + SQLite + a
> socket.io mini-service on :3004 behind a Caddy gateway). There is no
> managed-PaaS path; "deploy" means "rsync the standalone build to a host
> and restart the process manager."

---

## How to use this checklist

1. **Run it in order.** Sections are sequenced so that earlier blockers
   (lint, types, tests) are caught before later ones (infra, monitoring).
   Don't skip ahead — a green monitoring check is meaningless if the build
   is broken.
2. **Each item has four fields:**
   - `[ ]` checkbox — mark with `x` when verified
   - **Owner** — the role accountable (not necessarily the person who runs
     the command)
   - **How to verify** — the exact command or step; copy-pasteable where
     possible
   - **Status** — `PASS` / `FAIL` / `BLOCKED` / `N/A`
3. **Statuses:**
   - `PASS` — verified working, evidence captured
   - `FAIL` — verification failed; do not launch until fixed
   - `BLOCKED` — cannot verify yet (e.g. waiting on DNS); track to closure
   - `N/A` — explicitly out of scope; record why
4. **Sign-off** — the launch owner initials each section as it goes green.
   The Go / No-Go decision requires every section signed off.

---

## 1. Code quality

| # | Item | Owner | How to verify | Status |
|---|------|-------|---------------|--------|
| 1.1 | ESLint passes with no errors | Eng lead | `cd /home/z/my-project && bun run lint 2>&1 \| tail -3` → exit 0, no output | ☐ PASS |
| 1.2 | TypeScript compiles clean | Eng lead | `cd /home/z/my-project && bunx tsc --noEmit 2>&1 \| grep "feature-flags"` → 0 lines (and review the rest for pre-existing errors) | ☐ PASS |
| 1.3 | All tests pass | Eng lead | `cd /home/z/my-project && bun test tests/` → 0 fail (skips are OK; they're the api-contract tests that need the dev server) | ☐ PASS |
| 1.4 | Production build succeeds | Eng lead | `cd /home/z/my-project && bun run build` → `.next/standalone/` exists, no fatal errors | ☐ PASS |
| 1.5 | No `console.log` in `src/` or `mini-services/` | Eng lead | `rg "console\.(log\|debug)" src/ mini-services/` → 0 hits (production logging goes through `src/lib/observability.ts`) | ☐ PASS |
| 1.6 | No `TODO` / `FIXME` / `XXX` in code paths shipping at launch | Eng lead | `rg "TODO\|FIXME\|XXX" src/` → review each; either fix or file an issue and link it from here | ☐ PASS |
| 1.7 | No secrets in the repo | Eng lead | `bun audit` + TruffleHog scan (`.github/workflows/security.yml`) → 0 verified secret hits | ☐ PASS |

**Section sign-off:** _________ (initials + date)

---

## 2. Security

All six layers from `docs/adr/0004-security-hardening-layers.md` must be
active. The feature flags in `src/lib/feature-flags.ts` default each layer
ON; verify they weren't turned off in the production env.

| # | Item | Owner | How to verify | Status |
|---|------|-------|---------------|--------|
| 2.1 | API key auth enforced on every protected route | Security | `curl -i http://localhost:3000/api/projects` without a key → 401. With a valid key → 200. Spot-check 3 more protected routes. | ☐ PASS |
| 2.2 | Rate limiting ON | Security | `curl` the ingest endpoint 101× in 60s from one IP → the 101st returns 429. Confirm `FF_RATE_LIMIT` is not `"false"` in env. | ☐ PASS |
| 2.3 | CORS + origin validation ON in production | Security | Send a request with `Origin: https://evil.example` → 403. Send one with an allowed origin → 200. Confirm `FF_CORS` is not `"false"` and `NODE_ENV=production`. | ☐ PASS |
| 2.4 | IP anonymization ON | Security | Submit a tracking event from a known IP, then query the session → the stored IP has its last octet zeroed. Confirm `FF_IP_ANON` is not `"false"`. | ☐ PASS |
| 2.5 | Audit logging ON | Security | Create a project, issue an API key, delete a project → `/api/projects/[id]/audit` returns all three events. Confirm `FF_AUDIT` is not `"false"`. | ☐ PASS |
| 2.6 | Security headers present | Security | `curl -sI https://<prod-host>/` → response includes `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`. (Set by `next.config.ts`.) | ☐ PASS |
| 2.7 | Input sanitization active | Security | `POST /api/track/events` with `<script>` in a field → stored sanitized (no raw HTML). Verify with a direct DB read. | ☐ PASS |
| 2.8 | No secrets in env that should be in a secret manager | Security | Review every `FF_*` and `*_KEY` env var on the host; confirm none are committed to the repo. | ☐ PASS |

**Section sign-off:** _________ (initials + date)

---

## 3. Performance

Targets are based on the `docs/performance.md` budget. The dashboard's most
expensive route is `/api/projects/[id]/stats` (aggregates over the full
session table); it must stay under the budget even at 10k sessions.

| # | Item | Owner | How to verify | Status |
|---|------|-------|---------------|--------|
| 3.1 | Stats API cache enabled | Perf | `GET /api/projects/[id]/stats` twice within 60s → second response is <5ms (cache hit). Check `src/lib/cache.ts` is in the call path. | ☐ PASS |
| 3.2 | p95 API latency < 1s under load | Perf | `hey -n 1000 -c 20 https://<prod-host>/api/projects/<id>/stats` → p95 < 1000ms. Record the actual number: p95 = ____ ms. | ☐ PASS |
| 3.3 | p99 API latency < 5s | Perf | Same `hey` run as 3.2 → p99 < 5000ms. p99 = ____ ms. | ☐ PASS |
| 3.4 | First Load JS budget | Perf | `bun run build` → check `.next/build-manifest.json` or the build summary; dashboard route First Load JS < 250 KB. | ☐ PASS |
| 3.5 | Lighthouse score on dashboard route | Perf | `lighthouse https://<prod-host>/ --only=categories=performance` → Performance ≥ 85. | ☐ PASS |
| 3.6 | No N+1 queries on hot paths | Perf | Read the `stats`, `sessions` list, and `heatmap` routes; confirm every loop body uses `include` / `select` rather than a per-row query. | ☐ PASS |

**Section sign-off:** _________ (initials + date)

---

## 4. Database

SQLite is a file; "backup strategy" mostly means "copy the file and verify
the copy opens". This is fine for a single-host deployment but does not
scale to multi-host — flag if the deploy target is multi-host.

| # | Item | Owner | How to verify | Status |
|---|------|-------|---------------|--------|
| 4.1 | Migrations applied | DB | `cd /home/z/my-project && bunx prisma migrate status` → no pending migrations. (For this project we use `db:push`, so verify `prisma/schema.prisma` matches the live DB with `bunx prisma validate`.) | ☐ PASS |
| 4.2 | Backup strategy documented | DB | Backup location, schedule, and restore command written down in `docs/rollback-plan.md` §"Database rollback". | ☐ PASS |
| 4.3 | Backup actually runs | DB | Trigger one backup now; verify the file exists at the documented location and is non-empty. | ☐ PASS |
| 4.4 | Restore tested in staging | DB | Restore the backup to a staging DB; `SELECT COUNT(*) FROM Session` matches production. (See `docs/rollback-plan.md` §"Rollback testing".) | ☐ PASS |
| 4.5 | Retention policy set | DB | Decide on a retention window (e.g. 90 days). Either enable `FF_AUTO_DELETE=true` and set the window, or document the manual purge procedure. | ☐ PASS |
| 4.6 | DB file path is absolute in `DATABASE_URL` | DB | `cat .env` → `DATABASE_URL=file:/abs/path/custom.db`. Relative paths break when the process is started from a different cwd. | ☐ PASS |

**Section sign-off:** _________ (initials + date)

---

## 5. Observability

The observability stack is `src/lib/observability.ts` + `logs/app.jsonl` +
the `/api/observability` endpoint. No external metrics backend — operators
read the JSONL file or hit the endpoint.

| # | Item | Owner | How to verify | Status |
|---|------|-------|---------------|--------|
| 5.1 | Health check responds 200 | Ops | `curl -fsS https://<prod-host>/api/health` → JSON with `status: "ok"`. Hit it 3× over 1 minute. | ☐ PASS |
| 5.2 | Logs writing | Ops | Make a request, then `tail -5 /home/z/my-project/logs/app.jsonl` → entries from the last minute. File grows over time. | ☐ PASS |
| 5.3 | Metrics collecting | Ops | `curl -s https://<prod-host>/api/observability` → `metrics.http_requests_total` has non-zero counters. | ☐ PASS |
| 5.4 | Feature flag status visible | Ops | Same `/api/observability` response includes `featureFlags: { AI_INSIGHTS: true, ... }` (added once the route is wired to `featureFlagStatus()`). For now, verify `featureFlagStatus()` returns the expected shape via `bun -e 'import("./src/lib/feature-flags").then(m => console.log(m.featureFlagStatus()))'`. | ☐ PASS |
| 5.5 | Alerts configured | Ops | At minimum: alert on `/api/health` returning non-200 (uptime monitor pings it every 60s). Alert on `error` log rate > 10/min. | ☐ PASS |
| 5.6 | Log rotation in place | Ops | `logrotate` (or equivalent) configured for `logs/app.jsonl` so the disk doesn't fill. Verify by checking `/etc/logrotate.d/insight-replay` (or your platform's equivalent). | ☐ PASS |

**Section sign-off:** _________ (initials + date)

---

## 6. Infrastructure

Two processes need to be running: the Next.js app on :3000 and the socket.io
mini-service on :3004. The Caddy gateway on :81 fronts both.

| # | Item | Owner | How to verify | Status |
|---|------|-------|---------------|--------|
| 6.1 | HTTPS configured | Ops | `curl -v https://<prod-host>/` → valid TLS cert (Let's Encrypt or equivalent), no self-signed warnings. | ☐ PASS |
| 6.2 | Caddy gateway running | Ops | `systemctl status caddy` (or `pm2 status caddy`) → active. `curl -H "Host: <prod-host>" http://localhost:81/` → 200. | ☐ PASS |
| 6.3 | Live-service running | Ops | `systemctl status insight-replay-live` (or `pm2 status`) → active. `curl http://localhost:3004/socket.io/?EIO=4&transport=polling` → 200 with `sid` payload. | ☐ PASS |
| 6.4 | Process manager set up | Ops | `pm2 list` (or `systemctl list-units \| grep insight-replay`) shows both `insight-replay-web` and `insight-replay-live` and they restart on crash. | ☐ PASS |
| 6.5 | Auto-restart on crash tested | Ops | `kill -9` the Next.js PID → process manager restarts it within 5s. Same for the live-service. | ☐ PASS |
| 6.6 | Host has ≥ 20% free disk | Ops | `df -h /home/z/my-project` → ≥ 20% free. Logs + DB grow; under 20% is a launch blocker. | ☐ PASS |
| 6.7 | Host has ≥ 512 MB free RAM | Ops | `free -m` → ≥ 512 MB available. Next.js + Prisma + the live-service together need headroom. | ☐ PASS |
| 6.8 | Firewall allows only 80/443/81 (and SSH) | Ops | `ufw status` (or equivalent) → only the required ports are open. :3000 and :3004 are NOT internet-reachable; they're behind Caddy. | ☐ PASS |

**Section sign-off:** _________ (initials + date)

---

## 7. Documentation

Docs that must be current at launch — operators will reach for these first
during an incident.

| # | Item | Owner | How to verify | Status |
|---|------|-------|---------------|--------|
| 7.1 | API reference updated | Docs | `docs/api-reference.md` lists every route under `src/app/api/`. `rg "export async function (GET\|POST\|PUT\|PATCH\|DELETE)" src/app/api/` count matches the doc's route count. | ☐ PASS |
| 7.2 | ADRs current | Docs | `docs/adr/` — every decision that shipped has an ADR. Specifically: 0001 (Prisma+SQLite), 0002 (socket.io), 0003 (LLM), 0004 (security), 0005 (cache), 0006 (agent-skills). | ☐ PASS |
| 7.3 | Runbook exists | Docs | Either this checklist + `docs/rollback-plan.md` together serve as the runbook, or a separate `docs/runbook.md` exists. Either way, an on-call engineer can answer "what do I do if X breaks?" without reading source. | ☐ PASS |
| 7.4 | Architecture diagram current | Docs | `docs/architecture.md` describes the two-process topology (Next.js + live-service), the Caddy gateway, and the data flow. Spot-check that the port numbers match the actual deployment. | ☐ PASS |
| 7.5 | Feature flags documented | Docs | This file + `docs/rollback-plan.md` together list every `FF_*` env var and the scenario where you'd flip it. | ☐ PASS |

**Section sign-off:** _________ (initials + date)

---

## 8. Rollback plan

The rollback plan is `docs/rollback-plan.md`. Verifying it here means
verifying that the plan exists AND that it's been tested in staging.

| # | Item | Owner | How to verify | Status |
|---|------|-------|---------------|--------|
| 8.1 | Rollback plan documented | Eng lead | `docs/rollback-plan.md` exists and covers: when to rollback, code rollback, DB rollback, feature-flag rollback, communication, post-rollback RCA. | ☐ PASS |
| 8.2 | Code rollback tested in staging | Eng lead | Deploy v1 to staging, then deploy v2, then revert v2 → v1 using the documented procedure. Confirm v1 is live and serving traffic. | ☐ PASS |
| 8.3 | DB restore tested in staging | DB | Restore the most recent backup to a staging DB following `docs/rollback-plan.md` §"Database rollback". Confirm row counts match. | ☐ PASS |
| 8.4 | Feature-flag rollback tested | Eng lead | Flip `FF_AI_INSIGHTS=false` in staging env, restart the process, confirm the Insights card shows the disabled state within 60s. | ☐ PASS |
| 8.5 | Rollback contact list current | Ops | `docs/rollback-plan.md` §"Communication" lists who to notify (on-call, eng lead, DB owner, comms) with current phone/email. | ☐ PASS |

**Section sign-off:** _________ (initials + date)

---

## 9. Monitoring

Distinct from observability (§5) which is "are we emitting the right
signals?" — monitoring is "is someone watching the signals and will they
wake up at 3am if they go red?"

| # | Item | Owner | How to verify | Status |
|---|------|-------|---------------|--------|
| 9.1 | Uptime monitor configured | Ops | External monitor (UptimeRobot, Pingdom, or equivalent) pings `https://<prod-host>/api/health` every 60s. Verify the monitor's dashboard shows the recent pings. | ☐ PASS |
| 9.2 | Uptime alert routes to on-call | Ops | Stop the Next.js process (or return a fake 500 from `/api/health` for 60s) → on-call receives a page within 2 minutes. Restart the process. | ☐ PASS |
| 9.3 | Error tracking set up | Ops | Sentry (or equivalent) wired into `src/lib/observability.ts` so any uncaught exception is reported. Verify by triggering a deliberate error in staging and confirming it appears in the error tracker. | ☐ PASS |
| 9.4 | Status page exists | Ops | Public status page (statuspage.io, Atlassian Status Page, or a static page) that will be updated during incidents. Even if it's just "all systems operational" today, it must exist. | ☐ PASS |
| 9.5 | On-call schedule defined | Ops | A rotation (even if it's one person for launch) is documented. Off-hours contact info is in `docs/rollback-plan.md` §"Communication". | ☐ PASS |

**Section sign-off:** _________ (initials + date)

---

## Go / No-Go decision

Complete this section only after every section above is signed off. The
launch is a **GO** when every row is green or explicitly waived.

### Blocking items (must be PASS or N/A)

| Section | Required state | Verified by | Sign-off |
|---------|----------------|-------------|----------|
| 1. Code quality | All PASS | Eng lead | _________ |
| 2. Security | All PASS | Security | _________ |
| 3. Performance | All PASS (or waived with reason) | Perf | _________ |
| 4. Database | All PASS | DB | _________ |
| 5. Observability | All PASS | Ops | _________ |
| 6. Infrastructure | All PASS | Ops | _________ |
| 7. Documentation | All PASS | Docs | _________ |
| 8. Rollback plan | All PASS | Eng lead | _________ |
| 9. Monitoring | All PASS | Ops | _________ |

### Decision

- [ ] **GO** — every blocking item is PASS or N/A; launch authorised.
- [ ] **NO-GO** — at least one blocking item is FAIL or BLOCKED; do not
      launch until resolved. List the blockers below.

**Decision:** ____________________

**Decision maker:** ____________________ (name + role)

**Date / time:** ____________________

**Waivers** (any item marked N/A above must be justified here):

| Item | Reason for waiver | Approved by | Expiry |
|------|-------------------|-------------|--------|
| | | | |

**Blockers** (if NO-GO):

| Item | Why it's blocking | Owner | ETA |
|------|-------------------|-------|-----|
| | | | |

---

## Post-launch (first 24 hours)

Not part of the go/no-go decision, but track these immediately after launch:

- [ ] First real (non-synthetic) session ingested and visible on the dashboard
- [ ] `/api/observability` shows non-zero traffic in the metrics
- [ ] No `error`-level log entries in the first hour
- [ ] On-call acknowledges they have access to the host, logs, and the rollback plan
- [ ] Schedule a post-launch retrospective for 1 week out

---

## File map

```
docs/
├── launch-checklist.md   ← this file
├── rollback-plan.md      ← the rollback procedures it references
├── architecture.md       ← process topology + data flow
├── api-reference.md      ← every API route
├── ci-cd.md              ← the CI pipeline that gates merges
└── adr/                  ← architectural decisions
src/lib/
└── feature-flags.ts      ← the feature flag system the rollback plan uses
```
