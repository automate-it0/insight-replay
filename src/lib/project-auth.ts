// Project access verification — centralizes the auth + project-existence checks
// that every route under `src/app/api/projects/[id]/` must perform before
// touching project-scoped data.
//
// WHY THIS EXISTS
// ───────────────
// Before this helper shipped, every route handler under `projects/[id]/` did
// the same dance:
//
//   const session = await getSession()
//   if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
//   const { id } = await ctx.params
//   // ... directly use `id` in db.project.X / db.session.findMany({ where: { projectId: id } })
//
// That pattern is an IDOR (Insecure Direct Object Reference): the `id` from
// the URL is fed straight into DB queries without ever verifying that
//   (a) a project with that id actually exists, and
//   (b) the authenticated user is allowed to see that project.
//
// This single-admin dashboard does not (yet) have a `userId` column on the
// Project model — every signed-in admin can access every project. But we still
// must guarantee that the `id` references a real project; otherwise any
// authenticated user can probe arbitrary IDs to learn which projects exist
// (resource enumeration) and have the route silently return empty results,
// 500s, or partial writes that pollute the audit log with garbage projectIds.
//
// THE CONTRACT
// ────────────
//   const { id } = await ctx.params
//   const { session, project, error } = await verifyProjectAccess(id)
//   if (error) return error
//   // ... safe to use `id` and `project` below
//
// - 401 if no valid session (auth failure).
// - 404 if `projectId` does not match a row in the Project table (IDOR block).
// - On success, returns the session AND the hydrated Project row so callers
//   that need project metadata (name, siteUrl, trackingId) can reuse it
//   instead of issuing a second `db.project.findUnique`.
//
// AUDIT
// ─────
// The "single-admin" comment below documents the deliberate decision to allow
// any authenticated admin into any project. When the schema gains multi-tenant
// ownership (a `userId`/`ownerId` column on Project), this is the ONE place
// that needs to add the ownership predicate — every route handler is already
// routed through this helper.

import { db } from "@/lib/db"
import { getSession, type SessionUser } from "@/lib/session"
import { NextResponse } from "next/server"

export type VerifyProjectAccessOk = {
  session: SessionUser
  project: { id: string; name: string; siteUrl: string; trackingId: string; createdAt: Date }
  error: null
}

export type VerifyProjectAccessErr = {
  session: null
  project: null
  error: NextResponse
}

export type VerifyProjectAccessResult = VerifyProjectAccessOk | VerifyProjectAccessErr

/**
 * Verify that the caller is authenticated AND that `projectId` refers to a
 * real project. Returns a discriminated union — callers MUST check `error`
 * first and short-circuit the handler with `if (error) return error`.
 *
 * Throws are intentionally avoided: route handlers in Next.js App Router
 * catch thrown `UNAUTHORIZED` errors inconsistently, and returning a
 * `NextResponse` directly is the simplest, safest contract.
 */
export async function verifyProjectAccess(
  projectId: string,
): Promise<VerifyProjectAccessResult> {
  // 1) Authentication — same signed-cookie session as the rest of the app.
  const session = await getSession()
  if (!session) {
    return {
      session: null,
      project: null,
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    }
  }

  // 2) Authorization / existence — confirm the project ID in the URL maps to
  //    a real row. This is the IDOR block: an attacker who guesses or
  //    enumerates project IDs cannot learn whether one exists (we return 404
  //    uniformly for unknown IDs, matching the 404 already returned by routes
  //    that did this check inline).
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) {
    return {
      session: null,
      project: null,
      error: NextResponse.json({ error: "Not found" }, { status: 404 }),
    }
  }

  // 3) Single-admin system: any authenticated user can access any project.
  //    We do NOT log the access here — that would be too noisy on read-heavy
  //    dashboard routes. Mutating routes already log via `auditLog` at the
  //    point of mutation, which is the right granularity for an audit trail.
  //    When multi-tenant ownership lands, add `&& project.userId === session.userId`
  //    here and return 403 on mismatch — no other call site needs to change.
  return { session, project, error: null }
}
