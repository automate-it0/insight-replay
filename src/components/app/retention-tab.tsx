"use client"

import { useEffect, useState } from "react"
import { api, fmtRelative } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { TrendingUp, UserPlus, RefreshCw } from "lucide-react"

interface RetentionData {
  cohorts: { label: string; size: number; periods: { periodIndex: number; retained: number; rate: number }[] }[]
  totalVisitors: number
  avgRetention: number
  newVisitors: number
  returningVisitors: number
}

export function RetentionTab({ projectId, range }: { projectId: string; range: string }) {
  const [data, setData] = useState<RetentionData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api<RetentionData>(`/api/projects/${projectId}/retention?range=${range}`)
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

  const maxPeriods = data ? Math.max(...data.cohorts.map((c) => c.periods.length), 0) : 0

  return (
    <div className="h-full overflow-y-auto scroll-thin p-6 space-y-5">
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : !data || data.cohorts.length === 0 ? (
        <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
          No retention data for this range.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">Retention & cohorts</h2>
              <p className="text-xs text-muted-foreground">
                Weekly cohorts · {data.totalVisitors} unique visitors
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card className="p-4">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                <TrendingUp className="h-3.5 w-3.5" /> Avg retention
              </div>
              <div className="text-2xl font-semibold mt-1.5">{data.avgRetention.toFixed(1)}%</div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                <UserPlus className="h-3.5 w-3.5" /> New visitors
              </div>
              <div className="text-2xl font-semibold mt-1.5">{data.newVisitors}</div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                <RefreshCw className="h-3.5 w-3.5" /> Returning
              </div>
              <div className="text-2xl font-semibold mt-1.5">{data.returningVisitors}</div>
            </Card>
            <Card className="p-4">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                Total
              </div>
              <div className="text-2xl font-semibold mt-1.5">{data.totalVisitors}</div>
            </Card>
          </div>

          {/* Cohort matrix */}
          <Card className="p-5">
            <h3 className="font-semibold text-sm mb-4">Cohort retention matrix</h3>
            <div className="overflow-x-auto scroll-thin">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left py-2 px-2 font-medium">Cohort</th>
                    <th className="text-right py-2 px-2 font-medium">Size</th>
                    {Array.from({ length: maxPeriods }).map((_, i) => (
                      <th key={i} className="text-center py-2 px-2 font-medium">Week {i}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.cohorts.map((c, ci) => (
                    <tr key={ci} className="border-t border-border/40">
                      <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">
                        {fmtRelative(c.label)}
                      </td>
                      <td className="py-2 px-2 text-right font-medium">{c.size}</td>
                      {Array.from({ length: maxPeriods }).map((_, pi) => {
                        const p = c.periods.find((x) => x.periodIndex === pi)
                        if (!p) return <td key={pi} className="py-2 px-2 text-center text-muted-foreground/30">—</td>
                        return (
                          <td key={pi} className="py-1.5 px-1.5 text-center">
                            <div
                              className="rounded h-8 flex flex-col items-center justify-center font-medium"
                              style={{
                                background: p.rate > 0
                                  ? `oklch(0.72 0.16 162 / ${0.1 + (p.rate / 100) * 0.6})`
                                  : "oklch(0.3 0 0 / 0.3)",
                                color: p.rate > 40 ? "oklch(0.13 0.02 162)" : "inherit",
                              }}
                              title={`${p.retained} of ${c.size} (${p.rate.toFixed(0)}%)`}
                              aria-label={`Week ${pi}: ${p.retained} of ${c.size} retained, ${p.rate.toFixed(0)}%`}
                            >
                              <span>{p.rate.toFixed(0)}%</span>
                              <span className="text-[9px] opacity-70">{p.retained}</span>
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="text-[10px] text-muted-foreground mt-3 flex items-center gap-2">
              <span>Darker = higher retention</span>
              <div className="flex items-center gap-1">
                <span className="h-3 w-8 rounded" style={{ background: "oklch(0.72 0.16 162 / 0.1)" }} />
                <span>→</span>
                <span className="h-3 w-8 rounded" style={{ background: "oklch(0.72 0.16 162 / 0.7)" }} />
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  )
}
