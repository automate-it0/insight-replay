# Security Policy

This document defines the security policy for the **Insight Replay** project
(a session-replay, heatmap, and live-analytics tool — Microsoft Clarity clone).
It covers which versions receive security updates, how to report a
vulnerability privately, the response timeline you can expect, the scope of
issues we will triage, and the rules of disclosure during the fix window.

The project is currently released under the version banner
`0.7.0-SECURE-34L` (see `package.json`), reflecting the active security-
hardening track. Security is a first-class deliverable of this repository —
please report issues responsibly so they can be fixed before public exposure.

---

## 1. Supported Versions

We ship security fixes only for the versions listed below. Older releases are
out of support and will not receive back-ports — upgrade to a supported
release before reporting.

| Version | Supported          | Notes                                                       |
|---------|--------------------|-------------------------------------------------------------|
| 0.7.x   | :white_check_mark: | Current `0.7.0-SECURE-34L` line; receives all fixes.       |
| 0.6.x   | :x:                | End-of-life; upgrade to 0.7.x.                              |
| 0.5.x   | :x:                | End-of-life; upgrade to 0.7.x.                              |
| < 0.5   | :x:                | Never released publicly; not supported.                    |

> Pre-release, beta, and tagged `-rc.*` builds are **not** supported for
> production use and will not receive standalone security patches. Treat
> them as developer previews only.

---

## 2. Reporting a Vulnerability

**Do NOT open a public GitHub issue, PR, or discussion for a security
vulnerability.** Public reports make active exploitation trivial and force
an emergency patch path that is worse for everyone.

### How to report privately

Open a **Private Security Advisory** on the GitHub repository — this is the only supported private channel:

> **Report URL:** <https://github.com/automate-it0/insight-replay/security/advisories/new>
>
> **Maintainer GitHub handle:** `@automate-it0`

GitHub's private advisory feature keeps the report visible only to repository
maintainers until the fix is published, automatically tracks the disclosure
timeline, and lets the reporter request a CVE once the advisory is published.

Please include the following so we can reproduce and triage quickly:

1. **Title / summary** of the issue (one line).
2. **Affected version(s)** — at minimum the `package.json` `version` string
   and the commit SHA you tested against (`git rev-parse HEAD`).
3. **Component / file / route** where the issue lives
   (e.g. `src/app/api/track/events/route.ts`, `/api/projects/[id]/sessions`).
4. **Steps to reproduce** — a numbered list, plus the minimal HTTP request,
   payload, or SDK call that triggers it. Include environment details
   (`Node`/`bun` version, browser, OS) if relevant.
5. **Impact** — what an attacker gains (RCE, account takeover, data leak,
   DoS, cross-project data injection, etc.) and the privileges required.
6. **Suggested fix** (optional but welcome).

We will acknowledge receipt within **72 hours** (see §3).

### What not to do

- Do **not** open a GitHub Issue, PR, or Discussion describing the flaw.
- Do **not** post screenshots, payloads, or exploit code in any public
  channel (Issues, Discussions, Discord, social media, blog post).
- Do **not** attempt exploitation on production deployments — use a local
  instance (`bun dev` against a fresh SQLite DB) instead.
- Do **not** run automated scanners at high volume against hosted demo
  instances; that exhausts rate limits and harms other users.

---

## 3. Response SLA

Our target service-level agreement for security reports:

| Stage                       | Target        | Clock starts                  |
|-----------------------------|---------------|-------------------------------|
| Acknowledge receipt         | **72 hours**  | From the moment the GitHub private advisory is submitted. |
| Triage + severity rating   | 72 hours      | Same clock as acknowledgement; severity is assigned in the acknowledgement reply. |
| Patch / mitigation          | **90 hours**  | From the moment the report is acknowledged. |
| Public disclosure (if any) | After patch release + reporter sign-off, see §5. |

Severity bands (loosely aligned to CVSS v3.1):

- **Critical / High** — meets the 72h acknowledge / 90h patch targets above.
- **Medium** — 72h acknowledge, patch within 7 days.
- **Low / Informational** — 72h acknowledge, patch in the next regular release.

If we miss a target we will tell you *why* and give you a revised ETA — silence
on our end is itself a bug, and you are welcome to add a comment to the same
GitHub private advisory thread for an update.

---

## 4. Scope

### 4.1 In scope

The following are **in scope** for security reports:

- The Insight Replay application source tree at
  `/home/z/my-project/upload/insight-replay-extracted/`, specifically:
  - `src/app/api/**` (all HTTP routes — ingest, dashboard, admin, auth, audit,
    observability, security/health).
  - `src/middleware.ts` (request pipeline, CSRF, auth, rate-limit gate).
  - `src/lib/**` (auth, crypto, db-encryption, sanitize, sanitize-html,
    ssrf-guard, pow, csrf, session, project-auth, audit, rate-limit,
    ip-ban, login-lockout, file-integrity, retention, request-signer).
  - `prisma/schema.prisma` and any migration files (data-at-rest design,
    encrypted-column coverage, PII handling).
  - `mini-services/live-service/**` (Socket.io realtime service, port 3004).
  - `next.config.ts`, `Dockerfile`, `Caddyfile`, `.github/workflows/**`
    (build/deploy security posture).
- The tracking SDK as served from `/api/track/script` and embedded on
  third-party sites (XSS surface, origin/CORS handling, cookie/localstorage
  misuse, exfiltration of visitor data).
- Authentication & session handling: login/logout, session cookies,
  password hashing, lockout, IP-ban escalation, proof-of-work gate.
- Cryptography: envelope encryption (`v2:` field format), master KEK
  derivation, GCM nonce handling, key-zeroing, session secret resolution
  (`src/lib/startup.ts` + `src/lib/db-encryption.ts`).
