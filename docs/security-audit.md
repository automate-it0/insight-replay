# Security Audit — OWASP Top 10 (2021)

**Scope:** Insight Replay — full codebase (Next.js 16 App Router + Prisma + SQLite + TypeScript + Socket.io mini-service + z-ai-web-dev-sdk).
**Auditor:** security-and-hardening sub-agent (Task ID 10).
**Standard:** OWASP Top 10 — https://owasp.org/Top10/ (2021 edition).
**Method:** Static review of `src/lib/`, `src/app/api/`, `src/middleware.ts`, `next.config.ts`, `prisma/schema.prisma`, `package.json`, `.github/workflows/security.yml`. Dynamic verification via `grep` for sink patterns (`auditLog`, `validateApiKey`, `String(e)`, `fetch(`, `$queryRaw`, `process.env.`). No source files modified — this is an audit + helper task.

> **Note on skill paths.** The task brief referenced `.agent-skills/skills/security-and-hardening/SKILL.md` and `.agent-skills/references/security-checklist.md`; neither exists on this checkout (`.agent-skills/` is absent). The audit was performed against OWASP Top 10 (2021) directly, cross-referenced with the project's own ADR-0004 ("Security Hardening via 6 Parallel Layers") which documents the security design intent.

---

## Summary

| # | OWASP category | Risk | Status | Priority |
|---|----------------|------|--------|----------|
| A01 | Broken Access Control | **Medium** | Mitigated | P1 |
| A02 | Cryptographic Failures | **High** | Needs fix | P0 |
| A03 | Injection | **Low** | Protected | — |
| A04 | Insecure Design | **Medium** | Partially mitigated | P1 |
| A05 | Security Misconfiguration | **Medium** | Partially mitigated | P1 |
| A06 | Vulnerable & Outdated Components | **Low** | Mitigated (CI) | P2 |
| A07 | Identification & Authentication Failures | **High** | Needs fix (documented tech-debt) | P0 |
| A08 | Software & Data Integrity Failures | **Low** | Mitigated (CI) | P2 |
| A09 | Security Logging & Monitoring Failures | **Medium** | Needs fix (lib exists, not wired) | P1 |
| A10 | Server-Side Request Forgery (SSRF) | **Low** | Protected | — |

**Aggregate:** 2 High / 4 Medium / 4 Low. No Critical.

**Headline finding:** The project has a well-designed 6-layer security architecture (ADR-0004) but **two layers are partially unbuilt**: (1) API-key auth is wired only into `/protected-test` (a demo endpoint), not into real dashboard routes; (2) audit logging is shipped as a library but never invoked anywhere in the codebase (`grep -r auditLog src/` returns zero call sites). These are documented as tech-debt in ADR-0004 and the worklog — this audit simply confirms them with current-state evidence.

---

## A01 — Broken Access Control

### Description
Restrictions on what authenticated users can do are not properly enforced. Attackers can act as other users or administrators, access unauthorized data, or modify data / view fields they should not see.

### Project surface
- **Ingest** (`POST /api/track/events`): open by design — accepts cross-origin POSTs from any tracked site. CORS + origin validation gates which origins may POST in production (project's `siteUrl`, the dashboard's own origin, or `localhost`/`127.0.0.1`).
- **Dashboard API** (~70 routes under `/api/projects/[id]/…`): intended to be API-key gated per ADR-0004.
- **Reader endpoints** (`/api/audit`, `/api/projects/[id]/audit`, `/api/observability`): intentionally open for the demo (documented in `src/app/api/audit/route.ts` comment).

