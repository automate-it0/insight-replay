"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useApp } from "@/store/app"
import { Sidebar } from "@/components/app/sidebar"
import { DashboardView } from "@/components/app/dashboard-view"
import { ProjectView } from "@/components/app/project-view"
import { Loader2 } from "lucide-react"

// Dashboard root. Client component.
//
// Auth model: the Edge middleware does a cheap cookie-presence check on every
// request and redirects unauthenticated browsers to /login before they ever
// get here. But middleware only checks for cookie PRESENCE — a tampered or
// expired cookie would pass the middleware gate and reach this page. So on
// mount we additionally call /api/auth/me, which performs the full HMAC +
// expiry verification server-side. If /me returns 401 (bad/expired session),
// we hard-redirect to /login. This is the second layer of the defense-in-
// depth pattern: middleware = first-line redirect, route handlers = real
// security boundary.
//
// The check runs once per dashboard mount. Subsequent API calls from the
// dashboard are themselves protected (each route handler calls getSession()
// or is gated by the middleware), so a session that becomes invalid mid-
// session will surface as 401s on the next API call — those errors are
// handled by the individual fetch sites (they redirect to /login too).

type AuthState = "checking" | "authenticated" | "unauthenticated"

export default function Home() {
  const view = useApp((s) => s.view)
  const router = useRouter()
  const [auth, setAuth] = useState<AuthState>("checking")

  useEffect(() => {
    let alive = true
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => {
        if (!alive) return null
        if (r.status === 401) {
          setAuth("unauthenticated")
          return null
        }
        return r.ok ? r.json() : null
      })
      .then((data) => {
        if (!alive) return
        if (data?.ok && data?.user) {
          setAuth("authenticated")
        } else {
          setAuth("unauthenticated")
        }
      })
      .catch(() => {
        if (alive) setAuth("unauthenticated")
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (auth === "unauthenticated") {
      // Preserve the current path so login can bounce back here.
      const from = window.location.pathname + window.location.search
      router.replace(`/login?from=${encodeURIComponent(from)}`)
    }
  }, [auth, router])

  if (auth !== "authenticated") {
    // Loading + redirecting states share the same minimal UI to avoid a
    // flash of the dashboard shell before the auth check completes.
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-background"
        role="status"
        aria-live="polite"
      >
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
          <p className="text-sm">
            {auth === "checking" ? "Verifying session…" : "Redirecting to login…"}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-background bg-grid">
      <div className="flex-1 flex flex-col md:flex-row min-h-0">
        <Sidebar />
        <main id="main-content" className="flex-1 min-w-0 flex flex-col">
          {view === "dashboard" ? <DashboardView /> : <ProjectView />}
        </main>
      </div>
      <footer className="mt-auto border-t border-border/60 bg-card/30 backdrop-blur px-6 py-3 text-xs text-muted-foreground flex items-center justify-between">
        <span>
          <span className="text-gradient font-semibold">Insight Replay</span> · Session replay,
          heatmaps & live analytics
        </span>
        <span className="hidden sm:inline">
          Built with Next.js · Prisma · Socket.io · Recharts
        </span>
      </footer>
    </div>
  )
}
