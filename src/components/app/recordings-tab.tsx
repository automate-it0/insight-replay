"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { api, fmtDuration, fmtRelative } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { AiSearchBar } from "./ai-search-bar"
import {
  Search,
  PlayCircle,
  Flame,
  MousePointerClick,
  Globe,
  Smartphone,
  Monitor,
  Tablet,
  Zap,
  ChevronRight,
  Sparkles,
} from "lucide-react"
import { RecordingPlayer } from "./recording-player"

interface Session {
  id: string
  visitorId: string
  country: string
  city: string
  device: string
  browser: string
  os: string
  startedAt: string
  duration: number
  totalClicks: number
  pageViewsCount: number
  isActive: boolean
  hasRageClick: boolean
  hasDeadClick: boolean
  screenWidth: number
  screenHeight: number
  language: string
}

type Filter = "all" | "rage" | "dead" | "active"

export const RecordingsTab = memo(function RecordingsTab({ projectId, range }: { projectId: string; range: string }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [aiMode, setAiMode] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const data = await api<{ sessions: Session[] }>(
        `/api/projects/${projectId}/sessions?range=${range}&filter=${filter}&q=${encodeURIComponent(q)}`
      )
      setSessions(data.sessions)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [projectId, range, filter, q])

  const filters: { id: Filter; label: string; icon: any }[] = useMemo(
    () => [
      { id: "all", label: "All", icon: PlayCircle },
      { id: "active", label: "Active", icon: Zap },
      { id: "rage", label: "Rage clicks", icon: Flame },
      { id: "dead", label: "Dead clicks", icon: MousePointerClick },
    ],
    []
  )

  return (
    <div className="h-full flex flex-col">
      {/* AI Search mode */}
      {aiMode ? (
        <div className="px-6 py-4 border-b border-border/60 bg-primary/5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">AI natural-language search</span>
            </div>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAiMode(false)}>
              ← Back to filters
            </Button>
          </div>
          <AiSearchBar projectId={projectId} range={range} />
        </div>
      ) : (
        <div className="px-6 py-3 border-b border-border/60 flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by country, browser, device…"
              aria-label="Search sessions"
              className="pl-8 h-9 bg-background/40"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setAiMode(true)}
          >
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            AI search
          </Button>
          <div
            className="flex items-center gap-1 rounded-lg border border-border/60 bg-background/40 p-0.5"
            role="group"
            aria-label="Filter sessions"
          >
            {filters.map((f) => {
              const Icon = f.icon
              const active = filter === f.id
              return (
                <button
                  key={f.id}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={active}
                  aria-label={`Show ${f.label} sessions`}
                  className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors ${
                    active ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {f.label}
                </button>
              )
            })}
          </div>
          <span className="text-xs text-muted-foreground ml-auto" aria-live="polite">{sessions.length} sessions</span>
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto scroll-thin">
        {loading ? (
          <div className="p-6 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No sessions match your filters.
          </div>
        ) : (
          <div className="divide-y divide-border/40" role="list" aria-label="Sessions">
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSession(s.id)}
                className="w-full text-left px-6 py-3 hover:bg-card/40 transition-colors flex items-center gap-4 group"
                aria-label={`Open recording: session from ${s.city}, ${s.country} on ${s.device} via ${s.browser}, ${s.isActive ? "live" : fmtRelative(s.startedAt)}`}
              >
                <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0" aria-hidden="true">
                  <PlayCircle className="h-4 w-4 text-primary" />
                </div>

                <div className="flex items-center gap-2 min-w-0 w-44 shrink-0">
                  {s.isActive ? (
                    <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-primary/20 text-primary font-medium shrink-0">
                      <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
                      LIVE
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground shrink-0">{fmtRelative(s.startedAt)}</span>
                  )}
                  <DeviceIcon device={s.device} />
                </div>

                <div className="flex items-center gap-1.5 text-sm min-w-0 w-40 shrink-0">
                  <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    {s.city}, {s.country}
                  </span>
                </div>

                <div className="text-xs text-muted-foreground hidden md:flex items-center gap-3 w-48 shrink-0">
                  <span>{s.browser}</span>
                  <span aria-hidden="true">·</span>
                  <span>{s.os}</span>
                </div>

                <div className="hidden lg:flex items-center gap-3 text-xs text-muted-foreground w-40 shrink-0">
                  <span className="flex items-center gap-1">
                    <MousePointerClick className="h-3 w-3" aria-hidden="true" />
                    {s.totalClicks}
                  </span>
                  <span>{s.pageViewsCount} pages</span>
                </div>

                <div className="text-xs text-muted-foreground w-20 shrink-0">{fmtDuration(s.duration)}</div>

                <div className="flex items-center gap-1 shrink-0">
                  {s.hasRageClick && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-destructive/15 text-destructive font-medium flex items-center gap-1">
                      <Flame className="h-3 w-3" aria-hidden="true" /> Rage
                    </span>
                  )}
                  {s.hasDeadClick && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-500 font-medium">
                      Dead
                    </span>
                  )}
                </div>

                <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}
      </div>

      {activeSession && (
        <RecordingPlayer sessionId={activeSession} onClose={() => setActiveSession(null)} />
      )}
    </div>
  )
})

function DeviceIcon({ device }: { device: string }) {
  const cls = "h-3.5 w-3.5 text-muted-foreground"
  if (device === "mobile") return <Smartphone className={cls} aria-hidden="true" />
  if (device === "tablet") return <Tablet className={cls} aria-hidden="true" />
  return <Monitor className={cls} aria-hidden="true" />
}
