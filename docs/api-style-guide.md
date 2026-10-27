# Insight Replay — API Style Guide

This document is the **authoritative** specification for how HTTP APIs in
Insight Replay are shaped, named, versioned, and evolved. It is the
contract that `src/lib/api-response.ts` and `src/lib/validate.ts` enforce
in code, and that every new route MUST follow. Existing routes are on a
migration path (see [Migration plan](#migration-plan)) — they will be
brought inline incrementally without breaking clients.

---

## Table of contents

- [Guiding principles](#guiding-principles)
- [Response shape standard](#response-shape-standard)
- [Error codes](#error-codes)
- [HTTP status codes](#http-status-codes)
- [URL & naming conventions](#url--naming-conventions)
- [Pagination](#pagination)
- [Filtering & sorting](#filtering--sorting)
- [Authentication](#authentication)
- [Rate limiting](#rate-limiting)
- [Correlation (`x-request-id`)](#correlation-x-request-id)
- [Versioning](#versioning)
- [Hyrum's Law](#hyrums-law)
- [Migration plan](#migration-plan)
- [Examples](#examples)

---

## Guiding principles

1. **Contract-first.** The shape of a response IS the API. Once a client
   depends on a field, removing or renaming it is a breaking change. We
   define the contract with `src/lib/api-response.ts` and
   `src/lib/validate.ts` first, then implement the route against them.
2. **One-Version Rule.** Exactly one success envelope and one error
   envelope. No per-route ad-hoc shapes. If you need to add a field, add
   it to the envelope (additively) — never invent a new envelope.
3. **Structured errors.** Errors are `{ code, message, details? }`, never
   bare strings. The `code` is machine-readable and stable; clients can
   branch on it. The `message` is human-readable and may change.
4. **Don't break existing clients.** Additive changes only. New fields
   are fine; renamed/removed fields are breaking. See [Versioning](#versioning).
5. **Boring on purpose.** Every endpoint looks the same. A developer who
   has used one endpoint should be able to predict the shape of any other.

---

## Response shape standard

### Success: `{ ok: true, data, requestId }`

```jsonc
// 200 OK
{
  "ok": true,
  "data": {
    "id": "proj_abc",
    "name": "Marketing site",
    "domain": "example.com"
  },
  "requestId": "req_4f8c…"
}
```

- `ok` is always `true` for success.
- `data` is the resource (object), the created resource (201), the
  deleted/no-content marker (204 → empty body), or the list (array).
  For paginated lists, see [Pagination](#pagination).
- `requestId` is echoed in the body AND in the `x-request-id` response
  header for correlation with `logs/app.jsonl`.

### Error: `{ ok: false, error: { code, message, details? }, requestId }`

```jsonc
// 404 Not Found
{
  "ok": false,
  "error": {
    "code": "PROJECT_NOT_FOUND",
    "message": "Project 'proj_xyz' was not found"
  },
  "requestId": "req_4f8c…"
}

// 400 Validation Error (with field details)
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": {
      "fields": {
        "name": "is required",
        "domain": "must be a valid domain"
      }
    }
  },
  "requestId": "req_4f8c…"
}
```

- `ok` is always `false` for errors.
- `error.code` is `SCREAMING_SNAKE_CASE`, stable, and machine-readable.
  See [Error codes](#error-codes) for the catalog.
- `error.message` is a short, human-readable description safe to show
  end users. May change between releases.
- `error.details` is OPTIONAL. Use it for structured hints (field errors,
  hint URLs, retry-after, etc.). Never put secrets, stack traces, or
  raw DB error strings here — log those via `src/lib/observability.ts`.
- `requestId` is the same value as the `x-request-id` response header.

### Paginated: `{ ok: true, data: [...], pagination, requestId }`

```jsonc
// 200 OK
{
  "ok": true,
  "data": [
    { "id": "sess_1", "startedAt": "2024-01-15T10:30:00Z" },
    { "id": "sess_2", "startedAt": "2024-01-15T10:31:00Z" }
  ],
  "pagination": {
    "total": 234,
    "page": 2,
    "pageSize": 20,
    "totalPages": 12
  },
  "requestId": "req_4f8c…"
}
```

- `pagination.total` is the **total count of items matching the query**,
  not `data.length`. Required even when `total === 0` (return `data: []`).
- `pagination.totalPages` is `Math.ceil(total / pageSize)` (0 when total is 0).

### 204 No Content

For DELETE / 204 success, the body is empty — no envelope. The
`x-request-id` header is still set. (This matches the HTTP spec; clients
treat 204 as "it worked, nothing to say.")

---

## Error codes

All error codes are `SCREAMING_SNAKE_CASE`. Codes are **stable** — clients
may branch on them. Messages may change.

### Generic codes

| Code                 | HTTP | Use when                                                  |
| -------------------- | ---- | --------------------------------------------------------- |
| `BAD_REQUEST`        | 400  | Generic malformed input (no more specific code applies).  |
| `VALIDATION_ERROR`   | 400  | One or more fields failed validation. Put field errors in `details.fields`. |
| `UNAUTHORIZED`       | 401  | No credentials, or credentials invalid/expired.           |
| `FORBIDDEN`          | 403  | Authenticated but not allowed to do this.                 |
| `NOT_FOUND`          | 404  | Resource doesn't exist (or caller can't see it — return 404 not 403 to avoid enumeration). |
| `METHOD_NOT_ALLOWED` | 405  | Wrong HTTP verb on a known path.                          |
| `CONFLICT`           | 409  | Request conflicts with current state (duplicate, stale version, race). |
| `GONE`               | 410  | Resource existed but was deleted.                         |
| `PAYLOAD_TOO_LARGE`  | 413  | Request body exceeds size limit.                          |
| `UNPROCESSABLE`      | 422  | Syntactically valid request that semantically can't be processed (rare; prefer 400/422). |
| `RATE_LIMIT_EXCEEDED`| 429  | Rate limit hit. Include `Retry-After` and `X-RateLimit-Reset` headers. |
| `INTERNAL_ERROR`     | 500  | Unexpected server failure. Log details; don't leak to client. |
| `NOT_IMPLEMENTED`    | 501  | Endpoint exists but the operation is not yet supported.   |
| `BAD_GATEWAY`        | 502  | Upstream service failed.                                  |
| `SERVICE_UNAVAILABLE`| 503  | Temporarily down (maintenance, dependency outage).        |
| `GATEWAY_TIMEOUT`    | 504  | Upstream timed out.                                       |

### Domain-specific codes

Domain codes follow the pattern `<RESOURCE>_<PROBLEM>`. Examples:

| Code                       | HTTP | Use when                                              |
| -------------------------- | ---- | ----------------------------------------------------- |
| `PROJECT_NOT_FOUND`        | 404  | Project ID doesn't exist.                             |
| `PROJECT_APIKEY_INVALID`   | 401  | API key missing or doesn't match the project.         |
| `SESSION_NOT_FOUND`        | 404  | Session ID doesn't exist (under this project).        |
| `EVENT_TYPE_INVALID`       | 400  | Track event has an unknown `type`.                    |
| `FUNNEL_NOT_FOUND`         | 404  | Funnel ID doesn't exist.                              |
| `DASHBOARD_NAME_TAKEN`     | 409  | Dashboard with this name already exists.              |
| `APIKEY_REVOKED`           | 401  | API key has been revoked.                             |
| `EXPERIMENT_NOT_COMPLETE`  | 409  | Tried to read experiment results before completion.   |

> **Rule of thumb:** if the client might want to branch on the specific
> reason, give it a domain code. If it's just "your input was bad", use
> `VALIDATION_ERROR` and put the field in `details.fields`.

---

## HTTP status codes

| Code | Meaning                | When to use                                                                                  |
| ---- | ---------------------- | -------------------------------------------------------------------------------------------- |
| 200  | OK                     | Successful GET, PATCH, PUT (returns the resource).                                           |
| 201  | Created                | Successful POST that created a resource (returns the created resource).                      |
| 204  | No Content             | Successful DELETE, or PUT/PATCH where the response is intentionally empty.                   |
| 400  | Bad Request            | Malformed JSON, missing required query params, validation failures.                          |
| 401  | Unauthorized           | No credentials, or invalid/expired credentials.                                              |
| 403  | Forbidden              | Authenticated but not allowed.                                                               |
| 404  | Not Found              | Resource doesn't exist (or caller can't see it).                                             |
| 405  | Method Not Allowed     | Path exists but verb not supported (e.g. PUT on a GET-only route).                           |
| 409  | Conflict               | Duplicate, stale version, race condition.                                                    |
| 422  | Unprocessable Entity   | Rare; syntactically valid but semantically nonsensical. Prefer 400 for validation.           |
| 429  | Too Many Requests      | Rate limit hit. Include `Retry-After`.                                                       |
| 500  | Internal Server Error  | Unexpected server failure. Log details; return generic message.                              |
| 503  | Service Unavailable    | Temporarily down (e.g. DB unreachable). Used by `/api/health`.                               |

**Rules:**

- Never return 200 with an error body. If something went wrong, the status
  reflects it.
- Never return 4xx/5xx with a success-shaped body. Errors use the error
  envelope.
- 404 vs 403: if the caller might not be allowed to know the resource
  exists, return 404 (not 403) to avoid enumeration.
- 401 vs 403: 401 = "who are you?"; 403 = "I know who you are, but you
  can't do that".

---

## URL & naming conventions

- **Plural nouns.** `/api/projects`, `/api/sessions`, `/api/events`. Even
  for a single resource, the collection is plural (`/api/projects/:id`).
- **Kebab-case** for path segments. `/api/projects/:id/api-keys`, not
  `/api/projects/:id/apiKeys` or `/api/projects/:id/api_keys`.
- **Nested resources** express ownership. `/api/projects/:id/sessions`
  lists sessions under a project. Keep nesting shallow (max 2 levels);
  beyond that, use query params (e.g. `?projectId=…`).
- **IDs are opaque strings** in the URL — never expose sequential
  integers. Cuids/UUIDs are fine. Prefixes (`proj_`, `sess_`) are
  encouraged for debuggability.
- **Trailing slashes** are not used. `/api/projects/` is wrong; redirect
  or 404 it.
- **Verbs in paths** are allowed only when no RESTful shape fits:
  `/api/projects/:id/experiments/:eid/analyze` (an action, not a
  resource). Prefer a sub-resource for nouns.
- **Query params are snake_case** for consistency with the rest of the
  API. (`?page_size=20` is WRONG; use `?pageSize=20`. We use camelCase
  for query params because it's the existing convention in this codebase
  and in the dashboard's `api()` helper.)

---

## Pagination

**Request:**

```
GET /api/projects/proj_abc/sessions?page=2&pageSize=20
```

- `page` — 1-indexed integer, default `1`, min `1`.
- `pageSize` — integer, default `20`, min `1`, max `100`. Requests above
  100 are clamped to 100 (not rejected — be liberal in what you accept).

**Response:**

```jsonc
{
  "ok": true,
  "data": [/* up to pageSize items */],
  "pagination": {
    "total": 234,
    "page": 2,
    "pageSize": 20,
    "totalPages": 12
  },
  "requestId": "req_4f8c…"
}
```

- `total` is the count of items matching the query (NOT `data.length`).
- Always return `pagination` even when `total === 0` — clients can render
  "0 results" without a special case.
- Use `src/lib/validate.ts`'s `validatePagination(params)` to parse
  defensively. It never throws and never returns out-of-bounds values.

**Cursor pagination** is not currently used. If a list grows to the point
where offset pagination is too slow, add cursor pagination as a NEW query
param (`?cursor=…`) and return `pagination.nextCursor` in the response —
keep offset pagination working so existing clients don't break.

---

## Filtering & sorting

**Filtering** uses query params, one per dimension:

```
GET /api/projects/proj_abc/sessions?filter=rage&range=7&q=signup
GET /api/projects/proj_abc/sessions?device=mobile&country=US& rage=1
```

- `filter` — semantic filter (e.g. `rage`, `dead`, `excessive_scroll`).
  Multiple values via comma: `?filter=rage,dead`.
- `range` — time range in days (integer). Default `7`. Applied to
  `startedAt` (or `timestamp` for events) as `now - range * 86_400_000`.
- `q` — full-text search query.
- Field-specific filters use the field name directly
  (`?device=mobile`, `?country=US`). Multiple values via comma.

**Sorting** uses `sort`:

```
?sort=-startedAt        # descending by startedAt
?sort=startedAt         # ascending
?sort=-rage,startedAt   # primary desc, secondary asc
```

- `-` prefix = descending.
- Multiple sort keys comma-separated, applied in order.
- Unknown sort fields are silently ignored (defensive).

**Conventions:**

- Same param names across endpoints. `range` always means days;
  `filter` always means the semantic filter; `q` always means
  full-text search. Don't invent new names for the same concept.
- Filters are AND-combined. OR requires a different endpoint or a
  `?any=…` param (not currently used).

---

## Authentication

Two mechanisms, both supported everywhere auth is required:

1. **`Authorization: Bearer <key>` header** (preferred). Standard,
   cacheable, doesn't leak into URLs/logs.
2. **`?apikey=<key>` query param** (fallback). For browser testing where
   setting headers is awkward. **Caveat:** this leaks the key into URLs,
   proxy logs, and referrers — never use in production frontends.

```bash
# Header form (preferred)
curl -H "Authorization: Bearer pk_live_abc123" \
     https://api.example.com/api/projects/proj_abc/stats

# Query form (browser testing only)
curl https://api.example.com/api/projects/proj_abc/stats?apikey=pk_live_abc123
```

**Currently enforced:** only `/api/projects/:id/protected-test` actually
checks an API key (see ADR-0004). The auth helper `src/lib/auth.ts` is
ready to be wired into more routes incrementally. The tracking ingest
endpoint (`/api/track/events`) is intentionally open and relies on
Origin/CORS validation (see ADR-0004) because the SDK cannot negotiate
credentials.

**Auth failures:**

- Missing key → `401` with code `UNAUTHORIZED`.
- Invalid/expired/revoked key → `401` with code `PROJECT_APIKEY_INVALID`
  (or `APIKEY_REVOKED`).
- Valid key but lacks permission for this resource → `403` `FORBIDDEN`.
- For resources the caller may not see: return `404` `NOT_FOUND` (not 403)
  to avoid revealing the resource's existence.

---

## Rate limiting

Currently enforced **only** on `/api/track/events` (the open ingest
endpoint). The limit is per-IP and enforced in `src/middleware.ts` via
`src/lib/rate-limit.ts`. When a route is rate-limited:

**On success (under the limit):**

```
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1731678200
```

**On 429 (over the limit):**

```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-RateLimit-Reset: 1731678200
Content-Type: application/json

{
  "ok": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded"
  },
  "requestId": "req_4f8c…"
}
```

- `Retry-After` is in seconds.
- `X-RateLimit-Reset` is a Unix timestamp (seconds since epoch) when the
  limit resets.
- Use `tooManyRequests()` from `src/lib/api-response.ts` to produce this
  response — it stamps both headers automatically.

---

## Correlation (`x-request-id`)

Every API response includes a `x-request-id` header for correlation with
`logs/app.jsonl` (structured logs from `src/lib/observability.ts`).

**Behaviour:**

- If the incoming request has an `x-request-id` header, it's echoed back
  on the response.
- If not, the middleware (`src/middleware.ts`) generates one
  (`req_<random>`).
- The response body also includes `requestId` so clients parsing JSON
  can use it without reading headers.
- Use `getRequestIdFromRequest(req)` at the top of a handler to thread
  the id through to `apiSuccess(data, { requestId })`, `serverError(..., { requestId })`, etc.

```typescript
import { apiSuccess, getRequestIdFromRequest } from "@/lib/api-response"

export async function GET(req: NextRequest) {
  const requestId = getRequestIdFromRequest(req)
  // ... do work, log with { requestId } ...
  return apiSuccess(data, { requestId })
}
```

---

## Versioning

**Currently unversioned.** All routes live under `/api/...` with no `v1`
prefix. This is intentional for a v1 product:

- Adding `/v1/` now would be cargo-culting — we have no v2 to distinguish
  from.
- The One-Version Rule says there's one shape; we evolve it additively
  until we genuinely can't, then introduce `/v2/` in parallel.

**When to add `/v1/`:**

- When you're about to ship a `/v2/`. (You don't version until you have
  a second version.)
- When you want to clearly mark "stable" vs "experimental" endpoints.
  In that case, mark experimental with a header (`Api-Experimental: true`)
  or a path prefix (`/api/experimental/...`), not by versioning the stable
  ones.

**When to introduce `/v2/`:**

- When an additive change is impossible (e.g. you need to change a
  field's type, remove a field, or change the semantics of an existing
  field). Then:
  1. Keep `/v1/...` working unchanged for a deprecation period (min 6 months).
  2. Add `/v2/...` with the new shape.
  3. Document the migration path.
  4. Announce the deprecation in the response via a `Deprecation` header
     and/or a `Sunset` header (RFC 8594) on `/v1/...` responses.

---

## Hyrum's Law

> With a sufficient number of users of an API, it does not matter what
> you promise in the contract: all observable behaviours of your system
> will be depended on by somebody.
> — Hyrum Wright

**What this means for Insight Replay:**

- Every field you return WILL be depended on, even if undocumented.
  Order matters. Types matter. Edge-case values matter.
- Empty `null` vs missing field vs empty string `""` are three different
  things to a client. Pick one and stick with it.
- The order of items in a list response WILL be depended on. If you
  change the default sort order, you break clients. Document the default
  order and don't change it without bumping the version.
- Error messages WILL be string-matched by some client somewhere, even
  though we tell them not to. That's why `error.code` exists — promote
  branching on the code, not the message.
- HTTP status codes WILL be depended on. Don't return 200 for errors
  "because it's easier for the client to parse".
- Response headers (e.g. `X-RateLimit-Remaining`) WILL be depended on.
  Don't rename them.

**Practical rules:**

1. Be intentional about every observable behaviour. If you don't want
   clients to depend on it, don't ship it.
2. Document every field, every header, every status code, every order.
3. When you must change something observable, treat it as a breaking
   change — see [Versioning](#versioning).
4. The newer the API, the more freedom you have to change things. The
   more users, the less. Tighten the contract over time, don't loosen it.

---

## Migration plan

Existing routes (53 `route.ts` files under `src/app/api/`) predate this
style guide. They return ad-hoc shapes like `{ error: "..." }` (no code,
no envelope) and `{ project, counts }` (no `ok`/`data` wrapper). We will
NOT rewrite them all at once — that would break the dashboard's `api()`
helper in `src/lib/api.ts` and every component that calls it.

### Strategy: additive, incremental, never break clients.

**Phase 1 — Done (this task):** Ship `src/lib/api-response.ts` and
`src/lib/validate.ts`. No existing route changes. New routes MUST use
the new helpers from day one.

**Phase 2 — Opt-in migration:** Update the dashboard's `api()` helper
(`src/lib/api.ts`) to accept BOTH the old ad-hoc shape AND the new
envelope. The helper unwraps `data` from `{ ok: true, data }` if present,
else returns the body as-is. This means routes can be migrated one at a
time without breaking the dashboard.

```typescript
// src/lib/api.ts (Phase 2 sketch — NOT yet implemented)
export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    // New envelope: { ok: false, error: { code, message, details? } }
    if (body?.ok === false && body?.error?.message) {
      throw new Error(`${res.status} ${body.error.code}: ${body.error.message}`)
    }
    // Old shape: { error: "..." }
    throw new Error(`${res.status} ${body?.error ?? res.statusText}`)
  }
  const body = await res.json().catch(() => ({}))
  // New envelope: { ok: true, data: T }
  if (body?.ok === true && "data" in body) return body.data as T
  // Old shape: return as-is
  return body as T
}
```

**Phase 3 — Route-by-route migration:** Each route file moves to the new
helpers. Prioritise by:
1. Routes that already return errors as bare strings (lowest effort,
   highest value — clients get structured codes).
2. Routes called by external clients (track events, AI endpoints).
3. Internal dashboard-only routes (lowest risk; can be batched).

Each migration is a separate PR with its own review and verification —
no big-bang rewrite.

**Phase 4 — Deprecation:** Once all routes are migrated, the old ad-hoc
shapes are no longer produced. Any remaining clients depending on them
are alerted via `Deprecation` headers and given a sunset date.

### Migration checklist (per route)

- [ ] Replace `NextResponse.json(data)` with `apiSuccess(data)`.
- [ ] Replace `NextResponse.json({ error: "..." }, { status: 4xx })`
      with the appropriate shortcut (`badRequest`, `notFound`, etc.).
- [ ] Replace ad-hoc validation with `validate.ts` utilities; return
      `validationError()` on failure.
- [ ] Replace `NextResponse.json({ ok: true })` (DELETE) with
      `new NextResponse(null, { status: 204 })` or `apiSuccess(null, 204)`.
- [ ] Thread `requestId` through with `getRequestIdFromRequest(req)`.
- [ ] Update `docs/api-reference.md` to reflect the new shape.
- [ ] Run `bun test` — all 138 tests must still pass.

---

## Examples

### Create a project (POST)

**Request:**

```http
POST /api/projects
Content-Type: application/json
Authorization: Bearer pk_live_abc123
x-request-id: req_client_123

{ "name": "Marketing site", "domain": "example.com" }
```

**Response (201):**

```jsonc
{
  "ok": true,
  "data": {
    "id": "proj_abc",
    "name": "Marketing site",
    "domain": "example.com",
    "createdAt": "2024-01-15T10:30:00Z"
  },
  "requestId": "req_client_123"
}
```

### Validation error (400)

**Request:**

```http
POST /api/projects
Content-Type: application/json

{ "name": "", "domain": "not-a-domain" }
```

**Response (400):**

```jsonc
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": {
      "fields": {
        "name": "is required",
        "domain": "must be a valid domain"
      }
    }
  },
  "requestId": "req_4f8c…"
}
```

### Paginated list (200)

**Request:**

```http
GET /api/projects/proj_abc/sessions?page=2&pageSize=20&filter=rage&range=7
```

**Response (200):**

```jsonc
{
  "ok": true,
  "data": [
    { "id": "sess_1", "rage": true, "startedAt": "2024-01-15T10:30:00Z" },
    { "id": "sess_2", "rage": true, "startedAt": "2024-01-15T10:31:00Z" }
  ],
  "pagination": {
    "total": 234,
    "page": 2,
    "pageSize": 20,
    "totalPages": 12
  },
  "requestId": "req_4f8c…"
}
```

### Not found (404)

```jsonc
{
  "ok": false,
  "error": {
    "code": "PROJECT_NOT_FOUND",
    "message": "Project 'proj_xyz' was not found"
  },
  "requestId": "req_4f8c…"
}
```

### Rate limit (429)

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1731678200
Content-Type: application/json

{
  "ok": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Rate limit exceeded"
  },
  "requestId": "req_4f8c…"
}
```

### Delete (204)

```http
DELETE /api/projects/proj_abc
Authorization: Bearer pk_live_abc123
```

```http
HTTP/1.1 204 No Content
x-request-id: req_4f8c…

(empty body)
```

### Internal error (500)

```jsonc
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error"
  },
  "requestId": "req_4f8c…"
}
```

> Full details are logged to `logs/app.jsonl` keyed by `requestId`; the
> client gets only a generic message and the correlation id.