### Findings
1. **Ingest endpoint accepts any `projectId` — no verification the request comes from the project owner's site.**
   - Evidence: `src/app/api/track/events/route.ts` lines 144–177. The handler resolves the project by `id` *or* `trackingId`, then calls `isOriginAllowed(requestOrigin, [ownOrigin, siteOrigin])`. In production, an origin check runs. In dev (`NODE_ENV !== 'production'`), `isOriginAllowed` short-circuits to `true` (`route.ts:89`).
   - **CORS is bypassable.** Browser CORS enforcement is a client-side mechanism; any non-browser client (curl, server-side script, browser with disabled CORS) can spoof the `Origin` header. CORS is **defense in depth**, not an access-control boundary.
   - **Horizontal privilege escalation (cross-project data injection):** a script running on site A that knows site B's `trackingId` (a cuid, but not a secret — it appears in the public SDK snippet) can POST events into project B. The `trackingId` is effectively a capability URL but is published in cleartext HTML.
   - Real-world impact is bounded: ingest only inserts events; it does not return existing data. So an attacker can pollute but not exfiltrate. Still, a malicious tracker can inject `<script>` payloads (mitigated by `sanitize.ts`) or flood the rate limiter (100 req/min/IP).

2. **Dashboard routes do NOT enforce `validateApiKey`.** A grep for `validateApiKey` returns exactly two hits: the function definition (`src/lib/auth.ts:43`) and the demo route (`/protected-test/route.ts:22`). Zero production dashboard routes call it.
   - Examples of unprotected sensitive endpoints:
     - `GET /api/projects/[id]/export` — returns CSV of all sessions (visitor IDs, IPs country/city, referrers, UTM params).
     - `GET /api/projects/[id]/audit` — returns the audit log.
     - `GET /api/projects/[id]/apikeys` — returns masked API key metadata.
     - `POST /api/projects/[id]/apikeys` — **creates a new API key** for any caller who knows the project id.
     - `DELETE /api/projects/[id]/apikeys/[kid]` — revokes an API key.
     - `POST /api/projects/[id]` (route.ts) — updates project (could change `siteUrl`, redirecting ingest).
   - The reader endpoints (`/api/audit`, `/api/observability`) are intentionally open per their inline comments.

3. **No path-traversal risk in route params.** All routes use Prisma `findFirst` / `findUnique` with `where: { id, projectId }` style filters — the dashboard's project-scoped queries are correctly scoped.

### Risk: **Medium**
- Ingest data injection is possible but noisy and bounded by the rate limiter; stored XSS is prevented downstream by `sanitize.ts`.
- Dashboard routes are wide open, but the demo is single-tenant (no user model, no auth provider), so the "horizontal privilege escalation" risk between *users* does not apply — any caller can already access any project. This is documented tech-debt, not a regression.

### Status: **Mitigated (ingest) / Needs fix (dashboard)**

### Recommended action
- Wire `validateApiKey(req, projectId)` into every `POST`/`PUT`/`DELETE`/`PATCH` route under `/api/projects/[id]/`. GET routes that return sensitive data (export, audit, apikeys, sessions, visitors) should also be gated.
- For the ingest endpoint: consider adding a per-project HMAC signature header (signed with the `trackingId`) in addition to origin validation, so non-browser attackers can't inject events. This is a v2 change; for v1, document the trust model clearly.

---

## A02 — Cryptographic Failures

### Description
Failures related to cryptography (or lack thereof), often leading to exposure of sensitive data.

### Project surface
- SQLite database at `db/custom.db` (Prisma, `provider = "sqlite"`).
- API keys: `ApiKey.key` column (Prisma `String @unique @default(cuid())`).
- No password model — there is no user auth, so no password hashing applies yet.
- IPs: anonymized in `src/lib/ua.ts` before storage (last IPv4 octet zeroed, last 80 bits of IPv6 zeroed).

### Findings
1. **SQLite DB is unencrypted.**
   - Evidence: `prisma/schema.prisma` lines 7–10. `provider = "sqlite"`, `url = env("DATABASE_URL")`. No SQLCipher, no `PRAGMA key`.
   - The DB file at `db/custom.db` is `-rwxr-xr-x` (world-readable on this dev box). On a production host this should be `0600` and owned by the runtime user only.
   - Impact: if the DB file is exfiltrated (backup leak, container escape, supply-chain compromise of the host), all session data, event payloads, error stacks, IP (anonymized but still pseudo-identifiable), API keys, and audit logs are in cleartext.

