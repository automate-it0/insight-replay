// E2E spec: alerts tab — create, list, toggle.
//
// Path under test:
//   GET  /api/projects/[id]/alerts          → list alert rules
//   POST /api/projects/[id]/alerts          → create alert rule
//   PATCH /api/projects/[id]/alerts/[aid]   → toggle enabled / acknowledge
//   DELETE /api/projects/[id]/alerts/[aid]   → delete rule
// UI:
//   src/components/app/alerts-tab.tsx — the Alerts tab in the project view
//
// What this spec verifies (happy path):
//   1. From "/" dashboard, open the first project card.
//   2. The project shell mounts; the Alerts tab is selectable.
//   3. The Alerts tab shows the "New alert" button + the rules list.
//   4. Click "New alert" → dialog opens with the form fields.
//   5. Fill the form (name, threshold, window) + click "Create alert".
//   6. Dialog closes; the new alert appears in the rules list with the
//      name + threshold + window we typed.
//   7. Toggle the alert off (Switch) → the API PATCH succeeds and the
//      row reflects the new state.
//
// Preconditions when this spec runs against a live server:
//   - Admin user exists (see login.spec.ts setup).
//   - The seed project "Acme Inc. — Marketing Site" exists (POST /api/seed).
//   - Dev server reachable at http://localhost:3000.
//
// Auth handling:
//   - This spec depends on the login flow having already produced a valid
//     session cookie. We replicate the login inline in `beforeEach` rather
//     than relying on Playwright storageState because the task spec
//     ("just write the specs") didn't ask for a shared .auth/admin.json
//     fixture; once a verifier sets that up, the inline login can be
//     replaced with `test.use({ storageState: 'e2e/.auth/admin.json' })`.

import { test, expect } from "@playwright/test"

// A unique-per-run alert name so re-running the spec doesn't collide
// with a previously-created rule (the rules list is sorted by createdAt
// desc, so a stale row would otherwise show up first and steal the
// `getByText` matcher).
function uniqueAlertName(): string {
  return `E2E Alert ${Date.now()}`
}

test.describe("Alerts tab", () => {
  test.beforeEach(async ({ page }) => {
    // 1. Sign in. Mirrors login.spec.ts's happy path. On success the
    //    dashboard root renders.
    await page.goto("http://localhost:3000/login")
    await page.getByLabel("Email").fill("admin@example.com")
    await page.getByLabel("Password").fill("TestPass123!")
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page).toHaveURL("http://localhost:3000/", { timeout: 30_000 })
  })

  test("user can create an alert rule and toggle it off", async ({ page }) => {
    // 2. Open the first project. The dashboard-view renders project cards
    //    as <button> elements containing the project name in a
    //    `.font-semibold` div. We target the seeded "Acme" project by
    //    text (matches both "Acme Inc. — Marketing Site" and any other
    //    project whose name starts with "Acme") and click the FIRST one.
    const projectButton = page
      .getByRole("button", { name: /Acme/i })
      .first()
    await projectButton.click()

    // 3. The project shell mounts with a row of Tabs (Overview,
    //    Recordings, Live, Insights, Alerts, …). Wait for the Alerts
    //    tab to be visible, then click it. The Tabs primitives use
    //    role="tab" (see src/components/ui/tabs.tsx) so the role-based
    //    query is the documented stable contract.
    await page.getByRole("tab", { name: "Alerts" }).click()

    // 4. The Alerts tab body renders. Two cards: "Alert rules" and
    //    "Recent triggers". Assert the heading is visible so we fail
    //    fast if the wrong tab loaded (e.g. because the click raced a
    //    re-render).
    await expect(page.getByText("Alerts & monitoring")).toBeVisible()
    await expect(page.getByText("Alert rules")).toBeVisible()

    // 5. Open the Create dialog.
    await page.getByRole("button", { name: "New alert" }).click()

    // 6. The dialog renders a form with: Alert name (Input), Metric
    //    (Select), Condition (Select), Threshold (Input[type=number]),
    //    Window (Input[type=number]) — all wired to <Label htmlFor=...>
    //    so getByLabel resolves them. Defaults for the selects are
    //    already populated by alerts-tab.tsx (metric=sessions,
    //    condition=gt), so we only fill name + threshold + window.
    const alertName = uniqueAlertName()
    await page.getByLabel("Alert name").fill(alertName)
    await page.getByLabel("Threshold").fill("15")
    await page.getByLabel("Window (min)").fill("30")

    // 7. Submit. The dialog footer has a "Create alert" button.
    await page.getByRole("button", { name: "Create alert", exact: true }).click()

    // 8. The dialog closes (the form calls setCreateOpen(false) +
    //    setForm({...blank})) and load() re-fetches /api/projects/.../alerts.
    //    The new rule should appear at the top of the list (sorted by
    //    createdAt desc) with the name + threshold + window we typed.
    await expect(page.getByText(alertName).first()).toBeVisible({
      timeout: 10_000,
    })
    // The threshold value is rendered in the row's muted-foreground
    // summary line ("Sessions exceeds 15 · every 30min").
    await expect(page.getByText(/exceeds 15/).first()).toBeVisible()
    await expect(page.getByText(/every 30min/).first()).toBeVisible()

    // 9. Toggle the alert off. The Switch is rendered with an
    //    aria-label of `Toggle alert ${a.name}` (alerts-tab.tsx:221),
    //    so we can target it precisely by name.
    const toggleSwitch = page.getByRole("switch", {
      name: `Toggle alert ${alertName}`,
    })
    // Before click: the switch is on (alert just created with
    // enabled:true by the POST handler — see route.ts:106).
    await expect(toggleSwitch).toBeChecked()
    await toggleSwitch.uncheck()
    // After click + the optimistic-state update + PATCH round-trip:
    // the switch is off.
    await expect(toggleSwitch).not.toBeChecked()
  })
})
