"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"

/**
 * Route-level error boundary (App Router). Without this file, any render-time
 * throw inside a tab (e.g. a Recharts chart fed malformed data) propagates to
 * the root and Next.js unmounts the whole dashboard to its default
 * "Application error" screen with no recovery path. This boundary keeps the
 * shell alive and offers a retry.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console -- the documented Next.js error-boundary pattern
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        An unexpected error occurred while rendering this view. The error was
        logged — you can retry or navigate back.
        {error.digest ? (
          <>
            <br />
            <br />
            Reference:{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {error.digest}
            </code>
          </>
        ) : null}
      </p>
      <Button onClick={reset} variant="outline">
        Try again
      </Button>
    </div>
  )
}