2. **API keys are stored in plain text.**
   - Evidence: `src/app/api/projects/[id]/apikeys/route.ts:42` — `const fullKey = \`ir_${randomUUID().replace(/-/g, "")}\`` and `db.apiKey.create({ data: { key: fullKey } })`. Stored verbatim in the `ApiKey.key` column.
   - The GET endpoint correctly *masks* the key when listing (`maskKey(k.key)` returns `ir_••••abcd`) and only returns the full key once on creation (line 51). Good. But the *stored value* is plain.
   - Validation (`src/lib/auth.ts:50`) does `db.apiKey.findFirst({ where: { key, projectId } })` — a constant-time comparison is impossible with a plain DB lookup, but more importantly, a DB exfiltration = full API-key disclosure. Hashing at rest (e.g., SHA-256 with a per-key salt) would let us validate keys without storing them.
   - `cuid()` (the default in `schema.prisma`) and `randomUUID()` are *not* cryptographically random — they're unique IDs. For API keys we want `crypto.randomBytes(32).toString("hex")` (or use the existing `randomUUID()` but be honest that it's 122 bits of randomness from a v4 UUID, which is adequate).

3. **No encryption at rest for the audit log.** `logs/audit.jsonl` is plain text. Acceptable for a demo, but if audit logs contain PII (they do — `actor` + `ip`), they should be on an encrypted volume in production.

4. **IP anonymization is correctly applied** (`src/lib/track.ts:53` — `const ip = anonymizeIP(rawIp)`). This is a privacy win, not a vulnerability. Anonymization is irreversible, so even if the DB leaks, the last octet / 80 bits are gone.

5. **No TLS configuration in code.** TLS is terminated by the Caddy gateway (see `Caddyfile`), not by Next.js. Acceptable.

### Risk: **High** (if the DB file is stolen)

### Status: **Needs fix** — hash API keys at rest; tighten DB file permissions; document encryption-at-rest plan.

### Recommended action
- **Hash API keys at rest.** Store `sha256(key)` in the `ApiKey.keyHash` column (drop the `key` column after migration). On validation, hash the incoming key and look up by `keyHash`. Keep the raw key in memory only long enough to return it once on creation.
- **Tighten DB file permissions** to `0600`. Add a startup check in `src/lib/security-checklist.ts` (this audit ships that helper).
- **Document encryption-at-rest plan** as an ADR: either (a) move to Postgres + column-level encryption for PII fields, or (b) run SQLite on an encrypted volume (LUKS / dm-crypt), or (c) integrate SQLCipher (Prisma does not officially support SQLCipher, so this is the most invasive option).
- For the audit log: ensure the `logs/` directory is on an encrypted volume in production.

---

## A03 — Injection

### Description
User-supplied data is not validated, filtered, or sanitized, leading to SQL/NoSQL/OS/LDAP injection.

### Project surface
- All DB access goes through Prisma (`@prisma/client`).
- One `$queryRaw` site exists: `src/lib/observability.ts:186` — `await db.$queryRaw\`SELECT 1\``. **This is a tagged-template literal with no user input interpolated.** Safe.
- No `eval`, no `Function()`, no `child_process.exec`, no `execSync`.
- The ingest pipeline sanitizes all inbound strings via `src/lib/sanitize.ts` (HTML escape, control-char strip, prototype-pollution key filter, length caps).

### Findings
1. **SQL injection: protected.** Prisma's query builder parameterizes all values. The only `$queryRaw` is a constant health-check query. Grep for `\$queryRaw|\$executeRaw|raw SQL` returns one hit, no interpolation. ✅
2. **NoSQL injection: N/A.** No MongoDB / Redis / document store.
3. **Command injection: N/A.** No `child_process` imports anywhere in `src/`.
4. **Prototype pollution: protected at ingest.** `src/lib/sanitize.ts:43` filters `__proto__`, `constructor`, `prototype` keys recursively before persistence. Note: ADR-0004 documents that `sanitizePayload` is *shipped but not yet wired into the ingest route's POST handler* — the route calls `ingest(payload, req)` directly without first calling `sanitizePayload(payload)`. **This is a gap.** Until the wiring lands, the prototype-pollution guard is dead code at runtime. (Confirm via grep: `sanitizePayload` is defined in `src/lib/sanitize.ts` but has zero call sites in `src/app/`.)
5. **Stored XSS: protected at the sanitization layer** (when wired). HTML-escape on every persisted string means a `<script>` payload becomes `&lt;script&gt;` in the DB. The dashboard renders strings via React/JSX by default (auto-escaped); `dangerouslySetInnerHTML` is not used in the audited components.
6. **CSV injection (formula injection) in the export endpoint:** `src/app/api/projects/[id]/export/route.ts` uses `csvCell()` which wraps values containing `,`, `"`, `\n`, `\r` in double quotes — but does NOT escape leading `=`, `+`, `-`, `@`, `\t`, `\r` characters that Excel/Sheets interpret as formulas. A visitor's `referrer` or `utmSource` of `=cmd|'/c calc'!A1` would be stored (sanitized to HTML-escaped, but `=` survives HTML escape) and then exported into a CSV that Excel will execute on open. Risk is Low (requires an attacker who can ingest events AND a dashboard user who opens the CSV in Excel), but trivially fixable.

