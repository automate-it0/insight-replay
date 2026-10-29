# CONSTRAINTS

> The rulebook of measurable project constraints. **Hard** constraints block
> a merge when violated; **soft** constraints are baseline-tracked — we
> measure where we are vs. the target without blocking work that didn't
> introduce the violation.
>
> Companion docs: [`docs/constraints-guide.md`](./docs/constraints-guide.md)
> explains the philosophy. `scripts/check-constraints.sh` enforces every rule
> below automatically.

| # | Constraint | Type | Threshold |
|---|------------|------|-----------|
| 1 | Lint errors | HARD | 0 errors (warnings tracked) |
| 2 | Type safety | HARD | `tsc --noEmit` — 0 errors in `src/` |
| 3 | Tests | HARD | `bun test tests/` — 100% pass (skips allowed) |
| 4 | File complexity | SOFT (baseline-tracked) | no file > 800 lines |
| 5 | Function complexity | SOFT (optional) | no function > 100 lines |
| 6 | Security audit | SOFT (baseline-tracked) | `bun audit` — 0 high/critical |
| 7 | Bundle size | INFO | production JS < 500 KB gzipped |

---

## §1 Lint (HARD)

- **Rule:** ESLint must pass with 0 errors. Warnings are allowed but tracked.
- **Command:** `bun run lint`
- **Enforced by:** CI (every push and PR), `scripts/check-constraints.sh`.
- **Rationale:** Lint errors compound; catching them at PR time keeps the
  codebase reviewable and prevents style drift between contributors.
- **Waiver:** not waivable — fix the error.

## §2 Type safety (HARD on `src/`)

- **Rule:** `bunx tsc --noEmit` must report 0 errors for files under `src/`.
  Out-of-scope files are reported softly so pre-existing debt doesn't block
  unrelated work.
- **Command:** `bunx tsc --noEmit`
- **Enforced by:** CI (hard gate), `scripts/check-constraints.sh`.
- **Rationale:** `next.config.ts` sets `typescript.ignoreBuildErrors: true`
  (build speed), so the type gate has to live outside the build.
- **Waiver:** not waivable for `src/`.

## §3 Tests (HARD)

- **Rule:** `bun test tests/` must pass 100%. Skipped tests are allowed —
  `test.skipIf` is the standard for runtime-dependent tests (dev server down).
- **Command:** `bun test tests/`
- **Enforced by:** CI (every push and PR), `scripts/check-constraints.sh`.
- **Rationale:** the suite is small but guards the ingest pipeline and the
  pure helpers under `src/lib/`. A red suite must never be the baseline.
- **Waiver:** not waivable.

## §4 File complexity (SOFT, baseline-tracked)

- **Rule:** no source file should exceed 800 lines.
- **Command:** `wc -l` sweep over tracked source files.
- **Enforced by:** `scripts/check-constraints.sh` (report-only).
- **Rationale:** large files concentrate blame and merge conflicts. The
  threshold is directional, not absolute — a coherent 850-line file beats
  an arbitrary split.
- **Waiver:** file a waiver entry in the PR description (file, expected
  reduction, target date).

## §5 Function complexity (SOFT, optional)

- **Rule:** no function should exceed 100 lines.
- **Command:** static sweep in `scripts/check-constraints.sh`.
- **Enforced by:** `scripts/check-constraints.sh` (report-only).
- **Rationale:** long functions are the #1 predictor of regression-prone
  patches. Flagged for extraction, not enforced.
- **Waiver:** none needed (soft).

## §6 Security audit (SOFT, baseline-tracked)

- **Rule:** `bun audit` must report 0 high/critical advisories.
- **Command:** `bun audit`
- **Enforced by:** `.github/workflows/security.yml` (runs on every push, every
  PR, and weekly on Sundays) — see ADR-0004 §security layers.
- **Rationale:** supply-chain risk is real even for a self-hosted demo; the
  weekly run catches advisories published after the last PR.
- **Waiver:** documented in an ADR with a remediation date.

## §7 Bundle size (informational)

- **Rule:** production client JS should stay under 500 KB gzipped.
- **Command:** measured at build time from `.next/` output.
- **Enforced by:** informational only — reported in `check-constraints.sh`.
- **Rationale:** the dashboard is a data-dense SPA; keeping the client bundle
  small keeps first paint fast on modest hardware.

---

## Adding a new constraint

1. Write the rule in measurable form (a command that returns a number).
2. Open an ADR if the rule is architectural (see `docs/adr/0001` for format).
3. Add a numbered section here with: rule, type, threshold, command, enforced
   by, rationale, waiver policy.
4. Wire it into `scripts/check-constraints.sh` (and CI if HARD).
5. Record the baseline in the constraint section.

Unmeasurable rules ("keep it simple") are operating behaviors, not
constraints — they belong in [`docs/onboarding.md`](./docs/onboarding.md).
