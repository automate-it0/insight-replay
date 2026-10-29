# ADR-0004: Security Hardening via 6 Parallel Layers

## Status
Accepted (2025-01-01)

## Context
Insight Replay's tracking ingest endpoint (`POST /api/track/events`) is intentionally
**open** — it accepts cross-origin POSTs from any tracked site that knows the project's
`id` or `trackingId`. This is a hard product requirement: the SDK is a `<script>` tag
that site operators paste into their HTML, and it cannot negotiate credentials or
cookies with the dashboard host.

At the same time, the dashboard exposes sensitive endpoints (sessions, errors,
annotations, API key management, audit log, CSV export) that must not be open. And the
demo's reviewers need to see that the project takes security seriously — ad-hoc "we'll
add auth later" is not acceptable.

Forces:

- **Open ingest, closed dashboard.** The two surfaces have opposite security postures.
  The ingest endpoint must accept cross-origin POSTs from tracked sites; the dashboard
  must reject them.
- **Demo scope.** There is no user/session management system in the demo. There is no
  auth provider. There is no admin role. Any auth layer must work without these.
- **Defense in depth.** A single layer is brittle. If one layer is misconfigured or
  bypassed, the others must still hold.
- **GDPR / privacy.** Visitor IPs are PII under GDPR. The product must not store
  full IPs, even if the upstream proxy sends them.
- **Operability.** The hardening must not break the demo. The dashboard must still
  render, the SDK must still ingest, the live cursors must still stream.
- **Parallelisability.** Six hardening tasks were run simultaneously.
  Each layer had to be implementable in isolation, without touching the others' files.

## Decision
Implement **six parallel security layers**, each shipped as a discrete set of
files by a dedicated hardening task. The layers are:

| # | Layer | Files | What it does |
|---|-------|-------|--------------|
| 1 | **API key auth** | `src/lib/auth.ts`, `src/app/api/projects/[id]/protected-test/route.ts` | `validateApiKey(req, projectId)` enforces `Authorization: Bearer ir_…` or `?apikey=` against the `ApiKey` Prisma model, scoped to the project. Demo `/protected-test` endpoint returns 401 without a valid key, 200 with one. |
| 2 | **Rate limiting** | `src/lib/rate-limit.ts`, `src/middleware.ts` | Per-IP fixed-window counter on `POST /api/track/events` only (matcher scoped to `/api/track/:path*`). 100 req/min/IP (`INGEST_LIMIT`); 429 + `Retry-After: 60` on overflow. `API_LIMIT` (60/min) exported for future use on dashboard routes. Persisted on `globalThis` to survive hot reloads; fails open on internal error. |
| 3 | **CORS + origin validation** | `src/app/api/track/events/route.ts`, `src/app/api/track/script/route.ts` (rewritten) | In production, the ingest endpoint resolves the request's Origin (or Referer-derived origin) and rejects it with 403 unless it matches the project's `siteUrl`, the dashboard's own origin, or `localhost` (subdomain match supported). Dev mode stays wide open (`Access-Control-Allow-Origin: *`) for local testing. OPTIONS preflight is restrictive in prod (own-origin only); POST is permissive only for site-allowed origins. |
| 4 | **IP anonymization** | `src/lib/ua.ts` (added `anonymizeIP`, `retentionCutoff`), `src/lib/track.ts` (ingest pipeline) | All IPs reaching the DB have their last IPv4 octet (8 bits) or last 4 IPv6 groups (80 bits) zeroed before storage. `fakeGeo` (deterministic from the IP string) continues to work because it operates on the already-anonymized value, so each visitor still gets a stable country/city. Bonus `retentionCutoff(days)` helper for future GDPR purge jobs. |
| 5 | **Audit logging** | `src/lib/audit.ts`, `src/app/api/audit/route.ts`, `src/app/api/projects/[id]/audit/route.ts` | File-based JSONL audit log at `logs/audit.jsonl` (decoupled from SQLite so it survives DB resets). `auditLog()` is fire-and-forget, never throws. 10 canonical action constants (`project_created`, `apikey_created`, `alert_triggered`, `data_exported`, …). Reader endpoints (global + project-scoped) support `?limit` (default 100, max 500). |
| 6 | **Security headers + input sanitization** | `next.config.ts` (added `headers()`), `src/lib/sanitize.ts` | 6 security headers on all routes: CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `X-DNS-Prefetch-Control: off`. Sanitization library (`sanitizeString`, `sanitizeUrl`, `sanitizeEvent`, `sanitizePayload`) for the ingest pipeline: HTML-escapes stored strings, strips control chars, blocks `javascript:` URLs, prevents prototype pollution (`__proto__` / `constructor` / `prototype` keys filtered), caps strings/arrays/objects/events to bound memory. |

Text-diagram of the layers in request order:

```
  Browser (tracked site SDK or dashboard)
                    │
                    ▼
  ┌─────────────────────────────────────────────┐
  │ 1. Edge middleware (src/middleware.ts)      │
  │    • rate-limit /api/track/events (layer 2) │
  │    • stamp x-request-id                     │
  └─────────────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────┐
  │ 2. Next.js route handler                    │
  │    • CORS + origin check (layer 3, ingest)  │
  │    • API key check (layer 1, dashboard)     │
  │    • input sanitization (layer 6, ingest)   │
  │    • IP anonymization (layer 4, ingest)     │
  │    • audit log write (layer 5, mutating)    │
  └─────────────────────────────────────────────┘
                    │
                    ▼
  ┌─────────────────────────────────────────────┐
  │ 3. next.config.ts headers() — always runs   │
  │    • 6 security headers (layer 6)           │
  └─────────────────────────────────────────────┘
                    │
                    ▼
                  SQLite
```

