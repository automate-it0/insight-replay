<!-- Thanks for opening a PR! Fill in the sections below. -->
<!-- Delete anything that doesn't apply. -->

## Summary

<!-- What does this PR do, and why? One paragraph + bullet points if useful. -->

-

## Type of change

<!-- Check one. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Refactor (no behavior change)
- [ ] Performance improvement
- [ ] Documentation
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] CI / tooling

## Checklist

<!-- All boxes must be checked before requesting review. -->

- [ ] **Lint passes** — `bun run lint` exits 0 locally
- [ ] **Type-check passes** — `bunx tsc --noEmit` reviewed (warn-only is acceptable; new errors are not)
- [ ] **Tests added or updated** for the change (unit tests under `tests/`, contract tests under `tests/api-contracts.test.ts` if API shapes changed)
- [ ] **All tests pass** — `bun test tests/` green (138 pass + 1 skip is the current baseline)
- [ ] **Local quality gate green** — `./scripts/check-quality.sh` exits 0
- [ ] **Manual verification done** — dev server renders, core flow exercised, no console errors
- [ ] **No `console.log` left in production source** (`src/`, `mini-services/`) — use the structured logger in `src/lib/observability.ts`
- [ ] **Docs updated** if this changes API contracts, architecture, or ADRs (see `docs/`)
- [ ] **No secrets committed** — API keys, tokens, or credentials are in env vars, not code
- [ ] **BREAKING CHANGE footer documented** (if applicable) — Conventional Commits footer with `BREAKING CHANGE:` summary, plus migration notes in the PR description
- [ ] **CHANGELOG.md [Unreleased] entry added** (if user-facing) — describes the change under the `## [Unreleased]` heading following Keep a Changelog format

## Risk

<!-- What could this PR break? What's the blast radius? -->

- Affected areas:
- Risk level (low / medium / high):
- Mitigations:

## Testing

<!-- How did you verify this works? Be specific — paste curl commands, test
names, screenshots, etc. "It works" is not enough. -->

-

## Screenshots / Recordings

<!-- For UI changes only. Before/after if applicable. -->

## Rollback

<!-- If this needs to be reverted, what's the procedure? -->

-

## Related issues / ADRs

<!-- "Closes #123" / "Implements ADR-0007" etc. -->

-
