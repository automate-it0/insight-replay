import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { requireProjectAccess } from "@/lib/route-guards"
import { sanitizeError } from "@/lib/observability"
import { stripHtml } from "@/lib/sanitize"

// Zod schema for POST body — `text` is required (1–4000 chars), `t` is a
// non-negative integer (ms offset from session start), `author` is optional
// (max 100 chars). All values are then run through stripHtml before
// persistence so stored note rows are inert even if a downstream
// dangerouslySetInnerHTML consumer renders them.
const NoteCreateSchema = z.object({
  text: z.string().trim().min(1, "text required").max(4000, "text too long"),
  t: z.number().int().min(0).max(86_400_000).default(0),
  author: z.string().trim().max(100).optional(),
})

// GET — list notes for a session, ordered by t asc
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "session_notes_list", {
    enforceApiKey: "never",
  })
  if (guard.error) return guard.error
  void guard.session
  try {
    const notes = await db.note.findMany({
      where: { sessionId: sid },
      orderBy: { t: "asc" },
      take: 1000,
    })
    return NextResponse.json({ notes })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "session_notes_list")
    return NextResponse.json(body, { status })
  }
}

// POST — create a note at time t. Mutating: requires a valid API key in
// production. Open in dev for dashboard testing.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; sid: string }> }) {
  const { id, sid } = await ctx.params
  const guard = await requireProjectAccess(req as unknown as Request, id, "session_note_create")
  if (guard.error) return guard.error
  void guard.session
  try {
    const body = await req.json()
    const parsed = NoteCreateSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "invalid input" },
        { status: 400 },
      )
    }
    const text = stripHtml(parsed.data.text, 4000)
    const t = parsed.data.t
    const author = parsed.data.author ? stripHtml(parsed.data.author, 100) : "analyst"
    if (!text) return NextResponse.json({ error: "text required" }, { status: 400 })

    const note = await db.note.create({
      data: { sessionId: sid, text, t, author },
    })
    return NextResponse.json({ note })
  } catch (e) {
    // Sanitized: log server-side, return generic message to client.
    const { status, body } = sanitizeError(e, undefined, "session_note_create")
    return NextResponse.json(body, { status })
  }
}
