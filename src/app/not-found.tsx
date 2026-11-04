"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"

/**
 * 404 boundary (App Router). Triggered automatically by Next.js when a
 * route segment does not match any known path AND no `not-found.tsx` higher
 * in the tree intercepts first.
 *
 * Without this file, Next falls back to its default 404 page which does not
 * share the dashboard's design tokens and offers no recovery into the app.
 * This boundary keeps the visitor inside the shell and routes them back to
 * the dashboard root.
 *
 * Note: this boundary only renders for *unknown routes*. Authenticated-but-
 * unauthorized access is handled by `verifyProjectAccess()` returning a 403
 * JSON response — that path does not reach this file.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-6xl font-bold text-primary">404</p>
      <h2 className="text-lg font-semibold">Page not found</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        The page you are looking for does not exist or may have been moved.
      </p>
      <Button asChild variant="outline">
        <Link href="/">Back to dashboard</Link>
      </Button>
    </div>
  )
}
