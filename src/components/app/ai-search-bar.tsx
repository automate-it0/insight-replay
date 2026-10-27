"use client"

import { useState } from "react"
import { api, fmtDuration, fmtRelative } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Search, X, Zap } from "lucide-react"
import { RecordingPlayer } from "./recording-player"

interface AISession {
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
  hasRageClick: boolean
  hasDeadClick: boolean
}

export function AiSearchBar({ projectId, range }: { projectId: string; range: string }) {
  const [query, setQuery] = useState("")
  const [loading, setLoading] = useState(false)
  const [filters, setFilters] = useState<Record<string, any> | null>(null)
  const [sessions, setSessions] = useState<AISession[]>([])
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeSession, setActiveSession] = useState<string | null>(null)

  const EXAMPLES = [
    "mobile users who raged last week",
    "visitors from Google who converted",
    "desktop sessions longer than 30 seconds with errors",
    "returning visitors from Tokyo",
  ]

  async function search(q?: string) {
    const queryStr = (q ?? query).trim()
    if (!queryStr) return
    if (q) setQuery(q)
    setLoading(true)
    setError(null)
    setSearched(true)
    try {
      const d = await api<{ filters: Record<string, any> | null; sessions: AISession[]; error?: string }>(
        `/api/projects/${projectId}/ai-search`,
        { method: "POST", body: JSON.stringify({ query: queryStr, range: parseInt(range) }) }
      )
      setFilters(d.filters)
      setSessions(d.sessions || [])
      if (d.error) setError(d.error)
    } catch (e) {
      setError(String(e))
      setSessions([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      {/* Search input */}
      <div className="relative">
        <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-primary" aria-hidden="true" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Ask AI: 'mobile users who raged on pricing last week'"
          aria-label="Ask AI to search sessions"
          className="pl-9 pr-24 h-10 bg-background/40"
        />
        <Button
          size="sm"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 gap-1.5"
          onClick={() => search()}
          disabled={loading || !query.trim()}
          aria-label="Run AI search"
        >
          {loading ? <Zap className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Search className="h-3.5 w-3.5" aria-hidden="true" />}
          {loading ? "Searching" : "Search"}
        </Button>
      </div>

      {/* Example chips */}
      {!searched && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Example AI search queries">
          <span className="text-xs text-muted-foreground py-1" aria-hidden="true">Try:</span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => search(ex)}
              aria-label={`Search sessions matching: ${ex}`}
              className="text-xs px-2 py-1 rounded-full border border-border/60 bg-background/40 text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {/* Applied filters */}
      {filters && (
        <div className="flex items-center gap-2 flex-wrap" role="status" aria-live="polite">
          <span className="text-xs text-muted-foreground" aria-hidden="true">AI filters:</span>
          {Object.entries(filters).map(([k, v]) => (
            <Badge key={k} variant="secondary" className="text-[10px] gap-1">
              <span className="text-muted-foreground">{k}:</span> {String(v)}
            </Badge>
          ))}
          <button
            type="button"
            onClick={() => { setSearched(false); setFilters(null); setSessions([]); setQuery("") }}
            className="text-xs text-muted-foreground hover:text-foreground"
            aria-label="Clear AI search and filters"
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </div>
      )}

      {error && (
        <div className="text-xs text-destructive" role="alert">{error}</div>
      )}

      {/* Results */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
        </div>
      ) : searched && sessions.length === 0 && !error ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          No sessions match your query.
        </div>
      ) : (
        <div className="divide-y divide-border/40 rounded-lg border border-border/40" role="list" aria-label="AI search results">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveSession(s.id)}
              className="w-full text-left px-4 py-2.5 hover:bg-card/40 transition-colors flex items-center gap-3 group"
              aria-label={`Open session ${s.visitorId} from ${s.city}, ${s.country} on ${fmtRelative(s.startedAt)}`}
            >
              <div className="text-xs text-muted-foreground w-20 shrink-0">{fmtRelative(s.startedAt)}</div>
              <span className="text-xs font-mono w-28 truncate shrink-0">{s.visitorId}</span>
              <span className="text-xs text-muted-foreground w-28 truncate shrink-0">{s.city}, {s.country}</span>
              <span className="text-xs text-muted-foreground w-24 shrink-0">{s.browser} · {s.device}</span>
              <span className="text-xs text-muted-foreground w-20 shrink-0">{fmtDuration(s.duration)}</span>
              <div className="flex gap-1 shrink-0">
                {s.hasRageClick && <Badge variant="secondary" className="text-[9px] bg-destructive/15 text-destructive">rage</Badge>}
                {s.hasDeadClick && <Badge variant="secondary" className="text-[9px] bg-amber-500/15 text-amber-500">dead</Badge>}
              </div>
            </button>
          ))}
        </div>
      )}

      {activeSession && (
        <RecordingPlayer sessionId={activeSession} onClose={() => setActiveSession(null)} />
      )}
    </div>
  )
}
