import { NextResponse } from "next/server"
import { banIP } from "@/lib/ip-ban"

// Honeypot trap — any request to /api/trap/* auto-bans the requesting IP
// with an escalating duration (1h → 24h → 7d → permanent) based on how
// many times this IP has hit a trap before. These endpoints are NEVER
// linked from the UI — only automated scanners/probes hit them.

export async function GET(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  // Duration is computed from ban count inside banIP() — no fixed window.
  await banIP(ip, "honeypot_trap")
  return NextResponse.json(
    { error: "Not found" },
    { status: 404 }
  )
}

export async function POST(req: Request) {
  return GET(req)
}

export async function PUT(req: Request) {
  return GET(req)
}

export async function DELETE(req: Request) {
  return GET(req)
}
