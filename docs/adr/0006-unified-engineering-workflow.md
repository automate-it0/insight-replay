# ADR-0006: Unified Engineering Workflow and Shared Quality Gates

## Status
Accepted (2025-01-01)

## Context
Insight Replay is developed by several contributors and automation pipelines
working in parallel on disjoint file sets — features, hardening, tests, docs,
and CI all move at the same time. Without a shared process, every work stream
would:

- invent its own verification bar (some would ship unverified, some would
  over-verify),
- invent its own conventions (file layout, naming, error handling, response
  shape),
- duplicate work (re-reading the docs, re-discovering the `ctx.params` Promise
  signature, re-deciding whether to use `try/catch`),
- skip writing down what it did (so the next contributor has to
  reverse-engineer it),
- apply different quality gates (some "lint clean" only, some
  "lint + tsc + browser", some "nothing").

The project needed a **single source of truth** for "how do we work here" that
every contributor — human or automated — inherits automatically. The workflow
had to be discoverable from the repo root, applicable across the full
software lifecycle (debug → implement → review → ship), and lightweight enough
that people actually follow it.

Forces:

- **Parallel work streams.** Multiple tasks in flight simultaneously on disjoint
  file sets. Each must follow the same process without coordinating with the
  others.
- **Full lifecycle coverage.** The workflow must cover debugging, implementation,
  testing, code review, security, performance, observability, git, and shipping —
  not just one phase.
- **Discoverability.** A new contributor landing on the repo must find the
  workflow within seconds. It cannot live in a chat channel or an external wiki.
- **Low friction.** If the workflow requires reading 50 pages before doing
  anything, it will be skipped. The entry point must be short; the detail must
  be on-demand.
- **Quality bar consistency.** Every task — regardless of who runs it — must
  end with the same verification gate (lint clean, type-check passes, dev server
  compiles, browser verification for UI, curl for API changes, no console
  errors).

## Decision
Codify a **repo-level engineering workflow** with two artifacts:

1. **A task-type decision tree** (maintained in
   [`CONTRIBUTING.md`](../../CONTRIBUTING.md) and indexed by
   [`docs/context-map.md`](../context-map.md)) that routes each incoming task to
   the checklist that applies to it:
   - Bug → root-cause debugging, then the fix verified against the failing case.
   - Feature → incremental implementation (UI → frontend conventions in
     `docs/architecture.md` § Dashboard tabs; API → `docs/api-style-guide.md`;
     high-stakes change → `docs/doubt-review.md`).
   - Tests → the contract-test patterns in `tests/`.
   - Browser testing → the specs under `tests/browser/`.
   - Code review → the five review axes in [`docs/code-review.md`](../code-review.md)
     (security → `docs/security-audit.md`; performance → `docs/performance.md`).
   - Logs/metrics/alerts → `docs/architecture.md` § Observability.
   - Committing → conventional commits + `.gitmessage`.
   - Deploying → `docs/launch-checklist.md`.
2. **A uniform verification bar** that every change must clear before it is
   considered done: `bun run lint` → exit 0; build / dev server compiles;
   browser verification for UI changes; curl for API changes; no console errors.
   The measurable parts of this bar are enforced in CI
   (`.github/workflows/ci.yml`), so they cannot be skipped.

The lifecycle every task follows: `define → plan → build → verify → review →
ship`.

## Consequences

**Positive**

- **Process discipline.** Every task — feature, bug fix, or hardening — follows
  the same lifecycle and the same verification bar. The docs stay uniform, the
  codebase stays consistent.
- **Onboarding is fast.** The decision tree means a contributor does not have
  to remember "for security work, read the security audit" — the docs index
  tells them.
- **Checklists pull in only when needed.** A task doing observability work
  reads the observability section; a task doing security work reads the
  security docs. Nobody reads everything up front.
- **The verification bar is non-negotiable and uniform.** "Lint clean +
  type-check + build + browser/curl verification + no console errors" is the
  same bar for every task. This is what makes parallel work streams composable.
- **New contributors inherit the workflow automatically.** Anyone landing on
  the repo reads `CONTRIBUTING.md` first and immediately knows the rules of
  engagement.

**Negative**

- **Process overhead.** Every task has an upfront cost: read the decision tree,
  read the relevant checklist. For trivial tasks this is overhead; for complex
  tasks it pays for itself many times over.
- **The workflow is only as good as compliance.** A contributor who skips the
  docs and dives straight into code will not follow the process. Mitigated by
  CI enforcing the measurable parts (lint, type-check, tests) regardless of
  what anyone claims to have followed.
- **Maintenance burden.** The checklists must be kept in sync with the code.
  When a convention changes, the docs must change in the same PR.

## Alternatives Considered

### Ad-hoc (no shared workflow)
- **Pros:** Zero upfront cost. Each contributor does what they think is right.
- **Cons:** Inconsistent quality, inconsistent verification, inconsistent
  conventions. The docs would be a pile of unrelated entries, and every new
  contributor would have to reverse-engineer every convention.
- **Rejected.** The cost of inconsistency is higher than the cost of process.

### Editor-specific rulesets
- **Pros:** Integrated into a contributor's editor. Auto-applied to every
  interaction.
- **Cons:** Rules locked to one editor are not shared by anyone using a
  different tool — or by headless automation. The workflow must live in the
  repo, not in someone's editor config.
- **Rejected.** Repo-level files work for every tool and every contributor.

### ADR-only approach (no workflow guide, just ADRs)
- **Pros:** Already the format for documenting decisions (see this directory).
- **Cons:** ADRs document *what was decided*, not *how to work*. They are
  output, not input. A contributor starting a task needs to know the process,
  not just the historical decisions.
- **Rejected as the primary workflow mechanism.** ADRs are complementary —
  they capture decisions made *while* following the workflow.
