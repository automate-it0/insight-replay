"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { useApp } from "@/store/app"
import { api, fmtNumber, fmtRelative } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import {
  Globe,
  MousePointerClick,
  Eye,
  Zap,
  ArrowRight,
  Sparkles,
  PlayCircle,
  Flame,
  MapPin,
} from "lucide-react"

interface Project {
  id: string
  name: string
  siteUrl: string
  trackingId: string
  createdAt: string
  _count?: { sessions: number }
}

interface Stats {
  totals: {
    totalSessions: number
    activeNow: number
    totalClicks: number
    totalPages: number
    rageClicks: number
    deadClicks: number
    uniqueVisitors: number
    bounceRate: number
    avgDuration: number
  }
}

export const DashboardView = memo(function DashboardView() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [statsByProject, setStatsByProject] = useState<Record<string, Stats["totals"]>>({})
  const [seeding, setSeeding] = useState(false)
  const { openProject } = useApp()

  async function load() {
    setLoading(true)
    try {
      const data = await api<{ projects: Project[] }>("/api/projects")
      setProjects(data.projects)
      // fetch stats for each project (in parallel)
      const entries = await Promise.all(
        data.projects.map(async (p) => {
          try {
            const s = await api<Stats>(`/api/projects/${p.id}/stats?range=30`)
            return [p.id, s.totals] as const
          } catch {
            return [p.id, null] as const
          }
        })
      )
      const map: Record<string, Stats["totals"]> = {}
      for (const [id, t] of entries) if (t) map[id] = t
      setStatsByProject(map)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function seedDemo() {
    setSeeding(true)
    try {
      const r = await api<{ ok: boolean; created: number }>("/api/seed", {
        method: "POST",
        body: JSON.stringify({ count: 80 }),
      })
      toast.success(`Seeded ${r.created} demo sessions`)
      void load()
    } catch {
      toast.error("Failed to seed demo data")
    } finally {
      setSeeding(false)
    }
  }

  const { totalSessions, totalClicks, activeNow, rageClicks } = useMemo(
    () => {
      const values = Object.values(statsByProject)
      return {
        totalSessions: values.reduce((a, s) => a + s.totalSessions, 0),
        totalClicks: values.reduce((a, s) => a + s.totalClicks, 0),
        activeNow: values.reduce((a, s) => a + s.activeNow, 0),
        rageClicks: values.reduce((a, s) => a + s.rageClicks, 0),
      }
    },
    [statsByProject]
  )

  return (
    <div className="flex-1 overflow-y-auto scroll-thin">
      {/* Hero */}
      <div className="relative overflow-hidden border-b border-border/60">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-transparent" />
        <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative px-8 py-10 max-w-7xl">
          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-primary/15 text-primary border border-primary/25">
              <Sparkles className="h-3 w-3" />
              Session Replay · Heatmaps · Live
            </span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight max-w-2xl">
            Understand every user session like never before
          </h1>
          <p className="mt-3 text-muted-foreground max-w-xl">
            Replay recordings, visualize click heatmaps, watch live visitors, and surface
            frustration signals — a self-hosted alternative to Microsoft Clarity.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={seedDemo} disabled={seeding} variant="outline" className="gap-2">
              <PlayCircle className="h-4 w-4" />
              {seeding ? "Seeding demo data…" : "Seed demo data"}
            </Button>
          </div>

          {/* Global stat strip */}
          <div className="mt-8 grid grid-cols-2 md:grid-cols-4 gap-3 max-w-3xl">
            <HeroStat
              icon={<Eye className="h-4 w-4" />}
              label="Sessions (30d)"
              value={loading ? "—" : fmtNumber(totalSessions)}
            />
            <HeroStat
              icon={<MousePointerClick className="h-4 w-4" />}
              label="Clicks tracked"
              value={loading ? "—" : fmtNumber(totalClicks)}
            />
            <HeroStat
              icon={<Zap className="h-4 w-4" />}
              label="Active now"
              value={loading ? "—" : String(activeNow)}
              accent
            />
            <HeroStat
              icon={<Flame className="h-4 w-4" />}
              label="Rage clicks"
              value={loading ? "—" : fmtNumber(rageClicks)}
              danger
            />
          </div>
        </div>
      </div>

      {/* Projects */}
      <div className="px-8 py-8 max-w-7xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">Your projects</h2>
          <span className="text-xs text-muted-foreground">
            {projects.length} project{projects.length === 1 ? "" : "s"}
          </span>
        </div>

        {loading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <Card className="p-10 text-center border-dashed">
            <div className="mx-auto h-12 w-12 rounded-xl bg-primary/15 flex items-center justify-center mb-4">
              <Globe className="h-6 w-6 text-primary" />
            </div>
            <h3 className="font-semibold text-lg">No projects yet</h3>
            <p className="text-sm text-muted-foreground mt-1 mb-4">
              Create a project and install the tracking snippet, or seed demo data to explore.
            </p>
            <Button onClick={seedDemo} disabled={seeding} className="gap-2">
              <Sparkles className="h-4 w-4" />
              {seeding ? "Seeding…" : "Seed demo data"}
            </Button>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => {
              const s = statsByProject[p.id]
              return (
                <button
                  key={p.id}
                  onClick={() => openProject(p.id)}
                  className="group text-left"
                >
                  <Card className="p-5 h-full hover:border-primary/40 hover:bg-card/60 transition-all relative overflow-hidden">
                    <div className="absolute -top-12 -right-12 h-28 w-28 rounded-full bg-primary/5 blur-2xl group-hover:bg-primary/10 transition-colors" />
                    <div className="flex items-start justify-between relative">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">{p.name}</div>
                        <div className="text-xs text-muted-foreground truncate mt-0.5">
                          {p.siteUrl || "—"}
                        </div>
                      </div>
                      <div className="h-9 w-9 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
                        <Globe className="h-4 w-4 text-primary" />
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 mt-5 relative">
                      <MiniStat label="Sessions" value={s ? fmtNumber(s.totalSessions) : "—"} />
                      <MiniStat label="Active" value={s ? String(s.activeNow) : "—"} accent />
                      <MiniStat label="Rage" value={s ? String(s.rageClicks) : "—"} />
                    </div>

                    <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground relative">
                      <span className="flex items-center gap-1">
                        <MapPin className="h-3 w-3" />
                        {fmtRelative(p.createdAt)}
                      </span>
                      <span className="text-primary font-medium flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        Open <ArrowRight className="h-3 w-3" />
                      </span>
                    </div>
                  </Card>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
})

function HeroStat({
  icon,
  label,
  value,
  accent,
  danger,
}: {
  icon: React.ReactNode
  label: string
  value: string
  accent?: boolean
  danger?: boolean
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 backdrop-blur px-4 py-3">
      <div
        className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider ${
          accent ? "text-primary" : danger ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        {icon}
        {label}
      </div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  )
}

function MiniStat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent?: boolean
}) {
  return (
    <div className="rounded-lg bg-background/40 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${accent ? "text-primary" : ""}`}>{value}</div>
    </div>
  )
}
