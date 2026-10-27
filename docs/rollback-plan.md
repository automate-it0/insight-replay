# Rollback Plan

Rollback procedures for **Insight Replay**. The goal is to recover service
in under 15 minutes for any of the trigger conditions in §1, with no data
loss beyond what's already been committed.

> Companion document: `docs/launch-checklist.md` §8 verifies this plan has
> been tested. `src/lib/feature-flags.ts` is the feature-flag system
> referenced throughout.

---

## 1. When to rollback

Roll back immediately if **any** of the following is true. Do not wait for
root cause — recover first, investigate second.

| # | Trigger | Detection | Severity |
|---|---------|-----------|----------|
| 1.1 | Error rate > 5% sustained for 5 minutes | `/api/observability` metrics: `http_requests_total{status_class="5xx"}` / total > 0.05 over a 5-min window. Or: external uptime monitor reports > 5% failures. | Critical |
| 1.2 | p99 latency > 5s sustained for 5 minutes | `http_request_duration_seconds` histogram p99 > 5.0s. Compare against the launch budget in `docs/launch-checklist.md` §3.3. | Critical |
| 1.3 | Data corruption | Any query returns rows that violate a schema invariant (e.g. a Session with no Project, an Event with no Session, a negative duration). Detected via the health check or operator report. | Critical |
| 1.4 | Security breach | Confirmed unauthorised access: a leaked API key in the wild, an unexpected entry in the audit log, a third-party report. | Critical |
| 1.5 | AI provider outage | z-ai-web-dev-sdk returning 5xx for > 50% of calls over 5 minutes. Not a hard rollback — flip `FF_AI_INSIGHTS=false` instead (see §6). | High |
| 1.6 | Live-service unreachable | The socket.io mini-service on :3004 not responding. Not a hard rollback — flip `FF_LIVE_TRACKING=false` (see §6). | High |
| 1.7 | Disk > 90% full on the host | `df -h` shows the volume holding `logs/` or `db/` at > 90%. Roll back the latest deploy if it shipped a log-volume regression; otherwise clear logs first. | High |

**Decision rule:** if any 1.1–1.4 trigger is true, roll back the code
deployment AND any feature flags implicated. If only 1.5–1.7 are true, flip
the relevant feature flag — no code rollback needed.

---

## 2. How to rollback

Three rollback surfaces, in order of preference (fastest first):

### 2.1 Feature flag rollback (seconds, no redeploy)

For any incident isolated to a feature gated by `src/lib/feature-flags.ts`,
flip the env var and restart the process. Service recovers in < 60s.

```bash
# Example: AI insights are causing latency spikes
# 1. Edit the env on the host (or your env manager)
sudo vim /etc/insight-replay/env   # or: edit the systemd unit's Environment= lines
# Set: FF_AI_INSIGHTS=false

# 2. Restart the Next.js process so it picks up the new env
sudo systemctl restart insight-replay-web
# (or: pm2 restart insight-replay-web)

# 3. Verify the flag is now off
curl -s https://<prod-host>/api/observability | jq '.featureFlags.AI_INSIGHTS'
# → false

# 4. Verify the user-facing symptom is gone
curl -s -H "Authorization: Bearer <key>" https://<prod-host>/api/projects/<id>/ai
# → 503 with a "disabled" message (not a 500 stack trace)
```

See §6 for the full table of flags → flip scenarios.

### 2.2 Code rollback (minutes, requires previous build)

Two paths, depending on how you deployed:

**Path A — git revert + redeploy (for `git push`-based deploys):**

```bash
# On the production host:
cd /home/z/my-project

# 1. Find the last known-good commit
git log --oneline -10

# 2. Option A: revert the bad commit (creates a new commit, preserves history)
git revert <bad-commit-sha>
git push origin main

# 3. Option B: hard reset if the bad commit was very recent and unmerged elsewhere
#    Use with caution — rewrites history.
git reset --hard <last-good-commit-sha>

# 4. Rebuild and restart
bun run build
sudo systemctl restart insight-replay-web
sudo systemctl restart insight-replay-live
```

**Path B — switch to the previous Docker image (for image-based deploys):**

```bash
# 1. List the last 5 images deployed
docker images insight-replay --format "{{.ID}} {{.CreatedAt}} {{.Tag}}" | head -5

# 2. Update the deploy tag to the previous image
#    (in your deploy script / compose file / k8s manifest)
#    IMAGE=insight-replay:<previous-tag>

# 3. Restart the service with the old image
sudo systemctl restart insight-replay-web
sudo systemctl restart insight-replay-live

# 4. Verify the running image matches the previous version
docker inspect insight-replay-web | jq '.[0].Config.Image'
```

