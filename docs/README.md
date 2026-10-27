# Insight Replay — Documentation Index

This directory holds the project's reference documentation. Start here, then drill
into the section you need.

## Quick navigation

| Document | What it covers |
|----------|----------------|
| [**architecture.md**](./architecture.md) | Process topology, data flow, realtime flow, AI flow, security layers, dashboard tab list, build & run commands. Start here if you're new to the codebase. |
| [**api-reference.md**](./api-reference.md) | Every HTTP route under `src/app/api/` with method, path, auth, body/params, response shape, and curl examples. Grouped by domain. |
| [**code-review.md**](./code-review.md) | Five-axis code review (correctness, security, performance, maintainability, tests) of the frontend tabs + tracking ingest lib. Produced by the `code-review-and-quality` skill. |
| [**performance.md**](./performance.md) | Measure-first optimisation: in-memory TTL cache for the stats API, React memoisation, re-render reduction. Produced by the `performance-optimization` skill. |

## Architecture Decision Records (ADRs)

ADRs capture the *why* behind significant technical decisions. They are immutable —
when a decision is superseded, a new ADR is written that references the old one.

| # | Title | Topic |
|---|-------|-------|
| [0001](./adr/0001-use-prisma-sqlite-over-postgres.md) | Use Prisma + SQLite over PostgreSQL | Database choice for a zero-config demo; trade-offs vs Postgres/MySQL. |
| [0002](./adr/0002-socketio-mini-service-for-realtime.md) | Socket.io Mini-Service for Realtime Cursor Tracking | Why a separate process on :3004 instead of in-process WebSocket / SSE / polling. |
| [0003](./adr/0003-llm-powered-ai-features.md) | LLM-Powered AI Features via z-ai-web-dev-sdk | Backend-only constraint, lazy import, 200-on-error contract, structured prompts. |
| [0004](./adr/0004-security-hardening-layers.md) | Security Hardening via 6 Parallel Layers | API key auth, rate limit, CORS+origin, IP anon, audit log, headers+sanitize. |
| [0005](./adr/0005-in-memory-cache-for-stats.md) | In-Memory TTL Cache for Stats Aggregations | 60s TTL, globalThis persistence, 8s polling cadence, alternatives (Redis, HTTP cache). |
| [0006](./adr/0006-agent-skills-unified-workflow.md) | Adopt addyosmani/agent-skills as Unified Workflow | AGENTS.md as the entry point; skill lifecycle; verification bar. |

## Project-level references

| File | What it covers |
|------|----------------|
| [`../AGENTS.md`](../AGENTS.md) | The engineering workflow that governs every change. Decision tree mapping tasks to skills, six core operating behaviors, project context, verification bar. |
| [`../worklog.md`](../worklog.md) | Chronological history of every task and subagent. Append-only; each entry has Task ID, Agent, Task, Work Log, Stage Summary. |
| [`../prisma/schema.prisma`](../prisma/schema.prisma) | The full data model — 16 Prisma models (Project, Session, Event, Insight, ErrorEvent, Funnel, Goal, Segment, Note, Tag, Bookmark, Alert, AlertHistory, Dashboard, Experiment, Annotation, ApiKey). |
| [`../Caddyfile`](../Caddyfile) | Gateway config — `:81` listener with `@transform_port_query` matcher routing `?XTransformPort=<port>` to non-3000 services. |
| [`../next.config.ts`](../next.config.ts) | Next.js config — standalone output, 6 security headers applied to `/(.*)`, `typescript.ignoreBuildErrors: true`. |
| [`../package.json`](../package.json) | Scripts: `dev` (Next on :3000), `db:push`/`db:generate`/`db:migrate`/`db:reset`, `lint`, `build`, `start`. |

## How to read this documentation

1. **New to the codebase?** Read [architecture.md](./architecture.md) first — it
   explains which processes run, on which ports, and how data flows between them.
2. **Building or modifying an API?** Read [api-reference.md](./api-reference.md) for
   the route you're touching; the response shapes there are accurate (read directly
   from the route files).
3. **Wondering why a decision was made?** Check the ADRs above. If a decision isn't
   documented, write a new ADR (use `0001` as the template).
4. **Doing security / performance / testing work?** Apply the relevant skill from
   `.agent-skills/skills/` per the [AGENTS.md](../AGENTS.md) decision tree, then
   follow the verification bar.
5. **Curious what previous agents did?** Read [worklog.md](../worklog.md) — every task
   appends an entry with Task ID, Agent, Task, Work Log, Stage Summary.

## Conventions for new docs

- ADRs go in `docs/adr/` with the format `NNNN-kebab-case-title.md`. Continue the
  numbering; do not renumber existing ADRs. See the [ADR template](./adr/0001-use-prisma-sqlite-over-postgres.md).
- Reference docs (architecture, API, review, performance) go directly in `docs/`.
- Update this README whenever you add or rename a doc.
- Cross-link liberally — every ADR links to the others where relevant, and the
  architecture doc links back to the ADRs that justify each layer.
- Keep docs in sync with the code. The verification bar in [AGENTS.md](../AGENTS.md)
  includes "no console errors" — broken doc links should be treated with the same
  seriousness.
