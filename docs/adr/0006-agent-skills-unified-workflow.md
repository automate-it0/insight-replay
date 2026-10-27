# ADR-0006: Adopt addyosmani/agent-skills as Unified Workflow

## Status
Accepted (2025-01-01)

## Context
Insight Replay is being built by **multiple subagents running in parallel**, each
shipped with a narrow task brief ("build funnels + goals + segments backend",
"harden the ingest endpoint with rate limiting", "add audit logging", etc.). Without a
shared process, every agent would:

- invent its own verification bar (some would ship unverified, some would over-verify),
- invent its own conventions (file layout, naming, error handling, response shape),
- duplicate work (re-reading the worklog, re-discovering the `ctx.params` Promise
  signature, re-deciding whether to use `try/catch`),
- skip writing down what it did (so the next agent has to reverse-engineer it),
- apply different quality gates (some "lint clean" only, some "lint + tsc + browser",
  some "nothing").

The project needed a **single source of truth** for "how do we work here" that every
agent (and any future human contributor) inherits automatically. The workflow had to be
discoverable from the repo root, applicable across the full software lifecycle (debug →
implement → review → ship), and lightweight enough that agents actually follow it.

Forces:

- **Multi-agent parallelism.** 4+ subagents working simultaneously on disjoint file
  sets. Each must follow the same process without coordinating with the others.
- **Full lifecycle coverage.** The workflow must cover debugging, implementation,
  testing, code review, security, performance, observability, git, and shipping — not
  just one phase.
- **Discoverability.** A new agent (or contributor) landing on the repo must find the
  workflow within seconds. It cannot live in a Slack channel or a Notion doc.
- **Low friction.** If the workflow requires the agent to read 50 pages before doing
  anything, agents will skip it. The entry point must be short; the detail must be
  on-demand.
- **Quality bar consistency.** Every task — regardless of which agent runs it — must
  end with the same verification gate (lint clean, dev server compiles, browser
  verification for UI, curl for API changes, no console errors).

## Decision
Clone the **[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)**
repository into `.agent-skills/`. The repo provides 25 skills, each a `SKILL.md` file
under `.agent-skills/skills/<name>/SKILL.md` plus shared reference checklists under
`.agent-skills/references/`.

Author **`AGENTS.md`** at the repo root as the project-level entry point. It contains:

1. A **decision tree** mapping an incoming task to the right skill:
   - Bug → `debugging-and-error-recovery`
   - Feature → `incremental-implementation` → (UI? `frontend-ui-engineering`; API?
     `api-and-interface-design`; high-stakes? `doubt-driven-development`)
   - Tests → `test-driven-development`
   - Browser testing → `browser-testing-with-devtools`
   - Code review → `code-review-and-quality` → (security? `security-and-hardening`;
     performance? `performance-optimization`; too complex?
     `code-simplification`)
   - Logs/metrics/alerts → `observability-and-instrumentation`
   - Committing → `git-workflow-and-versioning`
   - Deploying → `shipping-and-launch`
2. **Six core operating behaviors** that every agent must follow:
   surface assumptions, manage confusion actively, push back when warranted, enforce
   simplicity, maintain scope discipline, verify-don't-assume.
3. **Project context** (stack, tracking, realtime, AI, dashboard tabs, security
   layers) so a new agent does not have to reverse-engineer it.
4. **Verification bar** that every change must clear: `bun run lint` → exit 0; dev
   server compiles; agent-browser for UI; curl for API; no console errors.
5. **Skill paths** so an agent can reference any skill's `SKILL.md` directly.
6. **Reference checklists** (`definition-of-done.md`, `security-checklist.md`,
   `performance-checklist.md`, `testing-patterns.md`, `observability-checklist.md`)
   pulled in by skills when needed.

The workflow is **auto-applied by phase**: when an agent starts a task, it reads
`AGENTS.md`, follows the decision tree to the right skill, reads that skill's
`SKILL.md`, and applies its checklist. The skill lifecycle is:
`define → plan → build → verify → review → ship`.

## Consequences

**Positive**

