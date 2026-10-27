"use client"

import { useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { GitBranch, ArrowRight, ListOrdered } from "lucide-react"

interface JourneyData {
  nodes: { id: string; name: string; virtual?: boolean }[]
  links: { source: string; target: string; value: number }[]
  starts: { url: string; count: number }[]
  ends: { url: string; count: number }[]
  topPaths: { path: string; count: number }[]
  totalSessions: number
}

const COLORS = [
  "oklch(0.72 0.16 162)",
  "oklch(0.74 0.16 230)",
  "oklch(0.78 0.18 70)",
  "oklch(0.66 0.22 320)",
  "oklch(0.68 0.2 16)",
  "oklch(0.7 0.15 200)",
  "oklch(0.75 0.17 150)",
  "oklch(0.65 0.18 280)",
]

export function JourneysTab({ projectId, range }: { projectId: string; range: string }) {
  const [data, setData] = useState<JourneyData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    void api<JourneyData>(`/api/projects/${projectId}/journeys?range=${range}`)
      .then(setData)
      .finally(() => setLoading(false))
  }, [projectId, range])

  // Build a layered sankey: Start → top entry pages → ... → Exit
  const sankey = useMemo(() => {
    if (!data) return null
    // Build adjacency
    const outLinks: Record<string, { target: string; value: number }[]> = {}
    for (const l of data.links) {
      ;(outLinks[l.source] = outLinks[l.source] || []).push({ target: l.target, value: l.value })
    }
    // Layer 0: Start. Layer 1: top entry pages (from starts). Layer 2: their top destinations. Layer 3: Exit.
    const startNode = "__start__"
    const exitNode = "__exit__"
    const topEntries = [...data.starts].sort((a, b) => b.count - a.count).slice(0, 5)
    const layer1 = topEntries.map((e) => e.url)

    // For each layer1 node, find top 3 next nodes
    const layer2Set = new Set<string>()
    const edges: { from: string; to: string; value: number; layer: number }[] = []
    topEntries.forEach((e) => {
      edges.push({ from: startNode, to: e.url, value: e.count, layer: 0 })
      const nexts = (outLinks[e.url] || []).filter((n) => n.target !== exitNode).sort((a, b) => b.value - a.value).slice(0, 3)
      nexts.forEach((n) => {
        layer2Set.add(n.target)
        edges.push({ from: e.url, to: n.target, value: n.value, layer: 1 })
      })
      const exits = (outLinks[e.url] || []).filter((n) => n.target === exitNode)
      exits.forEach((n) => edges.push({ from: e.url, to: exitNode, value: n.value, layer: 1 }))
    })
    const layer2 = Array.from(layer2Set)
    // layer2 → exit
    layer2.forEach((url) => {
      const exits = (outLinks[url] || []).filter((n) => n.target === exitNode)
      exits.forEach((n) => edges.push({ from: url, to: exitNode, value: n.value, layer: 2 }))
      const nexts = (outLinks[url] || []).filter((n) => n.target !== exitNode).sort((a, b) => b.value - a.value).slice(0, 2)
      nexts.forEach((n) => edges.push({ from: url, to: n.target, value: n.value, layer: 2 }))
    })

    const maxValue = Math.max(...edges.map((e) => e.value), 1)
    return { layer1, layer2, edges, maxValue }
  }, [data])

  return (
    <div className="h-full overflow-y-auto scroll-thin p-6 space-y-5">
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : !data || data.totalSessions === 0 ? (
        <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
          No journey data for this range.
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-primary" />
            <div>
              <h2 className="text-lg font-semibold">User journeys</h2>
              <p className="text-xs text-muted-foreground">
                How {data.totalSessions} visitors flow through your site
              </p>
            </div>
          </div>

          {/* Sankey-style flow */}
          <Card className="p-6">
            <h3 className="font-semibold text-sm mb-4">Page flow (top entry paths)</h3>
            {sankey && (
              <div className="flex items-stretch gap-3 overflow-x-auto scroll-thin pb-2">
                {/* Column 0: Start */}
                <FlowColumn title="Start">
                  <FlowNode label="Visitors" value={data.totalSessions} color="oklch(0.72 0.16 162)" />
                </FlowColumn>

                <FlowConnector />

                {/* Column 1: Entry pages */}
                <FlowColumn title="Entry pages">
                  {sankey.layer1.map((url, i) => {
                    const start = data.starts.find((s) => s.url === url)
                    return (
                      <FlowNode
                        key={url}
                        label={url}
                        value={start?.count || 0}
                        color={COLORS[i % COLORS.length]}
                      />
                    )
                  })}
                </FlowColumn>

                <FlowConnector />

                {/* Column 2: Next pages */}
                <FlowColumn title="Next pages">
                  {sankey.layer2.map((url, i) => {
                    const total = sankey.edges.filter((e) => e.from === url).reduce((a, e) => a + e.value, 0)
                    return (
                      <FlowNode
                        key={url}
                        label={url}
                        value={total}
                        color={COLORS[(i + 3) % COLORS.length]}
                      />
                    )
                  })}
                </FlowColumn>

                <FlowConnector />

                {/* Column 3: Exit */}
                <FlowColumn title="Exit">
                  {data.ends.sort((a, b) => b.count - a.count).slice(0, 5).map((e, i) => (
                    <FlowNode key={e.url + i} label={e.url} value={e.count} color="oklch(0.5 0 0)" />
                  ))}
                </FlowColumn>
              </div>
            )}
          </Card>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* Top paths */}
            <Card className="p-5">
              <h3 className="font-semibold text-sm mb-3 flex items-center gap-2">
                <ListOrdered className="h-4 w-4 text-primary" />
                Most common paths
              </h3>
              <div className="space-y-2">
                {data.topPaths.slice(0, 8).map((p, i) => {
                  const max = data.topPaths[0]?.count || 1
                  return (
                    <div key={i} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-5">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-mono truncate">{p.path}</div>
                        <div className="h-1.5 rounded-full bg-background/60 overflow-hidden mt-1">
                          <div className="h-full bg-primary/60 rounded-full" style={{ width: `${(p.count / max) * 100}%` }} />
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{p.count}</span>
                    </div>
                  )
                })}
              </div>
            </Card>

            {/* Entry + Exit pages */}
            <div className="grid grid-cols-2 gap-4">
              <Card className="p-5">
                <h3 className="font-semibold text-sm mb-3">Entry pages</h3>
                <div className="space-y-2">
                  {data.starts.sort((a, b) => b.count - a.count).slice(0, 6).map((s) => (
                    <div key={s.url} className="flex items-center justify-between text-xs">
                      <span className="font-mono truncate">{s.url}</span>
                      <span className="text-muted-foreground shrink-0 ml-2">{s.count}</span>
                    </div>
                  ))}
                </div>
              </Card>
              <Card className="p-5">
                <h3 className="font-semibold text-sm mb-3">Exit pages</h3>
                <div className="space-y-2">
                  {data.ends.sort((a, b) => b.count - a.count).slice(0, 6).map((s) => (
                    <div key={s.url} className="flex items-center justify-between text-xs">
                      <span className="font-mono truncate">{s.url}</span>
                      <span className="text-muted-foreground shrink-0 ml-2">{s.count}</span>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function FlowColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col shrink-0 min-w-[140px]">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 px-1">{title}</div>
      <div className="space-y-1.5 flex-1 flex flex-col justify-center">{children}</div>
    </div>
  )
}

function FlowNode({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-md border border-border/60 px-2.5 py-1.5" style={{ background: color + "15", borderColor: color + "40" }}>
      <div className="text-xs font-mono truncate" title={label}>{label}</div>
      <div className="text-[10px] text-muted-foreground flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        {value}
      </div>
    </div>
  )
}

function FlowConnector() {
  return (
    <div className="flex flex-col items-center justify-center shrink-0 px-1 self-center">
      <ArrowRight className="h-4 w-4 text-muted-foreground" />
    </div>
  )
}
