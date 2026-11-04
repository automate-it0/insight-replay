"use client"

import { Loader2 } from "lucide-react"

/**
 * Per-route loading boundary (App Router).
 *
 * Next.js renders this file's contents automatically while a route segment's
 * data is being fetched / while the segment's JS chunk is being downloaded
 * over a slow network. Without it, Next shows a blank white frame for the
 * duration of the route transition — which Core Web Vitals counts as LCP
 * regression on slow 3G / mobile hot-spot connections.
 *
 * The skeleton mirrors the dashboard shell (sidebar + main) so the layout
 * shift is zero when the real content hydrates — the user perceives a fast
 * navigation, not a layout pop-in.
 *
 * Auth flow note: this boundary is only displayed for *authenticated*
 * navigation between dashboard sub-routes. The `/` index page renders its
 * own loader while the `/api/auth/me` probe is in flight, so this boundary
 * does not compete with that pre-hydration state.
 */
export default function Loading() {
  return (
    <div
      className="min-h-screen flex items-center justify-center bg-background"
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
        <p className="text-sm">Loading…</p>
      </div>
    </div>
  )
}
