# Insight Replay — Agent Context Guide

This is the operating manual for **any AI agent (or human contributor)**
working on Insight Replay. It tells you how to start a session, how to
verify your work, what traps to avoid, and how to stay in your lane when
multiple agents work in parallel.

Read this **before** your first action. Pair it with:

- [`AGENTS.md`](../AGENTS.md) — the engineering workflow + verification bar.
- [`worklog.md`](../worklog.md) — every prior task's narrative.
- [`context-map.md`](./context-map.md) — the project map (where things live).
- [`.cursor/rules/`](../.cursor/rules/) — five IDE/agent rules scoped by glob.

---

## 1. How to start a session

### 1.1 Read these first (in order)

1. [`AGENTS.md`](../AGENTS.md) — the workflow. Defines the skill decision tree
   (which skill applies to which task), the six core operating behaviors
   (surface assumptions, manage confusion, push back, enforce simplicity,
   maintain scope, verify don't assume), the project context, and the
   verification bar.
2. [`worklog.md`](../worklog.md) — at minimum the last 3–5 entries. This tells
   you what other agents are doing RIGHT NOW (parallel work) and what's
   recently changed. The worklog is append-only; entries are separated by `---`.
3. [`context-map.md`](./context-map.md) — the directory map + the 10 key files
   + the "if you're working on X, read these first" guide.
4. The relevant [`.cursor/rules/*.mdc`](../.cursor/rules/) rule for your task's
   file glob:
   - Touching `src/**` or `prisma/**`? Read `project-overview.mdc`.
   - Touching `src/app/api/**`? Read `api-conventions.mdc`.
   - Touching `tests/**`? Read `testing-conventions.mdc`.
   - Touching security-sensitive code or `middleware.ts`? Read `security.mdc`.
   - Touching `src/components/**` or `src/app/**` (UI)? Read `frontend.mdc`.
5. The relevant skill under [`skills/`](../skills/) per the AGENTS.md
   decision tree (e.g. `skills/coding-agent/SKILL.md`,
   `skills/task-review/SKILL.md`). The skills library lives at `skills/`,
   NOT at `.agent-skills/skills/` despite some stale references in older
   docs — use `ls skills/` to see the full list.

### 1.2 Sanity-check the environment

Before writing any code, confirm the baseline is green:

```bash
cd /home/z/my-project
bun run lint                            # must exit 0
bun test tests/ 2>&1 | tail -5          # must pass (skips OK if dev server down)
ls dev.log 2>/dev/null && tail -3 dev.log   # is the dev server already running?
```

If `bun run lint` is not clean on a baseline checkout, **stop and report** —
don't try to fix unrelated lint errors as a side-effect of your task
(unless your task explicitly includes them). The worklog will tell you
which agent owns the dirty file.

### 1.3 Decide if you need the runtime up

- Pure-function changes (anything under `src/lib/` that has no `db`/`fetch`/
  `fs`/`import` side effects): you don't need the dev server. Unit tests
  under `tests/<module>.test.ts` are enough.
- API route changes: start the dev server (`bun run dev` in one terminal,
  `bun mini-services/live-service/index.ts` in another, `caddy run --config
  Caddyfile` in a third if you need the gateway). Probe `/api/health` to
  confirm it's up.
- UI changes: also start the dev server; use `agent-browser` to snapshot
  the page and inspect the accessibility tree.

### 1.4 State your assumptions

Per AGENTS.md core behavior #1: before implementing anything non-trivial,
write down the assumptions you're making (in your worklog entry or in a
reply to the user). Examples: "I'm assuming the dev server is up and
seeded with demo data", "I'm assuming no other agent is editing
`recordings-tab.tsx` right now". If an assumption turns out to be wrong,
**stop and ask** — don't guess.

---

## 2. How to verify your work

The verification bar from AGENTS.md, in execution order:

### 2.1 Lint

```bash
bun run lint
```

Must exit 0. If you see errors:
- **In your own files**: fix them.
- **In files you didn't touch**: report in your worklog entry; don't fix
  them silently (scope discipline).

### 2.2 Typecheck

```bash
bunx tsc --noEmit
```

Not strictly in the verification bar but cheap and catches a lot. The
project has `typescript.ignoreBuildErrors: true` in `next.config.ts`, so
the build won't fail on type errors — but `tsc --noEmit` will surface them.

### 2.3 Unit tests

```bash
bun test tests/
```

