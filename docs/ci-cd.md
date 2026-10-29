# CI/CD

Continuous integration for **Insight Replay**. Three GitHub Actions workflows
keep the main branch green and a local script lets you run the same checks
before pushing.

> Scope note: this is **CI + quality gates only**. There is no CD/deploy step —
> Insight Replay ships as a self-hosted Next.js app, not a managed service.
> See the "Future improvements" section for the deferred deploy story.

---

## Pipeline overview

```
push / PR to main
        │
        ├──► ci.yml ────────────────────────────────┐
        │     ├─ Lint        (ESLint)               │
        │     ├─ Type-check  (tsc --noEmit)         │  all 4 run in
        │     ├─ Test        (bun test tests/)      │  parallel; build
        │     └─ Build       (next build)  ◄── only │  gated on lint+test
        │                                  on push  │  for `main` pushes
        │                                  to main  │
        │                                            │
        ├──► security.yml ──────────────────────────┤
        │     ├─ Audit deps  (bun audit)            │
        │     └─ Secrets scan (TruffleHog)          │
        │                                            │
        └──► quality-gate.yml ◄── runs AFTER ci.yml │
              ├─ Verify ci.yml succeeded            │
              └─ Grep for console.log in src/       ◄── the actual merge gate
```

### 1. `.github/workflows/ci.yml` — Main CI

Runs on every push to `main` and every PR targeting `main`. Four jobs:

| Job          | Command                  | When                          | Blocking? |
|--------------|--------------------------|-------------------------------|-----------|
| `lint`       | `bun run lint`           | always                        | yes       |
| `type-check` | `bunx tsc --noEmit`      | always                        | yes       |
| `test`       | `bun test tests/`        | always                        | yes       |
| `build`      | `bun run build`          | only on push to `main`        | yes (post-merge) |

Design notes:

- **Parallel by default.** Lint, type-check, and test run as independent jobs
  so a slow `tsc` doesn't gate the fast lint feedback. Build is the only one
  that waits — it `needs: [lint, test]` and only runs on `main` pushes, since
  PRs don't need a full `next build` to be reviewable.
- **Concurrency group** `ci-CI-${{ github.ref }}` cancels superseded runs on
  the same branch — saves runners and keeps PR signal clean.
- **Bun cache** keyed on `bun.lock` hash. Install step uses
  `--frozen-lockfile` so CI fails fast if `bun.lock` is stale.
- **`DATABASE_URL=file:/tmp/test.db`** is set on the `build` job because
  `@prisma/client` instantiates eagerly during `next build` and refuses to
  load without a writable SQLite path. The file is throwaway — we're
  validating the build, not running migrations.
- **Type-check caveat.** `next.config.ts` has
  `typescript.ignoreBuildErrors: true`, so `next build` would happily ship
  broken types. `tsc --noEmit` is the real gate — it catches type errors
  that `next build` would silently swallow.

### 2. `.github/workflows/security.yml` — Security scan

Runs on push to `main`, on PRs to `main`, and weekly on Sunday 00:00 UTC.

| Job            | Tool                | What it catches                            |
|----------------|---------------------|--------------------------------------------|
| `audit-deps`   | `bun audit`         | Known CVEs in installed dependencies      |
| `secrets-scan` | TruffleHog OSS      | Leaked API keys / tokens in git history    |

TruffleHog scans the **full git history** (`fetch-depth: 0`) with
`--only-verified` so it only reports secrets that have been validated against
the provider — cuts false positives from test fixtures and dummy values.

The weekly cron is a backstop for CVEs that ship *after* a PR landed. Without
it, a dependency could go unpatched for months until the next PR happens to
touch `bun.lock`.

### 3. `.github/workflows/quality-gate.yml` — The merge gate

Triggered by `workflow_run` after `ci.yml` completes. Two checks:

1. **Verify CI succeeded.** Uses `actions/github-script@v7` to inspect
   `github.event.workflow_run.conclusion`. If CI didn't succeed, the gate
   fails immediately with a message pointing at the failed CI run.
