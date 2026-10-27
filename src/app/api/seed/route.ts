import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { parseUA, fakeGeo } from "@/lib/ua"
import { reportUnauthorizedAdmin } from "@/lib/admin-radar"

/**
 * Constant-time string comparison.
 *
 * Compares two strings of equal length using XOR so the running time does
 * not depend on how early the first difference appears. Returns false
 * immediately on length mismatch (this leaks length, not content —
 * acceptable because the admin token's length is not itself a secret worth
 * protecting against a side-channel).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Validate the x-admin-token header against ADMIN_TOKEN env var.
 *
 * Fails CLOSED: if ADMIN_TOKEN is not configured on the server, every
 * request is rejected — seeding fake data is a destructive/opportunistic
 * operation that must not be exposed just because someone forgot to set
 * the env var.
 *
 * Returns true iff the request carries the exact expected token.
 */
function isAdminAuthorized(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN
  if (!expected) {
    // Server misconfiguration — fail closed.
    return false
  }
  const provided = req.headers.get("x-admin-token")
  if (!provided) return false
  return safeEqual(provided, expected)
}

// Demo data seeder: creates a project + realistic sessions/events/insights.
const PAGES = [
  { url: "/", title: "Acme — Ship faster", vh: 2400 },
  { url: "/pricing", title: "Pricing", vh: 1800 },
  { url: "/features", title: "Features", vh: 2600 },
  { url: "/blog", title: "Blog", vh: 1600 },
  { url: "/blog/getting-started", title: "Getting Started", vh: 2200 },
  { url: "/docs", title: "Docs", vh: 2000 },
  { url: "/signup", title: "Sign up", vh: 900 },
  { url: "/login", title: "Log in", vh: 700 },
  { url: "/contact", title: "Contact", vh: 1100 },
]

const CLICK_TARGETS: Record<string, { x: number; y: number; tag: string; text: string }[]> = {
  "/": [
    { x: 720, y: 540, tag: "A", text: "Start free trial" },
    { x: 120, y: 60, tag: "A", text: "Features" },
    { x: 720, y: 980, tag: "BUTTON", text: "Get started" },
    { x: 1300, y: 60, tag: "A", text: "Sign in" },
  ],
  "/pricing": [
    { x: 480, y: 720, tag: "BUTTON", text: "Choose Starter" },
    { x: 960, y: 720, tag: "BUTTON", text: "Choose Pro" },
    { x: 240, y: 60, tag: "A", text: "Pricing" },
  ],
  "/features": [
    { x: 360, y: 820, tag: "A", text: "Learn more" },
    { x: 1000, y: 1300, tag: "BUTTON", text: "Try it free" },
  ],
  "/blog": [
    { x: 420, y: 520, tag: "A", text: "Getting Started" },
    { x: 820, y: 700, tag: "A", text: "Read more" },
  ],
  "/blog/getting-started": [{ x: 720, y: 1600, tag: "A", text: "Sign up" }],
  "/docs": [{ x: 280, y: 400, tag: "A", text: "Quickstart" }],
  "/signup": [{ x: 720, y: 560, tag: "BUTTON", text: "Create account" }],
  "/login": [{ x: 720, y: 540, tag: "BUTTON", text: "Log in" }],
  "/contact": [{ x: 720, y: 760, tag: "BUTTON", text: "Send" }],
}

const BROWSERS = ["Chrome", "Safari", "Firefox", "Edge"]
const DEVICES = [
  { device: "desktop", w: 1440, h: 900 },
  { device: "desktop", w: 1536, h: 864 },
  { device: "desktop", w: 1280, h: 720 },
  { device: "mobile", w: 390, h: 844 },
  { device: "mobile", w: 360, h: 800 },
  { device: "tablet", w: 768, h: 1024 },
]
const IPS = [
  "12.34.56.78", "8.8.8.8", "24.10.20.30", "77.88.1.1", "203.0.113.5",
  "198.51.100.2", "192.0.2.9", "45.33.21.7", "91.198.174.2", "110.50.88.4",
]

