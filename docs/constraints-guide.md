# Constraints guide

> Companion to `CONSTRAINTS.md`. Read this once when you join the project, then
> reference it when you need to add, waive, or understand a constraint.

This guide explains **how** the constraint system works: the philosophy behind
it, how to add a new constraint, how to temporarily waive one, the difference
between baseline and target, and how CI enforces the whole thing.

---

## Philosophy: "decide once, enforce everywhere"

Every constraint in `CONSTRAINTS.md` exists because someone made a deliberate
decision about quality. The point of writing it down is to **decide once** —
in a PR, with review, with the full context — and then **enforce everywhere**:
on every developer's machine, on every PR, on every merge to `main`.

The alternative is deciding the same thing over and over: in code review, in a
Slack thread, in a postmortem. That's exhausting and inconsistent. Two
developers will reach different conclusions about whether a 900-line file is OK
depending on their mood. A constraint decides it once, writes it down, and
makes the answer machine-checkable.

This is also why constraints are *measurable*. "Code should be readable" is a
value, not a constraint — there's no command that returns a number. "No file >
800 lines" is a constraint — `wc -l` returns a number, the threshold is 800,
the check is automatic. If a rule can't be measured, it belongs in the
contributor guide as an operating behavior, not in the constraints list.

### Hard vs. soft constraints

| | Hard | Soft |
|---|---|---|
| **Gate behavior** | exit 1 on violation | exit 0; violation reported as a warning |
| **When to use** | The project is at target today and we want to keep it that way | The project has baseline debt; we want to track it without blocking work |
| **Regression handling** | Any violation fails | Regressions beyond baseline fail; baseline debt warns |
| **Examples** | Lint errors, tsc src errors, test pass rate | Files > 800 lines, audit high/critical, function size |

A soft constraint with a baseline of 0 is effectively a hard constraint. The
 distinction only matters when there's debt to pay down — soft lets us measure
 progress without blocking every PR on pre-existing violations.

---

## How to add a new constraint

Adding a constraint is a one-time decision that affects every future PR, so
treat it like an architectural decision (see `CONSTRAINTS.md` §11 — ADR
required for > 3-file decisions; adding a constraint definitely qualifies).

### Step 1: Write the rule in measurable form

Before touching any file, answer these five questions in a draft:

1. **Rule** — one sentence. "No file > 800 lines."
2. **Threshold** — the number. "800 lines, including comments and blanks."
3. **How to check** — the exact command. "`find src -type f \( -name '*.ts' -o -name '*.tsx' \) -exec wc -l {} + | awk '$1 > 800 && $2 != \"total\"'` must be empty."
4. **Enforced by** — CI, local, or both? Hard or soft?
5. **Baseline** — what does the project measure today, before the constraint
   exists? Run the check command and record the number.

If you can't answer all five, the constraint isn't ready. "Code should be
well-tested" fails #2 and #3 — it's a value, not a constraint.

### Step 2: Open an ADR

Create `docs/adr/NNNN-<short-name>.md` (next free number; current max is
`0006`). Use the MADR format the existing ADRs use — Context, Decision,
Consequences, Alternatives Considered. The ADR is where you surface
assumptions and invite pushback (surface assumptions before implementing).

