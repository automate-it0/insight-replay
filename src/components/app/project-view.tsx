"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { useApp } from "@/store/app"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  BarChart3,
  PlayCircle,
  Flame,
  Radio,
  Lightbulb,
  Settings,
  ArrowLeft,
  Globe,
  Filter,
  GitBranch,
  Users,
  TrendingUp,
  Target,
  AlertTriangle,
  LayoutDashboard,
  FlaskConical,
  Bell,
} from "lucide-react"
import { OverviewTab } from "./overview-tab"
import { RecordingsTab } from "./recordings-tab"
import { HeatmapsTab } from "./heatmaps-tab"
import { LiveTab } from "./live-tab"
import { InsightsTab } from "./insights-tab"
import { SettingsTab } from "./settings-tab"
import { FunnelsTab } from "./funnels-tab"
import { JourneysTab } from "./journeys-tab"
import { VisitorsTab } from "./visitors-tab"
import { RetentionTab } from "./retention-tab"
import { GoalsTab } from "./goals-tab"
import { ErrorsTab } from "./errors-tab"
import { DashboardsTab } from "./dashboards-tab"
import { ExperimentsTab } from "./experiments-tab"
import { AlertsTab } from "./alerts-tab"
import { AlertBell } from "./alert-bell"
import { FilterBar } from "./filter-bar"

interface Project {
  id: string
  name: string
  siteUrl: string
  trackingId: string
  // Backend returns Prisma's Project (which includes createdAt). SettingsTab
  // expects this field, so the local interface must declare the same shape
  // — otherwise TS sees two unrelated `Project` types and refuses to pass
  // one where the other is expected.
  createdAt: string
}

const TABS = [
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "dashboards", label: "Dashboards", icon: LayoutDashboard },
  { id: "recordings", label: "Recordings", icon: PlayCircle },
  { id: "heatmaps", label: "Heatmaps", icon: Flame },
  { id: "live", label: "Live", icon: Radio },
  { id: "funnels", label: "Funnels", icon: Filter },
  { id: "journeys", label: "Journeys", icon: GitBranch },
  { id: "experiments", label: "Experiments", icon: FlaskConical },
  { id: "visitors", label: "Visitors", icon: Users },
  { id: "retention", label: "Retention", icon: TrendingUp },
  { id: "goals", label: "Goals", icon: Target },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "insights", label: "Insights", icon: Lightbulb },
  { id: "errors", label: "Errors", icon: AlertTriangle },
  { id: "settings", label: "Settings", icon: Settings },
] as const

const FILTERABLE_TABS = ["overview", "recordings", "insights"]

export const ProjectView = memo(function ProjectView() {
  const { activeProjectId, tab, setTab, range, setRange, goHome } = useApp()
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeNow, setActiveNow] = useState(0)

  useEffect(() => {
    if (!activeProjectId) return
    setLoading(true)
    void api<{ project: Project; counts: { _count: number } }>(
      `/api/projects/${activeProjectId}`
    )
      .then((d) => setProject(d.project))
      .finally(() => setLoading(false))
  }, [activeProjectId])

  useEffect(() => {
    if (!activeProjectId) return
    let alive = true
    async function poll() {
      try {
        const s = await api<{ totals: { activeNow: number } }>(
          `/api/projects/${activeProjectId}/stats?range=1`
        )
        if (alive) setActiveNow(s.totals.activeNow)
      } catch {}
    }
    void poll()
    const t = setInterval(poll, 8000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [activeProjectId])

  // NOTE: this hook must stay ABOVE the early returns below. React requires
  // hooks to be called in the same order on every render — placing it after
  // an early return means the hook count changes between renders (loading
  // true → false), which breaks the rules of hooks and can corrupt the
  // component state.
  const showFilters = useMemo(() => FILTERABLE_TABS.includes(tab), [tab])

  if (loading) {
    return (
      <div className="flex-1 p-8 space-y-4 overflow-y-auto">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        Project not found.
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="border-b border-border/60 bg-card/30 backdrop-blur px-6 py-3 flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={goHome} className="gap-1.5 text-muted-foreground" aria-label="Back to projects list">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">Projects</span>
        </Button>
        <div className="h-6 w-px bg-border" aria-hidden="true" />
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-8 w-8 rounded-lg bg-primary/15 flex items-center justify-center shrink-0" aria-hidden="true">
            <Globe className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-sm truncate leading-tight">{project.name}</div>
            <div className="text-[11px] text-muted-foreground truncate">
              {project.siteUrl || "—"}
            </div>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-3">
          {activeNow > 0 && (
            <div
              className="hidden sm:flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full bg-primary/15 text-primary border border-primary/25"
              role="status"
              aria-live="polite"
              aria-label={`${activeNow} visitors active now`}
            >
              <span className="relative flex h-2 w-2" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
              </span>
              {activeNow} live
            </div>
          )}
          <AlertBell projectId={project.id} />
          <div
            className="flex items-center rounded-lg border border-border/60 bg-background/40 p-0.5"
            role="group"
            aria-label="Time range selector"
          >
            {(["1", "7", "30"] as const).map((r) => {
              const label = r === "1" ? "24 hours" : r === "7" ? "7 days" : "30 days"
              return (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  aria-pressed={range === r}
                  aria-label={`Last ${label}`}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    range === r
                      ? "bg-primary/20 text-primary font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {r === "1" ? "24h" : r === "7" ? "7d" : "30d"}
                </button>
              )
            })}
          </div>
        </div>
      </header>

      <div
        className="border-b border-border/60 px-6 flex items-center gap-1 overflow-x-auto scroll-thin"
        role="tablist"
        aria-label="Project analytics tabs"
      >
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              role="tab"
              aria-selected={active}
              aria-controls={`tabpanel-${t.id}`}
              id={`tab-${t.id}`}
              tabIndex={active ? 0 : -1}
              className={`relative flex items-center gap-2 px-3 py-3 text-sm transition-colors whitespace-nowrap ${
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t.label}
              {t.id === "live" && activeNow > 0 && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                  {activeNow}
                </span>
              )}
              {active && (
                <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-primary rounded-full" aria-hidden="true" />
              )}
            </button>
          )
        })}
      </div>

      {showFilters && <FilterBar projectId={project.id} range={range} />}

      <div
        className="flex-1 min-h-0 overflow-hidden"
        role="tabpanel"
        id={`tabpanel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        tabIndex={0}
      >
        {tab === "overview" && <OverviewTab projectId={project.id} range={range} />}
        {tab === "dashboards" && <DashboardsTab projectId={project.id} range={range} />}
        {tab === "recordings" && <RecordingsTab projectId={project.id} range={range} />}
        {tab === "heatmaps" && <HeatmapsTab projectId={project.id} range={range} />}
        {tab === "live" && <LiveTab projectId={project.id} />}
        {tab === "funnels" && <FunnelsTab projectId={project.id} range={range} />}
        {tab === "journeys" && <JourneysTab projectId={project.id} range={range} />}
        {tab === "experiments" && <ExperimentsTab projectId={project.id} range={range} />}
        {tab === "visitors" && <VisitorsTab projectId={project.id} range={range} />}
        {tab === "retention" && <RetentionTab projectId={project.id} range={range} />}
        {tab === "goals" && <GoalsTab projectId={project.id} range={range} />}
        {tab === "alerts" && <AlertsTab projectId={project.id} />}
        {tab === "insights" && <InsightsTab projectId={project.id} range={range} />}
        {tab === "errors" && <ErrorsTab projectId={project.id} range={range} />}
        {tab === "settings" && <SettingsTab project={project} />}
      </div>
    </div>
  )
})
