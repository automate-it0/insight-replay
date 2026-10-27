"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { api, fmtNumber, fmtDuration } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts"
import { toast } from "sonner"
import { LayoutDashboard, Plus, Trash2, Eye, TrendingUp, AlertTriangle, Target, Clock, Users, Zap } from "lucide-react"

interface Widget {
  id: string
  type: "metric" | "chart" | "table"
  title: string
  metric?: string
  chart?: string
  table?: string
  w: number
  h: number
  x: number
  y: number
}
interface Dashboard {
  id: string
  name: string
  layout: Widget[]
}

const PIE_COLORS = ["oklch(0.72 0.16 162)", "oklch(0.74 0.16 230)", "oklch(0.78 0.18 70)", "oklch(0.66 0.22 320)"]

const METRIC_ICONS: Record<string, any> = {
  totalSessions: Eye,
  conversions: Target,
  rageClicks: AlertTriangle,
  errors: AlertTriangle,
  avgDuration: Clock,
  bounceRate: TrendingUp,
  activeNow: Zap,
  uniqueVisitors: Users,
}

export function DashboardsTab({ projectId, range }: { projectId: string; range: string }) {
  const [dashboards, setDashboards] = useState<Dashboard[]>([])
  const [active, setActive] = useState<Dashboard | null>(null)
  const [widgetData, setWidgetData] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)
  const [dataLoading, setDataLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")

  async function load() {
    setLoading(true)
    try {
      const d = await api<{ dashboards: Dashboard[] }>(`/api/projects/${projectId}/dashboards`)
      setDashboards(d.dashboards)
      if (d.dashboards.length && !active) {
        setActive(d.dashboards[0])
        void loadDashboardData(d.dashboards[0])
      }
    } finally {
      setLoading(false)
    }
  }

  async function loadDashboardData(dash: Dashboard) {
    setDataLoading(true)
    setActive(dash)
    setWidgetData({})
    try {
      const d = await api<{ widgets: Record<string, { data: any }> }>(
        `/api/projects/${projectId}/dashboards/${dash.id}/data?range=${range}`
      )
      setWidgetData(d.widgets)
    } catch {
      toast.error("Failed to load dashboard data")
    } finally {
      setDataLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [projectId])

  useEffect(() => {
    if (active) void loadDashboardData(active)
  }, [range])

  async function handleCreate() {
    if (!newName.trim()) return
    try {
      const d = await api<{ dashboard: Dashboard }>(`/api/projects/${projectId}/dashboards`, {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), layout: [] }),
      })
      setDashboards((arr) => [...arr, d.dashboard])
      setCreateOpen(false)
      setNewName("")
      toast.success("Dashboard created")
      void loadDashboardData(d.dashboard)
    } catch {
      toast.error("Failed to create dashboard")
    }
  }

  async function removeDash(id: string) {
    try {
      await api(`/api/projects/${projectId}/dashboards/${id}`, { method: "DELETE" })
      const remaining = dashboards.filter((d) => d.id !== id)
      setDashboards(remaining)
      if (active?.id === id) {
        setActive(remaining[0] || null)
        setWidgetData({})
      }
    } catch {}
  }

  // Memoize the rendered widget grid so unrelated state changes (createOpen,
  // newName typing in the dialog) don't re-walk the layout + re-render every
  // WidgetRenderer. Deps are `active` (the layout source) and `widgetData`
  // (the data source) — both stable references when the user is just
  // interacting with the create-dialog input.
  const renderedWidgets = useMemo(() => {
    if (!active || active.layout.length === 0) return null
    return active.layout.map((w) => {
      const data = widgetData[w.id]?.data
      return (
        <div
          key={w.id}
          style={{ gridColumn: `span ${w.w}`, gridRow: `span ${w.h}` }}
          className="min-h-[80px]"
        >
          <WidgetRenderer widget={w} data={data} />
        </div>
      )
    })
  }, [active, widgetData])

  // Memoize the sidebar dashboard list — same idea: typing in the create
  // dialog shouldn't re-render every sidebar button.
  // NOTE: list rendering moved inline so each row can carry an accessible
  // active state (aria-current) and a real <button> for the delete action
  // (the old SVG-with-onClick was not keyboard reachable).
  // const renderedDashboardList = useMemo(...) — replaced above.

  return (
    <div className="h-full flex">
      <div className="w-56 shrink-0 border-r border-border/60 flex flex-col">
        <div className="p-3 border-b border-border/60">
          <Button onClick={() => setCreateOpen(true)} className="w-full gap-2" size="sm">
            <Plus className="h-4 w-4" aria-hidden="true" /> New dashboard
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin p-2 space-y-1">
          {loading ? (
            <div className="p-3 space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          ) : dashboards.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">No dashboards yet.</div>
          ) : (
            <ul className="space-y-1 list-none p-0 m-0">
              {dashboards.map((d) => (
                <li key={d.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => loadDashboardData(d)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault()
                        void loadDashboardData(d)
                      }
                    }}
                    aria-current={active?.id === d.id ? "true" : undefined}
                    className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors group flex items-center gap-2 cursor-pointer ${
                      active?.id === d.id ? "bg-primary/15" : "hover:bg-card/40"
                    }`}
                  >
                    <LayoutDashboard className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
                    <span className="text-sm font-medium truncate flex-1">{d.name}</span>
                    <button
                      type="button"
                      aria-label={`Delete dashboard ${d.name}`}
                      className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive p-0.5 -m-0.5"
                      onClick={(e) => { e.stopPropagation(); void removeDash(d.id) }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin">
        {!active ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select or create a dashboard
          </div>
        ) : (
          <div className="p-6">
            <div className="mb-5">
              <h2 className="text-lg font-semibold">{active.name}</h2>
              <p className="text-xs text-muted-foreground">{active.layout.length} widgets</p>
            </div>

            {active.layout.length === 0 ? (
              <Card className="p-10 text-center border-dashed">
                <LayoutDashboard className="h-10 w-10 text-muted-foreground mx-auto mb-3" aria-hidden="true" />
                <div className="font-medium">This dashboard is empty</div>
                <p className="text-xs text-muted-foreground mt-1">Pre-built dashboards include widgets. Create one from a template or add widgets via the API.</p>
              </Card>
            ) : dataLoading ? (
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(12, 1fr)" }}>
                {active.layout.map((w) => (
                  <div key={w.id} style={{ gridColumn: `span ${w.w}`, gridRow: `span ${w.h}` }}>
                    <Skeleton className="h-full min-h-[80px] rounded-xl" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(12, 1fr)", gridAutoRows: "120px" }}>
                {renderedWidgets}
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create dashboard</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-2">
              <Label htmlFor="dashboard-name">Dashboard name</Label>
              <Input id="dashboard-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Marketing KPIs" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

const WidgetRenderer = memo(function WidgetRenderer({ widget, data }: { widget: Widget; data: any }) {
  if (widget.type === "metric") {
    const Icon = METRIC_ICONS[widget.metric || ""] || Eye
    const value = data?.value ?? 0
    const label = data?.label ?? widget.title
    return (
      <Card className="p-4 h-full flex flex-col justify-between">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {widget.title}
        </div>
        <div className="text-3xl font-semibold">
          {widget.metric === "avgDuration" ? fmtDuration(value) : widget.metric === "bounceRate" ? `${value}%` : fmtNumber(value)}
        </div>
        <div className="text-[10px] text-muted-foreground">{label}</div>
      </Card>
    )
  }

  if (widget.type === "chart") {
    return (
      <Card className="p-4 h-full flex flex-col">
        <div className="text-sm font-semibold mb-2">{widget.title}</div>
        <div className="flex-1 min-h-0">
          {!data ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">No data</div>
          ) : widget.chart === "area" ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id={`g${widget.id}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="oklch(0.72 0.16 162)" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="oklch(0.72 0.16 162)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 0.06)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "oklch(0.68 0 0)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fill: "oklch(0.68 0 0)", fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "oklch(0.205 0 0)", border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 8, fontSize: 11 }} />
                <Area type="monotone" dataKey="sessions" stroke="oklch(0.72 0.16 162)" strokeWidth={2} fill={`url(#g${widget.id})`} />
              </AreaChart>
            </ResponsiveContainer>
          ) : widget.chart === "pie" ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={data} dataKey="value" nameKey="name" innerRadius={30} outerRadius={50} paddingAngle={3} stroke="none">
                  {data.map((_: any, i: number) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "oklch(0.205 0 0)", border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 8, fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : widget.chart === "bar" ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 2, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 0.06)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "oklch(0.68 0 0)", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(d) => d.slice(5)} />
                <YAxis tick={{ fill: "oklch(0.68 0 0)", fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: "oklch(0.205 0 0)", border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 8, fontSize: 11 }} cursor={{ fill: "oklch(1 0 0 / 0.04)" }} />
                <Bar dataKey="count" fill="oklch(0.66 0.2 22)" radius={[3, 3, 0, 0]} barSize={16} />
              </BarChart>
            </ResponsiveContainer>
          ) : null}
        </div>
      </Card>
    )
  }

  if (widget.type === "table") {
    return (
      <Card className="p-4 h-full flex flex-col">
        <div className="text-sm font-semibold mb-2">{widget.title}</div>
        <div className="flex-1 overflow-y-auto scroll-thin space-y-1.5">
          {!data || data.length === 0 ? (
            <div className="text-xs text-muted-foreground py-4 text-center">No data</div>
          ) : (
            data.map((row: any, i: number) => {
              const max = data[0]?.value || data[0]?.views || 1
              const val = row.value ?? row.views ?? 0
              const name = row.name ?? row.url ?? ""
              return (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-xs font-mono truncate w-32">{name}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-background/60 overflow-hidden">
                    <div className="h-full bg-primary/50 rounded-full" style={{ width: `${(val / max) * 100}%` }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-8 text-right">{val}</span>
                </div>
              )
            })
          )}
        </div>
      </Card>
    )
  }

  return null
})