# Git Workflow — Insight Replay

This document is the source of truth for how code gets into `main` on Insight Replay.
It is read by every agent and contributor before opening a PR.

> **One-line summary**: trunk-based development, atomic conventional commits,
> small PRs (< 400 lines), CI must be green, squash-merge, tag releases with
> `vX.Y.Z`, update `CHANGELOG.md` in the same PR as the change.

---

## 1. Branching strategy — trunk-based

### `main` is always deployable

- `main` is protected. No direct pushes. Every change lands via a PR.
- Every commit on `main` must build (`bun run lint` exit 0, `bun test tests/`
  green, `next build` succeeds) and render in the browser without console
  errors. If `main` is red, fixing it is the team's top priority.
- Releases are cut from `main` by tagging (`git tag -a v1.0.0 -m "…"`).
  There is no `release/*` branch and no `develop` branch.

### Branch naming

| Branch prefix | When to use                              | Example                      |
|---------------|------------------------------------------|------------------------------|
| `feat/`       | New user-facing feature or capability    | `feat/retention-cohort-matrix` |
| `fix/`        | Bug fix (user-visible or test-only)      | `fix/missing-project-404`    |
| `chore/`      | Tooling, deps, config — no prod code     | `chore/bun-install-cache-ci` |
| `docs/`       | Markdown only                            | `docs/git-workflow`          |
| `refactor/`   | Behaviour-preserving code restructure    | `refactor/extract-live-helpers` |
| `test/`       | Test-only changes                        | `test/api-contracts-404s`    |
| `perf/`       | Performance change, no behaviour delta   | `perf/stats-cache-aside`     |
| `security/`   | Security hardening                       | `security/origin-allowlist`  |

Rules:

- Kebab-case, `< 50` chars, descriptive — `feat/add-stuff` is bad,
  `feat/retention-cohort-matrix` is good.
- One logical change per branch. If you're tempted to put two unrelated
  fixes on the same branch, split it.
- Delete the branch after merge. Squash-merge keeps `main` clean.

### Branch lifetime

- Short-lived: hours to a couple of days, not weeks.
- Rebase on `main` before opening the PR and again before merge if `main`
  has moved. The PR view should always show a clean, linear set of commits
  on top of the latest `main`.

---

## 2. Commit guidelines — atomic + conventional

### Atomic commits

- **One commit = one logical change.** A bug fix and a refactor belong in
  two commits even if they touch the same file.
- **Commit as a save point.** If you're mid-refactor and something breaks,
  `git bisect` should be able to pinpoint the bad commit in seconds. That
  only works if every commit builds.
- **Target < 100 lines per commit** (excluding tests + generated files).
  If a commit is approaching 400 lines, you're probably batching — split it.
- **Never commit broken code.** Each commit must pass `bun run lint` and
  `bun test tests/`. The CI workflow enforces this on every PR.

### Conventional Commit format

The repo ships a `.gitmessage` template. Wire it in once:

```bash
bash scripts/setup-git.sh
```