- **Process discipline.** Every agent — whether building a feature, fixing a bug, or
  hardening security — follows the same lifecycle and the same verification bar. The
  worklog becomes more uniform, the codebase more consistent.
- **Skill discovery is automatic.** An agent does not have to remember "for security
  work, look at security-and-hardening/SKILL.md" — `AGENTS.md`'s decision tree tells
  it. The first applied skill in this project was `observability-and-instrumentation`,
  which produced `src/lib/observability.ts`, the `/api/observability` and `/api/health`
  endpoints, and the middleware's request-id stamping.
- **Reference checklists pull in only when needed.** An agent doing observability work
  pulls in `observability-checklist.md`; an agent doing security work pulls in
  `security-checklist.md`. The agent does not have to read all 25 skills up front.
- **The verification bar is non-negotiable and uniform.** "Lint clean + dev server
  compiles + browser/curl verification + no console errors" is the same bar for every
  task, regardless of which agent runs it. This is what makes the parallel agents'
  outputs composable.
- **Future agents inherit the workflow automatically.** A new agent landing on the
  repo reads `AGENTS.md` first (the file is named for them) and immediately knows the
  rules of engagement.
- **The workflow is fork-able.** Other projects can clone the same `.agent-skills/`
  directory, write their own `AGENTS.md`, and inherit the same process.

**Negative**

- **Skill discovery overhead.** Every task now has an upfront cost: read `AGENTS.md`,
  follow the tree, read the skill's `SKILL.md`, possibly read a reference checklist.
  For trivial tasks this is overhead; for complex tasks it pays for itself many times
  over.
- **25 skills is a lot to keep in your head.** An agent cannot memorise all of them.
  Mitigated by the decision tree in `AGENTS.md` — the agent only needs to read the
  one skill the tree points to.
- **The skills are general-purpose, not project-specific.** They say *how* to do TDD,
  not *what* to test in Insight Replay. Project-specific testing patterns must be
  authored separately. The `testing-patterns.md` reference is currently a stub.
- **Workflow is only as good as the agent's compliance.** An agent that skips reading
  `AGENTS.md` and dives straight into code will not follow the process. Mitigated by
  the brief explicitly requiring "read `AGENTS.md` first" — and by the verification bar
  being checkable from the output (lint, dev server, browser) regardless of whether
  the agent claims to have followed the workflow.
- **`.agent-skills/` adds ~1MB to the repo.** It is gitignored (see worklog Task
  `agent-skills-workflow`), so it does not bloat the commit history, but every
  contributor must `git clone` the skills repo separately. A setup script would help.

## Alternatives Considered

### Ad-hoc (no shared workflow)
- **Pros:** Zero upfront cost. Each agent does what it thinks is right.
- **Cons:** Inconsistent quality, inconsistent verification, inconsistent conventions.
  The worklog would be a pile of unrelated entries. The codebase would feel like 6
  different authors wrote it (because they did). The next agent would have to
  reverse-engineer every convention.
- **Rejected.** The cost of inconsistency is higher than the cost of process.

### Custom rules file (hand-written, project-specific)
- **Pros:** Tailored exactly to Insight Replay. No external dependency.
- **Cons:** Re-inventing what addyosmani/agent-skills already provides. Would have to
  write 25 skill docs by hand. Would not benefit from upstream improvements. Would not
  be portable to other projects.
- **Rejected.** Re-use beats re-invention when the re-used thing is good enough.

### Cursor / Copilot / IDE-level rules
- **Pros:** Integrated into the editor. Auto-applied to every interaction.
- **Cons:** Agent processes (subagents running headless) do not use Cursor or Copilot.
  They need a repo-level file they can read. IDE-level rules are also editor-specific,
  which violates the "any agent, any tool" brief.
- **Rejected.** The workflow must live in the repo, not in the editor.

### ADR-only approach (no skills, just ADRs)
- **Pros:** Already the format for documenting decisions (see this directory).
- **Cons:** ADRs document *what was decided*, not *how to work*. They are output, not
  input. An agent starting a task needs to know the process, not just the historical
  decisions.
- **Rejected as the primary workflow mechanism.** ADRs are complementary — they
  capture decisions made *while* following the workflow.