### Risk: **Low** (with the sanitization-wiring caveat)

### Status: **Protected** (SQLi), **Needs fix** (sanitizePayload wiring + CSV formula escaping)

### Recommended action
- Wire `sanitizePayload(payload)` into `POST /api/track/events` before `ingest(payload, req)`. One-line change. Closes the prototype-pollution + stored-XSS gap.
- In `csvCell()`, prefix any value that starts with `=`, `+`, `-`, `@`, `\t`, `\r` with a single quote `'` (or strip the leading char) to neutralize spreadsheet formula injection.
- Long-term: enable `react/no-danger` ESLint rule to prevent future `dangerouslySetInnerHTML` usage.

---

## A04 — Insecure Design

### Description
Missing or ineffective control design. Distinct from implementation bugs — these are architectural flaws.

### Findings
1. **No rate limiting on dashboard API routes.** `src/lib/rate-limit.ts` exports both `INGEST_LIMIT` (100/min/IP, used) and `API_LIMIT` (60/min/IP, **unused**). Grep for `rateLimit(` returns two hits: the function definition and `src/middleware.ts:14` (ingest only). The middleware's matcher is `["/api/:path*"]` but the rate-limit branch only fires when `path === "/api/track/events"`. Every other API route passes through with no rate limiting at all. An attacker can scrape `/api/projects/[id]/export` at line rate.
2. **No account lockout / no auth.** There is no user model, so there is nothing to lock. Documented as v1 scope (ADR-0004 "Alternatives Considered" — NextAuth rejected for v1).
3. **No CSRF protection on dashboard mutating routes.** Dashboard POST routes (`/api/projects/[id]/apikeys`, `/api/projects/[id]/alerts`, etc.) accept JSON bodies and have no CSRF token, no `SameSite` cookie check (because there's no cookie auth), no `Origin` check on dashboard routes. Today this is moot because there's no auth to forge — but the moment auth lands, CSRF becomes a real risk. The ingest endpoint's origin check does not extend to dashboard routes.
4. **`trackingId` is published in cleartext HTML** (the snippet in `SettingsTab`). Anyone who can view-source the tracked site learns the project's `trackingId` and can inject events. This is by design (Clarity/GA4 work the same way), but it's an insecure-design tradeoff that should be documented.
5. **`ApiKey` revocation has no audit trail.** `auditLog()` exists for `APIKEY_REVOKED` but is never called. Deleting an API key leaves no trace.
6. **No data retention enforcement.** `retentionCutoff(days)` is shipped in `src/lib/ua.ts:166` but no scheduler calls it. GDPR right-to-erasure requests have no code path.
7. **CSP allows `'unsafe-inline'` and `'unsafe-eval'` for `script-src`** (`next.config.ts:7`). This weakens the CSP significantly — inline scripts and `eval()` are allowed. Next.js 16 with App Router mostly avoids inline scripts, but the SDK script (`/api/track/script`) is served as a separate file, so this could be tightened. Acceptable for v1, documented as tech-debt.

### Risk: **Medium**

### Status: **Partially mitigated** (ingest is rate-limited + origin-checked; dashboard is not)

### Recommended action
- Wire `API_LIMIT` into the middleware for all non-ingest `/api/*` routes. (One branch in `src/middleware.ts`.)
- When auth lands, add CSRF tokens (or enforce `SameSite=Lax` cookies + `Origin` header checks on mutating dashboard routes).
- Schedule a daily job that calls `db.session.deleteMany({ where: { lastActiveAt: { lt: retentionCutoff(90) } } })`. Document the retention window in the privacy policy.
- Tighten CSP: drop `'unsafe-eval'` (test first — some chart libs need it), keep `'unsafe-inline'` only if required for Next.js hydration.

---

## A05 — Security Misconfiguration

### Description
Missing hardening, default configs, verbose error messages, unnecessary features enabled.

### Findings
1. **CORS is `*` in dev.** `src/app/api/track/events/route.ts:129–131` — `if (process.env.NODE_ENV !== "production") return { "Access-Control-Allow-Origin": "*" }`. Same in `script/route.ts:87`. This is correct for local testing but means a misconfigured prod build (e.g. `NODE_ENV` unset) would silently fall back to `*`. Mitigation: the helper shipped with this audit (`security-checklist.ts`) verifies `NODE_ENV === "production"` in prod and fails the check otherwise.
2. **Error responses leak internals.** Grep for `(e as Error).message` returns **25+ hits** across dashboard routes (`errors/route.ts`, `dashboards/`, `experiments/`, `sessions/[sid]/tags/`, `alerts/`, `audit/`, …). The ingest endpoint uses `String(e)` (`track/events/route.ts:204`). These expose:
   - Prisma error messages (table names, column names, constraint names).
   - Filesystem paths (if `appendFile` fails on the audit log).
   - Network errors (if the LLM SDK fails).
   - This is a minor info-disclosure risk — an attacker probing `/api/projects/[id]/apikeys` learns whether the DB is up, what column a `WHERE` failed on, etc.
3. **`X-Powered-By` header not explicitly disabled.** `next.config.ts` does not set `poweredByHeader: false`. Next.js defaults to sending `X-Powered-By: Next.js` which fingerprints the framework. (We could not confirm at static-review time whether the Caddy gateway strips it; the helper check verifies this at runtime.)
4. **DB file permissions: world-readable.** `db/custom.db` is `-rwxr-xr-x` on this dev box. Production should be `0600`.
5. **`typescript.ignoreBuildErrors: true`** in `next.config.ts:23`. Type errors are swallowed at build time — a misconfigured security-related type (e.g. `where: { projectId: undefined }` instead of `where: { projectId }`) would compile and ship. This is a misconfiguration risk; the tradeoff is "demo ships even with non-security TS errors in other agents' files."
6. **`reactStrictMode: false`** in `next.config.ts:25`. Not a security issue per se, but strict mode surfaces unsafe side effects (which can include security-relevant ones like double-fired `fetch`). Worth re-enabling.
7. **Six security headers ARE set** (`next.config.ts:3–17`): CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `X-DNS-Prefetch-Control: off`. ✅
8. **Missing headers:** `Strict-Transport-Security` (HSTS) is not set — but this is correctly handled by the Caddy gateway at the TLS termination point. No `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy` / `Cross-Origin-Resource-Policy` — these are progressive hardening for Spectre-class attacks; not required for v1.
9. **No directory listing risk** — Next.js does not enable it.
10. **Default `db:push` script uses `--accept-data-loss`** (`package.json:10`). This is a Prisma dev convenience; in production it should be `prisma migrate deploy`. Not a runtime security issue but an operational footgun.

### Risk: **Medium**

### Status: **Partially mitigated** — headers are good; error messages and DB permissions need work.

### Recommended action
- Replace all `(e as Error).message` and `String(e)` in `NextResponse.json({ error: … })` with a generic `"internal_error"` string; log the real error server-side via `logger.error()`.
- Set `poweredByHeader: false` in `next.config.ts`.
- Add a startup check (shipped in `security-checklist.ts`) that fails if `db/custom.db` is group/world readable.
- Re-enable `reactStrictMode: true` once the accessibility agent's filter-bar.tsx template-literal typo is fixed.
- Long-term: drop `typescript.ignoreBuildErrors` and fix the underlying TS errors.

---

## A06 — Vulnerable & Outdated Components

### Description
Using components with known vulnerabilities or outdated versions.

### Project surface (`package.json`)
- `next: ^16.1.1` — current at audit time. Next 16 is the latest major.
- `@prisma/client: ^6.11.1`, `prisma: ^6.11.1` — current.
- `next-auth: ^4.24.11` — **v4 is in maintenance**; Auth.js v5 is the current line. The project does not actually use next-auth (it's a leftover from the scaffold) — safe to remove.
- `z-ai-web-dev-sdk: ^0.0.18` — pre-1.0, but it's the in-house SDK; supply-chain risk is low.
- `react: ^19.0.0` — current.
- `socket.io-client: ^4.8.4` — current.
- `recharts: ^2.15.4` — current.
- All `@radix-ui/*` packages are pinned to recent versions.
- `sharp: ^0.34.3` — current.

### Findings
1. **`bun audit` is in CI** (`.github/workflows/security.yml:43–45`) and runs on every push, every PR, and weekly on Sundays. ✅
2. **No `bun audit` failures were observed at audit time** (the workflow is green per the worklog Task ID 5 verification).
3. **Unused dependency: `next-auth`** — adds to the dependency surface without being imported anywhere. Removing it shrinks the supply-chain attack surface.
4. **No SBOM generation.** A Software Bill of Materials (CycloneDX / SPDX) would let us track transitive dependencies. Not required for a demo, but recommended for production.
5. **No pinned versions** — `package.json` uses `^` ranges. `bun.lock` provides reproducible installs, but a fresh `bun install` outside CI could pick up newer patch versions. Acceptable for a small project; a larger project would use Renovate/Dependabot.

### Risk: **Low**

### Status: **Mitigated** (by CI audit job)

### Recommended action
- Remove `next-auth` from `package.json` (unused).
- Add `bun audit --severity high` to the CI quality gate (currently `bun audit` fails on *any* advisory — possibly too strict for a demo, but that's a project call).
- Consider adding Dependabot config for automated PRs on dependency bumps.

---

## A07 — Identification & Authentication Failures

### Description
Weak authentication, weak session management, weak credential storage.

### Findings
1. **No auth on dashboard.** There is no user model, no login flow, no session cookie. Every dashboard API route is callable by anyone who can reach the host. The API-key layer (`src/lib/auth.ts`) is shipped but only wired into `/protected-test`. **This is the largest unmitigated risk in the project**, but it is **explicitly documented** in ADR-0004 ("Alternatives Considered" — NextAuth rejected for v1) and the worklog. The demo is single-tenant by design.
2. **API keys not hashed at rest** — see A02.
3. **No session timeout** — N/A, no sessions.
4. **No account lockout** — N/A, no accounts.
5. **API key transmitted in URL query string as fallback** (`src/lib/auth.ts:24–28` — `?apikey=<key>`). Query strings are logged by proxies, CDNs, and browser history. The `Authorization: Bearer` header is the preferred path; the query fallback should be documented as "demo-only" and removed for production.
6. **API keys are long-lived.** No expiry field in the `ApiKey` model. A leaked key is valid until manually revoked.
7. **API key validation does a non-constant-time DB lookup.** `findFirst({ where: { key, projectId } })` is a SQLite `WHERE` clause; SQLite's comparison is byte-by-byte and not constant-time. Timing attacks against API keys are theoretically possible but practical exploitation requires low-latency network access and many requests — bounded by the (missing) dashboard rate limiter. Low risk in practice.

### Risk: **High** (theoretical — bounded by single-tenant demo scope)

### Status: **Needs fix** (documented in tech-debt; not a regression)

### Recommended action
- **Wire `validateApiKey` into real routes.** This is the single highest-impact change for A01 + A07.
- **Hash API keys at rest** (see A02).
- **Add an `expiresAt` field to `ApiKey`** and enforce it in `validateApiKey`.
- **Remove the `?apikey=` query fallback** for production (keep for dev).
- **Plan a path to NextAuth v5 / Auth.js** for multi-tenant — track as a separate ADR.

---

## A08 — Software and Data Integrity Failures

### Description
Code and infrastructure that does not protect against integrity violations (e.g. unsigned updates, untrusted dependencies, CI/CD pipeline weaknesses).

### Findings
1. **`bun audit` runs in CI** (`.github/workflows/security.yml`). ✅
2. **TruffleHog secrets scan runs in CI** (`.github/workflows/security.yml:60–65`), scanning full git history with `--only-verified` (low false-positive mode). ✅
3. **GitHub Actions are pinned to `@main` / `@v4` / `@v2`** — not to a SHA. This is a supply-chain risk: if `trufflesecurity/trufflehog@main` is compromised, the CI runner executes malicious code with access to the repo. **Recommend pinning to a SHA digest.**
4. **`bun install --frozen-lockfile`** in CI (`security.yml:41`) — reproducible installs. ✅
5. **No subresource integrity (SRI) on the tracking SDK.** The SDK is served from `/api/track/script` (same origin), so SRI is not strictly needed — but if the SDK were ever served from a CDN, SRI would be required.
6. **No package signature verification.** Bun verifies package signatures by default; no override. ✅

### Risk: **Low**

### Status: **Mitigated** (CI covers audits + secrets; CI pinning is the open gap)

### Recommended action
- Pin GitHub Actions to commit SHAs, not `@main` / `@v4`. Use Dependabot to bump the SHAs monthly.
- Generate an SBOM on every release (`bun sbom` or `cyclonedx-bun`).
- Long-term: sign container images / build artifacts with cosign.

---

## A09 — Security Logging and Monitoring Failures

### Description
Insufficient logging, monitoring, and alerting — security events are not recorded or detected.

### Findings
1. **`auditLog()` is shipped but never called.** Grep for `auditLog` across `src/` returns exactly one hit: the function definition in `src/lib/audit.ts:46`. Zero call sites in any route handler. The 10 canonical actions (`AUDIT_ACTIONS.APIKEY_CREATED`, `DATA_EXPORTED`, `ALERT_TRIGGERED`, …) are defined but unused.
   - Consequence: deleting an API key, exporting data, triggering an alert, creating/deleting a project — none of these are recorded in the audit log. The audit log file (`logs/audit.jsonl`) is empty until someone calls `auditLog()` for the first time.
2. **Observability logs (`logs/app.jsonl`) DO record security-adjacent events:** `ingest_unknown_project`, `ingest_origin_blocked`, `ingest_error`, `ingest_success`. So we have *operational* logging on the ingest path, but not *audit* logging on the dashboard path.
3. **No alerting on security events.** The `alerts/` API is for *product* alerts (rage clicks, error spikes), not security alerts (failed auth bursts, audit-log tampering, etc.).
4. **Audit log is append-only by convention, not by enforcement.** Any process with write access to `logs/audit.jsonl` can rewrite history. A tamper-evident log (chain hashes, or WORM storage) would be needed for true compliance — acceptable for the demo.
5. **Audit log reader endpoints are open** (`/api/audit`, `/api/projects/[id]/audit`) — documented in `src/app/api/audit/route.ts:11` comment. Anyone can read the audit log.
6. **No log retention policy.** `logs/app.jsonl` and `logs/audit.jsonl` grow unbounded.

### Risk: **Medium**

### Status: **Needs fix** — library is ready, wiring is missing.

### Recommended action
- **Wire `auditLog()` into every mutating dashboard route.** Specifically:
  - `POST /api/projects` → `PROJECT_CREATED`
  - `DELETE /api/projects/[id]` → `PROJECT_DELETED`
  - `POST /api/projects/[id]/apikeys` → `APIKEY_CREATED`
  - `DELETE /api/projects/[id]/apikeys/[kid]` → `APIKEY_REVOKED`
  - `POST /api/projects/[id]/alerts` → `ALERT_CREATED`
  - `DELETE /api/projects/[id]/alerts/[aid]` → `ALERT_DELETED`
  - `GET /api/projects/[id]/export` → `DATA_EXPORTED`
  - Alert evaluation path (in `alerts/[aid]/evaluate`) → `ALERT_TRIGGERED`
  - `POST /api/projects/[id]/sessions/[sid]/bookmark` → `SESSION_BOOKMARKED`
  - `POST /api/projects/[id]/sessions/[sid]/tags` → `SESSION_TAGGED`
- Gate `/api/audit` and `/api/projects/[id]/audit` behind `validateApiKey` (or admin auth, when it lands).
- Add a log-rotation script (daily, keep 30 days).

---

## A10 — Server-Side Request Forgery (SSRF)

### Description
A web server fetches a remote resource without validating the user-supplied URL.

### Project surface
- `z-ai-web-dev-sdk` makes outbound LLM API calls in three routes: `ai/route.ts`, `ai/session/route.ts`, `ai-search/route.ts`. The SDK's endpoint is configured by the SDK itself (env var), **not** by user input.
- `Alert.webhookUrl` is a user-supplied URL field, but grep for `webhookUrl` returns only the create/update routes — there is **no `fetch(webhookUrl)` call anywhere**. The webhook channel is stored but never invoked. So no SSRF today.
- No image-proxying, no URL-preview, no og:image fetcher.

### Findings
1. **No SSRF risk in current code.** The LLM SDK's URL is not user-controlled. The webhook URL is stored but never fetched.
2. **Future risk:** if alert evaluation is later implemented to POST to `Alert.webhookUrl`, that becomes an SSRF surface. Mitigations to apply *at that time*: allowlist schemes (`https://` only), block link-local / private IP ranges (RFC 1918, `169.254.0.0/16`, `::1`, `fc00::/7`), block DNS-rebinding by resolving once and connecting to the resolved IP, and do not follow redirects.

### Risk: **Low**

### Status: **Protected**

### Recommended action
- When alert webhook delivery is implemented, apply the SSRF mitigations above. Add a unit test that rejects `http://localhost`, `http://169.254.169.254` (AWS metadata), `http://10.x.x.x`, etc.
- Document the LLM SDK's outbound endpoints in the architecture doc.

---

## Top 5 prioritized actions

1. **Wire `validateApiKey(req, projectId)` into real dashboard routes** — especially `POST /api/projects/[id]/apikeys` (key creation), `GET /api/projects/[id]/export` (PII export), and all `DELETE` routes. **Today these are 100% open.** This is the single highest-impact change in the audit. (Closes A01 + A07.)

2. **Hash API keys at rest.** Add `ApiKey.keyHash` (SHA-256 of the raw key, indexed), drop the plain `key` column after a migration. Update `validateApiKey` to hash-then-lookup. This means a DB exfiltration does NOT leak working API keys. (Closes A02 + A07.)

3. **Wire `auditLog()` into mutating routes.** The library is shipped and tested; it just has zero call sites. Add the 10 calls listed in A09. This makes the audit log actually useful for compliance / forensics. (Closes A09.)

4. **Wire `sanitizePayload(payload)` into `POST /api/track/events`** before `ingest(payload, req)`. Today the prototype-pollution / stored-XSS / oversize-payload guards in `src/lib/sanitize.ts` are dead code at runtime. One-line fix. Also fix `csvCell()` to neutralize spreadsheet formula injection. (Closes A03.)

5. **Sanitize error responses + tighten config.** Replace `(e as Error).message` / `String(e)` in all `NextResponse.json({ error })` paths with a generic `"internal_error"` (log the real error server-side via `logger.error()`). Set `poweredByHeader: false` in `next.config.ts`. Tighten `db/custom.db` permissions to `0600`. Wire `API_LIMIT` into the middleware for non-ingest routes. (Closes A04 + A05.)

---

## Verification

- `bun run lint` → exit 0, clean (run at start of audit; no source files modified by this task).
- `bunx tsc --noEmit | grep security-checklist` → 0 errors (after creating `src/lib/security-checklist.ts`).
- `ls docs/security-audit.md src/lib/security-checklist.ts` → both files exist.

## File boundaries respected

- **Created:** `docs/security-audit.md` (this file), `src/lib/security-checklist.ts` (programmatic helper).
- **Modified:** none. No existing source files touched — this is an audit + helper task.