function rand(a: number, b: number) {
  return a + Math.random() * (b - a)
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// Generate a realistic-ish mouse path from (x1,y1) to (x2,y2)
function mousePath(x1: number, y1: number, x2: number, y2: number, steps: number) {
  const pts: { x: number; y: number }[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    // ease + jitter
    const ease = t * t * (3 - 2 * t)
    const jx = (Math.random() - 0.5) * 24
    const jy = (Math.random() - 0.5) * 24
    pts.push({
      x: Math.round(x1 + (x2 - x1) * ease + jx),
      y: Math.round(y1 + (y2 - y1) * ease + jy),
    })
  }
  return pts
}

interface GenEvent {
  type: string
  t: number
  x: number
  y: number
  scrollX: number
  scrollY: number
  viewportWidth: number
  viewportHeight: number
  pageUrl: string
  data: Record<string, unknown>
}

export async function POST(req: NextRequest) {
  // --- Security gate: disable seeding in production ---
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { ok: false, error: { code: "FORBIDDEN", message: "Seed endpoint is disabled in production" } },
      { status: 403 }
    )
  }

  // --- Second layer: require admin token even in dev ---
  if (!isAdminAuthorized(req as unknown as Request)) {
    // Fire a security alert — seeding fake data is destructive (overwrites
    // the demo DB); an unauthorized probe is high-signal.
    // See src/lib/admin-radar.ts.
    reportUnauthorizedAdmin(
      req as unknown as Request,
      "seed",
      "missing or invalid x-admin-token",
    )
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "Admin token required" } },
      { status: 401 }
    )
  }

  const body = await req.json().catch(() => ({}))
  const count = Math.min(200, body.count || 80)
  const projectName = body.name || "Acme Inc. — Marketing Site"
  const siteUrl = body.siteUrl || "https://acme.example.com"

  // Find or create project
  let project = await db.project.findFirst({ where: { name: projectName } })
  if (!project) {
    project = await db.project.create({ data: { name: projectName, siteUrl } })
  }

  let created = 0
  const now = Date.now()

  // Reusable visitor pool so some sessions are "returning"
  const visitorPool: string[] = []
  for (let v = 0; v < Math.floor(count * 0.55); v++) {
    visitorPool.push("v_" + Math.random().toString(36).slice(2, 10))
  }

  for (let i = 0; i < count; i++) {
    // Session started somewhere in the last 7 days, weighted to recent
    const ageMin = Math.floor(Math.pow(Math.random(), 1.5) * 7 * 24 * 60)
    const startedAt = new Date(now - ageMin * 60 * 1000)
    const isActive = ageMin < 3 && Math.random() < 0.25
    const dev = pick(DEVICES)
    const browser = pick(BROWSERS)
    const os = dev.device === "mobile" ? (Math.random() < 0.5 ? "iOS" : "Android") : pick(["Windows", "macOS", "Linux"])
    const ip = pick(IPS)
    const geo = fakeGeo(ip)
    const ua =
      dev.device === "mobile"
        ? `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 ${browser}/17.0 Mobile/15E148 Safari/604.1`
        : dev.device === "tablet"
        ? `Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 ${browser}/17.0 Mobile/15E148 Safari/604.1`
        : `Mozilla/5.0 (${os === "macOS" ? "Macintosh; Intel Mac OS X 10_15_7" : os === "Windows" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64"}) AppleWebKit/537.36 (KHTML, like Gecko) ${browser}/120.0.0.0 Safari/537.36`
    const uaInfo = parseUA(ua)
    // ~60% reuse a visitor from the pool (returning), 40% brand new
    const isNewVisitor = Math.random() < 0.4
    const visitorId = isNewVisitor
      ? "v_" + Math.random().toString(36).slice(2, 10)
      : pick(visitorPool)

    // Referrer + UTM
    const refRoll = Math.random()
    let referrer = ""
    let utmSource = ""
    let utmMedium = ""
    let utmCampaign = ""
    if (refRoll < 0.32) {
      referrer = "https://google.com"
      utmSource = "google"; utmMedium = "organic"; utmCampaign = ""
    } else if (refRoll < 0.5) {
      referrer = "https://twitter.com"
      utmSource = "twitter"; utmMedium = "social"; utmCampaign = "launch"
    } else if (refRoll < 0.62) {
      referrer = "https://t.co/x"
      utmSource = "twitter"; utmMedium = "social"; utmCampaign = "launch"
    } else if (refRoll < 0.72) {
      referrer = "https://newsletter.dev"
      utmSource = "newsletter"; utmMedium = "email"; utmCampaign = "weekly"
    } else if (refRoll < 0.8) {
      referrer = "https://linkedin.com"
      utmSource = "linkedin"; utmMedium = "social"; utmCampaign = "b2b"
    } else if (refRoll < 0.88) {
      referrer = "https://reddit.com"
      utmSource = "reddit"; utmMedium = "social"; utmCampaign = ""
    }

    // Determine session flow
    const pagesInSession = Math.random() < 0.45 ? 1 : Math.random() < 0.7 ? 2 : 3 + Math.floor(Math.random() * 3)
    const flow: { url: string }[] = []
    flow.push({ url: pick(["/", "/pricing", "/features", "/blog"]) })
    for (let p = 1; p < pagesInSession; p++) {
      flow.push({ url: pick(PAGES).url })
    }

    const events: GenEvent[] = []
    let t = 0
    const isRage = Math.random() < 0.18
    const isDead = Math.random() < 0.22
    let rageTriggered = false
    let deadTriggered = false

    for (const page of flow) {
      const meta = PAGES.find((p) => p.url === page.url)!
      const vh = dev.h
      const pageHeight = meta.vh
      const targets = CLICK_TARGETS[page.url] || []
      const pageStart = t

      // pageview
      events.push({
        type: "pageview",
        t,
        x: 0,
        y: 0,
        scrollX: 0,
        scrollY: 0,
        viewportWidth: dev.w,
        viewportHeight: vh,
        pageUrl: page.url,
        data: { title: meta.title, url: page.url },
      })
      t += Math.floor(rand(400, 1200))

      // initial mouse entry
      let cx = Math.floor(rand(dev.w * 0.2, dev.w * 0.8))
      let cy = Math.floor(rand(120, 300))

      // Reading: a few mouse moves + scrolls
      const moveCount = Math.floor(rand(8, 22))
      let scrollY = 0
      for (let m = 0; m < moveCount; m++) {
        const targetX = Math.floor(rand(dev.w * 0.1, dev.w * 0.9))
        const targetY = Math.floor(rand(120, vh - 80))
        const path = mousePath(cx, cy, targetX, targetY, 3)
        for (const p of path) {
          events.push({
            type: "mousemove",
            t,
            x: p.x,
            y: p.y,
            scrollX: 0,
            scrollY,
            viewportWidth: dev.w,
            viewportHeight: vh,
            pageUrl: page.url,
            data: {},
          })
          t += Math.floor(rand(60, 130))
        }
        cx = targetX
        cy = targetY
        // scroll a bit
        if (Math.random() < 0.55) {
          scrollY = Math.min(pageHeight - vh, scrollY + Math.floor(rand(120, 360)))
          events.push({
            type: "scroll",
            t,
            x: cx,
            y: cy,
            scrollX: 0,
            scrollY,
            viewportWidth: dev.w,
            viewportHeight: vh,
            pageUrl: page.url,
            data: {},
          })
          t += Math.floor(rand(200, 600))
        }
      }

      // A click on a target (or dead click)
      if (targets.length && Math.random() < 0.7) {
        const target = pick(targets)
        // move to target
        const path = mousePath(cx, cy, target.x, target.y, 4)
        for (const p of path) {
          events.push({
            type: "mousemove",
            t,
            x: p.x,
            y: p.y,
            scrollX: 0,
            scrollY,
            viewportWidth: dev.w,
            viewportHeight: vh,
            pageUrl: page.url,
            data: {},
          })
          t += Math.floor(rand(70, 130))
        }
        cx = target.x
        cy = target.y

        if (isRage && !rageTriggered && Math.random() < 0.6) {
          // rage click: 4 rapid clicks in place
          for (let r = 0; r < 4; r++) {
            events.push({
              type: "click",
              t,
              x: cx + Math.floor(rand(-6, 6)),
              y: cy + Math.floor(rand(-6, 6)),
              scrollX: 0,
              scrollY,
              viewportWidth: dev.w,
              viewportHeight: vh,
              pageUrl: page.url,
              data: { tag: target.tag, text: target.text, rage: true },
            })
            t += Math.floor(rand(120, 260))
          }
          rageTriggered = true
        } else if (isDead && !deadTriggered && Math.random() < 0.5) {
          // dead click: click on non-interactive area
          const dx = Math.floor(rand(80, dev.w - 80))
          const dy = Math.floor(rand(80, vh - 80))
          events.push({
            type: "click",
            t,
            x: dx,
            y: dy,
            scrollX: 0,
            scrollY,
            viewportWidth: dev.w,
            viewportHeight: vh,
            pageUrl: page.url,
            data: { tag: "DIV", text: "", dead: true },
          })
          t += Math.floor(rand(300, 800))
          deadTriggered = true
        } else {
          events.push({
            type: "click",
            t,
            x: cx,
            y: cy,
            scrollX: 0,
            scrollY,
            viewportWidth: dev.w,
            viewportHeight: vh,
            pageUrl: page.url,
            data: { tag: target.tag, text: target.text },
          })
          t += Math.floor(rand(400, 1200))
        }
      }

      // occasionally a keypress on signup/login
      if ((page.url === "/signup" || page.url === "/login") && Math.random() < 0.7) {
        for (let k = 0; k < Math.floor(rand(4, 12)); k++) {
          events.push({
            type: "keypress",
            t,
            x: 0,
            y: 0,
            scrollX: 0,
            scrollY,
            viewportWidth: dev.w,
            viewportHeight: vh,
            pageUrl: page.url,
            data: { key: "*", code: "Key" + k },
          })
          t += Math.floor(rand(80, 200))
        }
      }

      t += Math.floor(rand(500, 1500))
      void pageStart
    }

    // unload
    events.push({
      type: "unload",
      t,
      x: 0,
      y: 0,
      scrollX: 0,
      scrollY: 0,
      viewportWidth: dev.w,
      viewportHeight: dev.h,
      pageUrl: flow[flow.length - 1].url,
      data: {},
    })

    const duration = Math.round(t / 1000)
    const totalClicks = events.filter((e) => e.type === "click").length
    const pageViewsCount = events.filter((e) => e.type === "pageview").length
    const entryUrl = flow[0]?.url || "/"
    const exitUrl = flow[flow.length - 1]?.url || "/"
    // goal conversion: visited /signup or /pricing counts as a "signup" / "pricing_view" goal
    let convertedGoal = ""
    if (flow.some((f) => f.url === "/signup")) convertedGoal = "signup"
    else if (flow.some((f) => f.url === "/pricing")) convertedGoal = "pricing_view"
    // sometimes a JS error occurs (rage-click sessions more likely)
    const hasError = Math.random() < (rageTriggered ? 0.35 : 0.08)

    const session = await db.session.create({
      data: {
        projectId: project.id,
        visitorId,
        userAgent: ua,
        ip,
        country: geo.country,
        city: geo.city,
        device: uaInfo.device,
        browser,
        os,
        screenWidth: dev.w,
        screenHeight: dev.h,
        language: "en",
        referrer,
        utmSource,
        utmMedium,
        utmCampaign,
        entryUrl,
        exitUrl,
        isNewVisitor,
        startedAt,
        lastActiveAt: new Date(startedAt.getTime() + t),
        duration,
        isActive,
        totalClicks,
        pageViewsCount,
        hasRageClick: rageTriggered,
        hasDeadClick: deadTriggered,
        hasError,
        convertedGoal,
      },
    })

    // insert events
    const evRows = events.map((e) => ({
      sessionId: session.id,
      type: e.type,
      t: e.t,
      data: JSON.stringify(e.data),
      pageUrl: e.pageUrl,
      viewportWidth: e.viewportWidth,
      viewportHeight: e.viewportHeight,
      scrollX: e.scrollX,
      scrollY: e.scrollY,
      x: e.x,
      y: e.y,
    }))
    for (let k = 0; k < evRows.length; k += 200) {
      await db.event.createMany({ data: evRows.slice(k, k + 200) })
    }

    // insights
    if (rageTriggered) {
      const rc = events.find((e) => e.type === "click" && (e.data as { rage?: boolean }).rage)
      await db.insight.create({
        data: {
          sessionId: session.id,
          projectId: project.id,
          type: "rage_click",
          severity: "high",
          timestamp: startedAt,
          data: JSON.stringify({ x: rc?.x || 0, y: rc?.y || 0, pageUrl: rc?.pageUrl || "/" }),
        },
      })
    }
    if (deadTriggered) {
      const dc = events.find((e) => e.type === "click" && (e.data as { dead?: boolean }).dead)
      await db.insight.create({
        data: {
          sessionId: session.id,
          projectId: project.id,
          type: "dead_click",
          severity: "medium",
          timestamp: startedAt,
          data: JSON.stringify({ x: dc?.x || 0, y: dc?.y || 0, pageUrl: dc?.pageUrl || "/" }),
        },
      })
    }
    if (Math.random() < 0.15) {
      await db.insight.create({
        data: {
          sessionId: session.id,
          projectId: project.id,
          type: "excessive_scroll",
          severity: "low",
          timestamp: startedAt,
          data: JSON.stringify({ pageUrl: flow[0].url }),
        },
      })
    }
    // quick-back insight: returned to previous page very fast
    if (Math.random() < 0.1 && flow.length >= 2) {
      await db.insight.create({
        data: {
          sessionId: session.id,
          projectId: project.id,
          type: "quick_back",
          severity: "low",
          timestamp: startedAt,
          data: JSON.stringify({ pageUrl: flow[1].url }),
        },
      })
    }

    // JS errors
    if (hasError) {
      const errT = Math.floor(rand(2000, Math.max(3000, t)))
      const errMsgs = [
        "TypeError: Cannot read properties of undefined (reading 'map')",
        "ReferenceError: process is not defined",
        "SyntaxError: Unexpected token '<'",
        "Network request failed: 503 Service Unavailable",
        "ChunkLoadError: Loading chunk 5 failed.",
      ]
      await db.errorEvent.create({
        data: {
          sessionId: session.id,
          projectId: project.id,
          message: pick(errMsgs),
          stack: "    at Object.render (app.js:4:1820)\n    at PageView (index.js:12:5)",
          type: "js",
          url: pick(flow).url,
          line: Math.floor(rand(1, 400)),
          timestamp: new Date(startedAt.getTime() + errT),
          t: errT,
        },
      })
    }

    created++
  }

  // mark a handful of sessions as active now for the live view
  const recent = await db.session.findMany({
    where: { projectId: project.id, startedAt: { gte: new Date(now - 10 * 60 * 1000) } },
    take: 6,
  })
  for (const s of recent.slice(0, 4)) {
    await db.session.update({ where: { id: s.id }, data: { isActive: true } })
  }

  // Demo funnels
  const existingFunnels = await db.funnel.count({ where: { projectId: project.id } })
  if (existingFunnels === 0) {
    await db.funnel.createMany({
      data: [
        {
          projectId: project.id,
          name: "Homepage → Pricing → Signup",
          steps: JSON.stringify([
            { url: "/", name: "Homepage" },
            { url: "/pricing", name: "Pricing" },
            { url: "/signup", name: "Signup" },
          ]),
        },
        {
          projectId: project.id,
          name: "Blog → Signup",
          steps: JSON.stringify([
            { url: "/blog", name: "Blog list" },
            { url: "/blog/getting-started", name: "Article" },
            { url: "/signup", name: "Signup" },
          ]),
        },
        {
          projectId: project.id,
          name: "Features → Pricing",
          steps: JSON.stringify([
            { url: "/features", name: "Features" },
            { url: "/pricing", name: "Pricing" },
          ]),
        },
      ],
    })
  }

  // Demo goals
  const existingGoals = await db.goal.count({ where: { projectId: project.id } })
  if (existingGoals === 0) {
    await db.goal.createMany({
      data: [
        { projectId: project.id, name: "Signup", type: "url", match: "equals", url: "/signup", value: 50 },
        { projectId: project.id, name: "Pricing view", type: "url", match: "equals", url: "/pricing", value: 10 },
        { projectId: project.id, name: "Contact form", type: "url", match: "equals", url: "/contact", value: 5 },
      ],
    })
  }

  // Demo segments
  const existingSegs = await db.segment.count({ where: { projectId: project.id } })
  if (existingSegs === 0) {
    await db.segment.createMany({
      data: [
        { projectId: project.id, name: "Mobile users", filters: JSON.stringify({ device: "mobile" }) },
        { projectId: project.id, name: "Rage-click sessions", filters: JSON.stringify({ hasRageClick: true }) },
        { projectId: project.id, name: "From Google", filters: JSON.stringify({ utmSource: "google" }) },
        { projectId: project.id, name: "Returning visitors", filters: JSON.stringify({ isNewVisitor: false }) },
      ],
    })
  }

  // Demo alerts
  const existingAlerts = await db.alert.count({ where: { projectId: project.id } })
  if (existingAlerts === 0) {
    await db.alert.createMany({
      data: [
        { projectId: project.id, name: "Rage click surge", metric: "rageClicks", condition: "gt", threshold: 5, windowMin: 60, channel: "inapp" },
        { projectId: project.id, name: "Error rate spike", metric: "errors", condition: "gt", threshold: 3, windowMin: 30, channel: "inapp" },
        { projectId: project.id, name: "Traffic drop", metric: "sessions", condition: "drops", threshold: 50, windowMin: 120, channel: "inapp" },
        { projectId: project.id, name: "Conversion dip", metric: "conversions", condition: "drops", threshold: 30, windowMin: 180, channel: "inapp" },
      ],
    })
    // seed some alert history
    const alerts = await db.alert.findMany({
      where: { projectId: project.id },
      take: 100,
    })
    for (const a of alerts.slice(0, 2)) {
      const triggerTime = new Date(now - Math.floor(Math.random() * 2 * 24 * 60 * 60 * 1000))
      await db.alertHistory.create({
        data: {
          alertId: a.id,
          projectId: project.id,
          triggeredAt: triggerTime,
          value: a.threshold + Math.floor(Math.random() * 5),
          message: `${a.name}: threshold ${a.threshold} exceeded`,
        },
      })
      await db.alert.update({ where: { id: a.id }, data: { lastTriggered: triggerTime } })
    }
  }

  // Demo dashboards
  const existingDash = await db.dashboard.count({ where: { projectId: project.id } })
  if (existingDash === 0) {
    await db.dashboard.createMany({
      data: [
        {
          projectId: project.id,
          name: "Executive Overview",
          layout: JSON.stringify([
            { id: "w1", type: "metric", title: "Total Sessions", metric: "totalSessions", w: 3, h: 1, x: 0, y: 0 },
            { id: "w2", type: "metric", title: "Conversions", metric: "conversions", w: 3, h: 1, x: 3, y: 0 },
            { id: "w3", type: "metric", title: "Rage Clicks", metric: "rageClicks", w: 3, h: 1, x: 6, y: 0 },
            { id: "w4", type: "metric", title: "JS Errors", metric: "errors", w: 3, h: 1, x: 9, y: 0 },
            { id: "w5", type: "chart", title: "Sessions trend", chart: "area", w: 6, h: 2, x: 0, y: 1 },
            { id: "w6", type: "chart", title: "Device split", chart: "pie", w: 6, h: 2, x: 6, y: 1 },
            { id: "w7", type: "table", title: "Top pages", table: "topPages", w: 6, h: 2, x: 0, y: 3 },
            { id: "w8", type: "table", title: "Top referrers", table: "referrer", w: 6, h: 2, x: 6, y: 3 },
          ]),
        },
        {
          projectId: project.id,
          name: "Performance Monitor",
          layout: JSON.stringify([
            { id: "w1", type: "metric", title: "Avg Duration", metric: "avgDuration", w: 4, h: 1, x: 0, y: 0 },
            { id: "w2", type: "metric", title: "Bounce Rate", metric: "bounceRate", w: 4, h: 1, x: 4, y: 0 },
            { id: "w3", type: "metric", title: "Active Now", metric: "activeNow", w: 4, h: 1, x: 8, y: 0 },
            { id: "w4", type: "chart", title: "Errors over time", chart: "bar", w: 12, h: 2, x: 0, y: 1 },
          ]),
        },
      ],
    })
  }

  // Demo experiments
  const existingExp = await db.experiment.count({ where: { projectId: project.id } })
  let expId = ""
  if (existingExp === 0) {
    const exp = await db.experiment.create({
      data: {
        projectId: project.id,
        name: "Pricing page CTA color",
        hypothesis: "Changing the CTA button from green to orange will increase signups by 10%",
        variants: JSON.stringify([
          { name: "control", weight: 50, description: "Green CTA button (current)" },
          { name: "variant_a", weight: 50, description: "Orange CTA button" },
        ]),
        goalName: "signup",
        status: "running",
        startDate: new Date(now - 5 * 24 * 60 * 60 * 1000),
      },
    })
    expId = exp.id
    // assign some existing sessions to variants (deterministic by visitor hash)
    const recentSessions = await db.session.findMany({
      where: { projectId: project.id, startedAt: { gte: new Date(now - 5 * 24 * 60 * 60 * 1000) } },
      take: 60,
    })
    for (const s of recentSessions) {
      const v = s.visitorId.charCodeAt(s.visitorId.length - 1) % 2 === 0 ? "control" : "variant_a"
      await db.session.update({ where: { id: s.id }, data: { experimentId: expId, variant: v } })
    }
  }

  // Demo annotations
  const existingAnn = await db.annotation.count({ where: { projectId: project.id } })
  if (existingAnn === 0) {
    await db.annotation.createMany({
      data: [
        { projectId: project.id, date: new Date(now - 5 * 24 * 60 * 60 * 1000), text: "Started pricing CTA experiment", color: "primary" },
        { projectId: project.id, date: new Date(now - 3 * 24 * 60 * 60 * 1000), text: "Deployed homepage redesign", color: "emerald" },
        { projectId: project.id, date: new Date(now - 1 * 24 * 60 * 60 * 1000), text: "Featured on Product Hunt", color: "amber" },
      ],
    })
  }

  return NextResponse.json({ ok: true, projectId: project.id, project, created })
}
