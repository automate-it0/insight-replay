"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { api, fmtRelative, fmtDuration } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Search,
  Users,
  Globe,
  Smartphone,
  Monitor,
  Tablet,
  Clock,
  MousePointerClick,
  Eye,
  Target,
  X,
  ChevronRight,
} from "lucide-react"

interface Visitor {
  visitorId: string
  sessionCount: number
  firstSeen: string
  lastSeen: string
  totalClicks: number
  totalPages: number
  totalDuration: number
  avgDuration: number
  device: string
  browser: string
  country: string
  city: string
  isNewVisitor: boolean
  convertedGoal: string
  tags: string[]
}

interface VisitorDetail {
  visitor: {
    visitorId: string
    totalSessions: number
    totalClicks: number
    totalPages: number
    totalDuration: number
    avgDuration: number
    firstSeen: string
    lastSeen: string
    devices: string[]
    browsers: string[]
    countries: string[]
    conversionCount: number
    tags: string[]
    sessions: any[]
  }
}

export const VisitorsTab = memo(function VisitorsTab({ projectId, range }: { projectId: string; range: string }) {
  const [visitors, setVisitors] = useState<Visitor[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState("")
  const [activeVisitor, setActiveVisitor] = useState<string | null>(null)
  const [detail, setDetail] = useState<VisitorDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const d = await api<{ visitors: Visitor[] }>(
        `/api/projects/${projectId}/visitors?range=${range}&q=${encodeURIComponent(q)}`
      )
      setVisitors(d.visitors)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [projectId, range, q])

  async function openVisitor(vid: string) {
    setActiveVisitor(vid)
    setDetailLoading(true)
    setDetail(null)
    try {
      const d = await api<VisitorDetail>(`/api/projects/${projectId}/visitors/${vid}`)
      setDetail(d)
    } finally {
      setDetailLoading(false)
    }
  }

  // Stable placeholder array for the loading skeleton — avoids creating a
  // fresh array on every keystroke in the search box.
  const skeletonRows = useMemo(() => Array.from({ length: 8 }), [])

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-3 border-b border-border/60 flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search visitor ID…"
            aria-label="Search visitors"
            className="pl-8 h-9 bg-background/40"
          />
        </div>
        <span className="text-xs text-muted-foreground ml-auto" aria-live="polite">{visitors.length} visitors</span>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin">
        {loading ? (
          <div className="p-6 space-y-2">
            {skeletonRows.map((_, i) => <Skeleton key={i} className="h-16" />)}
          </div>
        ) : visitors.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">No visitors found.</div>
        ) : (
          <div className="divide-y divide-border/40" role="list" aria-label="Visitors">
            {visitors.map((v) => (
              <button
                key={v.visitorId}
                onClick={() => openVisitor(v.visitorId)}
                className="w-full text-left px-6 py-3 hover:bg-card/40 transition-colors flex items-center gap-4 group"
                aria-label={`Open visitor profile: ${v.visitorId} from ${v.city}, ${v.country}, ${v.isNewVisitor ? "new" : "returning"}`}
              >
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0" aria-hidden="true">
                  <Users className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0 w-44 shrink-0">
                  <div className="text-sm font-mono truncate">{v.visitorId}</div>
                  <div className="text-[11px] text-muted-foreground">{fmtRelative(v.lastSeen)}</div>
                </div>
                <Badge variant={v.isNewVisitor ? "default" : "secondary"} className="text-[10px]">
                  {v.isNewVisitor ? "New" : "Returning"}
                </Badge>
                <div className="hidden md:flex items-center gap-1.5 text-sm w-40 shrink-0">
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{v.city}, {v.country}</span>
                </div>
                <div className="hidden lg:flex items-center gap-1 text-xs text-muted-foreground w-32 shrink-0">
                  <DeviceIcon device={v.device} /> {v.browser}
                </div>
                <div className="hidden lg:flex items-center gap-3 text-xs text-muted-foreground w-40 shrink-0">
                  <span className="flex items-center gap-1"><Eye className="h-3 w-3" aria-hidden="true" />{v.sessionCount}</span>
                  <span className="flex items-center gap-1"><MousePointerClick className="h-3 w-3" aria-hidden="true" />{v.totalClicks}</span>
                </div>
                <div className="text-xs text-muted-foreground w-16 shrink-0">{fmtDuration(v.avgDuration)}</div>
                {v.convertedGoal && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 flex items-center gap-1">
                    <Target className="h-2.5 w-2.5" aria-hidden="true" /> {v.convertedGoal}
                  </span>
                )}
                {v.tags.length > 0 && (
                  <div className="hidden xl:flex gap-1">
                    {v.tags.slice(0, 2).map((t) => (
                      <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">{t}</span>
                    ))}
                  </div>
                )}
                <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>

      {activeVisitor && (
        <VisitorDrawer
          visitorId={activeVisitor}
          detail={detail}
          loading={detailLoading}
          onClose={() => { setActiveVisitor(null); setDetail(null) }}
        />
      )}
    </div>
  )
})

function VisitorDrawer({
  visitorId,
  detail,
  loading,
  onClose,
}: {
  visitorId: string
  detail: VisitorDetail | null
  loading: boolean
  onClose: () => void
}) {
  return (
    <div
      className="fixed inset-y-0 right-0 z-40 w-full max-w-md bg-card border-l border-border shadow-2xl flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={`Visitor profile: ${visitorId}`}
    >
      <div className="flex items-center justify-between px-5 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" aria-hidden="true" />
          <span className="font-semibold text-sm">Visitor profile</span>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close visitor profile">
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto scroll-thin p-5">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
          </div>
        ) : detail?.visitor ? (
          <div className="space-y-5">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Visitor ID</div>
              <div className="text-sm font-mono mt-0.5">{detail.visitor.visitorId}</div>
              <div className="text-xs text-muted-foreground mt-1">
                First seen {fmtRelative(detail.visitor.firstSeen)} · Last seen {fmtRelative(detail.visitor.lastSeen)}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Stat icon={<Eye className="h-3.5 w-3.5" />} label="Sessions" value={String(detail.visitor.totalSessions)} />
              <Stat icon={<Clock className="h-3.5 w-3.5" />} label="Total time" value={fmtDuration(detail.visitor.totalDuration)} />
              <Stat icon={<MousePointerClick className="h-3.5 w-3.5" />} label="Clicks" value={String(detail.visitor.totalClicks)} />
              <Stat icon={<Target className="h-3.5 w-3.5" />} label="Conversions" value={String(detail.visitor.conversionCount)} />
            </div>

            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Environment</div>
              <div className="space-y-1.5 text-xs">
                <Row label="Devices" value={detail.visitor.devices.join(", ")} />
                <Row label="Browsers" value={detail.visitor.browsers.join(", ")} />
                <Row label="Countries" value={detail.visitor.countries.join(", ")} />
              </div>
            </div>

            {detail.visitor.tags.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Tags</div>
                <div className="flex flex-wrap gap-1.5">
                  {detail.visitor.tags.map((t) => (
                    <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Session history</div>
              <div className="space-y-1.5">
                {detail.visitor.sessions.map((s: any) => (
                  <div key={s.id} className="rounded-lg border border-border/50 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">{fmtRelative(s.startedAt)}</span>
                      {s.convertedGoal && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">{s.convertedGoal}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-muted-foreground">
                      <span className="flex items-center gap-1"><DeviceIcon device={s.device} /> {s.browser}</span>
                      <span>{s.city}</span>
                      <span>{fmtDuration(s.duration)}</span>
                      <span>{s.pageViewsCount}p</span>
                      <span>{s.totalClicks}c</span>
                    </div>
                    <div className="mt-1 text-muted-foreground font-mono">
                      {s.entryUrl} → {s.exitUrl}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-muted-foreground text-center py-8">No data found for this visitor.</div>
        )}
      </div>
    </div>
  )
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-background/40 px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">{icon}{label}</div>
      <div className="text-sm font-semibold mt-0.5">{value}</div>
    </div>
  )
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="capitalize">{value}</span>
    </div>
  )
}
function DeviceIcon({ device }: { device: string }) {
  if (device === "mobile") return <Smartphone className="h-3 w-3" aria-hidden="true" />
  if (device === "tablet") return <Tablet className="h-3 w-3" aria-hidden="true" />
  return <Monitor className="h-3 w-3" aria-hidden="true" />
}