2. **No `console.log` in production source.** Greps `src/` and
   `mini-services/` for `console.log` calls. Production logging should go
   through the structured logger in `src/lib/observability.ts` so it ends up
   in `logs/app.jsonl` with request IDs and timestamps.

This is the workflow you mark as a **required status check** in GitHub branch
protection. Because it transitively requires CI to pass, it's a single
checkbox that enforces lint + type-check + test + console.log hygiene.

---

## Run checks locally

```bash
./scripts/check-quality.sh
```

Runs the same three checks CI runs, with one difference:

| Check        | Local behavior   | CI behavior  |
|--------------|------------------|--------------|
| `bun run lint`        | hard fail      | hard fail |
| `bunx tsc --noEmit`   | **soft warn**  | hard fail |
| `bun test tests/`     | hard fail      | hard fail |

`tsc --noEmit` is soft locally because the project has a handful of pre-existing
TS errors being paid down (see `docs/code-review.md`, which notes
11 pre-existing TS errors at the time of that review). CI still enforces it as a hard gate
to prevent new errors from landing; locally we just warn so devs aren't blocked
on errors they didn't introduce.

Exit codes:

- `0` — all hard checks passed (warnings may have been printed)
- `1` — at least one hard check failed; fix before pushing

### Manual one-offs

```bash
bun run lint              # ESLint only
bunx tsc --noEmit         # type-check only
bun test tests/           # all 138 tests + 1 intentional skip
bun test tests/ua.test.ts # single file
```

### Running api-contracts tests

`tests/api-contracts.test.ts` hits the live dev server on `localhost:3000`. It
auto-skips if the server is unreachable, so `bun test tests/` is always safe to
run in CI and locally. To exercise the contract tests:

```bash
bun run dev &             # start dev server on :3000
sleep 3                   # wait for "Ready"
bun test tests/api-contracts.test.ts
```

---

## Branch protection recommendations

In GitHub repo settings → Branches → Branch protection rules → `main`:

### Required status checks

Mark these as **required** before merge:

- `Quality Gate / quality-gate` — the merge gate from `quality-gate.yml`. This
  transitively requires CI to pass, so you don't need to also mark `Lint`,
  `Type-check`, or `Test` as required (but you can, for finer-grained signal
  in the PR checks panel).
- `Audit dependencies` — from `security.yml`. Blocks merge on known CVEs.
- `Scan for leaked secrets` — from `security.yml`. Blocks merge on secret leaks.

### Other settings

- **Require a pull request before merging** — at least 1 approval.
- **Require status checks to pass before merging** — see list above.
- **Require branches to be up to date before merging** — ensures the PR was
  tested against the latest `main`.
- **Do not allow bypassing the above settings** — even for admins. The whole
  point of a gate is that no one slips through it.
- **Limit who can push to matching branches** — only `main` should accept PR
  merges; no direct pushes.
- **Allow force pushes:** Never.
- **Allow deletions:** Never.

### Required reviewers

- At least 1 reviewer for PRs to `main`.
- For high-blast-radius changes (schema, security middleware, CI itself),
  consider requiring 2 reviewers via `CODEOWNERS`.

---

## Secret management

### What counts as a secret

