"use client"

import { memo, useEffect, useMemo, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { toast } from "sonner"
import { Loader2, ShieldCheck, Download } from "lucide-react"
import {
  getDeviceFingerprint,
  DEVICE_FP_HEADER,
} from "@/lib/device-fp"
import {
  solvePoW,
  fetchPoWChallenge,
  extractPoWFromBody,
  type ClientPoWChallenge,
} from "@/lib/pow-client"

type Mode = "login" | "setup"

interface AuthResponse {
  ok: boolean
  error?: string
  user?: { id: string; email: string; name: string | null; role: string }
  // The server attaches a fresh PoW challenge to the 401/403 bodies so the
  // client can solve + retry without an extra GET round-trip.
  pow?: ClientPoWChallenge
}

/**
 * Login + first-time-setup form. Renders inside the /login page.
 *
 * Behavior:
 *   - On mount, probes `GET /api/auth/setup` to decide whether to surface
 *     the "Create admin account" link (only shown when zero users exist).
 *   - In `login` mode: email + password → fetch PoW challenge → solve PoW
 *     (~1–4 s on a modern browser) → POST /api/auth/login with
 *     `x-pow-challenge` + `x-pow-nonce` headers. On 403 "Proof of work
 *     required" (challenge expired or replayed) the response carries a
 *     fresh challenge → solve + retry once, transparently. On success
 *     redirect to `/` (or `?from=` target if present).
 *   - In `setup` mode: email + name + password → POST /api/auth/setup → on
 *     success auto-login (the endpoint issues the cookie) and redirect to `/`.
 *     Setup does NOT require PoW — it's only the login endpoint that's the
 *     brute-force target (setup is one-shot, available only when zero users
 *     exist, so it's not economically attractive to attack).
 *
 * Errors are surfaced both inline (red text under the form) and as a toast,
 * so the user gets feedback even if they've scrolled past the form.
 */
export const LoginForm = memo(function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [mode, setMode] = useState<Mode>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [setupAvailable, setSetupAvailable] = useState(false)
  const [pending, startTransition] = useTransition()
  // "Computing…" state — distinct from `pending` so the button label can tell
  // the user we're solving the PoW puzzle (~1–4 s on a modern browser) vs.
  // waiting on the network round-trip. Cleared on submit completion / error.
  const [computing, setComputing] = useState(false)

  // Read the `from` param once — used to bounce the user back to the page
  // they were trying to reach after a successful login. We sanitize it to a
  // local path (no protocol/host) to prevent open-redirect via crafted URLs.
  const safeFrom = useMemo(() => {
    const fromParam = searchParams.get("from") || "/"
    return fromParam.startsWith("/") && !fromParam.startsWith("//")
      ? fromParam
      : "/"
  }, [searchParams])

  // Derived UI labels for the submit button + mode-switch link. Memoized on
  // mode/setupAvailable/computing/pending so the ternary chain doesn't
  // re-evaluate on every parent re-render.
  const labels = useMemo(() => {
    const submitLabel = mode === "login" ? "Sign in" : "Create admin account"
    const busyLabel = computing ? "Computing…" : pending ? "Please wait…" : submitLabel
    const switchPrompt =
      mode === "login"
        ? setupAvailable
          ? "No account yet?"
          : null
        : "Already have an account?"
    const switchAction = mode === "login" ? "Create admin account" : "Sign in instead"
    return { submitLabel, busyLabel, switchPrompt, switchAction }
  }, [mode, setupAvailable, computing, pending])

  // Probe whether first-time setup is still available. We do this client-side
  // (rather than passing it in from a server component) so the page stays
  // statically renderable and the probe runs once on mount.
  useEffect(() => {
    let alive = true
    fetch("/api/auth/setup", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AuthResponse & { setupAvailable?: boolean } | null) => {
        if (alive && data?.setupAvailable) setSetupAvailable(true)
      })
      .catch(() => {
        /* swallow — link just won't show, login still works */
      })

    // Pre-warm the device fingerprint cache so the login POST can attach
    // the `x-device-fp` header synchronously on submit (no flash of an
    // async await between click and request — the user gets immediate
    // feedback). The fingerprint is a one-shot compute on first mount;
    // subsequent dashboard requests then read from the cache. The
    // `getDeviceFingerprint()` call is a no-op on the server (returns
    // null) — this component is "use client" so this effect only runs
    // in the browser, but the guard inside the helper makes it doubly
    // safe. Failures are swallowed — if the fingerprint can't be
    // computed (insecure context, no canvas), login still works; the
    // server falls back to IP-only binding for that session.
    getDeviceFingerprint().catch(() => {
      /* swallow — non-fatal, see comment above */
    })

    return () => {
      alive = false
    }
  }, [])

  function switchMode(next: Mode) {
    setMode(next)
    setError(null)
    // Don't clear email/password — convenient if the user typed them then
    // realized they need to set up first.
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)

    // Snapshot the field values at submit time so a user typing during the
    // async PoW solve doesn't change what we send.
    const emailTrim = email.trim()
    const passwordSnap = password
    const nameSnap = name.trim() || undefined

    // Resolve the device fingerprint now (almost always a cache hit —
    // the mount effect pre-warmed it). If we have one, attach it as the
    // `x-device-fp` header so the server can store `fpHash` alongside
    // `ipHash` in the new session — enabling the combined binding that
    // survives mobile network switches. If we don't (server-rendered
    // submit, insecure context, extension blocking canvas), login still
    // succeeds; the server falls back to IP-only binding for this
    // session.
    let fpHeader: Record<string, string> = {}
    try {
      const fp = await getDeviceFingerprint()
      if (fp) fpHeader = { [DEVICE_FP_HEADER]: fp }
    } catch {
      /* swallow — server falls back to IP-only binding */
    }

    startTransition(async () => {
      try {
        // ─── Login mode: solve PoW before POSTing. ─────────────────────────
        // The challenge is single-use + 60s TTL (see src/lib/pow.ts), so we
        // fetch one fresh per submit. The PoW solve is the slow step
        // (~1–4 s on a modern browser); the network round-trip is dwarfed
        // by it, so we don't pre-fetch on mount — pre-warming would only
        // save ~50 ms at the cost of a stale challenge if the user takes
        // more than 60 s to type their password.
        let result: { ok: boolean; status: number; data: AuthResponse | null }
        if (mode === "login") {
          result = await loginWithPoW(emailTrim, passwordSnap, fpHeader)
        } else {
          // Setup mode — no PoW (one-shot endpoint, not a brute-force target).
          const r = await fetch("/api/auth/setup", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...fpHeader },
            body: JSON.stringify({
              email: emailTrim,
              password: passwordSnap,
              name: nameSnap,
            }),
          })
          const data = (await r.json().catch(() => null)) as AuthResponse | null
          result = { ok: r.ok, status: r.status, data }
        }

        const { ok, data } = result
        if (!ok || !data?.ok) {
          // 403 specifically with "Proof of work required" should not surface
          // here — `loginWithPoW` handles it internally with one retry. If we
          // do see it, the retry already failed; surface the error.
          const msg = data?.error || "Something went wrong. Please try again."
          setError(msg)
          toast.error(msg)
          return
        }

        toast.success(
          mode === "login" ? "Welcome back!" : "Admin account created",
        )
        // Hard navigation so the dashboard re-mounts with the fresh cookie.
        // `safeFrom` is sanitized to a local path (no protocol/host) above to
        // prevent open-redirect abuse via a crafted `?from=` value.
        router.replace(safeFrom)
        router.refresh()
      } catch {
        const msg = "Network error — please check your connection."
        setError(msg)
        toast.error(msg)
      } finally {
        setComputing(false)
      }
    })
  }

  /**
   * Login flow with Proof-of-Work:
   *   1. Fetch a fresh PoW challenge (GET /api/auth/login/pow).
   *   2. Solve the PoW locally (~1–4 s).
   *   3. POST /api/auth/login with x-pow-challenge + x-pow-nonce (and the
   *      device-fingerprint header, when present).
   *   4. If 403 "Proof of work required": the response carries a fresh
   *      challenge — solve + retry ONCE (the previous challenge was
   *      consumed, so we MUST use the new one). One retry covers the common
   *      case (challenge expired between fetch + POST, or stale tab). We
   *      don't loop indefinitely — a second 403 surfaces as a real error.
   *   5. Return the parsed response + status.
   *
   * Throws on network failure (caught by `handleSubmit`'s try/catch).
   */
  async function loginWithPoW(
    emailValue: string,
    passwordValue: string,
    fpHeader: Record<string, string>,
  ): Promise<{ ok: boolean; status: number; data: AuthResponse | null }> {
    // Step 1: fetch challenge.
    setComputing(true)
    let challenge = await fetchPoWChallenge()

    // Two attempts: the initial one + one retry on 403 with a fresh inline
    // challenge from the response body.
    for (let attempt = 0; attempt < 2; attempt++) {
      // Step 2: solve. The challenge is single-use, so if the user double-
      // clicks submit while this loop is mid-solve, the second click would
      // mint its own challenge and the first click's POST would 403 → retry
      // with the inline fresh challenge. That's the correct behavior.
      setComputing(true)
      const nonce = await solvePoW(challenge.challenge, challenge.difficulty)
      setComputing(false)

      // Step 3: POST.
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...fpHeader,
          "x-pow-challenge": challenge.challenge,
          "x-pow-nonce": nonce,
        },
        body: JSON.stringify({ email: emailValue, password: passwordValue }),
      })
      const data = (await r.json().catch(() => null)) as AuthResponse | null

      // Step 4: 403 → retry once with the fresh inline challenge.
      if (
        r.status === 403 &&
        data?.error === "Proof of work required" &&
        data?.pow &&
        attempt === 0
      ) {
        const fresh = extractPoWFromBody(data)
        if (fresh) {
          challenge = fresh
          continue
        }
      }

      // Non-retryable response (success, 401, 429, etc.). Return to the
      // caller — the 401/429 bodies ALSO carry a fresh PoW challenge for the
      // next submit attempt, but we don't auto-retry those (the user typed
      // wrong credentials, or is locked out — they should see the error).
      return { ok: r.ok, status: r.status, data }
    }

    // We get here only if both attempts returned a 403 we couldn't recover
    // from (e.g. server lost the cache entry between retries). Surface a
    // friendly error.
    return {
      ok: false,
      status: 403,
      data: { ok: false, error: "Login verification failed. Please try again." },
    }
  }

  // While solving the PoW puzzle we surface a distinct "Computing…" label so
  // the user understands the wait is local computation (browser doing the
  // hash search), not a stalled network request. The disabled state still
  // uses the unified `pending || computing` flag so the button is non-
  // interactive throughout. (The actual label values live in `labels`
  // above, memoized on the relevant state.)

  return (
    <Card className="w-full max-w-sm border-border/60 shadow-lg">
      <CardHeader className="space-y-2 text-center">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        </div>
        <CardTitle className="text-xl">
          {mode === "login" ? "Sign in to Insight Replay" : "Create admin account"}
        </CardTitle>
        <CardDescription>
          {mode === "login"
            ? "Enter your credentials to access the dashboard."
            : "Set up the first admin account to get started. This is only available once."}
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit} noValidate>
        <CardContent className="space-y-4">
          {mode === "setup" && (
            <div className="space-y-2">
              <Label htmlFor="name">Name (optional)</Label>
              <Input
                id="name"
                type="text"
                autoComplete="name"
                placeholder="Ada Lovelace"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
                maxLength={100}
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={pending}
              maxLength={254}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              placeholder={mode === "login" ? "••••••••" : "At least 8 characters"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={pending}
              minLength={mode === "setup" ? 8 : undefined}
              maxLength={256}
            />
            {mode === "setup" && (
              <p className="text-xs text-muted-foreground">
                Use at least 8 characters.
              </p>
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-3 py-2"
            >
              {error}
            </p>
          )}
        </CardContent>

        <CardFooter className="flex flex-col gap-3">
          <Button type="submit" className="w-full" disabled={pending || computing}>
            {(pending || computing) && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {labels.busyLabel}
          </Button>

          {labels.switchPrompt && (
            <p className="text-xs text-muted-foreground text-center">
              {labels.switchPrompt}{" "}
              <button
                type="button"
                onClick={() => switchMode(mode === "login" ? "setup" : "login")}
                className="text-primary underline-offset-4 hover:underline font-medium"
                disabled={pending}
              >
                {labels.switchAction}
              </button>
            </p>
          )}

          <a
            href="/api/download"
            className="w-full mt-2 inline-flex items-center justify-center gap-2 rounded-md border border-border/60 bg-background/40 px-4 py-2 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
          >
            <Download className="h-3.5 w-3.5" />
            تحميل المشروع كامل (zip · 4.7MB)
          </a>
        </CardFooter>
      </form>
    </Card>
  )
})