- Input validation & output encoding: SQL/NoSQL injection, XSS in
  recording playback, SSRF in any outbound-fetch path, path traversal in
  `/api/download`, open redirect, CRLF injection.
- Rate limiting / abuse: ingest flooding, login brute-force, API-key
  brute-force, proof-of-work bypass.
- Secrets & configuration: leakage via error responses, log lines, source
  maps, or static assets (the `0.7.0-SECURE-34L` banner is intentional
  metadata — not a leak).

### 4.2 Out of scope

The following are **out of scope** and will be closed without a patch
(though we still appreciate a heads-up via private advisory):

- Vulnerabilities in third-party packages already tracked upstream —
  file those with the upstream maintainer and the relevant CNA. We will
  bump the dependency version once an upstream fix is published.
- Theoretical issues requiring the attacker to already be a fully
  authenticated admin on a self-hosted instance (i.e. issues that reduce
  to "an admin can do admin things").
- Findings from automated scanners (e.g. `npm audit`, Snyk, Trivy) that
  are unaccompanied by a working proof of concept against this codebase.
- Denial-of-service via sustained high-volume traffic against any public
  demo instance — that is an operational matter, not a code flaw.
- Self-XSS, clickjacking on pages that contain no sensitive UI, missing
  security headers with negligible real-world impact (we will still
  consider them as low-severity hardening, on a best-effort basis).
- Issues in `node_modules/`, `bun.lock`, `package-lock.json`, or any
  vendored copy of a third-party library.
- "Security feature requests" — proposals to add new defensive controls
  belong in the regular Issues / Discussions backlog, not the security
  mailbox.

### 4.3 Safe-harbor / good-faith reporting

We consider security research conducted in good faith and within the
boundaries above to be a contribution to the project. We will not pursue
legal action against reporters who:

- Avoid harming other users, accessing other people's data, or degrading
  service availability;
- Stop probing and report as soon as they have a reproducible finding;
- Honor the disclosure rules in §5.

---

## 5. Disclosure Policy

### 5.1 Coordinated disclosure

This project follows **coordinated disclosure** (sometimes called
"responsible disclosure"). Concretely:

1. The reporter reports privately per §2.
2. Maintainers and the reporter work together to triage, reproduce, and
   patch within the SLA in §3.
3. The fix is prepared on a non-public branch and landed together with a
   public advisory at release time — not before.
4. Public disclosure happens **after** the patched release is published
   **and** the reporter has signed off (or a 90-day deadline has elapsed,
   whichever comes first).

### 5.2 No private disclosure during the fix window

While a fix is being prepared (i.e. between acknowledgement and the public
advisory), all parties agree **not** to disclose any details of the
vulnerability — including the existence of the report, affected components,
or proof-of-concept code — through any public or semi-public channel
(GitHub Issues/PRs/Discussions, blog posts, conference talks, social
media, Discord/Slack, mailing lists, etc.).

This no-disclosure window exists so that:

- A proper patch can be written, reviewed, and released without a
  zero-day pressure cooker;
- Downstream operators get a chance to upgrade before exploit details are
  public;
- The reporter receives proper credit at disclosure time.

If a deadline helps you plan, the default coordinated-disclosure deadline
is **90 days from acknowledgement** (the same 90-day convention used by
common industry coordinated-disclosure guidelines). We can negotiate a
different date on a per-case basis — just say so in the report.

### 5.3 Public advisory

At disclosure time the maintainers will publish:

- A GitHub Security Advisory (GHSA) attached to this repository, with CVSS
  score, affected version range, patched version, and credit to the
  reporter (unless the reporter prefers to remain anonymous).
- A `CHANGELOG.md` entry describing the fix and linking to the advisory.
- A short note in the release notes / git tag message.

### 5.4 Exceptions

The only acceptable reason to break the no-disclosure window early is:

- The maintainers are unresponsive past the 90-hour patch SLA *and* the
  unresponsiveness continues for an additional 14 days past the
  patch-deadline, *and* the issue is being actively exploited in the wild.
  Even then, the reporter must give the maintainers a final 7-day written
  notice (as a comment on the same GitHub private advisory) before publishing.

Anything else is treated as a non-coordinated (adversarial) disclosure
and the project reserves the right to publish its own advisory early to
protect users, ahead of any externally imposed timeline.

---

## 6. Security Disclosure Policy (Recap)

To make the policy easy to reference:

- **Private reporting only** via the security mailbox in §2 — never via
  public GitHub channels.
- **72h acknowledgement / 90h patch** SLA per §3.
- **Coordinated disclosure** with a default 90-day post-acknowledgement
  deadline per §5.
- **No private-to-public disclosure during the fix window** per §5.2,
  subject only to the narrow §5.4 exception.
- **Good-faith researchers have safe harbor** per §4.3.

---

## 7. Contact

| Concern                          | Channel                                              |
|----------------------------------|------------------------------------------------------|
| Reporting a security vulnerability | [GitHub Private Security Advisory](https://github.com/automate-it0/insight-replay/security/advisories/new) (see §2) |
| General security questions       | Open a regular GitHub Discussion (non-sensitive only) |
| Non-security bugs / features     | Open a regular GitHub Issue or Pull Request           |
| Direct maintainer contact         | Mention `@automate-it0` in a GitHub Discussion (non-sensitive only) |

> **Maintainer note:** Ensure GitHub's *Private vulnerability reporting*
> feature is enabled under **Settings → Security & analysis → Private
> vulnerability reporting**. Reports submitted via this channel are visible
> only to repository administrators until the advisory is published.
