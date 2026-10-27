import { NextResponse } from "next/server"
import { runHealthChecks, sanitizeError } from "@/lib/observability"

// Health check endpoint — for load balancers / uptime monitors.
// Returns 200 if ok, 503 if degraded/down.
export async function GET() {
  try {
    const health = await runHealthChecks()
    const status = health.status === "ok" ? 200 : 503
    return NextResponse.json(health, { status })
  } catch (e) {
    const { status, body } = sanitizeError(e, undefined, "health")
    return NextResponse.json(body, { status })
  }
}
