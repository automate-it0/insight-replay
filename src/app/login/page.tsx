import type { Metadata } from "next"
import { Suspense } from "react"
import { LoginForm } from "@/components/app/login-form"
import { Loader2 } from "lucide-react"

export const metadata: Metadata = {
  title: "Sign in · Insight Replay",
  description: "Authenticate to access the Insight Replay dashboard.",
  robots: { index: false, follow: false },
}

// /login — public page (the middleware whitelists /login from the
// session-cookie check). Renders the LoginForm client component, which
// probes /api/auth/setup on mount to decide whether to surface the
// "Create admin account" link (only shown when zero users exist).
//
// Server-component wrapper is intentionally minimal: no DB calls here, no
// getSession() check (we WANT this page to render even for logged-in users,
// e.g. if they manually navigate to /login to switch accounts). The form
// itself handles the redirect to / on successful auth.
//
// Suspense boundary is required because LoginForm uses `useSearchParams()`
// (to honor the `?from=` bounce-back param) — Next.js requires any component
// reading search params to be wrapped in Suspense so the static-render pass
// can degrade gracefully.
export default function LoginPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background bg-grid px-4 py-12">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-gradient">
          Insight Replay
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Session replay · heatmaps · live analytics
        </p>
      </div>
      <Suspense
        fallback={
          <div className="flex items-center justify-center text-muted-foreground py-12">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          </div>
        }
      >
        <LoginForm />
      </Suspense>
      <footer className="mt-8 text-xs text-muted-foreground text-center max-w-sm">
        <p>
          Built with Next.js · Prisma · Socket.io · Recharts
        </p>
      </footer>
    </div>
  )
}
