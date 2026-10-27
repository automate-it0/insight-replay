"use client"

import { memo, useMemo } from "react"

// Stylized website wireframes rendered at a natural pixel width so that
// recorded cursor / scroll coordinates line up with visible UI.
export const PageMock = memo(function PageMock({ url, width }: { url: string; width: number }) {
  const isMobile = useMemo(() => width < 600, [width])
  const isKnown = useMemo(() => knownPage(url), [url])
  return (
    <div
      style={{ width }}
      className="bg-[#0f1115] text-[#e7e9ee] font-sans mx-auto origin-top-left"
    >
      {/* Header */}
      <header
        className="flex items-center justify-between px-8 border-b border-white/10"
        style={{ height: 64 }}
      >
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-400 to-cyan-400" />
          <span className="font-semibold tracking-tight">Acme</span>
        </div>
        <nav className="flex items-center gap-6 text-sm text-white/70">
          {!isMobile && (
            <>
              <span>Features</span>
              <span>Pricing</span>
              <span>Blog</span>
              <span>Docs</span>
            </>
          )}
          <span className="px-3 py-1.5 rounded-md bg-emerald-500/90 text-black text-xs font-medium">
            {url === "/login" ? "Log in" : "Start free"}
          </span>
        </nav>
      </header>

      {url === "/" && <HeroLanding />}
      {url === "/pricing" && <PricingPage isMobile={isMobile} />}
      {url === "/features" && <FeaturesPage isMobile={isMobile} />}
      {url === "/blog" && <BlogList isMobile={isMobile} />}
      {url === "/blog/getting-started" && <ArticlePage />}
      {url === "/docs" && <DocsPage />}
      {(url === "/signup" || url === "/login") && <AuthPage mode={url} />}
      {url === "/contact" && <ContactPage />}
      {!isKnown && <HeroLanding />}

      <footer className="border-t border-white/10 px-8 py-6 text-xs text-white/40 flex items-center justify-between">
        <span>© Acme Inc.</span>
        <span>Built for builders</span>
      </footer>
    </div>
  )
})

function knownPage(url: string) {
  return [
    "/",
    "/pricing",
    "/features",
    "/blog",
    "/blog/getting-started",
    "/docs",
    "/signup",
    "/login",
    "/contact",
  ].includes(url)
}

function HeroLanding() {
  return (
    <div>
      <section className="px-8 py-16 text-center max-w-3xl mx-auto" style={{ minHeight: 560 }}>
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
          <span className="px-5 py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold">
            Start free trial
          </span>
          <span className="px-5 py-2.5 rounded-lg border border-white/20 text-sm">See demo</span>
        </div>
        <div className="mt-10 h-44 rounded-xl bg-gradient-to-br from-white/5 to-white/0 border border-white/10" />
      </section>
      <section className="px-8 py-10 grid grid-cols-1 md:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xl border border-white/10 p-5 bg-white/[0.02]">
            <div className="h-8 w-8 rounded-lg bg-emerald-500/20 mb-3" />
            <div className="h-3 w-2/3 rounded bg-white/15 mb-2" />
            <div className="h-2 w-full rounded bg-white/8" />
            <div className="h-2 w-4/5 rounded bg-white/8 mt-1.5" />
          </div>
        ))}
      </section>
      <section className="px-8 py-14 text-center">
        <div className="h-3 w-48 rounded bg-white/15 mx-auto mb-3" />
        <div className="h-2 w-72 rounded bg-white/8 mx-auto" />
        <span className="inline-block mt-6 px-5 py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold">
          Get started
        </span>
      </section>
    </div>
  )
}

