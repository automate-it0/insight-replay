// E2E spec: login flow.
//
// Path under test:
//   GET  /login                           → renders <LoginForm>
//   GET  /api/auth/login/pow              → PoW challenge (single-use, 60s TTL)
//   POST /api/auth/login                  → verifies PoW + credentials,
//                                            issues session cookie, returns
//                                            { ok: true, user: {...} }
//   router.replace(safeFrom)              → dashboard at "/"
//
// What this spec verifies (happy path):
//   1. /login renders the Insight Replay branding + the LoginForm card.
//   2. The Email / Password fields accept input.
//   3. The Sign in button submits the form (triggering the PoW solve + POST).
//   4. On success the browser ends up at "/" (the dashboard root).
//   5. The dashboard shell renders the brand footer (auth cookie took).
//
// Preconditions (must be true when this spec runs against a live server):
//   - An admin user exists with email admin@example.com and password
//     TestPass123! (seed via POST /api/auth/setup the first time the DB
//     is empty, OR via the setup form in setup mode — login-form.tsx).
//   - The dev server is reachable at http://localhost:3000 (Playwright's
//     webServer block in playwright.config.ts handles this).
//
// The spec does NOT verify:
//   - Wrong-password failure path (covered by tests/security/auth.test.ts).
//   - PoW-replay rejection (covered by tests/security/auth.test.ts).
//   - Lockout after N failed attempts (covered by tests/security/auth.test.ts).

import { test, expect } from "@playwright/test"

test.describe("Login flow", () => {
  test("admin can sign in and reach the dashboard", async ({ page }) => {
    // 1. Navigate to /login directly. Going to "/" first would also work
    //    (middleware bounces unauthenticated requests to /login) but
    //    adds a redirect hop that adds ~50ms + a flake risk if the
    //    middleware's cookie check races the cookie write on a slow CI box.
    await page.goto("http://localhost:3000/login")

    // 2. The page shell renders the brand + tagline (from src/app/login/page.tsx).
    await expect(page.getByRole("heading", { name: "Insight Replay" })).toBeVisible()
    await expect(page.getByText(/Session replay · heatmaps · live analytics/)).toBeVisible()

    // 3. The LoginForm card renders its title + the two required fields.
    //    LoginForm uses <Label htmlFor="email" /> + <Label htmlFor="password" />
    //    so Playwright's accessible-name machinery resolves them via getByLabel.
    await expect(page.getByRole("heading", { name: /Sign in to Insight Replay/i })).toBeVisible()
    await expect(page.getByLabel("Email")).toBeVisible()
    await expect(page.getByLabel("Password")).toBeVisible()

    // 4. Fill the credentials.
    await page.getByLabel("Email").fill("admin@example.com")
    await page.getByLabel("Password").fill("TestPass123!")

    // 5. Submit. The button's idle label is "Sign in" (busy state labels
    //    are "Computing…" / "Please wait…" — see login-form.tsx).
    await page.getByRole("button", { name: "Sign in" }).click()

    // 6. The LoginForm now:
    //      a. fetches a PoW challenge,
    //      b. solves it locally (~1–4s on a modern browser),
    //      c. POSTs /api/auth/login,
    //      d. on success router.replace("/") — a hard navigation so the
    //         dashboard re-mounts with the fresh session cookie.
    //    The 30s timeout here is the same as the global test timeout —
    //    enough for the PoW solve + the network round-trip even on a
    //    cold dev-server first-compile.
    await expect(page).toHaveURL("http://localhost:3000/", { timeout: 30_000 })

    // 7. The dashboard root (src/app/page.tsx) renders the footer with the
    //    brand text on every authenticated mount. Asserting it confirms
    //    the session cookie was issued and /api/auth/me returned ok:true
    //    (otherwise page.tsx would still be showing "Verifying session…"
    //    and would have bounced back to /login).
    await expect(page.getByText("Insight Replay").first()).toBeVisible()
  })
})
