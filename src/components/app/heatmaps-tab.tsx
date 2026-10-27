"use client"

import { useEffect, useRef, useState } from "react"
import { api, fmtNumber } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  MousePointerClick,
  Move,
  ArrowDownToLine,
  Flame,
} from "lucide-react"
import { PageMock } from "./page-mock"

interface HeatData {
  kind: string
  url: string
  points: { x: number; y: number; sy: number }[]
  count: number
}
interface ScrollData {
  kind: string
  url: string
  max: number
  buckets: number[]
  count: number
}

const PAGES = [
  "/",
  "/pricing",
  "/features",
  "/blog",
  "/blog/getting-started",
  "/docs",
  "/signup",
  "/login",
  "/contact",
]
const PAGE_HEIGHTS: Record<string, number> = {
  "/": 2400,
  "/pricing": 1800,
  "/features": 2600,
  "/blog": 1600,
  "/blog/getting-started": 2200,
  "/docs": 2000,
  "/signup": 900,
  "/login": 700,
  "/contact": 1100,
}
const BASE_WIDTH = 1280

export function HeatmapsTab({ projectId, range }: { projectId: string; range: string }) {
  const [url, setUrl] = useState("/")
  const [kind, setKind] = useState<"click" | "move" | "scroll">("click")
  const [data, setData] = useState<HeatData | ScrollData | null>(null)
  const [loading, setLoading] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api<HeatData | ScrollData>(
      `/api/projects/${projectId}/heatmap?url=${encodeURIComponent(url)}&kind=${kind}&range=${range}`
    )
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
  }, [projectId, url, kind, range])

  const pageHeight = PAGE_HEIGHTS[url] || 1600

  const heatData = kind === "scroll" ? null : (data as HeatData | null)
  const scrollData = kind === "scroll" ? (data as ScrollData | null) : null

  function renderHeat(canvas: HTMLCanvasElement, hd: HeatData | null) {
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    canvas.width = BASE_WIDTH
    canvas.height = pageHeight
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (!hd || !hd.points.length) return

    // offscreen accumulation
    const off = document.createElement("canvas")
    off.width = BASE_WIDTH
    off.height = pageHeight
    const octx = off.getContext("2d")
    if (!octx) return
    octx.clearRect(0, 0, off.width, off.height)
    octx.globalCompositeOperation = "lighter"
    for (const p of hd.points) {
      const x = p.x
      const y = p.y // already page-absolute (y + scrollY done server-side)
      const r = kind === "click" ? 26 : 18
      const g = octx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, "rgba(255,255,255,0.55)")
      g.addColorStop(1, "rgba(255,255,255,0)")
      octx.fillStyle = g
      octx.beginPath()
      octx.arc(x, y, r, 0, Math.PI * 2)
      octx.fill()
    }
    // map density → color
    const src = octx.getImageData(0, 0, off.width, off.height)
    const out = ctx.createImageData(off.width, off.height)
    const sd = src.data
    const od = out.data
    for (let i = 0; i < sd.length; i += 4) {
      const a = sd[i + 3]
      if (a === 0) continue
      const v = a / 255
      const [r, g, b] = ramp(v)
      od[i] = r
      od[i + 1] = g
      od[i + 2] = b
      od[i + 3] = Math.min(255, 60 + v * 200)
    }
    ctx.putImageData(out, 0, 0)
  }

  // Render heatmap onto canvas when data changes
  useEffect(() => {
    if (kind === "scroll") return
    const canvas = canvasRef.current
    if (canvas && heatData) renderHeat(canvas, heatData)
  }, [heatData, kind, pageHeight])

  const kinds = [
    { id: "click" as const, label: "Clicks", icon: MousePointerClick },
    { id: "move" as const, label: "Moves", icon: Move },
    { id: "scroll" as const, label: "Scroll depth", icon: ArrowDownToLine },
  ]

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 border-b border-border/60 flex items-center gap-3 flex-wrap">
        <div
          className="flex items-center gap-1 rounded-lg border border-border/60 bg-background/40 p-0.5"
          role="group"
          aria-label="Heatmap type"
        >
          {kinds.map((k) => {
            const Icon = k.icon
            const active = kind === k.id
            return (
              <button
                key={k.id}
                onClick={() => setKind(k.id)}
                aria-pressed={active}
                aria-label={`Show ${k.label} heatmap`}
                className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors ${
                  active ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {k.label}
              </button>
            )
          })}
        </div>

        <label htmlFor="heatmap-page-select" className="sr-only">Heatmap page URL</label>
        <select
          id="heatmap-page-select"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="h-8 rounded-lg border border-border/60 bg-background/40 px-2 text-xs"
          aria-label="Select page to visualize"
        >
          {PAGES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        <div className="ml-auto text-xs text-muted-foreground flex items-center gap-3" aria-live="polite">
          {!loading && data && (
            <>
              <span className="flex items-center gap-1">
                <Flame className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {fmtNumber((data as HeatData).count ?? 0)} data points
              </span>
              <span aria-hidden="true">·</span>
              <span>Page height: {pageHeight}px</span>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin bg-[#0a0b0d]">
        {loading ? (
          <div className="p-6">
            <Skeleton className="h-8 w-full max-w-3xl mx-auto" />
            <Skeleton className="h-[600px] w-full max-w-3xl mx-auto mt-3" />
          </div>
        ) : kind === "scroll" ? (
          <ScrollDepthView data={scrollData} url={url} pageHeight={pageHeight} />
        ) : (
          <div className="flex justify-center p-6">
            <div className="relative shadow-2xl" style={{ width: BASE_WIDTH }}>
              <PageMock url={url} width={BASE_WIDTH} />
              <canvas
                ref={canvasRef}
                className="absolute top-0 left-0 w-full h-full pointer-events-none"
                style={{ width: BASE_WIDTH, height: pageHeight }}
                role="img"
                aria-label={`Heatmap overlay for ${url}: ${heatData?.points.length ?? 0} ${kind} data points`}
              />
              {!heatData || heatData.points.length === 0 ? (
                <div className="absolute inset-0 flex items-center justify-center" role="status">
                  <div className="bg-black/70 text-white text-sm px-4 py-2 rounded-lg">
                    No {kind} data for this page yet
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Classic heatmap color ramp
function ramp(v: number): [number, number, number] {
  // 0 -> blue, 0.3 -> cyan/green, 0.6 -> yellow, 0.85 -> orange, 1 -> red/white
  const stops: [number, [number, number, number]][] = [
    [0.0, [30, 80, 220]],
    [0.25, [40, 180, 200]],
    [0.45, [90, 220, 90]],
    [0.65, [240, 220, 60]],
    [0.82, [240, 130, 40]],
    [1.0, [240, 60, 60]],
  ]
  for (let i = 0; i < stops.length - 1; i++) {
    const [a, ca] = stops[i]
    const [b, cb] = stops[i + 1]
    if (v <= b) {
      const f = (v - a) / (b - a || 1)
      return [
        Math.round(ca[0] + (cb[0] - ca[0]) * f),
        Math.round(ca[1] + (cb[1] - ca[1]) * f),
        Math.round(ca[2] + (cb[2] - ca[2]) * f),
      ]
    }
  }
  return stops[stops.length - 1][1]
}

function ScrollDepthView({
  data,
  url,
  pageHeight,
}: {
  data: ScrollData | null
  url: string
  pageHeight: number
}) {
  const max = data ? Math.max(...data.buckets) : 0
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-sm">Scroll depth distribution</h3>
            <p className="text-xs text-muted-foreground">
              How far users scroll on <span className="font-mono">{url}</span>
            </p>
          </div>
          <span className="text-xs text-muted-foreground">{data?.count ?? 0} scroll events</span>
        </div>
        <div className="space-y-1.5">
          {data?.buckets.map((b, i) => {
            const pct = max ? (b / max) * 100 : 0
            const depthPct = Math.round(((i + 1) / data.buckets.length) * 100)
            return (
              <div key={i} className="flex items-center gap-3">
                <div className="w-12 text-xs text-muted-foreground text-right tabular-nums">
                  {depthPct}%
                </div>
                <div className="flex-1 h-5 rounded bg-background/40 overflow-hidden relative">
                  <div
                    className="h-full rounded transition-all"
                    style={{
                      width: `${pct}%`,
                      background: `linear-gradient(90deg, oklch(0.74 0.16 230), oklch(0.72 0.16 162))`,
                    }}
                  />
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
                    {b}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="text-xs text-muted-foreground mt-4">
          Page render height: {pageHeight}px · Max scroll observed: {data?.max ?? 0}px
        </div>
      </Card>
    </div>
  )
}
