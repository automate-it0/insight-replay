"use client"

import { useEffect, useMemo, useRef, useState, useCallback } from "react"
import { api, fmtDuration, fmtTime } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { PageMock } from "./page-mock"
import { Markdown } from "./markdown"
import {
  X,
  Play,
  Pause,
  Rewind,
  FastForward,
  Globe,
  MousePointerClick,
  Eye,
  Flame,
  Clock,
  Monitor,
  Smartphone,
  Tablet,
  ChevronRight,
  ListChecks,
  Sparkles,
  Bookmark,
  BookmarkCheck,
  Tag as TagIcon,
  AlertTriangle,
  StickyNote,
  List,
} from "lucide-react"
import {
  computeReplayState,
  computeScale,
  findProjectForSession,
  type EventRow,
  type SessionRow,
  type InsightRow,
  type ReplayState,
  type PageInfo,
} from "./recording-player-helpers"

interface ErrorRow {
  id: string
  message: string
  t: number
  url: string
}

interface NoteRow {
  id: string
  text: string
  t: number
  author: string
}

interface TagRow {
  id: string
  label: string
  color: string
}

const SPEEDS = [0.5, 1, 2, 4]

export function RecordingPlayer({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [session, setSession] = useState<SessionRow | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [insights, setInsights] = useState<InsightRow[]>([])
  const [errors, setErrors] = useState<ErrorRow[]>([])
  const [loading, setLoading] = useState(true)

  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(2)
  const [scale, setScale] = useState(1)
  const [showCursor, setShowCursor] = useState(true)

  // AI + collaboration
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [bookmarked, setBookmarked] = useState(false)
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [tags, setTags] = useState<TagRow[]>([])
  const [newTag, setNewTag] = useState("")
  const [newNote, setNewNote] = useState("")
  const [sideTab, setSideTab] = useState<"info" | "ai" | "notes" | "timeline">("info")

  const containerRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number>(0)

  // The session detail route is /api/projects/[id]/sessions/[sid]. The player
  // is opened with only a sessionId, so we look the project up once and cache
  // it so the AI/bookmark/tag/note actions don't have to re-probe every time.
  const projectIdRef = useRef<string | null>(null)

  async function getProjectId(): Promise<string | null> {
    if (projectIdRef.current) return projectIdRef.current
    const pid = await findProjectForSession(sessionId)
    if (pid) projectIdRef.current = pid
    return pid
  }

  // Initial load: probe projects for the session, then fetch related data.
  useEffect(() => {
    let alive = true
    setLoading(true)
    projectIdRef.current = null
    ;void (async () => {
      try {
        const { projects } = await api<{ projects: { id: string }[] }>("/api/projects")
        for (const p of projects) {
          try {
            const d = await api<{ session: SessionRow; events: EventRow[]; insights: InsightRow[] }>(
              `/api/projects/${p.id}/sessions/${sessionId}`
            )
            if (d.session && alive) {
              projectIdRef.current = p.id
              setSession(d.session)
              setEvents(d.events)
              setInsights(d.insights)
              const [n, tg, bm, errs] = await Promise.all([
                api<{ notes: NoteRow[] }>(`/api/projects/${p.id}/sessions/${sessionId}/notes`).catch(() => ({ notes: [] })),
                api<{ tags: TagRow[] }>(`/api/projects/${p.id}/sessions/${sessionId}/tags`).catch(() => ({ tags: [] })),
                api<{ bookmarked: boolean }>(`/api/projects/${p.id}/sessions/${sessionId}/bookmark`).catch(() => ({ bookmarked: false })),
                api<{ errors: ErrorRow[]; aggregate: unknown }>(`/api/projects/${p.id}/errors?sessionId=${sessionId}&range=30`).catch(() => ({ errors: [], aggregate: {} })),
              ])
              if (alive) {
                setNotes(n.notes)
                setTags(tg.tags)
                setBookmarked(bm.bookmarked)
                setErrors(errs.errors)
              }
            }
            break
          } catch {
            continue
          }
        }
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [sessionId])

  async function runAI() {
    if (!session) return
    setAiLoading(true)
    setAiAnalysis(null)
    setSideTab("ai")
    try {
      const pid = await getProjectId()
      if (!pid) throw new Error("project not found")
      const d = await api<{ analysis: string | null; error?: string }>(
        `/api/projects/${pid}/ai/session`,
        { method: "POST", body: JSON.stringify({ sessionId }) }
      )
      if (d.analysis) setAiAnalysis(d.analysis)
      else toast.error(d.error || "AI analysis failed")
    } catch {
      toast.error("AI analysis failed")
    } finally {
      setAiLoading(false)
    }
  }

  async function toggleBookmark() {
    if (!session) return
    try {
      const pid = await getProjectId()
      if (!pid) throw new Error("project not found")
      const d = await api<{ bookmarked: boolean }>(`/api/projects/${pid}/sessions/${sessionId}/bookmark`, { method: "POST" })
      setBookmarked(d.bookmarked)
      toast.success(d.bookmarked ? "Bookmarked" : "Removed bookmark")
    } catch {
      toast.error("Failed")
    }
  }

  async function addTag() {
    if (!newTag.trim() || !session) return
    try {
      const pid = await getProjectId()
      if (!pid) throw new Error("project not found")
      const d = await api<{ tag: TagRow }>(`/api/projects/${pid}/sessions/${sessionId}/tags`, {
        method: "POST",
        body: JSON.stringify({ label: newTag.trim() }),
      })
      setTags((t) => [...t, d.tag])
      setNewTag("")
    } catch {
      toast.error("Failed to add tag")
    }
  }

  async function addNote() {
    if (!newNote.trim() || !session) return
    try {
      const pid = await getProjectId()
      if (!pid) throw new Error("project not found")
      const d = await api<{ note: NoteRow }>(`/api/projects/${pid}/sessions/${sessionId}/notes`, {
        method: "POST",
        body: JSON.stringify({ text: newNote.trim(), t: Math.floor(currentTime) }),
      })
      setNotes((n) => [...n, d.note].sort((a, b) => a.t - b.t))
      setNewNote("")
    } catch {
      toast.error("Failed to add note")
    }
  }

  const duration = useMemo(() => {
    if (!events.length) return session?.duration ? session.duration * 1000 : 0
    return Math.max(events[events.length - 1].t, (session?.duration || 0) * 1000)
  }, [events, session])

  // Resize observer for scaling
  useEffect(() => {
    if (!session || !containerRef.current) return
    const el = containerRef.current
    const compute = () => {
      setScale(computeScale(el.clientWidth, el.clientHeight, session.screenWidth, session.screenHeight))
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [session])

  // Playback loop
  useEffect(() => {
    if (!playing || !duration) return
    lastFrameRef.current = performance.now()
    const tick = (now: number) => {
      const dt = now - lastFrameRef.current
      lastFrameRef.current = now
      setCurrentTime((ct) => {
        const next = ct + dt * speed
        if (next >= duration) {
          setPlaying(false)
          return duration
        }
        return next
      })
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [playing, speed, duration])

  // Compute current replay state (pure helper — see recording-player-helpers.ts)
  const state: ReplayState = useMemo(() => computeReplayState(events, currentTime), [events, currentTime])

  const seek = useCallback(
    (t: number) => {
      setCurrentTime(Math.max(0, Math.min(duration, t)))
    },
    [duration]
  )

  const togglePlay = () => {
    if (currentTime >= duration) seek(0)
    setPlaying((p) => !p)
  }

  const skip = (delta: number) => seek(currentTime + delta)

  // Stable refs for keyboard handler so the listener is only registered once.
  // The ref values are synced in an effect (not during render) — assigning
  // `ref.current` while rendering is unsafe: React may discard the render
  // without committing it, leaving the keyboard handler pointing at a stale
  // closure. Syncing in an effect guarantees the refs hold the latest
  // committed values before the listener can fire.
  const togglePlayRef = useRef(togglePlay)
  const skipRef = useRef(skip)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    togglePlayRef.current = togglePlay
    skipRef.current = skip
    onCloseRef.current = onClose
  })

  // Keyboard controls
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault()
        togglePlayRef.current()
      } else if (e.key === "ArrowLeft") {
        skipRef.current(-2000)
      } else if (e.key === "ArrowRight") {
        skipRef.current(2000)
      } else if (e.key === "Escape") {
        onCloseRef.current()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Eye className="h-4 w-4 text-primary" />
            Session Replay
          </div>
          {session && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="font-mono">{session.visitorId}</span>
              <span>·</span>
              <span>{session.city}, {session.country}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {session && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 h-8"
                onClick={runAI}
                disabled={aiLoading}
              >
                <Sparkles className={`h-3.5 w-3.5 ${aiLoading ? "animate-spin" : ""}`} />
                <span className="hidden sm:inline">{aiLoading ? "Analyzing…" : "AI analyze"}</span>
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleBookmark}>
                {bookmarked ? <BookmarkCheck className="h-4 w-4 text-primary" /> : <Bookmark className="h-4 w-4" />}
              </Button>
            </>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0">
        {/* Viewport */}
        <div className="flex-1 flex flex-col min-w-0">
          <div ref={containerRef} className="flex-1 relative overflow-hidden bg-[#0a0b0d] flex items-center justify-center p-4">
            {loading || !session ? (
              <div className="space-y-3 w-full max-w-md">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-96 w-full" />
              </div>
            ) : (
              <div
                className="relative shadow-2xl"
                style={{
                  width: session.screenWidth * scale,
                  height: session.screenHeight * scale,
                }}
              >
                {/* The actual viewport, scaled */}
                <div
                  className="absolute top-0 left-0 overflow-hidden bg-[#0f1115]"
                  style={{
                    width: session.screenWidth,
                    height: session.screenHeight,
                    transform: `scale(${scale})`,
                    transformOrigin: "top left",
                    borderRadius: 8,
                  }}
                >
                  {/* scrolling page */}
                  <div
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${-state.scrollY}px)` }}
                  >
                    <PageMock url={state.pageUrl} width={session.screenWidth} />
                  </div>

                  {/* click ripples */}
                  {state.ripples.map((r, i) => {
                    const op = 1 - r.age / 600
                    const size = 14 + (r.age / 600) * 40
                    const ringColor = r.rage ? "248,113,113" : r.dead ? "251,191,36" : "16,185,129"
                    return (
                      <div
                        key={i}
                        className="absolute pointer-events-none"
                        style={{
                          left: r.x,
                          top: r.y,
                          transform: "translate(-50%, -50%)",
                        }}
                      >
                        <div
                          className="rounded-full border-2"
                          style={{
                            width: size,
                            height: size,
                            borderColor: `rgba(${ringColor},${op})`,
                            background: `rgba(${ringColor},${op * 0.2})`,
                          }}
                        />
                        <div
                          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                          style={{
                            width: 6,
                            height: 6,
                            background: `rgb(${ringColor})`,
                            opacity: op,
                          }}
                        />
                      </div>
                    )
                  })}

                  {/* cursor */}
                  {showCursor && (
                    <div
                      className="absolute pointer-events-none transition-[left,top] duration-75"
                      style={{ left: state.x, top: state.y, transform: "translate(-2px,-2px)" }}
                    >
                      <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                        <path
                          d="M3 2L19 11L11 13L8 20L3 2Z"
                          fill="white"
                          stroke="black"
                          strokeWidth="1.2"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <div className="absolute top-5 left-4 text-[10px] px-1.5 py-0.5 rounded bg-black/80 text-white whitespace-nowrap">
                        {session.visitorId.slice(0, 6)}
                      </div>
                    </div>
                  )}

                  {/* page change badge */}
                  <div className="absolute top-3 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full bg-black/70 text-white text-[11px] font-mono backdrop-blur">
                    {state.pageUrl}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Controls */}
          {!loading && session && (
            <div className="border-t border-white/10 bg-card/40 px-5 py-3">
              {/* Seek bar */}
              <div
                className="relative h-8 cursor-pointer group"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const f = (e.clientX - rect.left) / rect.width
                  seek(f * duration)
                }}
              >
                <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 rounded-full bg-white/10" />
                <div
                  className="absolute top-1/2 -translate-y-1/2 left-0 h-1.5 rounded-full bg-primary"
                  style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                />
                {/* event markers */}
                {events
                  .filter((e) => e.type === "click" || e.type === "pageview")
                  .slice(0, 120)
                  .map((e, i) => (
                    <div
                      key={i}
                      className="absolute top-1/2 -translate-y-1/2 w-1 h-2.5 rounded-full"
                      style={{
                        left: `${duration ? (e.t / duration) * 100 : 0}%`,
                        background:
                          e.type === "pageview" ? "oklch(0.74 0.16 230)" : "oklch(0.78 0.18 70)",
                      }}
                    />
                  ))}
                {/* playhead */}
                <div
                  className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-primary border-2 border-background shadow"
                  style={{ left: `${duration ? (currentTime / duration) * 100 : 0}%` }}
                />
              </div>

              <div className="flex items-center gap-3 mt-2">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => skip(-3000)}>
                  <Rewind className="h-4 w-4" />
                </Button>
                <Button
                  variant="default"
                  size="icon"
                  className="h-9 w-9 rounded-full bg-primary"
                  onClick={togglePlay}
                >
                  {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => skip(3000)}>
                  <FastForward className="h-4 w-4" />
                </Button>

                <div className="text-xs font-mono text-muted-foreground tabular-nums">
                  {fmtDuration(Math.floor(currentTime / 1000))} / {fmtDuration(Math.floor(duration / 1000))}
                </div>

                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => setShowCursor((s) => !s)}
                    className={`text-xs px-2 py-1 rounded ${showCursor ? "bg-primary/20 text-primary" : "text-muted-foreground"}`}
                  >
                    Cursor
                  </button>
                  <div className="flex items-center rounded-lg border border-white/10 p-0.5">
                    {SPEEDS.map((s) => (
                      <button
                        key={s}
                        onClick={() => setSpeed(s)}
                        className={`px-2 py-0.5 text-xs rounded-md ${
                          speed === s ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground"
                        }`}
                      >
                        {s}x
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Side panel */}
        <aside className="w-80 shrink-0 border-l border-white/10 bg-card/40 flex flex-col">
          {loading || !session ? (
            <div className="p-4 space-y-3 overflow-y-auto scroll-thin">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : (
            <>
              {/* Side tabs */}
              <div className="flex items-center border-b border-white/10 shrink-0">
                {[
                  { id: "info" as const, label: "Info", icon: Eye },
                  { id: "ai" as const, label: "AI", icon: Sparkles },
                  { id: "notes" as const, label: "Notes", icon: StickyNote, badge: notes.length },
                  { id: "timeline" as const, label: "Timeline", icon: List },
                ].map((tb) => {
                  const Icon = tb.icon
                  const active = sideTab === tb.id
                  return (
                    <button
                      key={tb.id}
                      onClick={() => setSideTab(tb.id)}
                      className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs relative transition-colors ${
                        active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {tb.label}
                      {tb.badge ? <span className="text-[9px] px-1 rounded bg-primary/20 text-primary">{tb.badge}</span> : null}
                      {active && <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-primary rounded-full" />}
                    </button>
                  )
                })}
              </div>

              <div className="flex-1 overflow-y-auto scroll-thin p-4 space-y-5">
                {sideTab === "info" && (
                  <InfoTab
                    session={session}
                    insights={insights}
                    tags={tags}
                    newTag={newTag}
                    setNewTag={setNewTag}
                    addTag={addTag}
                    pages={state.pages}
                    seek={seek}
                  />
                )}
                {sideTab === "ai" && (
                  <AiTab aiLoading={aiLoading} aiAnalysis={aiAnalysis} runAI={runAI} />
                )}
                {sideTab === "notes" && (
                  <NotesTab
                    currentTime={currentTime}
                    newNote={newNote}
                    setNewNote={setNewNote}
                    addNote={addNote}
                    notes={notes}
                    seek={seek}
                  />
                )}
                {sideTab === "timeline" && (
                  <TimelineTab events={events} currentTime={currentTime} seek={seek} errors={errors} />
                )}
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Side-panel tab contents — extracted so each tab is self-contained.         */
/* -------------------------------------------------------------------------- */

function InfoTab({
  session,
  insights,
  tags,
  newTag,
  setNewTag,
  addTag,
  pages,
  seek,
}: {
  session: SessionRow
  insights: InsightRow[]
  tags: TagRow[]
  newTag: string
  setNewTag: (s: string) => void
  addTag: () => void
  pages: PageInfo[]
  seek: (t: number) => void
}) {
  return (
    <>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Visitor</div>
        <div className="text-sm font-mono">{session.visitorId}</div>
        <div className="text-xs text-muted-foreground mt-1">{fmtTime(session.startedAt)}</div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Stat icon={<Clock className="h-3.5 w-3.5" />} label="Duration" value={fmtDuration(session.duration)} />
        <Stat icon={<Eye className="h-3.5 w-3.5" />} label="Pages" value={String(session.pageViewsCount)} />
        <Stat icon={<MousePointerClick className="h-3.5 w-3.5" />} label="Clicks" value={String(session.totalClicks)} />
        <Stat icon={<Flame className="h-3.5 w-3.5" />} label="Rage" value={session.hasRageClick ? "Yes" : "No"} danger={session.hasRageClick} />
      </div>

      {tags.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1"><TagIcon className="h-3 w-3" /> Tags</div>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span key={t.id} className="text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">{t.label}</span>
            ))}
          </div>
        </div>
      )}
      <div className="flex gap-1.5">
        <Input value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag()} placeholder="Add tag…" className="h-8 text-xs" />
        <Button size="sm" variant="outline" className="h-8 px-2" onClick={addTag}>Add</Button>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Environment</div>
        <div className="space-y-1.5 text-xs">
          <Row label="Device" value={session.device} icon={<DeviceIcon device={session.device} />} />
          <Row label="Browser" value={session.browser} />
          <Row label="OS" value={session.os} />
          <Row label="Screen" value={`${session.screenWidth}×${session.screenHeight}`} />
          <Row label="Language" value={session.language} />
          <Row label="Location" value={`${session.city}, ${session.country}`} icon={<Globe className="h-3 w-3" />} />
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1"><ListChecks className="h-3 w-3" /> Pages visited</div>
        <div className="space-y-1">
          {pages.length === 0 && <div className="text-xs text-muted-foreground">—</div>}
          {pages.map((p, i) => (
            <button key={i} onClick={() => seek(p.t + 50)} className="w-full text-left flex items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-white/5">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <span className="font-mono truncate">{p.url}</span>
              <span className="ml-auto text-muted-foreground">{fmtDuration(Math.floor(p.t / 1000))}</span>
            </button>
          ))}
        </div>
      </div>

      {insights.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1"><Flame className="h-3 w-3" /> Insights</div>
          <div className="space-y-1.5">
            {insights.map((ins) => (
              <div key={ins.id} className={`text-xs px-2 py-1.5 rounded border ${ins.type === "rage_click" ? "border-destructive/30 bg-destructive/10" : ins.type === "dead_click" ? "border-amber-500/30 bg-amber-500/10" : "border-white/10 bg-white/5"}`}>
                <div className="font-medium capitalize">{ins.type.replace("_", " ")}</div>
                <div className="text-muted-foreground mt-0.5">{ins.data && (ins.data as { pageUrl?: string }).pageUrl}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function AiTab({
  aiLoading,
  aiAnalysis,
  runAI,
}: {
  aiLoading: boolean
  aiAnalysis: string | null
  runAI: () => void
}) {
  if (aiLoading) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 animate-spin text-primary" />
          Analyzing session…
        </div>
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-4" />)}
      </div>
    )
  }
  if (aiAnalysis) {
    return <Markdown content={aiAnalysis} />
  }
  return (
    <div className="text-center py-8">
      <div className="h-12 w-12 rounded-xl bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center mx-auto mb-3">
        <Sparkles className="h-6 w-6 text-primary" />
      </div>
      <div className="font-medium text-sm">AI session analysis</div>
      <p className="text-xs text-muted-foreground mt-1 mb-4">
        Get an AI-generated summary of what this visitor did, pain points, and recommendations.
      </p>
      <Button size="sm" className="gap-1.5" onClick={runAI}>
        <Sparkles className="h-3.5 w-3.5" /> Analyze session
      </Button>
    </div>
  )
}

function NotesTab({
  currentTime,
  newNote,
  setNewNote,
  addNote,
  notes,
  seek,
}: {
  currentTime: number
  newNote: string
  setNewNote: (s: string) => void
  addNote: () => void
  notes: NoteRow[]
  seek: (t: number) => void
}) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Add note at {fmtDuration(Math.floor(currentTime / 1000))}</div>
        <div className="flex gap-1.5">
          <Input value={newNote} onChange={(e) => setNewNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} placeholder="Note text…" className="h-8 text-xs" />
          <Button size="sm" className="h-8 px-2" onClick={addNote}>Add</Button>
        </div>
      </div>
      <div className="space-y-2">
        {notes.length === 0 && <div className="text-xs text-muted-foreground text-center py-4">No notes yet. Add timestamps to mark important moments.</div>}
        {notes.map((n) => (
          <button key={n.id} onClick={() => seek(n.t)} className="w-full text-left rounded-lg border border-white/10 bg-white/5 p-2.5 hover:bg-white/10 transition-colors">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
              <span className="flex items-center gap-1"><StickyNote className="h-3 w-3" /> {n.author}</span>
              <span className="font-mono">{fmtDuration(Math.floor(n.t / 1000))}</span>
            </div>
            <div className="text-xs">{n.text}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

function TimelineTab({
  events,
  currentTime,
  seek,
  errors,
}: {
  events: EventRow[]
  currentTime: number
  seek: (t: number) => void
  errors: ErrorRow[]
}) {
  const timelineEvents = events
    .filter((e) => ["pageview", "click", "scroll", "keypress", "visibility"].includes(e.type))
    .slice(0, 200)
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Event timeline</div>
      <div className="space-y-0.5 max-h-[60vh] overflow-y-auto scroll-thin">
        {timelineEvents.map((e, i) => (
          <button
            key={i}
            onClick={() => seek(e.t)}
            className={`w-full text-left flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-white/5 ${
              e.t <= currentTime && currentTime < e.t + 500 ? "bg-primary/15" : ""
            }`}
          >
            <EventIcon type={e.type} />
            <span className="text-muted-foreground font-mono w-12 shrink-0">{fmtDuration(Math.floor(e.t / 1000))}</span>
            <span className="truncate flex-1">
              {e.type === "click" ? `Click: ${(e.data as { text?: string }).text || (e.data as { tag?: string }).tag}` :
               e.type === "pageview" ? `Page: ${e.pageUrl}` :
               e.type === "scroll" ? `Scroll to ${e.scrollY}px` :
               e.type === "keypress" ? `Key: ${(e.data as { key?: string }).key}` :
               e.type === "visibility" ? `Tab ${((e.data as { hidden?: boolean }).hidden) ? "hidden" : "visible"}` :
               e.type}
            </span>
          </button>
        ))}
        {errors.map((er) => (
          <button key={er.id} onClick={() => seek(er.t)} className="w-full text-left flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-red-500/10 text-red-300">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="font-mono w-12 shrink-0">{fmtDuration(Math.floor(er.t / 1000))}</span>
            <span className="truncate flex-1">Error: {er.message.slice(0, 50)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Small presentational helpers.                                              */
/* -------------------------------------------------------------------------- */

function EventIcon({ type }: { type: string }) {
  if (type === "click") return <MousePointerClick className="h-3 w-3 text-emerald-400 shrink-0" />
  if (type === "pageview") return <Eye className="h-3 w-3 text-sky-400 shrink-0" />
  if (type === "scroll") return <ChevronRight className="h-3 w-3 text-amber-400 shrink-0" />
  if (type === "keypress") return <span className="text-[9px] text-violet-400 w-3 text-center">⌨</span>
  if (type === "visibility") return <span className="text-[9px] text-muted-foreground w-3 text-center">●</span>
  return <span className="h-3 w-3 shrink-0" />
}

function Stat({
  icon,
  label,
  value,
  danger,
}: {
  icon: React.ReactNode
  label: string
  value: string
  danger?: boolean
}) {
  return (
    <div className="rounded-lg bg-white/5 px-2.5 py-2">
      <div className={`flex items-center gap-1 text-[10px] uppercase tracking-wider ${danger ? "text-destructive" : "text-muted-foreground"}`}>
        {icon}
        {label}
      </div>
      <div className={`text-sm font-semibold mt-0.5 ${danger ? "text-destructive" : ""}`}>{value}</div>
    </div>
  )
}

function Row({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1 capitalize">
        {icon}
        {value}
      </span>
    </div>
  )
}

function DeviceIcon({ device }: { device: string }) {
  if (device === "mobile") return <Smartphone className="h-3 w-3" />
  if (device === "tablet") return <Tablet className="h-3 w-3" />
  return <Monitor className="h-3 w-3" />
}
