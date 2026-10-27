"use client"

import { useEffect, useState, type ComponentType } from "react"
import { api, fmtRelative } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Flame,
  MousePointerClick,
  ArrowDownToLine,
  TrendingUp,
  ChevronRight,
  Smartphone,
  Monitor,
  Tablet,
} from "lucide-react"
import { RecordingPlayer } from "./recording-player"

interface Insight {
  id: string
  type: string
  severity: string
  data: Record<string, unknown>
  timestamp: string
  session: {
    id: string
    country: string
    city: string
    browser: string
    device: string
    startedAt: string
  }
}

const META: Record<string, { label: string; icon: ComponentType<{ className?: string }>; color: string; bg: string }> = {
  rage_click: { label: "Rage clicks", icon: Flame, color: "text-destructive", bg: "bg-destructive/15" },
  dead_click: { label: "Dead clicks", icon: MousePointerClick, color: "text-amber-500", bg: "bg-amber-500/15" },
  excessive_scroll: { label: "Excessive scrolling", icon: ArrowDownToLine, color: "text-sky-400", bg: "bg-sky-500/15" },
  quick_back: { label: "Quick backs", icon: TrendingUp, color: "text-violet-400", bg: "bg-violet-500/15" },
}

export function InsightsTab({ projectId, range }: { projectId: string; range: string }) {
  const [insights, setInsights] = useState<Insight[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api<{ insights: Insight[]; counts: Record<string, number> }>(
      `/api/projects/${projectId}/insights?range=${range}`
    )
      .then((d) => {
        if (!alive) return
        setInsights(d.insights)
        setCounts(d.counts)
      })
      .catch(() => {
        if (!alive) return
        setInsights([])
        setCounts({})
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [projectId, range])

  const total = Object.values(counts).reduce((a, b) => a + b, 0)

  return (
    <div className="h-full overflow-y-auto scroll-thin p-6 space-y-5">
      {/* Summary */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        {Object.entries(META).map(([key, m]) => {
          const Icon = m.icon
          const c = counts[key] || 0
          return (
            <Card key={key} className="p-4">
              <div className={`inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider px-2 py-0.5 rounded ${m.bg} ${m.color}`}>
                <Icon className="h-3 w-3" />
                {m.label}
              </div>
              <div className="text-2xl font-semibold mt-2">{c}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">
                {total ? Math.round((c / total) * 100) : 0}% of signals
              </div>
            </Card>
          )
        })}
      </div>

      {/* Feed */}
      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border/60 flex items-center justify-between">
          <h3 className="font-semibold text-sm">Frustration signals</h3>
          <span className="text-xs text-muted-foreground">{insights.length} events</span>
        </div>
        {loading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : insights.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No frustration signals detected in this range. Nice!
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {insights.map((ins) => {
              const m = META[ins.type] || META.dead_click
              const Icon = m.icon
              return (
                <button
                  key={ins.id}
                  onClick={() => setActive(ins.session.id)}
                  className="w-full text-left px-5 py-3 hover:bg-card/40 transition-colors flex items-center gap-4 group"
                >
                  <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${m.bg}`}>
                    <Icon className={`h-4 w-4 ${m.color}`} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{m.label}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5">
                      <span className="font-mono">
                        {(ins.data as { pageUrl?: string }).pageUrl || "/"}
                      </span>
                      <span>·</span>
                      <span>{fmtRelative(ins.timestamp)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <DeviceIcon device={ins.session.device} />
                    <span>{ins.session.city}, {ins.session.country}</span>
                    <span>·</span>
                    <span>{ins.session.browser}</span>
                  </div>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                      ins.severity === "high"
                        ? "bg-destructive/15 text-destructive"
                        : ins.severity === "medium"
                        ? "bg-amber-500/15 text-amber-500"
                        : "bg-white/10 text-muted-foreground"
                    }`}
                  >
                    {ins.severity}
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )
            })}
          </div>
        )}
      </Card>

      {active && <RecordingPlayer sessionId={active} onClose={() => setActive(null)} />}
    </div>
  )
}

function DeviceIcon({ device }: { device: string }) {
  if (device === "mobile") return <Smartphone className="h-3 w-3" />
  if (device === "tablet") return <Tablet className="h-3 w-3" />
  return <Monitor className="h-3 w-3" />
}
