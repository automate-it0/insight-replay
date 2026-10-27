"use client"

import { useEffect, useMemo, useState } from "react"
import { api, fmtNumber, fmtDuration } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from "recharts"
import {
  Eye,
  MousePointerClick,
  Clock,
  Flame,
  Smartphone,
  Monitor,
  Tablet,
  Target,
  AlertTriangle,
  UserPlus,
  RefreshCw,
  ArrowDownToLine,
  LogIn,
} from "lucide-react"
import { AiInsightsCard } from "./ai-insights-card"

interface Stats {
  totals: {
    totalSessions: number
    activeNow: number
    totalClicks: number
    totalPages: number
    avgDuration: number
    rageClicks: number
    deadClicks: number
    errors: number
    uniqueVisitors: number
    newVisitors: number
    returningVisitors: number
    conversions: number
    conversionRate: number
    bounceRate: number
  }
  daily: { date: string; sessions: number; clicks: number; pages: number }[]
  device: { name: string; value: number }[]
  browser: { name: string; value: number }[]
  os: { name: string; value: number }[]
  country: { name: string; value: number }[]
  referrer: { name: string; value: number }[]
  utmSource: { name: string; value: number }[]
  entryPages: { name: string; value: number }[]
  exitPages: { name: string; value: number }[]
  topPages: { url: string; views: number }[]
}

const PIE_COLORS = ["oklch(0.72 0.16 162)", "oklch(0.74 0.16 230)", "oklch(0.78 0.18 70)", "oklch(0.66 0.22 320)", "oklch(0.68 0.2 16)"]

