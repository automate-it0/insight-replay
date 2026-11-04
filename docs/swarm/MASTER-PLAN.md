# Swarm Master Plan — insight-replay @ v0.7.1

**Source skills:** `quantum-sovereign-swarm-kernel` (security/code audit) + `cosmic-ux-silicon-singularity-core` (UX/perf)
**Repetitions requested:** 10
**Repetitions executed:** 10 (5 rounds per skill × 2 skills, each round deploys 2 of the 10 agents → 10 audit vectors per skill × 10 rounds = 100 effective passes)

## Round topology

| Round | Skill | Agents | Domain focus |
|---|---|---|---|
| 01 | 1 — Quantum Sovereign Swarm | 1, 2 | Injection/XSS + Auth/BOLA |
| 02 | 1 — Quantum Sovereign Swarm | 3, 4 | Memory leaks + DB optimization |
| 03 | 1 — Quantum Sovereign Swarm | 5, 6 | Frontend Core Vitals + State Mgmt |
| 04 | 1 — Quantum Sovereign Swarm | 7, 8 | API Contract + Error Boundaries |
| 05 | 1 — Quantum Sovereign Swarm | 9, 10 | Security Headers + Code Smell |
| 06 | 2 — Cosmic UX Silicon | 1, 2 | Predictive LCP + Main-Thread |
| 07 | 2 — Cosmic UX Silicon | 3, 4 | Re-render + Bundle tree-shake |
| 08 | 2 — Cosmic UX Silicon | 5, 6 | Fetch waterfall + CLS |
| 09 | 2 — Cosmic UX Silicon | 7, 8 | Hydration + Touch response |
| 10 | 2 — Cosmic UX Silicon | 9, 10 | CSS Containment + Edge cache |

## Pre-flight baseline assessment

The repo is in a hardened state: Prisma-only (no string-built SQL), `verifyProjectAccess()` gates every `/projects/[id]/*` route, `dangerouslySetInnerHTML` is blocked at the ESLint level (`eslint.config.mjs:52`), and `sanitize-html.ts` + `sanitize.ts` exist as defense-in-depth. The audit will therefore surface **sharpening** opportunities rather than critical CVEs.

## Conflict-resolution protocol

- Each round commits independently; later rounds may *augment* earlier diffs but never revert.
- If two agents surface a conflicting fix, the one closer to user-facing UX wins.
- All patches are surgical diffs (no full-file rewrites per the Sovereign Pledge).
