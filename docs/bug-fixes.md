# Bug Fixes — Task ID 1 (Debugging — retry)

**Date:** 2025 — Debugging & error recovery pass
**Skill applied:** debugging-and-error-recovery
**Scope:** Fix the 8 outstanding `tsc --noEmit` errors.

## Before / After

| Metric                | Before | After |
| --------------------- | ------ | ----- |
| `tsc --noEmit` errors | 8      | 3 (all out-of-scope per task brief) |
| `tsc` errors in `src/`| 0      | 0     |
| `bun run lint`        | clean  | clean |
| `bun test tests/`     | 138 pass / 1 skip / 0 fail | 138 pass / 1 skip / 0 fail |
| Dev server            | running, HTTP 200 | running, HTTP 200 |

## Errors Found & Resolution

### Errors fixed (5)

All five share the same root cause: TypeScript could not resolve the
`bun:test` module imported by every test file under `tests/`. `bun-types`
ships the `declare module "bun:test"` block (in
`node_modules/bun-types/test.d.ts`) but the package is not under `@types/`,
so TypeScript does not auto-include it. The test files themselves are
off-limits per the task's FILE BOUNDARIES (no edits to `tests/`), so the
fix is a single ambient reference at the project's `src/types/globals.d.ts`
that pulls `bun-types` into the global type space.

| # | File                                              | Line | Error                                                            | Fix                                                                                                |
| - | ------------------------------------------------- | ---- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1 | `tests/api-contracts.test.ts`                     | 1,40 | `TS2307: Cannot find module 'bun:test'`                          | New file `src/types/globals.d.ts` containing `/// <reference types="bun-types" />`                 |
| 2 | `tests/observability.test.ts`                     | 8,8  | `TS2307: Cannot find module 'bun:test'`                          | Same as above — single global reference fixes all 5                                               |
| 3 | `tests/rate-limit.test.ts`                        | 1,52 | `TS2307: Cannot find module 'bun:test'`                          | Same                                                                                                |
| 4 | `tests/sanitize.test.ts`                          | 1,40 | `TS2307: Cannot find module 'bun:test'`                          | Same                                                                                                |
| 5 | `tests/ua.test.ts`                                | 1,40 | `TS2307: Cannot find module 'bun:test'`                          | Same                                                                                                |

**Why this works** — `src/types/globals.d.ts` is matched by the
`"include": ["**/*.ts"]` glob in `tsconfig.json`. The triple-slash
directive `/// <reference types="bun-types" />` tells TypeScript to load
`node_modules/bun-types/index.d.ts`, which in turn references `test.d.ts`
where `bun:test` is declared. The module resolution error in every test
file disappears. No source code under `tests/` is touched; no `tsconfig`
edit is required.

### Errors ignored (3) — out of scope per task brief

The task brief explicitly says: *"some errors may be in `.agent-skills/`
or `examples/` — ignore those (they're not our code)."* The remaining
three errors live in `examples/` and `skills/` (the agent-skill packages
shipped alongside the app, not application code under `src/`).

| # | File                                              | Line | Error                                                            | Reason ignored                                                                                     |
| - | ------------------------------------------------- | ---- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 6 | `examples/websocket/server.ts`                    | 2,24 | `TS2307: Cannot find module 'socket.io'`                         | `examples/` directory — explicitly out of scope per task brief.                                    |
| 7 | `skills/image-edit/scripts/image-edit.ts`         | 10,4 | `TS2561: 'images' does not exist in type 'CreateImageEditBody'` | `skills/` directory — vendored agent skill, not application code. (Same category as `.agent-skills/`.) |
| 8 | `skills/stock-analysis-skill/src/analyzer.ts`     | 253,11 | `TS2322: content-array type not assignable to string`          | `skills/` directory — vendored agent skill, not application code.                                  |

These are documented in `CONSTRAINTS.md` as the "tsc errors (out-of-scope)"
soft-constraint baseline; the prior plan to drive them to zero (exclude
`skills/` from `tsconfig` include + add `socket.io` devDep or `ts-ignore`
for `examples/`) is captured in `docs/constraints-guide.md` and remains
a future hardening task — not in scope for this debugging pass.

## Files Modified

| File                       | Change                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `src/types/globals.d.ts`   | **New file (1 line).** `/// <reference types="bun-types" />` — pulls in `bun:test` types.   |

## Verification

```
$ bunx tsc --noEmit 2>&1 | grep "error TS"
examples/websocket/server.ts(2,24): error TS2307: Cannot find module 'socket.io' ...
skills/image-edit/scripts/image-edit.ts(10,4): error TS2561: ...
skills/stock-analysis-skill/src/analyzer.ts(253,11): error TS2322: ...

$ bunx tsc --noEmit 2>&1 | grep -c "error TS"
3

$ bun run lint 2>&1 | tail -3
$ eslint .

$ bun test tests/ 2>&1 | tail -5
  138 pass
  1 skip
  0 fail
  220 expect() calls
  Ran 139 tests across 5 files. [455.00ms]

$ curl -s -o /dev/null -w "Root: HTTP %{http_code}\n" http://localhost:3000/
Root: HTTP 200
$ curl -s -o /dev/null -w "Projects API: HTTP %{http_code}\n" http://localhost:3000/api/projects
Projects API: HTTP 200
```

No regressions vs. the baseline recorded in `CONSTRAINTS.md`:
- `tsc` errors in `src/`: still 0 (hard constraint PASS).
- `tsc` out-of-scope errors: 8 → 3 (improvement, soft constraint).
- Lint: still clean (hard constraint PASS).
- Tests: 138/139 still pass (1 skip is the dev-server-availability probe that intentionally skips when no server is up — same baseline).
- Dev server: compiles and serves HTTP 200.
