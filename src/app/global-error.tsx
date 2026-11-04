"use client"

import { useEffect } from "react"
import { Button } from "@/components/ui/button"

/**
 * Global error boundary (App Router).
 *
 * `src/app/error.tsx` only catches errors thrown inside the *route segment*
 * — it does NOT catch errors thrown by the root `layout.tsx` itself, because
 * the layout is the parent of the error boundary. Next.js therefore requires
 * a separate `global-error.tsx` to handle root-layout failures (e.g. a
 * provider in `layout.tsx` throwing during hydration).
 *
 * This file REPLACES the entire `<html>` document for the duration of the
 * error — it must therefore render its own `<html>` and `<body>` tags. The
 * styling is intentionally inline-minimal: global-error must not depend on
 * the root layout's CSS chain (which may itself be broken).
 *
 * Recovery: a "Try again" button calls `reset()` which re-runs the root
 * layout. If the layout still throws, the boundary re-renders.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console -- the documented Next.js global-error pattern
    console.error(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          margin: 0,
          padding: "2rem",
          background: "#0a0a0a",
          color: "#fafafa",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "1rem",
          textAlign: "center",
        }}
      >
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Application error</h1>
        <p style={{ maxWidth: "28rem", color: "#a1a1aa", fontSize: "0.875rem" }}>
          A critical error occurred while loading the application shell. The
          error has been logged. You can try reloading — if the problem
          persists, contact the operator.
          {error.digest ? (
            <>
              <br />
              <br />
              Reference: <code style={{ color: "#71717a" }}>{error.digest}</code>
            </>
          ) : null}
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            background: "transparent",
            border: "1px solid #3f3f46",
            color: "#fafafa",
            padding: "0.5rem 1rem",
            borderRadius: "0.375rem",
            cursor: "pointer",
            fontSize: "0.875rem",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  )
}
