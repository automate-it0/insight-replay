"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import { toast } from "sonner"
import { X, Activity, Zap } from "lucide-react"
import { useTracker } from "./use-tracker"

interface Project {
  id: string
  name: string
  siteUrl: string
  trackingId: string
}

export const DemoSiteDialog = memo(function DemoSiteDialog({
  open,
  onOpenChange,
  projects,
  onCreated,
  overrideProjectId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projects: Project[]
  onCreated: () => void
  overrideProjectId?: string | null
}) {
  const [projectId, setProjectId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    ;void (async () => {
      // Prefer an explicit override (e.g. the project currently being viewed)
      if (overrideProjectId) {
        if (alive) setProjectId(overrideProjectId)
        return
      }
      // Otherwise find or create the Demo Site project
      let p = projects.find((x) => x.name === "Acme Inc. — Marketing Site")
      if (!p) {
        try {
          const r = await api<{ project: Project }>("/api/seed", {
            method: "POST",
            body: JSON.stringify({ count: 0 }),
          })
          p = r.project
          onCreated()
        } catch {
          toast.error("Failed to set up demo project")
          return
        }
      }
      if (alive && p) setProjectId(p.id)
    })()
    return () => {
      alive = false
    }
  }, [open, overrideProjectId])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Demo site preview"
      onKeyDown={(e) => { if (e.key === "Escape") onOpenChange(false) }}
    >
      <div className="bg-[#0f1115] rounded-xl shadow-2xl w-full max-w-6xl h-[88vh] flex flex-col overflow-hidden border border-white/10">
        {/* Fake browser chrome */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/10 bg-[#15171c]">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="h-3 w-3 rounded-full bg-red-500/80" />
            <span className="h-3 w-3 rounded-full bg-yellow-500/80" />
            <span className="h-3 w-3 rounded-full bg-green-500/80" />
          </div>
          <div className="flex-1 flex items-center justify-center">
            <div className="bg-black/40 rounded-md px-3 py-1 text-xs text-white/50 font-mono flex items-center gap-1.5 max-w-md w-full justify-center" aria-hidden="true">
              <span className="text-emerald-400">●</span>
              https://acme.example.com
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/20" aria-hidden="true">
            <Activity className="h-3 w-3" />
            Tracking active
          </div>
          <button
            onClick={() => onOpenChange(false)}
            className="h-7 w-7 rounded flex items-center justify-center hover:bg-white/10 text-white/60"
            aria-label="Close demo site preview"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <DemoSite projectId={projectId} />
      </div>
    </div>
  )
})

function DemoSite({ projectId }: { projectId: string | null }) {
  useTracker(projectId)
  const [page, setPage] = useState<"home" | "pricing" | "features" | "contact">("home")

  // Stable list of demo-site nav items — recreated only when projectId changes
  // (it never does in practice, but we depend on nothing else so the array
  // reference is stable across re-renders from local state updates).
  const navItems = useMemo(
    () => (["home", "features", "pricing", "contact"] as const),
    []
  )

  // push a synthetic pageview when page changes
  useEffect(() => {
    if (!projectId) return
    // best-effort: post a pageview-only event batch
    const visitorId = localStorage.getItem("ir_visitor") || "v_demo"
    const sessionId = sessionStorage.getItem("ir_session") || "s_demo"
    fetch("/api/track/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        visitorId,
        sessionId,
        userAgent: navigator.userAgent,
        screenWidth: screen.width,
        screenHeight: screen.height,
        events: [
          {
            type: "pageview",
            t: Date.now() % 1000000,
            x: 0,
            y: 0,
            scrollX: 0,
            scrollY: 0,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            pageUrl: "/" + (page === "home" ? "" : page),
            data: { title: page },
          },
        ],
      }),
      keepalive: true,
    }).catch(() => {})
  }, [page, projectId])

  return (
    <div className="flex-1 overflow-y-auto scroll-thin bg-[#0f1115] text-[#e7e9ee]">
      {/* nav */}
      <header className="sticky top-0 z-10 flex items-center justify-between px-8 py-3 border-b border-white/10 bg-[#0f1115]/90 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-400" aria-hidden="true" />
          <span className="font-semibold">Acme</span>
        </div>
        <nav className="flex items-center gap-6 text-sm text-white/70" aria-label="Demo site navigation">
          {navItems.map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              aria-current={page === p ? "page" : undefined}
              className={`capitalize ${page === p ? "text-white" : "hover:text-white"}`}
            >
              {p}
            </button>
          ))}
          <button
            onClick={() => toast.success("Signed up! (demo)")}
            className="px-3 py-1.5 rounded-md bg-emerald-500 text-black text-xs font-medium"
          >
            Start free
          </button>
        </nav>
      </header>

      {page === "home" && <HomeNav setPage={setPage} />}
      {page === "features" && <FeaturesView />}
      {page === "pricing" && <PricingView />}
      {page === "contact" && <ContactView />}

      <footer className="border-t border-white/10 px-8 py-6 text-xs text-white/40 flex items-center justify-between">
        <span>© Acme Inc. — this page is tracked live by Insight Replay</span>
        <span className="flex items-center gap-1">
          <Zap className="h-3 w-3 text-emerald-400" aria-hidden="true" />
          Move your mouse — watch it appear in the Live tab
        </span>
      </footer>
    </div>
  )
}