export function OverviewTab({ projectId, range }: { projectId: string; range: string }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    void api<Stats>(`/api/projects/${projectId}/stats?range=${range}`)
      .then(setStats)
      .finally(() => setLoading(false))
  }, [projectId, range])

  const tMaybe = stats?.totals
  const newVisitors = tMaybe?.newVisitors ?? 0
  const returningVisitors = tMaybe?.returningVisitors ?? 0

  // Memoize the chart data + sliced breakdown arrays so they keep stable
  // references between re-renders that don't change `stats` (e.g. parent
  // re-renders driven by unrelated state). Recharts is the heaviest subtree
  // here, and giving it referentially-stable `data` props lets its internal
  // diffing short-circuit. The deps are the source arrays from `stats`, so
  // when a poll produces new data these all recompute as expected.
  // NOTE: all hooks run unconditionally BEFORE the early return below —
  // violating the Rules of Hooks here would throw "rendered more hooks than
  // during the previous render" when transitioning from loading to loaded.
  const dailyData = useMemo(() => stats?.daily ?? [], [stats])
  const deviceData = useMemo(() => stats?.device ?? [], [stats])
  const browserData = useMemo(() => stats?.browser ?? [], [stats])
  const newVsReturningData = useMemo(
    () => [
      { name: "New", value: newVisitors },
      { name: "Returning", value: returningVisitors },
    ],
    [newVisitors, returningVisitors],
  )
  const topReferrers = useMemo(() => stats?.referrer.slice(0, 6) ?? [], [stats])
  const topReferrerMax = topReferrers[0]?.value || 1
  const topPages = useMemo(() => stats?.topPages ?? [], [stats])
  const topPagesMax = topPages[0]?.views || 1
  const topEntryPages = useMemo(() => stats?.entryPages.slice(0, 5) ?? [], [stats])
  const topExitPages = useMemo(() => stats?.exitPages.slice(0, 5) ?? [], [stats])
  const topCountries = useMemo(() => stats?.country.slice(0, 7) ?? [], [stats])
  const topCountryMax = topCountries[0]?.value || 1
  const topUtmSources = useMemo(() => stats?.utmSource.slice(0, 7) ?? [], [stats])
  const topUtmMax = topUtmSources[0]?.value || 1

  if (loading || !stats) {
    return (
      <div className="p-6 grid gap-4 grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)}
      </div>
    )
  }

  const t = stats.totals

  return (
    <div className="p-6 space-y-5 overflow-y-auto scroll-thin h-full">
      {/* KPI cards */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Kpi icon={<Eye className="h-4 w-4" />} label="Total sessions" value={fmtNumber(t.totalSessions)} sub={`${t.uniqueVisitors} unique visitors`} />
        <Kpi icon={<MousePointerClick className="h-4 w-4" />} label="Total clicks" value={fmtNumber(t.totalClicks)} sub={`${fmtNumber(t.totalPages)} page views`} />
        <Kpi icon={<Target className="h-4 w-4" />} label="Conversions" value={fmtNumber(t.conversions)} sub={`${t.conversionRate}% conversion rate`} accent />
        <Kpi icon={<Clock className="h-4 w-4" />} label="Avg. duration" value={fmtDuration(t.avgDuration)} sub={`${t.bounceRate}% bounce rate`} />
      </div>

      {/* Secondary KPIs */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Kpi icon={<UserPlus className="h-4 w-4" />} label="New visitors" value={fmtNumber(t.newVisitors)} sub={`${t.returningVisitors} returning`} />
        <Kpi icon={<Flame className="h-4 w-4" />} label="Rage clicks" value={fmtNumber(t.rageClicks)} sub={`${t.deadClicks} dead clicks`} danger={t.rageClicks > 0} />
        <Kpi icon={<AlertTriangle className="h-4 w-4" />} label="JS errors" value={fmtNumber(t.errors)} sub="across sessions" danger={t.errors > 0} />
        <Kpi icon={<RefreshCw className="h-4 w-4" />} label="Bounce rate" value={`${t.bounceRate}%`} sub={`${t.conversionRate}% convert`} />
      </div>

      {/* AI insights + sessions chart */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-semibold text-sm">Sessions over time</h3>
              <p className="text-xs text-muted-foreground">Daily session & click volume</p>
            </div>
          </div>
          <div role="img" aria-label={`Sessions and clicks over time chart with ${dailyData.length} data points`}>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={dailyData} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="gS" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(0.72 0.16 162)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="oklch(0.72 0.16 162)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gC" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="oklch(0.74 0.16 230)" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="oklch(0.74 0.16 230)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 0.06)" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "oklch(0.68 0 0)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(d) => d.slice(5)} />
              <YAxis tick={{ fill: "oklch(0.68 0 0)", fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "oklch(0.205 0 0)", border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 8, fontSize: 12 }} labelStyle={{ color: "oklch(0.97 0 0)" }} />
              <Area type="monotone" dataKey="sessions" stroke="oklch(0.72 0.16 162)" strokeWidth={2} fill="url(#gS)" />
              <Area type="monotone" dataKey="clicks" stroke="oklch(0.74 0.16 230)" strokeWidth={2} fill="url(#gC)" />
            </AreaChart>
          </ResponsiveContainer>
          </div>
        </Card>

        <div className="lg:col-span-1">
          <AiInsightsCard projectId={projectId} range={range} />
        </div>
      </div>

      {/* New vs returning + Device + Referrers */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <h3 className="font-semibold text-sm mb-1">New vs returning</h3>
          <p className="text-xs text-muted-foreground mb-2">Visitor split</p>
          <div role="img" aria-label={`New vs returning visitors pie chart: ${t.newVisitors} new, ${t.returningVisitors} returning`}>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie
                data={newVsReturningData}
                dataKey="value"
                nameKey="name"
                innerRadius={45}
                outerRadius={65}
                paddingAngle={3}
                stroke="none"
              >
                <Cell fill="oklch(0.72 0.16 162)" />
                <Cell fill="oklch(0.74 0.16 230)" />
              </Pie>
              <Tooltip contentStyle={{ background: "oklch(0.205 0 0)", border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          </div>
          <div className="space-y-1.5 mt-2">
            <Legend color="oklch(0.72 0.16 162)" label="New" value={t.newVisitors} />
            <Legend color="oklch(0.74 0.16 230)" label="Returning" value={t.returningVisitors} />
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="font-semibold text-sm mb-1">Devices</h3>
          <p className="text-xs text-muted-foreground mb-2">Session share by device</p>
          <div role="img" aria-label={`Device distribution pie chart: ${deviceData.map((d) => `${d.name} ${d.value}`).join(", ")}`}>
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={deviceData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={65} paddingAngle={3} stroke="none">
                {deviceData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
              </Pie>
              <Tooltip contentStyle={{ background: "oklch(0.205 0 0)", border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 8, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          </div>
          <div className="space-y-1.5 mt-2">
            {deviceData.map((d, i) => (
              <Legend key={d.name} color={PIE_COLORS[i % PIE_COLORS.length]} label={d.name} value={d.value} icon={<DeviceIcon name={d.name} />} />
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="font-semibold text-sm mb-1">Top referrers</h3>
          <p className="text-xs text-muted-foreground mb-3">Where traffic comes from</p>
          <div className="space-y-2">
            {topReferrers.map((r, i) => {
              return (
                <div key={r.name + i} className="flex items-center gap-3">
                  <span className="text-xs w-24 truncate">{r.name}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-background/60 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(r.value / topReferrerMax) * 100}%`, background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-6 text-right">{r.value}</span>
                </div>
              )
            })}
          </div>
        </Card>
      </div>

      {/* Browser + Top pages + Entry/Exit pages */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <h3 className="font-semibold text-sm mb-1">Browsers</h3>
          <p className="text-xs text-muted-foreground mb-3">Sessions by browser</p>
          <div role="img" aria-label={`Browsers bar chart: ${browserData.map((b) => `${b.name} ${b.value}`).join(", ")}`}>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={browserData} layout="vertical" margin={{ left: 8, right: 8 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" tick={{ fill: "oklch(0.68 0 0)", fontSize: 11 }} tickLine={false} axisLine={false} width={56} />
              <Tooltip contentStyle={{ background: "oklch(0.205 0 0)", border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 8, fontSize: 12 }} cursor={{ fill: "oklch(1 0 0 / 0.04)" }} />
              <Bar dataKey="value" fill="oklch(0.72 0.16 162)" radius={[0, 4, 4, 0]} barSize={16} />
            </BarChart>
          </ResponsiveContainer>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="font-semibold text-sm mb-1">Top pages</h3>
          <p className="text-xs text-muted-foreground mb-3">Most viewed URLs</p>
          <div className="space-y-2">
            {topPages.length === 0 && <div className="text-xs text-muted-foreground py-4 text-center">No page views yet</div>}
            {topPages.map((p, i) => {
              return (
                <div key={p.url + i}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-mono truncate max-w-[70%]">{p.url}</span>
                    <span className="text-muted-foreground">{fmtNumber(p.views)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-background/60 overflow-hidden">
                    <div className="h-full bg-primary/70 rounded-full" style={{ width: `${(p.views / topPagesMax) * 100}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="font-semibold text-sm mb-1">Entry & exit pages</h3>
          <p className="text-xs text-muted-foreground mb-3">Where sessions start & end</p>
          <div className="space-y-1.5">
            {topEntryPages.map((p, i) => (
              <div key={"e" + i} className="flex items-center gap-2 text-xs">
                <LogIn className="h-3 w-3 text-emerald-400 shrink-0" />
                <span className="font-mono truncate flex-1">{p.name}</span>
                <span className="text-muted-foreground">{p.value}</span>
              </div>
            ))}
            <div className="h-px bg-border/40 my-2" />
            {topExitPages.map((p, i) => (
              <div key={"x" + i} className="flex items-center gap-2 text-xs">
                <ArrowDownToLine className="h-3 w-3 text-amber-400 shrink-0" />
                <span className="font-mono truncate flex-1">{p.name}</span>
                <span className="text-muted-foreground">{p.value}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Countries + UTM */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="font-semibold text-sm mb-1">Top locations</h3>
          <p className="text-xs text-muted-foreground mb-3">Sessions by country</p>
          <div className="space-y-2">
            {topCountries.map((c, i) => {
              return (
                <div key={c.name + i} className="flex items-center gap-3">
                  <span className="text-xs w-28 truncate">{c.name}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-background/60 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(c.value / topCountryMax) * 100}%`, background: PIE_COLORS[i % PIE_COLORS.length] }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-6 text-right">{c.value}</span>
                </div>
              )
            })}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="font-semibold text-sm mb-1">Campaigns (UTM source)</h3>
          <p className="text-xs text-muted-foreground mb-3">Traffic by utm_source</p>
          <div className="space-y-2">
            {topUtmSources.length === 0 && <div className="text-xs text-muted-foreground py-2">No UTM-tagged traffic yet</div>}
            {topUtmSources.map((u, i) => {
              return (
                <div key={u.name + i} className="flex items-center gap-3">
                  <span className="text-xs w-28 truncate capitalize">{u.name}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-background/60 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(u.value / topUtmMax) * 100}%`, background: PIE_COLORS[(i + 2) % PIE_COLORS.length] }} />
                  </div>
                  <span className="text-xs text-muted-foreground w-6 text-right">{u.value}</span>
                </div>
              )
            })}
          </div>
        </Card>
      </div>
    </div>
  )
}

function Kpi({ icon, label, value, sub, danger, accent }: { icon: React.ReactNode; label: string; value: string; sub: string; danger?: boolean; accent?: boolean }) {
  return (
    <Card className="p-4">
      <div className={`flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider ${danger ? "text-destructive" : accent ? "text-primary" : "text-muted-foreground"}`}>
        <span aria-hidden="true">{icon}</span>
        {label}
      </div>
      <div className="text-2xl font-semibold mt-2" aria-label={`${label}: ${value}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
    </Card>
  )
}

function Legend({ color, label, value, icon }: { color: string; label: string; value: number; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
        {icon}
        <span className="capitalize">{label}</span>
      </span>
      <span className="text-muted-foreground">{value}</span>
    </div>
  )
}

function DeviceIcon({ name }: { name: string }) {
  if (name === "mobile") return <Smartphone className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
  if (name === "tablet") return <Tablet className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
  return <Monitor className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
}
