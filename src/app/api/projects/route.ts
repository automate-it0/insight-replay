import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { auditLog, AUDIT_ACTIONS } from "@/lib/audit"
import { getClientIP } from "@/lib/rate-limit"
import { getSession } from "@/lib/session"
import { validateUserUrl } from "@/lib/ssrf-guard"
import { stripHtml } from "@/lib/sanitize"

// Schema for POST /api/projects — validates + sanitizes the create-project
// payload. `name` is required (1–100 chars); `siteUrl` is optional but, when
// present, is passed through the SSRF guard (validateUserUrl) so the persisted
// URL cannot be a private-IP / localhost / non-http(s) value. Zod also strips
// unknown keys automatically (defence-in-depth against mass-assignment).
const CreateProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "name required")
    .max(100, "name too long"),
  siteUrl: z
    .string()
    .trim()
    .max(500, "siteUrl too long")
    .optional()
    .or(z.literal("")),
})

export async function GET() {
  // Cryptographic session verification — the middleware only does a cheap
  // cookie-presence check; this call actually verifies the HMAC signature and
  // expiry, so a forged cookie value cannot reach the protected logic below.
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const projects = await db.project.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { sessions: true } } },
    take: 100,
  })
  return NextResponse.json({ projects })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // Parse + validate the JSON body with Zod before any persistence. On
  // failure we return a 400 with the first human-readable Zod issue so the
  // caller knows which field was rejected. Unknown keys are stripped
  // automatically (Zod's default behaviour) — defence-in-depth against
  // mass-assignment / extra-field probes.
  let parsed: z.infer<typeof CreateProjectSchema>
  try {
    const body = await req.json()
    parsed = CreateProjectSchema.parse(body)
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    return NextResponse.json({ error: "invalid input" }, { status: 400 })
  }

  // stripHtml as a defence-in-depth backstop: Zod already bounds length +
  // trims, but stripHtml additionally removes any residual HTML tags and
  // escapes entities so the persisted name is inert even if a downstream
  // dashboard component renders it via dangerouslySetInnerHTML.
  const name = stripHtml(parsed.name, 100)
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 })

  // SSRF defense — `siteUrl` is a user-supplied URL that is later parsed
  // server-side for CORS origin matching and could be fetched by future
  // site-validation features. Validate at WRITE time so bad URLs never
  // enter the DB. Empty is allowed (the project can be created without a
  // site; siteUrl is optional). Non-empty must be a public http(s) URL.
  let safeSiteUrl = ""
  if (parsed.siteUrl && parsed.siteUrl.trim()) {
    const v = validateUserUrl(parsed.siteUrl)
    if (!v.ok) {
      return NextResponse.json({ error: `invalid siteUrl: ${v.reason}` }, { status: 400 })
    }
    // Persist the normalized, userinfo/fragment-stripped href — NOT the
    // raw input. This also defeats any `?@`-style authority tricks.
    safeSiteUrl = v.url.href
  }

  // Race-safety: the project create + the audit-log entry are wrapped in a
  // single Prisma interactive transaction so the audit trail can never
  // diverge from the project state (no orphan "project_created" entries for
  // a project that failed to insert, no projects without an audit entry).
  //
  // Note on duplicate-creation races: this does NOT prevent two concurrent
  // identical submissions from each creating a distinct project row —
  // Project has no natural unique key on (name, siteUrl) because two
  // operators may legitimately register the same site as separate tracking
  // contexts (e.g. staging vs prod). True idempotency would require the
  // client to send an Idempotency-Key header and the schema to persist it
  // in a `@unique` column; that's a larger surface change tracked as
  // follow-up. The transaction here covers atomicity of the audit pair.
  const clientIP = getClientIP(req as unknown as Request)
  const project = await db.$transaction(async (tx) => {
    const created = await tx.project.create({
      data: { name, siteUrl: safeSiteUrl },
    })
    await auditLog({
      action: AUDIT_ACTIONS.PROJECT_CREATED,
      projectId: created.id,
      actor: "api",
      ip: clientIP,
      details: { name: created.name, siteUrl: created.siteUrl },
    })
    return created
  })
  return NextResponse.json({ project })
}
