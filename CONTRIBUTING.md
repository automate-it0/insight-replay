# Contributing to Insight Replay

**Thank you** for contributing. Insight Replay is a self-hosted, Microsoft
Clarity-style session-replay + heatmap + live-analytics platform, and every
external contribution makes the demo richer and the surface harder. This
file is the entry-point guide for contributors — it tells you how to get
the project running locally, how to keep CI green, how to format commits
and PRs, and what the review bar is. It is deliberately opinionated so
you don't have to guess.

> **One-line summary**: trunk-based development, atomic Conventional Commits,
> PRs < 400 lines, CI must be green, squash-merge, tag releases with
> `vX.Y.Z`, update `CHANGELOG.md` in the same PR as the change.

This file is the **overview**. For canonical depth on any topic, follow
the inline links to `docs/git-workflow.md`, `docs/code-review.md`,
`docs/ci-cd.md`, `docs/architecture.md`, and the ADR series under
`docs/adr/`. If anything here contradicts a doc under `docs/`, the doc
wins — open a PR to fix this file.

## Table of contents

1. [Project context](#1-project-context)
2. [Dev environment prerequisites](#2-dev-environment-prerequisites)
3. [Dev setup — clone to running app](#3-dev-setup--clone-to-running-app)
4. [Repository layout](#4-repository-layout)
5. [Testing](#5-testing)
6. [Quality gate — `scripts/check-quality.sh`](#6-quality-gate--scriptscheck-qualitysh)
7. [Commit format — Conventional Commits + `.gitmessage`](#7-commit-format--conventional-commits--gitmessage)
8. [Branching strategy — trunk-based](#8-branching-strategy--trunk-based)
9. [Pull request process](#9-pull-request-process)
10. [Branch protection policy](#10-branch-protection-policy)
11. [Code-review expectations](#11-code-review-expectations)
12. [ADR discipline](#12-adr-discipline)
13. [CHANGELOG discipline](#13-changelog-discipline)
14. [Getting help](#14-getting-help)
15. [Quick reference cheat sheet](#15-quick-reference-cheat-sheet)

---

## 1. Project context

Insight Replay is **self-hosted**: a single Next.js standalone server
bundle behind a Caddy gateway. No managed services, no Docker compose
required to start the demo.

- **Stack**: Next.js 16 (App Router) + TypeScript + Prisma + SQLite + Tailwind + shadcn/ui + Recharts + Socket.io.
- **Tracking**: standalone SDK at `/api/track/script.js`, ingest at `/api/track/events`.
- **Realtime**: socket.io mini-service on port 3004 (`mini-services/live-service`).
- **AI**: `z-ai-web-dev-sdk` for insights, session analysis, NL search.
- **Dashboard**: 15 tabs — Overview, Dashboards, Recordings, Heatmaps, Live, Funnels, Journeys, Experiments, Visitors, Retention, Goals, Alerts, Insights, Errors, Settings.
- **Security layers**: API key auth, rate limiting, CORS+origin validation, IP anonymization, audit logging, security headers, input sanitization.
- **Engines**: `node >= 20.0.0`, `bun >= 1.3.0` (see `package.json#engines`).

For the full architecture map see [`docs/architecture.md`](./docs/architecture.md).

---

## 2. Dev environment prerequisites

- **Bun** `>= 1.3.0` — package manager + test runner + script runner. Install from <https://bun.sh>; CI pins `1.1.0`.
- **Node** `>= 20.0.0` — required by the Next.js 16 build.
- **Git** `>= 2.30` — for `rerere`, `--force-with-lease`, and conventional-commit hooks.
- **Editor** — VS Code + the official ESLint plugin is the path of least resistance (`eslint.config.mjs` is the source of truth).

Optional: **Caddy v2** (only for the production-style gateway on `:81` —
the dev server runs fine on `:3000` without it); **GitHub CLI (`gh`)**
for opening PRs from the terminal. Verify with `bun --version && node
--version && git --version`.

---

## 3. Dev setup — clone to running app

The canonical path from `git clone` to a working dashboard on
`http://localhost:3000`. Five steps, in order. Each step explains *why*,
not just *what*.

### 3.1 Clone

```bash
git clone https://github.com/<your-fork-or-org>/insight-replay.git
cd insight-replay
# External contributors: fork first, then add upstream:
git remote add upstream https://github.com/<upstream-org>/insight-replay.git
```

### 3.2 Install dependencies — `bun install`

```bash
bun install
```

Reads `bun.lock` and installs the exact transitive graph the team is on.
**Don't** run `bun install --no-save` or delete `bun.lock` — lockfile
drift is the #1 "works on my machine" cause. If `bun install` wants
to rewrite `bun.lock`, that belongs in its own `chore(deps):` PR.

### 3.3 Copy env file — `cp .env.example .env`

```bash
cp .env.example .env
```

`.env.example` is the canonical list of every env var the app expects.
The most important is `DATABASE_URL` (Prisma reads it via
`env("DATABASE_URL")` in `prisma/schema.prisma`); the example defaults
to `file:./db/custom.db` so the SQLite DB lands in the `.gitignore`'d
`db/` directory. Edit `.env` only to point at a non-default DB path or
rotate a local key. **Never commit `.env`** — it's git-ignored by policy
and `.github/workflows/security.yml` will fail the PR if a secret is
detected in code.

### 3.4 Generate Prisma client + push schema — `db:generate && db:push`

```bash
bun run db:generate    # regenerates @prisma/client into node_modules/.prisma/client
bun run db:push        # applies prisma/schema.prisma to the SQLite file (creates it on first run)
```

`db:generate` produces the type-safe client that `src/lib/db.ts`
imports; without it, the dev server throws `@prisma/client did not
initialize yet` on first request. Re-run it whenever you change
`prisma/schema.prisma` — `--hot` doesn't pick up schema changes.

Nuke-and-rebuild the local DB:

```bash
rm -f db/custom.db && bun run db:push && bun run dev
# Then visit http://localhost:3000/api/seed to seed demo data.
```

### 3.5 Start the dev server — `bun run dev`

```bash
bun run dev    # next dev -p 3000 (output piped to dev.log via tee)
```

App is live at `http://localhost:3000`. The live socket.io service on
`:3004` is **optional** — the Live tab degrades gracefully when
unreachable. To start it (only for Live-tab work):
`cd mini-services/live-service && bun install && bun run dev` (port 3004).

### 3.6 One-time git config + verify

```bash
bash scripts/setup-git.sh     # wires .gitmessage + pull.rebase + rerere; repo-local only; idempotent
bun run lint                 # exit 0, no output
bun test tests/              # prints "138 pass | 1 skip" (current baseline)
./scripts/check-quality.sh    # prints "PASS — all checks green"
```

If all three pass, you're ready to open a PR. If any one fails, see
[§6](#6-quality-gate--scriptscheck-qualitysh) for triage.

---

## 4. Repository layout

```
.
├── src/
│   ├── app/                 # Next.js App Router — pages + API routes (api/, page.tsx, layout.tsx)
│   ├── components/{app,ui}/  # domain components + shadcn/ui primitives
│   ├── lib/                 # cross-cutting libs (auth, db, sanitize, …)
│   ├── hooks/  store/
├── prisma/schema.prisma     # single source of truth for the data model
├── tests/                   # unit + contract + security + browser tests
├── docs/                    # long-form docs (adr/, git-workflow, ci-cd, …)
├── scripts/                 # check-quality.sh, setup-git.sh, generate-secret.sh, …
├── mini-services/live-service/  # socket.io service (port 3004)
├── .github/{workflows,ISSUE_TEMPLATE,PULL_REQUEST_TEMPLATE.md}
├── .gitmessage .env.example CHANGELOG.md package.json
```

---

## 5. Testing

Tests live under `tests/`. Bun's built-in runner is the only runner — no
Jest, no Vitest, no Mocha. The current baseline is **138 pass + 1 skip**.

- `tests/ua.test.ts` — UA parsing + geo lookup.
- `tests/sanitize.test.ts` / `tests/sanitize-html.test.ts` — input + strict-HTML sanitization.
- `tests/rate-limit.test.ts` — sliding-window rate limiter.
- `tests/csrf.test.ts` — CSRF token issue + verify.
- `tests/observability.test.ts` — structured logger + request IDs.
- `tests/session-fp.test.ts` — session + device fingerprint.
- `tests/api-contracts.test.ts` — 9 contract tests against live `/api/**`; **auto-skips** when the dev server is unreachable so CI stays green without booting `bun run dev`.
- `tests/security/*.test.ts` — 6 security files: SSRF, sanitization, rate-limit, info-leak, fuzz, auth.
- `tests/browser/*.spec.sh` — 5 browser smoke specs, run via `tests/browser/run-all.sh`.

### Running tests + coverage

```bash
bun test tests/                                  # full suite (what CI runs)
bun test tests/ua.test.ts                        # single file
bun test tests/ua.test.ts -t "Chrome on macOS"   # single test by name substring
bun test tests/security/                         # security suite only
bun run dev & bash tests/browser/run-all.sh      # browser specs (needs dev server on :3000)
bunx c8 --reporter=text --reporter=lcov bun test tests/   # coverage → lcov.info (no threshold gate)
```

The repo does **not** gate on a coverage threshold — `bun test tests/`
green is the bar. As a rule, any change to `src/lib/**` should land with
a test in `tests/**` exercising the new branch.

### Writing tests

- Match the existing style: `test()` blocks grouped under `describe()`, `expect(actual).toEqual(expected)` assertions, `beforeEach` for shared setup. See `tests/ua.test.ts` for the canonical pattern.
- For API-shape changes, add a contract test to `tests/api-contracts.test.ts` — the existing tests show the pattern: `fetch` against the dev server, assert on the response envelope, guard with `if (serverUnreachable) test.skip()`.
- For security-sensitive changes, add a test under `tests/security/<topic>.test.ts` and follow `tests/security/helpers.ts`.
- Tests are **fast** — the whole suite runs in < 5 s on a warm machine. If your test takes > 1 s, mock the DB or shrink the fixture.

---

## 6. Quality gate — `scripts/check-quality.sh`

This is the local pre-push gate. **Run it before every push.** It mirrors
what `.github/workflows/ci.yml` runs in CI — failing here is faster than
failing in PR review.

```bash
./scripts/check-quality.sh   # exit 0 = all hard checks pass; 1 = a hard check failed
```

Three sections run in sequence, then a summary prints. Lint + Tests are
**hard** (non-zero exit blocks the push); Type-check is **soft** (warns
but does NOT block — the project has `typescript.ignoreBuildErrors: true`
in `next.config.ts` and a small set of pre-existing TS errors being paid
down; new errors are a review issue, not a build issue).

`api-contracts.test.ts` auto-skips when the dev server is unreachable, so
this script works whether or not `bun run dev` is running.

### Triage

- **Lint failures** — usually `no-unused-vars`, `react-hooks/exhaustive-deps`, or import-order. Run `bun run lint --fix` for the auto-fixable subset. **Never** disable a rule with `eslint-disable` to make lint pass — bring it up in the PR instead.
- **Type-check warnings** — review them. New errors must be fixed before pushing (reviewers will catch them anyway). Pre-existing errors can be ignored as long as the count didn't go up.
- **Test failures** — read the message. If a test is failing because of an intentional behaviour change in your PR, update the test in the same commit. If it's failing for a reason you don't understand, STOP —
  open an issue with the failing output and ask before changing product behaviour.

---

## 7. Commit format — Conventional Commits + `.gitmessage`

Every commit message follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/).
The repo ships a [`.gitmessage`](./.gitmessage) template; once you've run
`bash scripts/setup-git.sh` ([§3.6](#36-one-time-git-config--verify)),
`git commit` opens your editor pre-loaded with it. The full type list,
scope list, and three worked examples are all in `.gitmessage` — read it
once, refer back as needed.

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types (lowercase, exactly one)

- `feat` — new user-facing feature. · `fix` — bug fix (user-visible or test-only).
- `perf` — code change that improves performance. · `refactor` — code change that neither fixes a bug nor adds a feature.
- `style` — formatting, whitespace, semicolons — no production code change.
- `test` — adding or correcting tests. · `docs` — documentation only.
- `chore` — build, deps, config, tooling — no production code change.
- `ci` — changes to CI pipelines / workflows. · `security` — hardening that closes a security gap (use when `fix(security)` is too vague).

### Scopes (optional but encouraged — pick the most affected area)

`api` · `ui` · `db` · `track` · `live` · `ai` · `security` ·
`observability` · `test` · `docs` · `ci`. (Full rationale in `.gitmessage`.)

### Subject · Body · Footer rules

- **Subject**: imperative mood ("add", not "added"), lowercase first letter, no trailing period, ≤ 72 chars, **what** changed (not **why**).
- **Body**: wrap at 72 cols, explain **what** + **why** (not **how** — the diff shows how), blank line before and after.
- **Footer**: `BREAKING CHANGE: <description>` → bumps MAJOR; `!` after type/scope is the same signal (e.g. `feat(api)!: drop v1 envelope`); references `Closes #123` / `Refs #456` / `See docs/adr/0007-*.md`; `Co-authored-by: Name <email>` trailers go at the very bottom.

### Atomic-commit discipline

- **One commit = one logical change.** A bug fix and a refactor belong in two commits even if they touch the same file.
- **Commit as a save point.** Each commit must pass `bun run lint` and `bun test tests/`. If you're mid-refactor and something breaks, `git bisect` should pinpoint the bad commit in seconds — that only works if every commit builds.
- **Target < 100 lines per commit** (excluding tests + generated files). Approaching 400? You're batching — split it.

Three full worked examples live at the bottom of [`.gitmessage`](./.gitmessage).

---

## 8. Branching strategy — trunk-based

This project uses **trunk-based development**. No `develop` branch,
no `release/*` branch. `main` is the only long-lived branch and it is
always deployable.

### Branch naming

- `feat/<short-kebab-name>` — new user-facing feature (e.g. `feat/retention-cohort-matrix`).
- `fix/` — bug fix (e.g. `fix/missing-project-404`).
- `chore/` — tooling, deps, config — no prod code (e.g. `chore/bun-install-cache-ci`).
- `docs/` — markdown only. · `refactor/` — behaviour-preserving restructure (e.g. `refactor/extract-live-helpers`).
- `test/` — test-only changes (e.g. `test/api-contracts-404s`). · `perf/` — perf change, no behaviour delta (e.g. `perf/stats-cache-aside`).
- `security/` — security hardening (e.g. `security/origin-allowlist`).

Rules: kebab-case, `< 50` chars, descriptive. `feat/add-stuff` is bad;
`feat/retention-cohort-matrix` is good. One logical change per branch.

### Lifetime

Short-lived: hours to a couple of days, not weeks. Rebase on `main` before
opening the PR and again before merge if `main` has moved — the PR view
should always show a clean, linear set of commits on top of the latest
`main`. Use `--force-with-lease`, **never** `--force` (the former refuses
to push if someone else has pushed to your branch in the meantime). For
the canonical session (clone, branch, commit, rebase, push, open PR,
rebase again, squash-merge), see [§15](#15-quick-reference-cheat-sheet).

---

## 9. Pull request process

### 9.1 PR size

Target **< 400 lines** (excluding generated files, lockfiles, snapshots).
If you can't stay under 400, split the PR into a stack: open PR #1
against `main`, then PR #2 against PR #1's branch, etc. Reviewers handle
one stack-frame at a time.

### 9.2 PR description

[`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md)
auto-fills the PR body when you open a PR from the GitHub UI. Fill in
**Summary**, **Type of change**, **Checklist**, **Risk**, **Testing**,
**Screenshots/Recordings** (if UI), **Rollback**, and **Related issues /
ADRs**. Delete sections that don't apply rather than leaving them blank.

### 9.3 The 9-item PR-readiness checklist

Before you request review, all 9 of these boxes must be checked. They map
1-to-1 with the checklist in
[`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md):

- [ ] **Lint passes** — `bun run lint` exits 0 locally.
- [ ] **Type-check passes** — `bunx tsc --noEmit` reviewed (warn-only is acceptable; new errors are not).
- [ ] **Tests added or updated** for the change — unit tests under `tests/`, contract tests under `tests/api-contracts.test.ts` if API shapes changed.
- [ ] **All tests pass** — `bun test tests/` green (138 pass + 1 skip is the current baseline; if the count moved, call it out in the PR description).
- [ ] **Local quality gate green** — `./scripts/check-quality.sh` exits 0.
- [ ] **Manual verification done** — dev server renders, core flow exercised, no console errors.
- [ ] **No `console.log` left in production source** (`src/`, `mini-services/`) — use the structured logger in `src/lib/observability.ts`.
- [ ] **Docs updated** if this changes API contracts, architecture, or ADRs (see `docs/`).
- [ ] **No secrets committed** — API keys, tokens, or credentials are in env vars, not code.

Two **conditional** items (also from the PR template) apply when relevant:

- [ ] **BREAKING CHANGE footer documented** (if applicable) — Conventional Commits footer with `BREAKING CHANGE:` summary + migration notes in the PR description.
- [ ] **`CHANGELOG.md` `[Unreleased]` entry added** (if user-facing) — under `## [Unreleased]`, following Keep a Changelog format (see [§13](#13-changelog-discipline)).

### 9.4 Required reviews

- **1 approving review** from a maintainer for PRs < 100 lines.
- **2 approving reviews** for PRs ≥ 100 lines or any PR touching `src/middleware.ts`, `src/lib/auth.ts`, `src/lib/sanitize.ts`, `prisma/schema.prisma`, `.github/workflows/`, or `src/app/api/track/**`.
- Self-merges are not allowed. The author never approves their own PR.

### 9.5 CI must pass

The PR's CI run (`.github/workflows/ci.yml`) must be green before merge:

- **Lint** job — `bun run lint` exit 0.
- **Type-check** job — `bunx tsc --noEmit` clean.
- **Test** job — `bun test tests/` green.
- **Build** job — runs only on `push` to `main` (skipped on PRs for fast feedback) — `bun run build` succeeds.

The **quality-gate** workflow (`.github/workflows/quality-gate.yml`) is
the merge gate (blocks merge until lint + test green). The **security**
workflow (`security.yml`) runs `bun audit` + TruffleHog secret scanning;
either failing blocks merge.

### 9.6 Squash-merge

PRs are **squash-merged**. The squash-merge commit's message is the
PR's Conventional-Commit subject (the PR title); the body is the PR
description. Reviewers should make sure the PR title is a valid
Conventional-Commit subject before approving. Why squash-merge: every
commit on `main` is one PR — easy to revert, easy to bisect, easy to
attribute. Exception: a PR that legitimately needs to preserve multiple
commits (e.g. a refactoring series where each step is independently
revertable) may be rebased-and-merged with explicit reviewer sign-off —
document the reason in the PR description.

### 9.7 During review

- Address review feedback with **new commits** on the same branch (don't amend-and-force-push during review — it makes the conversation hard to follow; squash happens at merge time).
- Push new commits and re-request review when the previous round is resolved; don't `@-mention` reviewers for every tiny push — wait for a coherent batch.
- If a reviewer asks for something you disagree with, **push back in the PR**. Honest technical disagreement beats false agreement.

---

## 10. Branch protection policy

`main` is protected (GitHub repo settings → Branches → Branch protection
rules). No one — including admins — pushes directly to `main`; hot-fixes
go through the same PR flow on a `fix/` branch with priority review.

| Rule                                                | Setting |
|-----------------------------------------------------|---------|
| Require a pull request before merging               | ✅ |
| Require approvals                                  | ✅ (1 or 2 — see [§9.4](#94-required-reviews)) |
| Require review from Code Owners                     | ✅ (for `src/middleware.ts`, `src/lib/auth.ts`, `src/lib/sanitize.ts`, `prisma/schema.prisma`) |
| Dismiss stale pull request approvals on push        | ✅ |
| Require status checks to pass + up-to-date before merge | ✅ (`Lint`, `Type-check`, `Test`, `Quality gate`) |
| Require conversation resolution on merge            | ✅ |
| Require linear history                              | ✅ (squash-merge only — see [§9.6](#96-squash-merge)) |
| Do not allow bypassing the above                     | ✅ |
| Force pushes + Deletions                             | ❌ denied |

---

## 11. Code-review expectations

The full review process lives in [`docs/code-review.md`](./docs/code-review.md).
The short version: every review goes through **five axes** — correctness,
security, performance, maintainability, tests.

### Reviewer hat

- **Read the diff before reading the description.** The description tells you what the author *intended*; the diff tells you what they *did*. Both matter, but they're not the same thing.
- **Cite the axis.** "this O(N²) loop is a perf issue" (axis: performance) is more actionable than "this is bad". The five-axis frame keeps review from devolving into taste arguments.
- **Severity labels** — `Blocker` (must fix before merge), `Important` (should fix), `Nit` (optional), `FYI` (informational). Use them; they save the author a round-trip.
- **Verify, don't assume.** If a comment claims "this won't compile" or "this test fails", check it locally first. Wrong review feedback erodes trust faster than missed bugs. If the author disagrees, hear them out — update the thread with what you learned; don't just restate the original position.

### Author hat

- **Read every comment.** Even the `Nit`s — they're signals about readability, even if you don't address them in this PR.
- **Reply before pushing.** A `Done` or `Fixed in <sha>` reply per thread is the minimum; a one-line explanation of *why* you pushed back is better. Silent resolutions leave reviewers guessing. Comments are about the code, not you.
- **The PR is not done until `main` is green.** A merge that breaks CI is your responsibility — rebased-on-`main`, hot-fixed, or reverted. "It passed on the PR" is not a defence if `main` is red.

### Response SLAs

| Reviewer state                          | Expected response |
|-----------------------------------------|-------------------|
| First-pass review requested              | 1 business day    |
| Follow-up review after author response  | 1 business day    |
| Hot-fix `fix/` branch review            | 2 hours           |

If you can't meet an SLA, leave a comment saying when you'll get to it.
Silence is the worst option.

---

## 12. ADR discipline

Architectural decisions that are hard to reverse — choice of database,
choice of realtime transport, choice of authentication scheme — belong
in an Architecture Decision Record (ADR). Six already exist under
[`docs/adr/`](./docs/adr): `0001` (Prisma+SQLite), `0002` (socket.io
mini-service), `0003` (LLM-powered AI features), `0004` (security-
hardening layers), `0005` (in-memory cache for stats), `0006` (unified
engineering workflow).

### When to write an ADR

Write one when **any** of these are true:

- The decision is **expensive to reverse** (changing it later would touch more than one subsystem).
- The decision has **more than one reasonable option** and you're picking one over another (e.g. SQLite vs Postgres).
- The decision creates a **new convention** future contributors are expected to follow (e.g. ADR-0006 establishes the engineering workflow), OR a reviewer asks "why this way?" and the answer is longer than a paragraph.

You **don't** need an ADR for: bug fixes, feature additions, refactors,
dependency bumps, lint rule tweaks. If in doubt, ask in the PR.

### How to write one

Numbering is **monotonic** — the next ADR is `0007-…`. Filename format:
`NNNN-kebab-case-title.md`. Copy the structure of an existing ADR (e.g.
`0005-in-memory-cache-for-stats.md`) — `# ADR-NNNN: <Title>` / `##
Status` (Accepted (YYYY-MM-DD) | Superseded by ADR-MMMM | Deprecated) /
`## Context` (issue, forces, alternatives, trade-offs) / `## Decision`
(option chosen, named precisely) / `## Consequences` (Positive /
Negative / Neutral) / `## References` (`Closes #issue` / `See
docs/adr/NNNN-*.md` / etc.).

### Superseding an ADR

ADRs are **never edited in place** once Status moves past `Accepted`.
To reverse or replace:

1. Write a new ADR (`0008-…`) that explains the new decision and explicitly references the old one.
2. Update the **Status** line of the old ADR to `Superseded by ADR-0008 (YYYY-MM-DD)`. Do **not** touch the rest of the file — the historical reasoning must remain readable.
3. Add a one-line entry to `## [Unreleased]` in `CHANGELOG.md` under the **Changed** subsection: "Superseded ADR-NNNN with ADR-MMMM — <reason>".

### ADRs in PRs

The PR that introduces an architectural change is the same PR that adds
the ADR — committed under `docs/adr/` in the same commit as the code
that implements the decision. The PR description's **Related issues /
ADRs** section must reference the ADR (e.g. "Implements ADR-0007"),
matching the conventional-commit footer `See docs/adr/0007-*.md`.

---

## 13. CHANGELOG discipline

`CHANGELOG.md` follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
The PR that introduces the change also adds the entry to the
`## [Unreleased]` section — there is no separate "changelog PR". Pick the
right subsection: **Added · Changed · Deprecated · Removed · Fixed ·
Security**. One bullet per change — imperative mood, lowercase first
letter, no trailing period. If a change closes a security gap, use the
**Security** subsection (not **Fixed**).

On release: (1) rename `## [Unreleased]` → `## [X.Y.Z] — YYYY-MM-DD`;
(2) add a fresh empty `## [Unreleased]` block at the top; (3) bump
`package.json` `"version"`; (4) commit (`chore: release vX.Y.Z`) +
tag (`git tag -a vX.Y.Z -m "Release vX.Y.Z"`) + push; (5) the release
workflow (`.github/workflows/release.yml`) picks up the tag and creates
the GitHub Release with the matching CHANGELOG section as the body. See
[`docs/git-workflow.md`](./docs/git-workflow.md) §5–6 for the full
versioning + changelog policy.

---

## 14. Getting help

- **[`docs/`](./docs)** — the full doc index. Start at [`docs/README.md`](./docs/README.md).
- **[`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE)** — `bug_report.md` and `feature_request.md`. Use them when opening issues.
- **GitHub Discussions** — for design questions that don't belong in an issue yet.

If you find a doc that's wrong, the fix is a PR — commit type `docs:`.

---

## 15. Quick reference cheat sheet

```bash
# --- One-time setup -------------------------------------------------------
git clone <repo> && cd insight-replay
bun install
cp .env.example .env
bun run db:generate
bun run db:push
bash scripts/setup-git.sh

# --- Day-to-day ----------------------------------------------------------
bun run dev                  # http://localhost:3000
bun test tests/              # full suite (138 pass + 1 skip baseline)
bun test tests/ua.test.ts    # single file
./scripts/check-quality.sh   # pre-push gate (lint + tsc + tests)

# --- Branching -----------------------------------------------------------
git checkout main && git pull --rebase
git checkout -b feat/<short-kebab-name>
# ... edit, atomic commits (template auto-opens) ...
git fetch origin && git rebase origin/main
git push -u origin feat/<short-kebab-name>
# open PR on GitHub; CI runs; address review with new commits

# --- Before merge --------------------------------------------------------
git rebase origin/main
git push --force-with-lease      # NEVER --force
# squash-merge from GitHub UI; delete the branch
```

### Commit message — minimal checklist

- [ ] `<type>(<scope>): <subject>` on line 1, imperative mood, ≤ 72 chars.
- [ ] Blank line, then body wrapped at 72 cols explaining what + why.
- [ ] Blank line, then footer (`BREAKING CHANGE:` / `Closes #` / `Refs #` / `See docs/adr/`).
- [ ] `bun run lint` + `bun test tests/` pass on this commit.

### PR — minimal checklist

- [ ] < 400 lines (excluding generated files).
- [ ] [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md) filled in (Summary / Type of change / Checklist / Risk / Testing / Rollback / Related issues).
- [ ] All 9 items in [§9.3](#93-the-9-item-pr-readiness-checklist) checked.
- [ ] `CHANGELOG.md` `[Unreleased]` entry added (if user-facing).
- [ ] ADR added or updated (if architectural — see [§12](#12-adr-discipline)).
- [ ] CI green (Lint + Type-check + Test + Quality gate).
- [ ] Required approvals present (1 for < 100 lines, 2 for ≥ 100 or sensitive paths — see [§9.4](#94-required-reviews)).
- [ ] Rebased on latest `main`; squash-merge ready.

---

*This document is the contribution overview. For canonical depth on any
topic, follow the inline links to `docs/git-workflow.md`,
`docs/code-review.md`, `docs/ci-cd.md`, `docs/architecture.md`, and the
ADR series under `docs/adr/`. If anything here contradicts a doc under
`docs/`, the doc wins — open a PR to fix this file.*