function PricingPage({ isMobile }: { isMobile: boolean }) {
  const plans = [
    { name: "Starter", price: "$0", cta: "Choose Starter", highlight: false },
    { name: "Pro", price: "$29", cta: "Choose Pro", highlight: true },
    { name: "Team", price: "$99", cta: "Choose Team", highlight: false },
  ]
  return (
    <section className="px-8 py-14">
      <h2 className="text-3xl font-bold text-center">Simple, transparent pricing</h2>
      <p className="text-white/60 text-center mt-2">Start free. Upgrade when you grow.</p>
      <div className={`grid gap-5 mt-10 max-w-4xl mx-auto ${isMobile ? "grid-cols-1" : "grid-cols-3"}`}>
        {plans.map((p) => (
          <div
            key={p.name}
            className={`rounded-2xl p-6 border ${
              p.highlight ? "border-emerald-500/60 bg-emerald-500/[0.06]" : "border-white/10"
            }`}
          >
            <div className="text-sm text-white/60">{p.name}</div>
            <div className="text-4xl font-bold mt-2">{p.price}<span className="text-sm text-white/40 font-normal">/mo</span></div>
            <div className="space-y-2 mt-5">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-2 rounded bg-white/8" style={{ width: `${90 - i * 10}%` }} />
              ))}
            </div>
            <span
              className={`block text-center mt-6 py-2.5 rounded-lg text-sm font-medium ${
                p.highlight ? "bg-emerald-500 text-black" : "border border-white/20"
              }`}
            >
              {p.cta}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

function FeaturesPage({ isMobile }: { isMobile: boolean }) {
  return (
    <section className="px-8 py-14">
      <h2 className="text-3xl font-bold text-center">Everything you need to understand users</h2>
      <div className={`grid gap-5 mt-10 max-w-4xl mx-auto ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-2xl border border-white/10 p-6 bg-white/[0.02]">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/20 mb-4" />
            <div className="h-3 w-1/2 rounded bg-white/20 mb-2" />
            <div className="h-2 w-full rounded bg-white/8 mb-1" />
            <div className="h-2 w-4/5 rounded bg-white/8" />
            <span className="inline-block mt-4 text-sm text-emerald-400">Learn more →</span>
          </div>
        ))}
      </div>
      <div className="text-center mt-12">
        <span className="inline-block px-5 py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold">
          Try it free
        </span>
      </div>
    </section>
  )
}

function BlogList({ isMobile }: { isMobile: boolean }) {
  return (
    <section className="px-8 py-12 max-w-4xl mx-auto">
      <h2 className="text-3xl font-bold">From the blog</h2>
      <div className={`grid gap-5 mt-8 ${isMobile ? "grid-cols-1" : "grid-cols-2"}`}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-white/10 overflow-hidden">
            <div className="h-40 bg-gradient-to-br from-emerald-500/20 to-cyan-500/10" />
            <div className="p-5">
              <div className="h-3 w-3/4 rounded bg-white/20 mb-2" />
              <div className="h-2 w-full rounded bg-white/8 mb-1" />
              <div className="h-2 w-5/6 rounded bg-white/8" />
              <span className="inline-block mt-3 text-sm text-emerald-400">Read more →</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ArticlePage() {
  return (
    <article className="px-8 py-12 max-w-2xl mx-auto">
      <div className="h-4 w-1/3 rounded bg-emerald-500/40 mb-4" />
      <h1 className="text-3xl font-bold leading-tight">Getting started with Acme in 5 minutes</h1>
      <div className="text-white/40 text-sm mt-2">5 min read · Aug 2024</div>
      <div className="space-y-3 mt-8">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="h-2.5 rounded bg-white/8" style={{ width: `${95 - (i % 3) * 12}%` }} />
        ))}
      </div>
      <div className="h-48 rounded-xl bg-white/5 border border-white/10 my-8" />
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-2.5 rounded bg-white/8" style={{ width: `${92 - (i % 2) * 10}%` }} />
        ))}
      </div>
      <span className="inline-block mt-8 px-5 py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold">
        Sign up
      </span>
    </article>
  )
}

function DocsPage() {
  return (
    <div className="flex">
      <aside className="w-56 border-r border-white/10 p-5 hidden md:block">
        <div className="text-xs uppercase text-white/40 mb-3">Guides</div>
        {["Quickstart", "Installation", "Tracking SDK", "Heatmaps", "API reference"].map((s, i) => (
          <div key={s} className={`text-sm py-1.5 ${i === 0 ? "text-emerald-400" : "text-white/60"}`}>
            {s}
          </div>
        ))}
      </aside>
      <div className="flex-1 p-8 max-w-2xl">
        <h1 className="text-3xl font-bold">Quickstart</h1>
        <div className="space-y-3 mt-6">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-2.5 rounded bg-white/8" style={{ width: `${94 - (i % 3) * 10}%` }} />
          ))}
        </div>
        <div className="rounded-lg bg-black/40 border border-white/10 p-4 my-6 font-mono text-xs text-emerald-300">
          npm install @acme/tracker
        </div>
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-2.5 rounded bg-white/8" style={{ width: `${88 - i * 8}%` }} />
          ))}
        </div>
      </div>
    </div>
  )
}

function AuthPage({ mode }: { mode: string }) {
  return (
    <div className="px-8 py-14 max-w-sm mx-auto">
      <h2 className="text-2xl font-bold text-center">
        {mode === "/signup" ? "Create your account" : "Welcome back"}
      </h2>
      <p className="text-white/50 text-center text-sm mt-1">
        {mode === "/signup" ? "Start tracking in minutes" : "Log in to your dashboard"}
      </p>
      <div className="space-y-3 mt-7">
        {mode === "/signup" && (
          <Field label="Full name" />
        )}
        <Field label="Email" />
        <Field label="Password" />
        <span className="block text-center mt-5 py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold">
          {mode === "/signup" ? "Create account" : "Log in"}
        </span>
      </div>
    </div>
  )
}

function ContactPage() {
  return (
    <div className="px-8 py-14 max-w-md mx-auto">
      <h2 className="text-2xl font-bold text-center">Get in touch</h2>
      <div className="space-y-3 mt-7">
        <Field label="Name" />
        <Field label="Email" />
        <div className="h-24 rounded-lg bg-white/5 border border-white/10" />
        <span className="block text-center mt-5 py-2.5 rounded-lg bg-emerald-500 text-black text-sm font-semibold">
          Send
        </span>
      </div>
    </div>
  )
}

function Field({ label }: { label: string }) {
  return (
    <div>
      <div className="text-xs text-white/50 mb-1.5">{label}</div>
      <div className="h-10 rounded-lg bg-white/5 border border-white/10" />
    </div>
  )
}