Every commit message follows [Conventional Commits 1.0.0](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`,
  `perf`, `security`, `ci`.
- **Scopes** (optional but encouraged): `api`, `ui`, `db`, `track`,
  `live`, `ai`, `security`, `observability`, `test`, `docs`, `ci`.
- **Subject**: imperative mood ("add", not "added"), lowercase first
  letter, no trailing period, ≤ 72 chars.
- **Body**: what + why (not how — the diff shows how). Wrap at 72 cols.
- **Footer**: `BREAKING CHANGE: <description>` for major bumps, `!` after
  the type/scope for the same signal (e.g. `feat(api)!: …`), issue/PR/ADR
  references (`Closes #123`, `Refs #456`, `See docs/adr/0007-*.md`).

Three worked examples live at the bottom of `.gitmessage`.

### What goes in the footer

| Footer                                | Meaning                                                       |
|---------------------------------------|---------------------------------------------------------------|
| `BREAKING CHANGE: <desc>`             | Major version bump; describe the migration.                   |
| `Closes #123`                         | Closes issue #123 on merge.                                   |
| `Refs #456`                           | References but does not close.                                |
| `See docs/adr/0007-*.md`              | Pointers to design context.                                   |
| `Co-authored-by: Name <email>`        | Attribution. Last line of the footer.                         |

---

## 3. Pull request process

### PR size

- **Target < 400 lines** (excluding generated files, lockfiles, snapshots).
- If you can't stay under 400, split the PR into a stack: open PR #1
  against `main`, then PR #2 against PR #1's branch, etc. Reviewers
  handle one stack-frame at a time.

### PR description template

Copy this into every PR (the `.github/pull_request_template.md` will
pre-fill it once added):

```markdown
## What
One-sentence summary of the change.

## Why
The problem this solves. Link the issue / ADR / Slack thread.

## How
2–5 bullets on the approach. Call out anything a reviewer should look at
extra carefully (concurrency, security, breaking changes).

## Verification
- [ ] `bun run lint` exit 0
- [ ] `bun test tests/` green
- [ ] `bunx tsc --noEmit` clean (or pre-existing errors unchanged)
- [ ] Dev server compiles, no console errors
- [ ] For UI: agent-browser snapshot attached / described
- [ ] For API: curl example + response shape
- [ ] `CHANGELOG.md` [Unreleased] section updated

## Risk
What could break. What's out of scope. What you considered but didn't do
(Chesterton's Fence).

## Linked
- Closes #
- Refs #
- See docs/adr/
```

### Required reviews

- **1 approving review** from a maintainer for PRs < 100 lines.
- **2 approving reviews** for PRs ≥ 100 lines or any PR touching
  `src/middleware.ts`, `src/lib/auth.ts`, `src/lib/sanitize.ts`,
  `prisma/schema.prisma`, `.github/workflows/`, or `src/app/api/track/**`.
- Self-merges are not allowed. The author never approves their own PR.

### CI must pass

The PR's CI run (`.github/workflows/ci.yml`) must be green before merge:

- **Lint** job: `bun run lint` exit 0.
- **Type-check** job: `bunx tsc --noEmit` clean.
- **Test** job: `bun test tests/` green. The `api-contracts.test.ts`
  file auto-skips when the dev server is unreachable, so CI passes
  without booting a server.
- **Build** job: runs only on `push` to `main` (skipped on PRs to keep
  feedback fast) — `bun run build` succeeds.

The **quality-gate** workflow (`.github/workflows/quality-gate.yml`) is
the merge gate: it blocks the merge button until lint + test are green.

Run the same checks locally before pushing:

```bash
bash scripts/check-quality.sh
```

---

## 4. Branch protection

`main` is protected with these rules (configured in GitHub repo settings
→ Branches → Branch protection rules):

| Rule                                        | Setting |
|---------------------------------------------|---------|
| Require a pull request before merging       | ✅      |
| Require approvals                           | ✅ (1 or 2 — see §3) |
| Require review from Code Owners             | ✅ (for `src/middleware.ts`, `src/lib/auth.ts`, `src/lib/sanitize.ts`, `prisma/schema.prisma`) |
| Dismiss stale pull request approvals on push | ✅     |
| Require status checks to pass before merge  | ✅      |
| Require branches to be up to date before merge | ✅   |
| Required status checks                      | `Lint`, `Type-check`, `Test`, `Quality gate` |
| Require conversation resolution on merge    | ✅      |
| Require linear history                      | ✅ (squash-merge only — see §6) |
| Do not allow bypassing the above            | ✅      |
| Force pushes                                | ❌ denied |
| Deletions                                   | ❌ denied |

No one — including admins — pushes directly to `main`. Hot-fixes go
through the same PR flow on a `fix/` branch; the only difference is they
get priority review.

---

## 5. Versioning — semantic

This project follows [Semantic Versioning 2.0.0](https://semver.org/):

| Bump    | When                                                                                  |
|---------|---------------------------------------------------------------------------------------|
| MAJOR   | Incompatible API or behaviour change (commit footer `BREAKING CHANGE:` or `!`).       |
| MINOR   | New feature, backward-compatible.                                                     |
| PATCH   | Bug fix, backward-compatible.                                                         |

- The version lives in `package.json` (`"version"` field) and in git tags.
- Releases are tagged as annotated tags: `git tag -a v1.0.0 -m "Release v1.0.0"`.
- Pre-1.0 (`0.x.y`): anything can change at any time; minor bumps may
  include breaking changes. This is documented in `CHANGELOG.md`.
- The first stable release is **v1.0.0**, cut when the API surface
  stabilizes after the standardized-envelope migration in
  `docs/api-style-guide.md`.

### Tagging a release

```bash
# 1. Make sure main is green + CHANGELOG is up to date.
git checkout main
git pull --rebase

# 2. Update package.json version.
#    (e.g. 0.6.0 → 1.0.0)
$EDITOR package.json

# 3. Promote [Unreleased] → [1.0.0] — YYYY-MM-DD in CHANGELOG.md,
#    add a fresh empty [Unreleased] block at the top.

# 4. Commit + tag + push.
git add package.json CHANGELOG.md
git commit -m "chore: release v1.0.0"
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin main --tags
```

GitHub Actions will pick up the tag and (once a publish workflow exists)
cut the release artifacts.

---

## 6. Changelog discipline — Keep a Changelog

`CHANGELOG.md` follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).

### Update the changelog in the same PR as the change

- The PR that introduces the change also adds the entry to the
  **[Unreleased]** section of `CHANGELOG.md`. No separate "changelog PR".
- Pick the right subsection: **Added · Changed · Deprecated · Removed · Fixed · Security**.
- One bullet per change — imperative mood, lowercase first letter, no
  trailing period. Link to issues / PRs / ADRs where relevant.
- If a change closes a security gap, use the **Security** subsection
  (not **Fixed**).

### On release

1. Rename the **[Unreleased]** section header → `[X.Y.Z] — YYYY-MM-DD`.
2. Add a fresh empty `[Unreleased]` block at the top.
3. Bump `package.json` version.
4. Commit + tag (see §5).

---

## 7. Rebasing + merge strategy

### Rebase feature branches on `main` before merge

```bash
git fetch origin
git rebase origin/main
# Resolve conflicts; rerere will replay recorded resolutions.
git push --force-with-lease
```

- Use `--force-with-lease`, never `--force`. `--force-with-lease` refuses
  to push if someone else has pushed to your branch in the meantime.
- After rebase, the PR's commit list should be a clean, linear stack on
  top of the latest `main`.

### Squash-merge

- PRs are **squash-merged**. The squash-merge commit's message is the PR's
  conventional-commit subject (the PR title); the body is the PR
  description. Reviewers should make sure the PR title is a valid
  conventional-commit subject before approving.
- Why squash-merge: every commit on `main` is one PR — easy to revert,
  easy to bisect, easy to attribute. The intermediate "WIP" commits on
  the feature branch never land on `main`.
- Exceptions: a PR that legitimately needs to preserve multiple commits
  (e.g. a refactoring series where each step is independently revertable)
  may be rebased-and-merged with explicit reviewer sign-off. Document
  the reason in the PR description.

### Conflict resolution

- Resolve on the feature branch, never on `main`.
- After resolving, re-run `bun run lint && bun test tests/` before
  pushing.
- `rerere.enabled = true` (set by `scripts/setup-git.sh`) replays
  recorded resolutions across rebases — fewer re-conflicts.

---

## 8. CI / CD — what runs where

The CI workflows live under [`.github/workflows/`](../.github/workflows):

| Workflow                | File                                  | Triggers on            | What it does                                                      |
|-------------------------|---------------------------------------|------------------------|-------------------------------------------------------------------|
| **CI**                  | `ci.yml`                              | push to `main`, PRs    | Lint + Type-check + Test jobs in parallel; Build on `main` only. |
| **Security**            | `security.yml`                        | push to `main`, PRs    | `bun audit` + secret scanning.                                   |
| **Quality gate**        | `quality-gate.yml`                    | PRs                    | Blocks the merge button until Lint + Test are green.             |

### Concurrency

- `ci.yml` cancels superseded runs on the same ref
  (`concurrency.cancel-in-progress: true`) — frees runners + keeps the
  PR signal clean.

### Local pre-flight

Before pushing, run the same checks locally:

```bash
bash scripts/check-quality.sh
```

This script runs `bun run lint`, `bunx tsc --noEmit`, and
`bun test tests/` in sequence and exits non-zero on the first failure.
Failing locally is faster than failing in CI.

---

## 9. Quick reference

```bash
# One-time setup (commits use the .gitmessage template from now on).
bash scripts/setup-git.sh

# Start a feature branch.
git checkout main
git pull --rebase
git checkout -b feat/retention-cohort-matrix

# Make atomic commits.
git add src/app/api/projects/[id]/retention/route.ts
git commit   # opens .gitmessage template
git add src/components/app/retention-tab.tsx
git commit

# Rebase on main before opening the PR.
git fetch origin
git rebase origin/main
git push -u origin feat/retention-cohort-matrix

# Open the PR. CI runs. Address review feedback with new commits.
# (Don't amend-and-force-push during review — it makes the conversation
#  hard to follow. Amend/squash happens at merge time.)

# Rebase again before merge if main has moved.
git rebase origin/main
git push --force-with-lease

# Squash-merge from the GitHub UI. Delete the branch.
```

### Commit message — minimal checklist

- [ ] `<type>(<scope>): <subject>` on line 1, imperative mood, ≤ 72 chars.
- [ ] Blank line, then body wrapped at 72 cols explaining what + why.
- [ ] Blank line, then footer (`BREAKING CHANGE:` / `Closes #` / `Refs #` / `See docs/adr/`).
- [ ] `bun run lint` + `bun test tests/` pass on this commit.

### PR — minimal checklist

- [ ] < 400 lines (excluding generated files).
- [ ] Description template filled in (`What / Why / How / Verification / Risk / Linked`).
- [ ] `CHANGELOG.md` [Unreleased] entry added.
- [ ] CI green (Lint + Type-check + Test + Quality gate).
- [ ] Required approvals present (1 for < 100 lines, 2 for ≥ 100 or sensitive paths).
- [ ] Rebased on latest `main`; squash-merge ready.