> **Verification after code rollback:** hit `/api/health` (expect 200),
> then make one real request through the dashboard to confirm the user
> flow works. Then check `/api/observability` metrics to confirm error
> rate is dropping.

### 2.3 Database rollback (minutes, requires a recent backup)

Only needed for §1.3 (data corruption) or §1.4 (security breach that
involved data writes). For all other triggers, the database is fine —
don't touch it.

**Backup location:**

```
/home/z/my-project/db/backups/custom-YYYYMMDD-HHMMSS.db
```

The backup is a plain copy of the SQLite file taken while the DB was
quiescent (or via SQLite's online backup API). Restoring is a file copy.

**Restore command:**

```bash
# 1. STOP the Next.js process so it isn't writing to the DB during restore
sudo systemctl stop insight-replay-web
sudo systemctl stop insight-replay-live

# 2. Move the corrupted DB aside (don't delete — needed for forensics)
mv /home/z/my-project/db/custom.db /home/z/my-project/db/custom.corrupted-$(date +%Y%m%d%H%M%S).db

# 3. Copy the most recent good backup into place
cp /home/z/my-project/db/backups/custom-<good-timestamp>.db /home/z/my-project/db/custom.db

# 4. Verify the restored DB opens and has the expected row counts
sqlite3 /home/z/my-project/db/custom.db "SELECT COUNT(*) FROM Session; SELECT COUNT(*) FROM Event;"

# 5. Restart the services
sudo systemctl start insight-replay-web
sudo systemctl start insight-replay-live

# 6. Hit /api/health and confirm the DB check is "ok"
curl -s https://<prod-host>/api/health | jq '.checks[] | select(.name=="database")'
```

**Data loss window:** any sessions ingested between the backup timestamp
and the rollback will be lost. Accept this — it's better than serving
corrupted data. Re-ingest from upstream sources (tracking SDKs on customer
sites) is not possible; the loss is permanent. The backup cadence in §3
should keep this window ≤ 1 hour.

---

## 3. Rollback testing

The rollback plan is untested = the rollback plan doesn't work. Test it in
staging before every launch and after every deploy-pipeline change.

### 3.1 Test matrix

| Test | Frequency | Owner | Pass criteria |
|------|-----------|-------|---------------|
| Feature flag flip | Before every launch | Eng lead | Flag flips within 60s of env change + restart; user-facing symptom gone. |
| Code rollback (git revert) | Before every launch | Eng lead | Staging serves the previous commit's behaviour within 5 minutes of `git revert`. |
| Code rollback (image switch) | Before every launch (if image-based) | Eng lead | Staging serves the previous image's behaviour within 5 minutes of the switch. |
| DB restore | Monthly | DB | Restored DB row counts match the backup; app starts and serves traffic. |
| Full rollback drill | Quarterly | Eng lead | Trigger a fake incident (kill the live-service, inject a 500, corrupt a row) and run the full plan end-to-end. Time-to-recovery < 15 minutes. |

### 3.2 Staging test procedure

```bash
# On the staging host (mirror of production):

# 1. Snapshot current state
cd /home/z/my-project
git rev-parse HEAD > /tmp/before-rollback.sha
sqlite3 db/custom.db "SELECT COUNT(*) FROM Session" > /tmp/before-rollback.sessions

# 2. Deploy a "bad" change (e.g. break one route on purpose)
echo "throw new Error('rollback test')" >> src/app/api/health/route.ts
bun run build && sudo systemctl restart insight-replay-web

# 3. Confirm the bad change is live
curl -s https://staging.example.com/api/health   # → 500

# 4. Run the rollback procedure from §2.2
git revert HEAD
bun run build && sudo systemctl restart insight-replay-web

# 5. Verify recovery
curl -s https://staging.example.com/api/health   # → 200
git rev-parse HEAD  # matches /tmp/before-rollback.sha

# 6. Run the DB restore test from §2.3
#    (use a recent backup; verify the row count matches /tmp/before-rollback.sessions)

# 7. Run a feature flag test from §2.1
#    (set FF_AI_INSIGHTS=false, restart, verify the AI route returns 503)
```

Record the time-to-recovery in the worklog after each drill. If it exceeds
15 minutes, file an issue and improve the procedure before the next launch.

---

## 4. Communication

### 4.1 Who to notify

| Role | When | How |
|------|------|-----|
| On-call engineer | Immediately on trigger detection | Pager / phone |
| Eng lead | Within 5 minutes of trigger | Slack + phone if no Slack response |
| DB owner | If §2.3 (DB rollback) is being considered | Slack + phone |
| Security | If §1.4 (security breach) is the trigger | Phone — security must approve the rollback approach |
| Comms / customer success | Within 15 minutes of confirmed user impact | Slack; they draft the status page update |
| Executive sponsor | Within 30 minutes for Critical incidents | Phone |

### 4.2 Status page updates

A status page entry should be posted within 15 minutes of trigger detection.
Use this template:

> **[Investigating]** We're investigating reports of <symptom>. We've
> identified <preliminary cause> and are rolling back. Next update in
> 15 minutes or when resolved, whichever is first.

Update the entry at each milestone:

- **[Identified]** — root cause confirmed, rollback in progress
- **[Monitoring]** — rollback complete, watching metrics for recovery
- **[Resolved]** — service confirmed healthy for 15 minutes; post-mortem
  to follow within 48 hours

### 4.3 Internal comms channel

Open a dedicated Slack channel `#incident-YYYY-MM-DD` for every Critical
incident. All rollback discussion goes there, not in DMs, so the timeline
is reconstructable for the RCA.

---

## 5. Post-rollback

### 5.1 Stabilisation

Once rolled back, **do not** immediately re-attempt the bad deploy. Hold
the rollback for at least 30 minutes of clean traffic to confirm:

- [ ] `/api/health` returns 200 every minute for 30 minutes
- [ ] Error rate < 1% over the 30-minute window
- [ ] p99 latency back under 5s
- [ ] No new error-level log entries related to the rolled-back change

### 5.2 Root cause analysis (RCA)

File an RCA within 48 hours of resolution. Use this template — store
completed RCAs in `docs/rca/YYYY-MM-DD-<short-description>.md`:

```markdown
# RCA: <short description>

**Date:** YYYY-MM-DD
**Severity:** Critical / High / Medium
**Time to detect:** ____ minutes
**Time to rollback:** ____ minutes
**Time to resolve:** ____ minutes
**Impact:** <users affected, requests failed, data lost>

## Summary
<one paragraph: what happened, in plain language>

## Timeline (UTC)
- HH:MM — <event>
- HH:MM — <event>
- HH:MM — Rollback initiated
- HH:MM — Service recovered

## Root cause
<the actual technical cause, not "a bug". Be specific: which line of code,
which config, which upstream change.>

## Contributing factors
<what made this worse or harder to detect: missing test, missing alert,
insufficient logging, etc.>

## What went well
<parts of the response that worked: fast detection, clean rollback,
good comms.>

## What went badly
<parts that didn't: slow detection, rollback procedure had a gap,
poor comms.>

## Action items
| # | Action | Owner | Due | Tracking |
|---|--------|-------|-----|----------|
| 1 | <specific, actionable, testable step> | <name> | YYYY-MM-DD | <issue #> |

## Lessons learned
<what we'll do differently next time. Be concrete.>
```

### 5.3 Action item follow-up

Every action item from the RCA must have:

- A named owner (not "the team")
- A due date (≤ 30 days for Critical, ≤ 60 for High)
- A tracking issue in the project tracker

The launch owner reviews open action items weekly until all are closed.
Action items that prevent the next launch are launch blockers — add them
to `docs/launch-checklist.md` §1 (or the relevant section) as a new row.

---

## 6. Feature flag rollback scenarios

The fastest path to recovery for most incidents. Each row maps a symptom
to the flag to flip. All flags are documented in `src/lib/feature-flags.ts`.

| Symptom | Flag to flip | Env var to set | Effect | User-facing impact |
|---------|--------------|----------------|--------|--------------------|
| AI insights causing latency spikes or 5xx from the LLM provider | `AI_INSIGHTS` | `FF_AI_INSIGHTS=false` | The dashboard Insights card stops calling the LLM; shows a static "AI insights disabled" message. | Insight card is empty; rest of dashboard unaffected. |
| Per-session AI analysis failing (`/ai/session` 5xx) | `AI_SESSION_ANALYSIS` | `FF_AI_SESSION=false` | The "Analyze with AI" button in the recording player returns 503 instead of 500. | Player still works; AI panel shows a disabled state. |
| AI search timing out or returning garbage | `AI_SEARCH` | `FF_AI_SEARCH=false` | The AI search bar shows a "search disabled" state; manual filters still work. | Search reverts to manual filter UI. |
| Live-service down or causing websocket errors in the browser console | `LIVE_TRACKING` | `FF_LIVE_TRACKING=false` | The Live tab shows a static "live tracking disabled" message; no socket.io connection attempted. | Historical data still browsable; live cursor overlay gone. |
| Experiments tab causing confusion or a bug | `EXPERIMENTS` | `FF_EXPERIMENTS=false` | The Experiments tab is hidden from the sidebar. | Tab hidden; existing experiment data preserved in DB. |
| Custom dashboards causing crashes | `CUSTOM_DASHBOARDS` | `FF_DASHBOARDS=false` | The Dashboards tab is hidden from the sidebar. | Tab hidden; existing dashboards preserved in DB. |
| Rate limiter false-positive blocking legitimate traffic | `RATE_LIMITING` | `FF_RATE_LIMIT=false` | Rate limiting disabled. **Re-enable ASAP** — leaves ingest vulnerable to DoS. | All requests allowed; watch error rate. |
| CORS false-positive blocking a legitimate origin | `CORS_VALIDATION` | `FF_CORS=false` (production only) | CORS validation disabled. **Re-enable ASAP** — opens the API to any origin. | All origins accepted; treat as a security event. |
| IP anonymization needs to be off for forensic investigation | `IP_ANONYMIZATION` | `FF_IP_ANON=false` | Full client IPs stored in DB + logs. **Document the window** and re-enable. | Security/privacy event; notify Security. |
| Audit log fills disk or audit writes are failing requests | `AUDIT_LOGGING` | `FF_AUDIT=false` | Privileged actions no longer recorded. **Re-enable ASAP** — loses forensic trail. | No user impact; loss of audit data. |
| Auto-delete job deleting sessions it shouldn't | `AUTO_DELETE_OLD_SESSIONS` | `FF_AUTO_DELETE` (unset, or any value other than `"true"`) | Auto-delete stops. Existing deleted data is gone (restore from backup if needed). | Future sessions preserved. |
| Debug observability filling the disk | `DEBUG_OBSERVABILITY` | `FF_DEBUG` (unset, or any value other than `"true"`) | Verbose logging stops. | No user impact; log volume drops. |

### 6.1 Procedure for every flag flip

1. **Identify the flag** from the table above.
2. **Set the env var** on the host (or your env manager).
3. **Restart the Next.js process** so the new env is picked up:
   ```bash
   sudo systemctl restart insight-replay-web
   # (or: pm2 restart insight-replay-web)
   ```
4. **Verify** the flag is now in the expected state:
   ```bash
   curl -s https://<prod-host>/api/observability | jq '.featureFlags.<NAME>'
   ```
5. **Verify** the user-facing symptom is gone (make the request that was
   failing; confirm it now succeeds or returns the documented "disabled"
   response).
6. **Notify** the on-call channel that the flag was flipped and why.
7. **File an issue** to track re-enabling the flag (or keeping it off
   permanently if the underlying issue is by design).

### 6.2 Order of operations for a multi-flag incident

If multiple flags are implicated (e.g. "AI is broken AND the live-service
is down"), flip them one at a time, verifying between each flip. This
keeps the recovery attributable — if flipping flag B makes things worse,
you know B was the wrong call, not a side effect of A.

---

## 7. Quick reference card

Print this and tape it to the wall. Or bookmark it. Or both.

```
──────────────────────────────────────────────────────────────────────
 ROLLBACK QUICK CARD — Insight Replay
──────────────────────────────────────────────────────────────────────

WHEN TO ROLL BACK (any one):
  • error rate > 5% for 5 min
  • p99 latency > 5s for 5 min
  • data corruption
  • security breach

FASTEST PATH (try this first):
  Flip a feature flag → restart → verify
  See §6 table for which flag.

CODE ROLLBACK:
  git revert <bad-commit> && git push
  bun run build && sudo systemctl restart insight-replay-web insight-replay-live

DB ROLLBACK (only for corruption / breach):
  systemctl stop insight-replay-web insight-replay-live
  mv db/custom.db db/custom.corrupted-$(date +%s).db
  cp db/backups/custom-<good>.db db/custom.db
  sqlite3 db/custom.db "SELECT COUNT(*) FROM Session"
  systemctl start insight-replay-web insight-replay-live

VERIFY AFTER EVERY ROLLBACK:
  curl -s https://<host>/api/health | jq .status       # → "ok"
  curl -s https://<host>/api/observability | jq .status

COMMUNICATE:
  • Page on-call immediately
  • Status page within 15 min
  • Open #incident-YYYY-MM-DD channel
  • RCA within 48 hours (template in §5.2)
──────────────────────────────────────────────────────────────────────
```

---

## File map

```
docs/
├── rollback-plan.md      ← this file
├── launch-checklist.md   ← §8 verifies this plan is tested
└── rca/                  ← completed RCAs go here (created on first use)
src/lib/
└── feature-flags.ts      ← the flag system §6 references
```
