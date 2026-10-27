# ADR-0001: Use Prisma + SQLite over PostgreSQL

## Status
Accepted (2025-01-01)

## Context
Insight Replay is a self-hosted Microsoft Clarity-style analytics tool that needs to be
launched as a **demo / prototype** with the absolute minimum amount of operational
friction. The data model is fully relational — `Project`, `Session`, `Event`, `Insight`,
`Funnel`, `Goal`, `Alert`, `Experiment`, etc., with foreign-key cascades and JSON-encoded
columns on several rows — but the scale we are designing for is a single tenant with at
most a few thousand sessions. The team is using Next.js 16 + TypeScript and already plans
to adopt Prisma as the ORM for type safety and migration ergonomics.

The forces driving this decision:

- **Zero-config setup.** Reviewers and contributors must be able to `bun install`,
  `bun run db:push`, `bun run dev` and have a working app. No external server should be
  required; no Docker compose file should be required for the demo to start.
- **Single-process deployability.** The Next.js standalone build should ship the database
  with it so the demo can run on one box behind the existing Caddy gateway.
- **Type-safe ORM.** Prisma is the preferred choice regardless of the underlying engine —
  the question is which `datasource` Prisma should target.
- **Acceptable concurrency.** Writes happen on the tracking ingest endpoint
  (`POST /api/track/events`) which is rate-limited to 100 req/min/IP. Reads are
  dashboard queries, mostly `findMany` + JS-side aggregation. Both are well within
  SQLite's practical envelope.
- **GDPR friendliness.** The data never leaves the host; the file is trivial to wipe or
  rotate. (Note: SQLite does not encrypt at rest — see Consequences.)

## Decision
Use **Prisma ORM with the `sqlite` provider**, persisting to a single file at
`db/custom.db` (configured via `DATABASE_URL=file:./db/custom.db`).

`prisma/schema.prisma` therefore starts with:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
generator client {
  provider = "prisma-client-js"
}
```

All schema changes are applied via `bun run db:push` (`prisma db push --accept-data-loss`),
which is fine for a demo but would be replaced by `prisma migrate` for a production
deployment. SQLite's lack of an array column type is handled by JSON-stringifying arrays
and objects into `String` columns (e.g. `Funnel.steps`, `Dashboard.layout`,
`Experiment.variants`, `Segment.filters`) and parsing them back on read.

## Consequences

**Positive**

- A reviewer can clone the repo and have a working app in one `db:push` — no Postgres
  server, no Docker image, no connection string.
- The entire database is one file (`db/custom.db`) that can be `scp`'d, deleted, or
  snapshot-copied for backup. This is invaluable for the demo: the seeded "Acme Inc."
  dataset ships with the repo's runtime state.
- Prisma's TypeScript types work identically against SQLite and Postgres, so swapping the
  provider later is mostly a schema-level change — the route handler code stays the same.
- WAL mode (which Prisma enables by default for SQLite) gives us concurrent readers +
  a single writer, which is sufficient at our write volume.
- Single-file deploys well to a Next.js standalone build (the `db/` directory is
  sibling to the server bundle).

**Negative**

- **Single writer.** SQLite serialises writes. Under a real traffic spike the ingest
  endpoint would queue behind a single writer lock. The rate limiter (100 req/min/IP)
  makes this a non-issue at demo scale, but it would be a hard ceiling in production.
- **No encryption at rest.** The file is plain bytes on disk. PII (anonymized IPs —
  see ADR-0004) and visitor data are stored unencrypted. A production deployment would
  need LUKS / file-system encryption or a switch to Postgres with column-level encryption.
- **No built-in replication.** There is no read-replica story; scaling out reads would
  require sharding at the app layer or migrating to Postgres.
- **No full-text search, no JSON operators.** Several endpoints work around this by
  loading rows into Node and aggregating in JS (e.g. funnel analyze, journeys,
  retention cohorts). At demo scale this is fine; at production scale it would not be.
- **No native `Enum` type.** Status / metric / condition fields are stored as plain
  strings and validated in route handlers (e.g. `VALID_METRICS`,
  `VALID_CONDITIONS` in the alerts routes).

## Alternatives Considered

### PostgreSQL (via Prisma)
- **Pros:** Real concurrency, JSONB, full-text search, managed hosting (Supabase, Neon,
  RDS), mature replication, native enums, encryptable at rest.
- **Cons:** Requires a running server for the demo. Either Docker compose (extra
  friction for reviewers) or a managed instance (extra cost + signup). Schema changes
  would need `prisma migrate` instead of the trivially-destructive `db push`. Overkill
  for a single-tenant demo where the whole dataset fits in memory.
- **Rejected for v1.** Revisit when the project needs multi-tenant scale or moves to
  production. The Prisma schema is portable — switching providers is a one-day task.

### MySQL (via Prisma)
- **Pros:** Mature, widely supported, slightly faster than Postgres at simple primary-key
  reads in some benchmarks.
- **Cons:** Same operational overhead as Postgres (external server required) without
  Postgres's superior JSON / full-text support. Inferior choice on both axes.
- **Rejected.** If we move off SQLite, we go to Postgres.

### MariaDB / PlanetScale / Turso / Cloudflare D1
- Each adds a vendor lock-in or a different ops model that does not fit the
  "single-file demo" brief.
- **Rejected** for the prototype.

### Plain JSON files (no DB)
- Considered for a few minutes as the absolute zero-config option.
- **Rejected:** the data model is genuinely relational (sessions → events → insights with
  cascade deletes), and a JSON-file implementation would reimplement joins, indexes, and
  transactions badly.