The ADR should answer:
- **Why this threshold and not another?** (e.g. "800 lines, not 500, because
  shadcn/ui components routinely run 600-700 lines and we don't want to fight
  the framework.")
- **Why hard vs. soft?** (e.g. "Soft because the baseline is 2 violations and
  we can't fix them in this PR.")
- **What's the alternative?** (e.g. "We could use a `complexity` ESLint rule
  instead of a line count, but that requires AST parsing and adds setup cost.")

### Step 3: Add the constraint to `CONSTRAINTS.md`

Add a new numbered section following the table format the existing sections
use. Update the "Current baseline vs. targets" table at the bottom.

### Step 4: Wire it into `scripts/check-constraints.sh`

Add a new section to the script following the pattern of the existing checks:

```bash
# ============================================================================
# N. CONSTRAINT NAME (HARD|SOFT, baseline-tracked?) — one-line rule.
#    Baseline: X. Target: Y. See CONSTRAINTS.md §N.
# ============================================================================
header "N. Constraint name — threshold"
# Run the check command, capture output, parse the measured value.
measured_value=$(... command ...)
if [ "$measured_value" -le "$THRESHOLD" ]; then
  pass "measured: $measured_value"
  add_row "Constraint name" "$THRESHOLD" "$measured_value" PASS hard
else
  fail "measured: $measured_value"
  add_row "Constraint name" "$THRESHOLD" "$measured_value" FAIL hard
fi
```

Use the `add_row` helper so the constraint appears in the summary table.

### Step 5: Wire it into CI (if `Enforced by: CI`)

Add a job (or a step in an existing job) to `.github/workflows/ci.yml`. For
hard constraints, the job must `exit 1` on violation. Reference
`docs/ci-cd.md` for the existing job structure — parallel jobs are preferred
so a slow check doesn't gate fast feedback.

### Step 6: Document the baseline

If the constraint is soft (baseline > target), record the baseline in the
constraint section and in the "Current baseline vs. targets" table. The script
should treat regressions beyond baseline as hard fails — see "Regressions vs.
baseline" in `CONSTRAINTS.md`.

### Checklist

- [ ] Rule is one sentence and measurable
- [ ] Threshold is a specific number
- [ ] Check command is exact and reproducible
- [ ] ADR written and linked from the constraint section
- [ ] Section added to `CONSTRAINTS.md` with all 5 fields
- [ ] "Current baseline vs. targets" table updated
- [ ] `scripts/check-constraints.sh` runs the check and reports via `add_row`
- [ ] CI job added (if `Enforced by: CI`)
- [ ] Baseline recorded (if soft)
- [ ] PR description links the ADR

---

## How to temporarily waive a constraint

Sometimes a constraint blocks legitimate work. Example: a critical security
fix needs to land today, but it touches a file that's already at 800 lines and
the fix pushes it to 810. The fix is more important than the constraint. The
right move is to **waive the constraint temporarily**, not to silently break
it.

### What a waiver is

A waiver is a documented, time-bounded exception to a constraint. It says:
"we know this constraint exists, we know we're violating it, here's why, and
here's when we'll come back into compliance."

### What a waiver is not

- **Not a permanent change to the threshold.** If the threshold is wrong,
  change it via an ADR (see "How to add a new constraint"). A waiver is for
  exceptions, not for redefining the rule.
- **Not a silent break.** If you violate a constraint without a waiver, the
  gate fails (hard) or the regression fails (soft beyond baseline). That's
  working as intended.
- **Not open-ended.** Every waiver has an expiry date. If you can't pick a
  date, you don't have a waiver — you have an unaddressed regression.

### How to file a waiver

Add a section to the relevant constraint in `CONSTRAINTS.md`, under a
`## Waivers` subsection:

```markdown
## Waivers

### W-001 — recording-player.tsx > 800 lines (expires 2025-12-31)

- **Constraint**: §8 Code complexity — files > 800 lines
- **Waived for**: `src/components/app/recording-player.tsx` (currently 883 lines)
- **Reason**: The code-simplification pass extracted helpers (768→544 main body)
  but the player UI itself is still one component. Splitting it into
  `<PlayerControls>`, `<PlayerCanvas>`, `<PlayerSidePanel>` is a separate
  refactor tracked in #123.
- **Expiry**: 2025-12-31 — if the refactor hasn't landed by then, either land
  it or extend the waiver with a new justification.
- **Approved by**: @reviewer in PR #124
```

Then update `scripts/check-constraints.sh` to skip the waived file. The skip
must reference the waiver ID:

```bash
# W-001: recording-player.tsx waived until 2025-12-31 — see CONSTRAINTS.md §8.
over_files=$(find src -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path '*/recording-player.tsx' -exec wc -l {} + \
  | awk '$1 > 800 && $2 != "total" { printf "  %s: %s lines\n", $2, $1 }')
```

### Wavier rules

1. **One waiver per constraint per file.** Don't stack waivers.
2. **Expiry is a date, not "when X happens."** Vague expiries don't get
   reviewed and don't expire. Pick a date 1-3 months out.
3. **Renewals need new justification.** Don't auto-renew. If the waiver is
   still needed, write a new waiver with a new reason and a new expiry.
4. **Expired waivers are violations.** The check script should fail on expired
   waivers — if the date has passed, the constraint applies again.
5. **Waivers are visible.** They live in `CONSTRAINTS.md`, not in a comment in
   the script. Anyone reading the constraint sees the exception.

---

## Current baseline vs. targets

This table mirrors the one in `CONSTRAINTS.md`'s final section. It exists in
both places so you can find it from either entry point.

| # | Constraint | Threshold | Baseline (today) | Target | Status |
|---|---|---|---|---|---|
| 1 | Lint errors | 0 | 0 | 0 | ✅ met |
| 2 | tsc errors (`src/`) | 0 | 0 | 0 | ✅ met |
| 2 | tsc errors (out-of-scope) | 0 | 8 | 0 | ⚠ baseline debt |
| 3 | Test pass rate | 100% | 100% (138 pass / 1 skip / 0 fail) | 100% | ✅ met |
| 3 | Coverage `src/lib/` | 80% | unmeasured | 80% | ⚠ measure first |
| 3 | Coverage `src/app/api/` | 60% | unmeasured | 60% | ⚠ measure first |
| 4 | Bundle (gzipped, per route) | < 500KB | unmeasured | < 500KB | ⚠ measure first |
| 5 | API p95 (cached) | < 200ms | unmeasured continuously | < 200ms | ⚠ measure first |
| 5 | API p95 (uncached) | < 1s | unmeasured continuously | < 1s | ⚠ measure first |
| 6 | axe violations (critical/serious) | 0 | 0 (last audit) | 0 | ✅ met (re-audit needed) |
| 7 | Audit high/critical | 0 | 62 (5 crit + 57 high) | 0 | ⚠ baseline debt |
| 7 | Auth on mutating routes | 100% | 100% | 100% | ✅ met |
| 8 | Files > 800 lines | 0 | 2 | 0 | ⚠ baseline debt |
| 8 | Functions > 100 lines | 0 | 42 (heuristic) | 0 | ⚠ baseline debt |
| 9 | Unjustified new deps | 0 | 0 | 0 | ✅ met (manual) |
| 10 | Conventional commit format | 100% | partial | 100% | ⚠ guideline |
| 11 | ADR for > 3-file decisions | 100% | 100% (6 ADRs) | 100% | ✅ met |

### What "baseline debt" means

A constraint with `⚠ baseline debt` has a measured value above target, but the
project chose to track it rather than block every PR on it. The constraint
still works — anything *worse* than baseline is a regression and fails the
gate. The debt gets paid down by deliberate work, not by accident.

Example: audit high/critical has a baseline of 62 (transitive deps of
`next-intl`, `@reactuses/core`, etc.). Today's gate accepts 62, fails at 63.
When someone runs `bun update --latest` and the count drops to 40, the
baseline should be updated to 40 in `CONSTRAINTS.md` and
`scripts/check-constraints.sh`. The constraint gets stricter over time —
ratchet-only.

### What "measure first" means

A constraint with `⚠ measure first` has a target but no baseline because the
measurement infrastructure isn't wired up yet. The constraint exists in
`CONSTRAINTS.md` as a statement of intent; the check script reports
"unmeasured" or "not built" instead of a number. The path to making these
hard gates is documented in each constraint's "Future: hard gate" subsection.

---

## How CI enforces constraints

CI runs the hard constraints on every PR and every push to `main`. The
pipelines live in `.github/workflows/`:

```
.github/workflows/
├── ci.yml              # lint + type-check + test + build (hard)
├── security.yml        # bun audit + TruffleHog (hard)
└── quality-gate.yml    # merge gate — runs after ci.yml
```

### `ci.yml` — main CI

Runs four parallel jobs on every push to `main` and every PR targeting `main`:

| Job          | Command                  | Hard constraint? |
|--------------|--------------------------|------------------|
| `lint`       | `bun run lint`           | yes — `CONSTRAINTS.md` §1 |
| `type-check` | `bunx tsc --noEmit`      | yes — `CONSTRAINTS.md` §2 (CI fails on any tsc error, including out-of-scope; locally the script is more lenient — see below) |
| `test`       | `bun test tests/`        | yes — `CONSTRAINTS.md` §3 |
| `build`      | `bun run build`          | yes (post-merge only) — `next.config.ts` has `ignoreBuildErrors: true`, so `build` is a smoke test, not a type check |

Concurrency group `ci-CI-${{ github.ref }}` cancels superseded runs on the same
branch. Bun cache is keyed on `bun.lock` hash. Install uses
`--frozen-lockfile` so CI fails fast if `bun.lock` is stale.

**Note on the type-check discrepancy**: CI runs `tsc --noEmit` as a hard gate
on the *entire* project, including `tests/`, `examples/`, and `skills/`. The
local `scripts/check-constraints.sh` is more lenient — it only fails on `src/`
errors and warns on out-of-scope errors. This is intentional: CI is the
authoritative gate, local is the fast feedback loop. Don't let the local
script's leniency fool you into thinking CI will pass — if you add a tsc
error in `tests/`, CI will fail.

### `security.yml` — security scan

Runs on push to `main`, on PRs to `main`, and weekly on Sunday 00:00 UTC.

| Job            | Tool          | Hard constraint? |
|----------------|---------------|------------------|
| `audit-deps`   | `bun audit`   | yes — `CONSTRAINTS.md` §7 |
| `secrets-scan` | TruffleHog OSS | yes — `CONSTRAINTS.md` §7 (implicit; no secrets in git history) |

The weekly cron is a backstop for CVEs that ship *after* a PR landed. Without
it, a dependency could go unpatched for months until the next PR happens to
touch `bun.lock`.

**Note on audit discrepancy**: CI's `bun audit` job fails on any
vulnerability, not just high/critical. Locally,
`scripts/check-constraints.sh` only fails on regressions beyond the high/
critical baseline (62 today). This means CI is stricter than local — if you
add a dep with a low-severity advisory, CI fails but the local script passes.
Trust CI.

### `quality-gate.yml` — the merge gate

Triggered by `workflow_run` after `ci.yml` completes. Two checks:

1. **Verify CI succeeded.** Uses `actions/github-script@v7` to inspect
   `github.event.workflow_run.conclusion`. If CI didn't succeed, the gate
   fails immediately.
2. **No `console.log` in production source.** Greps `src/` and
   `mini-services/` for `console.log` calls. Production logging should go
   through the structured logger in `src/lib/observability.ts`.

This is the workflow you mark as a **required status check** in GitHub branch
protection. Because it transitively requires CI to pass, it's a single
checkbox that enforces lint + type-check + test + console.log hygiene.

### Local enforcement: `scripts/check-constraints.sh`

Run this before pushing. It mirrors CI's hard constraints and adds the soft
constraints CI doesn't (yet) check:

```bash
./scripts/check-constraints.sh
```

Output is a summary table:

```
 Constraint                 Threshold          Measured           Status   Kind
 -------------------------- ------------------ ------------------ -------- ------
 Lint errors                0                  0                  PASS     hard
 tsc errors (src/)          0                  0                  PASS     hard
 tsc errors (out-of-scope)  0 (target)         8                  WARN     soft
 Test pass rate             100%               100%               PASS     hard
 Files > 800 lines          0 (target)         2                  WARN     soft
 Functions > 100 lines      0 (target)         42                 WARN     soft
 Audit high/critical        0 (target)         62                 WARN     soft
 Bundle (gzipped)           <500KB             not built          WARN     soft
```

Exit codes:
- `0` — all hard constraints passed (warnings may have been printed)
- `1` — at least one hard constraint failed; fix before pushing

The local script is a **strict subset** of CI for hard constraints and a
**strict superset** for soft constraints. If the local script passes, CI's
hard constraints will pass. If CI fails, the local script will also fail
(assuming you re-run after pulling).

### `scripts/check-quality.sh` vs. `scripts/check-constraints.sh`

Two scripts, two purposes:

| Script | What it checks | When to run |
|---|---|---|
| `scripts/check-quality.sh` | Lint (hard), tsc (soft — warns on all errors), tests (hard) | Pre-push — fast feedback on the basics |
| `scripts/check-constraints.sh` | Everything in `CONSTRAINTS.md` — lint, tsc (src hard, OOS soft), tests, file size, function size, audit, bundle | Pre-push when you want the full picture; also a good "where are we vs. baseline?" check |

`check-quality.sh` is the original CI-oriented script.
`check-constraints.sh` is the broader constraint-driven script. They overlap
on lint and tests; neither deprecates the other. Run `check-quality.sh` for speed, `check-constraints.sh`
for completeness.

---

## File map

```
CONSTRAINTS.md                    # the rulebook — 11 constraints with thresholds
scripts/check-constraints.sh      # automated checker; runs every constraint
scripts/check-quality.sh          # faster pre-push check (lint + tsc + tests)
docs/constraints-guide.md         # this file
docs/ci-cd.md                     # CI pipeline docs (what runs where)
docs/adr/                         # ADRs — required for > 3-file decisions (§11)
.github/workflows/
├── ci.yml                        # lint + type-check + test + build
├── security.yml                  # bun audit + TruffleHog
└── quality-gate.yml              # merge gate (runs after ci.yml)
```

---

## Verification

When this guide was written, the
following was confirmed:

```bash
# The constraint checker runs end-to-end and produces a summary table.
bash scripts/check-constraints.sh 2>&1 | tail -20

# Lint is clean (constraint §1 — hard, met).
bun run lint 2>&1 | tail -3
```

The constraint checker exits 0 (PASS with warnings) — all hard constraints
met, all soft constraints at-or-below baseline. Re-run after any change that
could affect a constraint (new dep, new file, new function) to catch
regressions before they hit CI.