All pass (skips OK when the dev server is down — `test.skipIf` is the
project's standard for runtime-dependent tests). If you added a pure
function to `src/lib/`, add a matching `tests/<module>.test.ts`.

### 2.4 Dev server compiles

```bash
bun run dev
# wait for "✓ Compiled in …ms" in dev.log
# visit http://localhost:81/  (or http://localhost:3000/ if Caddy isn't up)
```

No fatal errors in `dev.log`. If a page 500s on load, find the syntax/type
error in the offending file (it's usually named in the log) and either
fix it (if it's yours) or document the blocker in your worklog.

### 2.5 API contracts (if you touched an API route)

```bash
# Hit the endpoint and confirm the response shape matches the style guide:
curl -s http://localhost:3000/api/health | jq .
curl -s http://localhost:3000/api/projects | jq .

# For ingest, test from a disallowed origin to confirm the 403 path:
curl -X POST http://localhost:3000/api/track/events \
  -H "Content-Type: application/json" \
  -H "Origin: https://evil.example" \
  -d '{"projectId":"x"}' -i
```

### 2.6 Browser (if you touched UI)

Use the `agent-browser` skill (or any headless browser). Snapshot:

- The page renders without console errors.
- Landmarks present: `main`, `nav`, `header` (or complementary).
- The tab you changed has the expected `role="tab"` / `role="tabpanel"`.
- Every icon-only button has an `aria-label` that reads like a sentence.
- No focus traps; Tab key cycles through interactive elements.

### 2.7 Audit log (if you touched a mutating endpoint)

```bash
tail -5 logs/audit.jsonl   # confirm your action logged with the right AUDIT_ACTIONS constant
```

### 2.8 Append your worklog entry

Every task ends with a `worklog.md` append. Format (separated by `---`):

```markdown
---
Task ID: <N> (<skill name>)
Agent: <you>
Task: <one-line summary>

Work Log:
- What you read first.
- What you changed, file by file, with the why.
- Any Chesterton's-fence notes (things you considered changing but kept,
  and why).
- Any blockers (e.g. dev server down because of another agent's WIP).

Stage Summary:
- Files touched (count + list).
- Verification gates cleared (lint ✓, tests ✓ N pass, dev compiles ✓,
  browser ✓).
- What's left for the next agent.
```

---

## 3. Common pitfalls

### 3.1 Don't break the tracking ingest pipeline

`POST /api/track/events` is the **most security-sensitive route in the
project**. It's open (no API key), so it relies entirely on:

- Edge rate limiting (`src/middleware.ts` + `src/lib/rate-limit.ts`).
- Origin validation (`src/app/api/track/events/route.ts` inline fns).
- Payload sanitization (`src/lib/sanitize.ts`, called from `src/lib/track.ts`).
- IP anonymization (`src/lib/ua.ts` `anonymizeIP`, called from `track.ts`).

**Don't**:
- Add an API-key gate to it. Tracked-site SDKs can't carry secrets.
- Remove or weaken the origin check, even "just for testing".
- Change the order of operations in `ingest()` (sanitize → anonymize →
  parseUA → detect → persist).
- Change the response shape (`{ ok, sessionId, projectId }`) without
  updating the standalone SDK at `/api/track/script` and the in-dashboard
  `use-tracker.ts`.

### 3.2 Don't remove security layers

The 9 security controls in `.cursor/rules/security.mdc` are disjoint by
design (ADR-0004). Defense-in-depth means each one catches a different
class of attack. If you find yourself thinking "this sanitize step is
redundant because the route already validates", **stop** — the sanitize
step is the belt to the validator's suspenders. Both stay.

If you genuinely believe a layer is wrong, write an ADR proposing the
change; don't delete it in a PR.

### 3.3 Don't change API response shapes without a migration plan

Per Hyrum's Law: every field a client reads is part of the API. The
project follows a 4-phase migration plan documented in
[`api-style-guide.md#migration-plan`](./api-style-guide.md):

1. Add the new field (additive).
2. Update callers to use the new field.
3. Deprecate the old field (still present, marked deprecated).
4. Remove the old field in a follow-up release.

**Never**:
- Rename a field inline.
- Change an HTTP status code without a migration plan.
- Switch from `{ ok, data }` to a bare `data` (or vice versa).
- Remove `requestId` from a response — clients use it for log correlation.

### 3.4 Don't import server-only libs into client components

`z-ai-web-dev-sdk`, `fs`, `prisma`, `@prisma/client`, `socket.io` (server)
— all server-only. Importing them into `src/components/**` or
`src/app/**/page.tsx` will either (a) break the build, (b) bloat the
browser bundle, or (c) leak secrets. AI calls go through
`/api/projects/[id]/ai*` routes; the route handler lazy-imports the SDK
server-side.

### 3.5 Don't bypass the Zustand store for navigation

`useApp()` is the single source of truth for `view`, `activeProjectId`,
`tab`, `range`, `filters`. Don't set them via `useState` in a component
and try to keep them in sync with the store — you'll get out-of-sync bugs.
Use the actions: `openProject(id)`, `setTab(t)`, `setRange(r)`,
`setFilters(f)`, `goHome()`.

### 3.6 Don't mock the database in tests

Either (a) extract the logic into a pure function and test that, or (b)
write an integration test that hits the real dev server via `test.skipIf`.
Mocks lie about SQLite semantics — especially around `onDelete: Cascade`,
JSON columns, and case sensitivity.

### 3.7 Don't edit `src/components/ui/*` to customise behaviour

`src/components/ui/*` is generated shadcn/ui code. Customise by composing
(wrap a primitive in a new component under `src/components/app/`), not by
editing the primitive. If you must edit a primitive (rare), regenerate
the diff with `bunx shadcn@latest add <component>` first to confirm
you're not diverging from upstream.

### 3.8 Don't skip the worklog

If your task doesn't end with a `worklog.md` entry, the next agent has no
way to know what you did. Even a "no-op, decided not to change anything"
entry is valuable — it tells the next agent the question was asked and
answered.

### 3.9 Don't trust `next.config.ts` `ignoreBuildErrors`

`typescript.ignoreBuildErrors: true` and `eslint.ignoreDuringBuilds: false`
mean the **build** won't fail on TS errors but **will** fail on lint
errors. Always run `bun run lint` AND `bunx tsc --noEmit` separately —
the build passing does not imply type-safety.

### 3.10 Don't persist raw IPs or user agents

The pattern is: `anonymizeIP(rawIp)` → store. `parseUA(ua)` → store the
parsed `{device, browser, os}`, keep the raw UA in `Session.userAgent` for
replay forensics but derive no new fields from it. If you add a new
session-like model, follow the same pattern.

---

## 4. File boundary rules when working in parallel

Multiple agents may be working on this repo simultaneously. To avoid
clobbering each other:

### 4.1 Touch only what your task asks you to touch

Per AGENTS.md core behavior #5 (maintain scope discipline). If you spot a
bug in a file outside your scope:

1. **Don't fix it inline.** Note it in your worklog entry under "Blockers
   / observations".
2. The next agent whose scope includes that file will pick it up.
3. If the bug blocks your verification (e.g. a syntax error in another
   agent's WIP is making the dev server 500 on every page), document it
   in detail in your worklog — file, line, the exact fix needed — but
   don't apply the fix.

### 4.2 File-ownership map (typical parallel split)

| Area                                      | Owned by                                |
|-------------------------------------------|-----------------------------------------|
| `src/components/app/recording-player.tsx` | code-simplification agent (per worklog) |
| `src/components/app/live-tab.tsx`         | code-simplification agent               |
| `src/components/app/use-tracker.ts`       | code-simplification agent               |
| `src/components/app/page-mock.tsx`        | code-simplification agent               |
| `src/components/app/filter-bar.tsx`       | accessibility agent (recently edited)   |
| All other `src/components/app/*.tsx`      | open (check worklog for recent edits)   |
| `src/lib/*`                               | open                                    |
| `src/app/api/**`                          | open (api-and-interface-design agent owns migration) |
| `src/middleware.ts`                       | security-and-hardening agent            |
| `next.config.ts`                          | security-and-hardening agent            |
| `prisma/schema.prisma`                    | requires coordination (destructive `db push`) |
| `tests/**`                                | test-driven-development agent           |
| `docs/**`                                 | documentation agent / context-engineering agent |
| `.cursor/rules/**`                        | context-engineering agent               |
| `.github/workflows/**`                    | ci-cd-and-automation agent              |
| `AGENTS.md`, `worklog.md`                 | append-only; any agent may append       |

When in doubt, **grep the worklog** for the filename before editing it.

### 4.3 Append-only files

- `worklog.md` — append a `---`-separated entry. Never edit prior entries.
- `docs/adr/NNNN-*.md` — ADRs are immutable; supersede with a new ADR
  that references the old one.
- `logs/audit.jsonl`, `logs/app.jsonl` — runtime append-only.

### 4.4 Coordinating destructive operations

- `bun run db:push` is destructive (`--accept-data-loss` is baked into
  the script). Don't run it unless you've checked that no other agent is
  mid-query. If you must change the schema, announce it in your worklog
  entry **before** running the command.
- `bun run db:reset` wipes everything. Don't run it without explicit
  user permission.
- Deleting a file is rarely the right move. If a file is unused, mark it
  deprecated in a comment and leave it for the next agent to remove
  after confirming no caller relies on it.

### 4.5 Communication via worklog

When you finish a session, your worklog entry should answer:

1. What did you change? (files + counts)
2. Why? (one paragraph of motivation)
3. What did you consider but reject? (Chesterton's fence)
4. What blockers did you hit? (other agents' WIP, missing runtime, etc.)
5. What's left for the next agent? (deferred fixes, follow-up tasks)

If every agent does this, the worklog becomes a coordination channel:
the next agent reads your entry, knows what's safe to touch, and knows
what to defer.

---

## 5. Quick reference — the 30-second version

```
START:  read AGENTS.md → worklog.md (last 5) → context-map.md → relevant .cursor/rules/*.mdc
        + relevant skills/<name>/SKILL.md per AGENTS.md decision tree.

CODE:   use apiSuccess/apiError/paginated. Validate with src/lib/validate.ts.
        Sanitize at the edge. Anonymize before persist. Audit-log mutations.
        Use shadcn/ui + Tailwind tokens. WCAG 2.1 AA floor. Zustand for state.

VERIFY: bun run lint (exit 0) → bunx tsc --noEmit → bun test tests/ →
        bun run dev (compiles) → curl the endpoint → agent-browser the page.

LOG:    append a worklog.md entry (Task ID, Agent, Task, Work Log, Stage Summary).
        Note Chesterton's-fence decisions and blockers.

DON'T:  break ingest. Remove security layers. Change API shapes without a
        migration plan. Import server libs into client code. Mock the DB.
        Edit src/components/ui/*. Touch files outside your scope.
```