- API keys (z-ai-web-dev-sdk, any third-party integrations)
- Database credentials (in production; `DATABASE_URL` for SQLite is just a
  file path so it's typically not secret, but Postgres URLs would be)
- Auth tokens / JWT signing secrets
- Webhook signing secrets

### Where they live

- **Local dev**: `.env` (gitignored — verify with `cat .gitignore | grep -i env`)
- **CI**: GitHub Actions secrets, scoped to the repo or environment.
- **Production**: environment variables on the host. Never in the repo, never
  in `.env` files committed to git.

### How they're protected

- `secrets-scan` workflow runs TruffleHog on every push and PR — catches
  secrets committed in any commit, not just HEAD.
- Weekly cron re-scans the full history so a secret that slipped in months
  ago still gets caught when the scanner's rules update.
- PR template includes a "No secrets committed" checkbox as a human check.

### If a secret is leaked

1. **Revoke the secret immediately.** Scanning + removing the commit does not
   undo the leak — the secret must be rotated.
2. Remove the secret from history (`git filter-repo` or BFG).
3. Force-push the cleaned history.
4. Open a PR adding the now-revoked secret string to `.github/trufflehog-ignore`
   or the equivalent allow-list (only for the now-dead value, never live ones).
5. Postmortem: how did it leak? Add a guard (pre-commit hook, lint rule, etc.)
   to prevent recurrence.

---

## Future improvements

Deferred per task scope (CI + quality gates only — no CD). Listed here so the
next pass has a starting point.

### 1. Deploy step

`ci.yml` currently stops at `build`. A future `deploy.yml` workflow could:

- Trigger on push to `main` after `ci.yml` succeeds (`workflow_run`).
- `rsync` the `.next/standalone/` artifact to the production host.
- Restart the systemd service or PM2 process.
- Hit `/api/health` and roll back if it returns 5xx.

Insight Replay ships as a self-hosted app, so the deploy target is "your own
box," not Vercel/Netlify. SSH-based deploy with a health check is the right
shape.

### 2. E2E tests

The test pyramid currently has 128 unit tests + 11 contract tests (skipping
when the dev server is down). Missing layer: browser-driven E2E tests.

- **Playwright** is the natural fit (already in the JS ecosystem, runs against
  the real Next.js dev server).
- Cover the happy path: create project → embed SDK → record a session → replay
  it → view on dashboard.
- Run in CI as a 5th job in `ci.yml` (or a separate `e2e.yml` to keep the
  feedback loop fast — E2E is slow).

### 3. Lighthouse CI

For a dashboard-heavy app, performance budgets matter. `lighthouse-ci` could:

- Run against the production build (`bun run build && bun run start`).
- Assert budgets on LCP, TBT, CLS for the dashboard route.
- Fail the PR if scores regress by more than 5 points.

### 4. Bundle size tracking

`@next/bundle-analyzer` or `bundlewatch` could assert that the First Load JS
of key routes stays under a budget. Catches accidental `import _ from "lodash"`
regressions.

### 5. Dependency caching with bun's built-in cache

`oven/setup-bun@v2` can cache `~/.bun/install/cache` natively — the explicit
`actions/cache@v4` step in the workflows is belt-and-suspenders. Once the
built-in cache is verified stable, the explicit step can be removed.

### 6. Matrix testing

Currently CI runs only on `ubuntu-latest`. A matrix (`ubuntu-latest`,
`macos-latest`) would catch OS-specific issues — useful if anyone develops on
macOS. Not worth the runner minutes until the project has a macOS-specific
bug to chase.

### 7. Quality gate as a single composite action

`quality-gate.yml` currently does its checks inline. If more checks are added
(coverage threshold, license scan, etc.), extract them into a composite action
under `.github/actions/quality-gate/` for reuse.

---

## File map

```
.github/
├── workflows/
│   ├── ci.yml                 # lint + type-check + test + build
│   ├── security.yml           # bun audit + TruffleHog
│   └── quality-gate.yml       # merge gate (runs after ci.yml)
├── pull_request_template.md   # PR checklist + sections
scripts/
└── check-quality.sh           # local pre-push quality script
docs/
└── ci-cd.md                   # this file
```

---

## Verification

These commands were run when this CI/CD setup was created (worklog Task ID: 2,
CI/CD agent):

```bash
# Local quality gate runs end-to-end
./scripts/check-quality.sh 2>&1 | tail -15

# All three workflow files parse as valid YAML
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/security.yml'))"
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/quality-gate.yml'))"

# Adding the script + workflow files didn't break lint
bun run lint 2>&1 | tail -3
```

The YAML validation must pass (no syntax errors). `bun run lint` must exit 0
with no output — the workflows and script are config/infra, not source, but
ESLint still scans `.ts`/`.tsx` files and the script is excluded by the
`scripts/**` ignore? Actually, the `eslint.config.mjs` ignores list does NOT
include `scripts/**`, so the shell script (not `.ts`) is safe; if a `.ts`
file is later added under `scripts/`, ensure it conforms to the ESLint config
or add it to the ignores.