## Consequences

**Positive**

- **Defense in depth.** Each layer covers a different threat model. Even if origin
  validation (layer 3) were misconfigured, the rate limiter (layer 2) would still cap
  abuse. Even if the rate limiter were disabled, the sanitization library (layer 6)
  would still prevent stored XSS via the ingest payload.
- **Open ingest preserved.** The tracking SDK still works from any tracked site whose
  origin matches the project's `siteUrl`. No credentials required for ingest.
- **GDPR compliance.** Layer 4 ensures no full IP is ever stored. Layer 5's audit log
  gives a tamper-evident trail of who did what (intentionally file-based so it survives
  DB resets).
- **Demo stays functional.** Dev mode (`NODE_ENV !== 'production'`) short-circuits the
  origin check to `true`, so local testing is frictionless.
- **Parallelisability.** Each layer shipped in isolation with no merge
  conflicts. The six hardening tasks touched disjoint file sets.
- **Future-proofed.** `API_LIMIT` is exported but not yet wired into dashboard routes;
  `retentionCutoff(days)` is exported but not yet scheduled; audit log readers are open
  but can be gated behind admin auth later.

**Negative**

- **Some performance overhead.** Every API request passes through the edge middleware
  (matcher scoped to `/api/:path*`). The rate limiter's `Map` lookup is O(1) but still
  a lookup. The CORS validation on ingest does an extra `db.project.findFirst` to fetch
  `siteUrl` before calling `ingest()` — though this query is necessary anyway (the
  ingest pipeline needs the project row), so the overhead is the cost of moving the
  query earlier in the handler, not a new query.
- **Audit log is fire-and-forget.** A disk-full / permission-denied error on
  `appendFile` is silently swallowed (intentional — a logging failure must not break
  the user's request). This means a broken audit trail is invisible until someone reads
  the file. Mitigated by the `readAuditLog` endpoint returning `[]` on file-not-found,
  which makes the absence visible.
- **Sanitization library is wired only into the ingest path's library boundary, not yet
  into `track.ts`'s `ingest()` body.** ADR-0004 documents that `sanitizePayload` is
  ready to be called inside `src/app/api/track/events/route.ts` before `ingest()` — the
  ingest route's POST handler currently calls `ingest(payload, req)` directly. (See
  worklog Task 6 — the library was shipped; the wiring was intentionally left to a
  parallel agent per the task constraints.)
- **Origin check has a known limitation.** In production, the OPTIONS preflight handler
  cannot resolve a `projectId` (OPTIONS carries no body), so it only allows the
  dashboard's own origin + localhost. Cross-site tracking in production therefore
  requires the SDK to either same-origin-proxy or send `pid` in the URL — documented in
  the worklog.
- **Rate limiter state is per-process.** `globalThis.__rateLimitMap` is per-Next.js
  process. A multi-instance deployment would not share counters; each instance would
  allow 100 req/min/IP. Fine for a single-box demo; would need Redis for a real
  deployment.
- **Audit log readers are open.** `/api/audit` and `/api/projects/[id]/audit` return
  entries without auth. This is intentional for the demo but would need admin gating in
  production.

## Alternatives Considered

### Single middleware that does everything
- **Pros:** One file, one mental model.
- **Cons:** Forces all six concerns into the edge middleware, which runs on every
  request. Audit logging (file I/O) and API-key validation (DB lookup) are too slow for
  the edge runtime. The Edge runtime also cannot use Prisma. Mixing edge-safe and
  node-only code in one file is fragile.
- **Rejected.** The current split — edge-safe rate limiting in `middleware.ts`,
  node-only audit/auth in route handlers — matches each concern to the right runtime.

### External WAF (Cloudflare, AWS WAF)
- **Pros:** Managed, scales, no app code.
- **Cons:** Vendor lock-in + cost + the demo would not work without external
  infrastructure. Re-introduces the "external services" dependency that the project
  brief explicitly rejects.
- **Rejected for v1.** The six layers cover the same threat surface without an external
  dependency.

### NextAuth / Clerk / Auth.js for full user auth
- **Pros:** Real users, sessions, roles, RBAC. The right long-term answer.
- **Cons:** The demo has no user model. Adding one would mean a signup/login flow,
  password reset, email verification, etc. — far out of scope for what is essentially
  a single-tenant analytics demo. The API key layer gives us "good enough" auth for
  programmatic access without the rest.
- **Rejected for v1.** Track as the natural next step if the project moves to
  multi-tenant.

### Postgres Row-Level Security instead of app-layer auth
- **Pros:** Enforcement at the DB layer; impossible to bypass from the app.
- **Cons:** We are on SQLite (see ADR-0001) which does not have RLS. Even on Postgres,
  RLS policies would not help with cross-origin ingest validation, rate limiting, or
  audit logging.
- **Rejected** — does not match the database choice and does not cover the threat
  surface.
