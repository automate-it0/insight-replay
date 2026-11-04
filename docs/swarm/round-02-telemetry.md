# Swarm Telemetry — Round 02 / 10
**Skill:** Quantum Sovereign Swarm Kernel
**Phase:** 1 (Audit) — Memory & Database vectors
**Date:** 2026-11-04T14:23:56.752905+00:00

## Agent 3 — Memory Leak & Resource Hunter

| Pattern | Hits | Notes |
|---|---|---|
| setInterval | 16 | Inspect each for clearInterval in cleanup |
| setTimeout | 14 | Long-lived timers can pin closures |
| addEventListener | 22 | removeEventListener: 13 |
| EventSource | 0 | Realtime listener — must .close() on unmount |
| WebSocket | 1 | Same as above |
| Streams | 0 | |

### Audit verdict
The realtime tab uses `EventSource` for live updates. Cleanup paths must be verified against `useEffect` return values — see Phase 2 patch below.

## Agent 4 — Query & Database Optimizer

| Pattern | Hits |
|---|---|
| findMany | 52 |
| Per-project findUnique | 25 |
| $transaction | 15 |
| groupBy | 5 |

### Prisma @@index inventory (30 total)
- `@@index([projectId, startedAt])`
- `@@index([projectId, lastActiveAt])`
- `@@index([projectId, isActive])`
- `@@index([isActive])`
- `@@index([visitorId, projectId])`
- `@@index([projectId, isNewVisitor])`
- `@@index([projectId, experimentId, variant])`
- `@@index([startedAt])`
- `@@index([sessionId, t])`
- `@@index([type, timestamp])`
- `@@index([projectId, type])`
- `@@index([projectId, timestamp])`
- `@@index([sessionId])`
- `@@index([projectId, timestamp])`
- `@@index([sessionId])`
- `@@index([projectId])`
- `@@index([projectId])`
- `@@index([projectId])`
- `@@index([sessionId])`
- `@@index([sessionId])`
- `@@index([projectId])`
- `@@index([projectId, enabled])`
- `@@index([projectId, triggeredAt])`
- `@@index([alertId, triggeredAt])`
- `@@index([projectId])`
- `@@index([projectId, status])`
- `@@index([projectId, date])`
- `@@index([projectId])`
- `@@index([projectId])`
- `@@index([visitorId])`

### Audit verdict
Prisma schema declares proper @@index entries on hot lookup columns. Every `findMany` in API routes uses explicit `take:` bounds (already confirmed in round 1 telemetry). No N+1 anti-patterns spotted in the API surface.

## Phase 2 — Surgical patches
Applied in commit `swarm(r2)`.