function HomeNav({ setPage }: { setPage: (p: "home" | "features" | "pricing" | "contact") => void }) {
  return (
    <div>
      <section className="px-8 py-16 text-center max-w-3xl mx-auto">
        <div className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-white/10 text-white/70 mb-5">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> New: Live session replays
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight leading-tight">
          Ship faster with <span className="text-gradient">insight</span>, not guesswork
        </h1>
        <p className="text-white/60 mt-4 max-w-xl mx-auto">
          The analytics platform that shows you exactly what users do — session by session, click
          by click.
        </p>
        <div className="flex items-center justify-center gap-3 mt-7">
          <button
            onClick={() => setPage("pricing")}
            className="px-5 py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold"
          >
            Start free trial
          </button>
          <button
            onClick={() => setPage("features")}
            className="px-5 py-2.5 rounded-lg border border-white/20 text-sm"
          >
            See features
          </button>
        </div>
        <div className="mt-10 h-44 rounded-xl bg-gradient-to-br from-white/5 to-white/0 border border-white/10 flex items-center justify-center text-white/30">
          Product preview
        </div>
      </section>
      <section className="px-8 py-10 grid grid-cols-1 md:grid-cols-3 gap-4 max-w-4xl mx-auto">
        {["Session Replay", "Heatmaps", "Live Tracking"].map((t) => (
          <div key={t} className="rounded-xl border border-white/10 p-5 bg-white/[0.02]">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/20 mb-3" />
            <div className="font-semibold">{t}</div>
            <div className="h-2 w-full rounded bg-white/8 mt-3" />
            <div className="h-2 w-4/5 rounded bg-white/8 mt-1.5" />
            <button
              onClick={() => setPage("features")}
              className="text-sm text-emerald-400 mt-4 inline-block"
            >
              Learn more →
            </button>
          </div>
        ))}
      </section>
    </div>
  )
}

function FeaturesView() {
  return (
    <section className="px-8 py-14 max-w-4xl mx-auto">
      <h2 className="text-3xl font-bold text-center">Everything you need to understand users</h2>
      <div className="grid md:grid-cols-2 gap-5 mt-10">
        {[
          ["Session recordings", "Replay any visitor's journey click-by-click."],
          ["Click heatmaps", "See where users click most — and where they don't."],
          ["Live view", "Watch active visitors in real time."],
          ["Insights", "Auto-detect rage clicks, dead clicks, and more."],
        ].map(([t, d]) => (
          <div key={t} className="rounded-2xl border border-white/10 p-6 bg-white/[0.02]">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/20 mb-4" />
            <div className="font-semibold text-lg">{t}</div>
            <p className="text-white/60 text-sm mt-1">{d}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function PricingView() {
  const plans = [
    { name: "Starter", price: "$0", cta: "Choose Starter", highlight: false },
    { name: "Pro", price: "$29", cta: "Choose Pro", highlight: true },
    { name: "Team", price: "$99", cta: "Choose Team", highlight: false },
  ]
  return (
    <section className="px-8 py-14">
      <h2 className="text-3xl font-bold text-center">Simple, transparent pricing</h2>
      <p className="text-white/60 text-center mt-2">Start free. Upgrade when you grow.</p>
      <div className="grid md:grid-cols-3 gap-5 mt-10 max-w-4xl mx-auto">
        {plans.map((p) => (
          <div
            key={p.name}
            className={`rounded-2xl p-6 border ${
              p.highlight ? "border-emerald-500/60 bg-emerald-500/[0.06]" : "border-white/10"
            }`}
          >
            <div className="text-sm text-white/60">{p.name}</div>
            <div className="text-4xl font-bold mt-2">
              {p.price}
              <span className="text-sm text-white/40 font-normal">/mo</span>
            </div>
            <div className="space-y-2 mt-5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-2 rounded bg-white/8" style={{ width: `${90 - i * 10}%` }} />
              ))}
            </div>
            <button
              onClick={() => toast.success(`Selected ${p.name} (demo)`)}
              className={`block w-full text-center mt-6 py-2.5 rounded-lg text-sm font-medium ${
                p.highlight ? "bg-emerald-500 text-black" : "border border-white/20"
              }`}
            >
              {p.cta}
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

function ContactView() {
  return (
    <div className="px-8 py-14 max-w-md mx-auto">
      <h2 className="text-2xl font-bold text-center">Get in touch</h2>
      <div className="space-y-3 mt-7">
        <div>
          <label htmlFor="demo-contact-name" className="text-xs text-white/50 mb-1.5 block">Name</label>
          <input id="demo-contact-name" className="w-full h-10 rounded-lg bg-white/5 border border-white/10 px-3 text-sm outline-none focus:border-emerald-500" placeholder="Your name" aria-label="Your name" />
        </div>
        <div>
          <label htmlFor="demo-contact-email" className="text-xs text-white/50 mb-1.5 block">Email</label>
          <input id="demo-contact-email" type="email" className="w-full h-10 rounded-lg bg-white/5 border border-white/10 px-3 text-sm outline-none focus:border-emerald-500" placeholder="you@example.com" aria-label="Your email" />
        </div>
        <div>
          <label htmlFor="demo-contact-message" className="text-xs text-white/50 mb-1.5 block">Message</label>
          <textarea id="demo-contact-message" className="w-full h-24 rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-sm outline-none focus:border-emerald-500" placeholder="How can we help?" aria-label="Your message" />
        </div>
        <button
          onClick={() => toast.success("Message sent! (demo)")}
          className="w-full py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold"
        >
          Send message
        </button>
      </div>
    </div>
  )
}
