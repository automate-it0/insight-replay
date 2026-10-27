"use client"

import { useEffect, useState } from "react"
import { api, fmtRelative } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts"
import { AlertTriangle, Globe, Smartphone, Monitor, Tablet } from "lucide-react"

interface ErrorEvent {
  id: string
  message: string
  stack: string
  url: string
  line: number
  t: number
  timestamp: string
  session: { id: string; visitorId: string; country: string; city: string; browser: string; device: string; startedAt: string }
}
interface ErrorsData {
  errors: ErrorEvent[]
  aggregate: {
    total: number
    byType: Record<string, number>
    byUrl: { url: string; count: number }[]
    affectedSessions: number
    daily: { date: string; count: number }[]
  }
}

export function ErrorsTab({ projectId, range }: { projectId: string; range: string }) {
  const [data, setData] = useState<ErrorsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api<ErrorsData>(`/api/projects/${projectId}/errors?range=${range}`)
      .then((d) => {
        if (alive) setData(d)
      })
      .catch(() => {
        if (alive) setData(null)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [projectId, range])

  return (
    <div className="h-full overflow-y-auto scroll-thin p-6 space-y-5">
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !data || data.aggregate.total === 0 ? (
        <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
          <div className="text-center">
            <AlertTriangle className="h-10 w-10 text-emerald-400 mx-auto mb-3" />
            <div className="font-medium">No errors recorded</div>
            <div className="text-xs mt-1">JS errors captured by the tracking SDK will appear here.</div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-400" />
            <div>
              <h2 className="text-lg font-semibold">Error tracking</h2>
              <p className="text-xs text-muted-foreground">
                {data.aggregate.total} errors across {data.aggregate.affectedSessions} sessions
              </p>
            </div>
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <Card className="p-5 lg:col-span-2">
              <h3 className="font-semibold text-sm mb-3">Errors over time</h3>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={data.aggregate.daily} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(1 0 0 / 0.06)" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "oklch(0.68 0 0)", fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(d) => d.slice(5)} />
                  <YAxis tick={{ fill: "oklch(0.68 0 0)", fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: "oklch(0.205 0 0)", border: "1px solid oklch(1 0 0 / 0.1)", borderRadius: 8, fontSize: 12 }}
                    cursor={{ fill: "oklch(1 0 0 / 0.04)" }}
                  />
                  <Bar dataKey="count" fill="oklch(0.66 0.2 22)" radius={[3, 3, 0, 0]} barSize={20} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card className="p-5">
              <h3 className="font-semibold text-sm mb-3">Errors by page</h3>
              <div className="space-y-2">
                {data.aggregate.byUrl.slice(0, 6).map((u) => {
                  const max = data.aggregate.byUrl[0]?.count || 1
                  return (
                    <div key={u.url}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="font-mono truncate">{u.url}</span>
                        <span className="text-muted-foreground">{u.count}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-background/60 overflow-hidden">
                        <div className="h-full bg-red-500/60 rounded-full" style={{ width: `${(u.count / max) * 100}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="px-5 py-3 border-b border-border/60">
              <h3 className="font-semibold text-sm">Error log</h3>
            </div>
            <div className="divide-y divide-border/40 max-h-[500px] overflow-y-auto scroll-thin">
              {data.errors.map((e) => (
                <div key={e.id} className="px-5 py-3 hover:bg-card/40 transition-colors">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-mono text-red-300 break-all">{e.message}</div>
                      {e.stack && (
                        <pre className="text-[10px] text-muted-foreground font-mono mt-1.5 whitespace-pre-wrap bg-background/40 p-2 rounded max-h-24 overflow-y-auto scroll-thin">
                          {e.stack}
                        </pre>
                      )}
                      <div className="flex items-center gap-3 mt-1.5 text-[11px] text-muted-foreground flex-wrap">
                        <span className="font-mono">{e.url}:{e.line}</span>
                        <span>·</span>
                        <span>{fmtRelative(e.timestamp)}</span>
                        <span>·</span>
                        <span className="flex items-center gap-1"><DeviceIcon device={e.session.device} /> {e.session.browser}</span>
                        <span>·</span>
                        <span className="flex items-center gap-1"><Globe className="h-3 w-3" /> {e.session.city}</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  )
}

function DeviceIcon({ device }: { device: string }) {
  if (device === "mobile") return <Smartphone className="h-3 w-3" />
  if (device === "tablet") return <Tablet className="h-3 w-3" />
  return <Monitor className="h-3 w-3" />
}
