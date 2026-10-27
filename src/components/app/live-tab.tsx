"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { io, Socket } from "socket.io-client"
import { api } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { PageMock } from "./page-mock"
import {
  Smartphone,
  Monitor,
  Tablet,
  MousePointer2,
  Sparkles,
  ExternalLink,
  Zap,
} from "lucide-react"
import {
  CLICK_RIPPLE_MS,
  addCursorsFromList,
  addCursor,
  removeCursor,
  applyLiveEvent,
  applyCursorSnapshot,
  initGhosts,
  ghostsToCursors,
  tickGhosts,
  removeGhosts,
  type LiveCursor,
  type ActiveSession,
  type Ghost,
} from "./live-tab-helpers"

export const LiveTab = memo(function LiveTab({ projectId }: { projectId: string }) {
  const [active, setActive] = useState<ActiveSession[]>([])
  const [cursors, setCursors] = useState<Record<string, LiveCursor>>({})
  const [loading, setLoading] = useState(true)
  const [simulating, setSimulating] = useState(true)
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<Socket | null>(null)
  const simRef = useRef<boolean>(true)

  // Fetch active sessions from API on mount and every 10s.
  // Guards against setting state after unmount/projectId change.
  useEffect(() => {
    let alive = true
    const fetchActive = async () => {
      try {
        const d = await api<{ sessions: ActiveSession[] }>(
          `/api/projects/${projectId}/sessions?range=1&filter=active`
        )
        if (alive) setActive(d.sessions)
      } catch {
        // ignore — keep last known state
      } finally {
        if (alive) setLoading(false)
      }
    }
    void fetchActive()
    const t = setInterval(fetchActive, 10000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [projectId])

  // Connect to live websocket. Each handler is a thin wrapper around a pure
  // cursor-map transition (see live-tab-helpers.ts).
  useEffect(() => {
    const socket = io("/?XTransformPort=3004", {
      transports: ["websocket", "polling"],
      forceNew: true,
      reconnection: true,
    })
    socketRef.current = socket
    socket.on("connect", () => {
      setConnected(true)
      socket.emit("subscribe", { projectId })
    })
    socket.on("disconnect", () => setConnected(false))
    socket.on("active-sessions", (list: { sessionId: string; visitorId: string; url: string }[]) =>
      setCursors((prev) => addCursorsFromList(prev, list, Date.now()))
    )
    socket.on("session-join", (s: { sessionId: string; visitorId: string; url: string }) =>
      setCursors((prev) => addCursor(prev, s, Date.now()))
    )
    socket.on("session-leave", ({ sessionId }: { sessionId: string }) =>
      setCursors((prev) => removeCursor(prev, sessionId))
    )
    socket.on("live-event", (msg: { sessionId: string; ev: { type: string; x: number; y: number; scrollY: number; pageUrl: string } }) =>
      setCursors((prev) => applyLiveEvent(prev, msg, Date.now()))
    )
    socket.on("cursor-snapshot", (list: { sessionId: string; lastX: number; lastY: number; lastScrollY: number; url: string; visitorId: string }[]) =>
      setCursors((prev) => applyCursorSnapshot(prev, list, Date.now()))
    )
    return () => {
      socket.disconnect()
    }
  }, [projectId])

  // Simulation: a few ghost cursors roaming. State machine lives in the
  // helpers; this effect just owns the interval and React state bridge.
  useEffect(() => {
    simRef.current = simulating
    if (!simulating) return
    const ghosts: Ghost[] = initGhosts(4, Date.now())
    setCursors((prev) => ghostsToCursors(ghosts, prev, Date.now()))

    const interval = setInterval(() => {
      if (!simRef.current) return
      setCursors((prev) => tickGhosts(ghosts, prev, Date.now()))
    }, 60)
    return () => {
      clearInterval(interval)
      setCursors((prev) => removeGhosts(prev))
    }
  }, [simulating])

  const cursorList = useMemo(
    () => Object.values(cursors).sort((a, b) => b.lastSeen - a.lastSeen),
    [cursors]
  )
  const liveCount = cursorList.length

  return (
    <div className="h-full flex">
      {/* Left: active sessions */}
      <div className="w-72 shrink-0 border-r border-border/60 flex flex-col">
        <div className="px-4 py-3 border-b border-border/60 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
            </span>
            <span className="text-sm font-semibold">Live now</span>
          </div>
          <span className="text-xs text-muted-foreground">{liveCount} visitors</span>
        </div>

        <div className="p-3 border-b border-border/60">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSimulating((s) => !s)}
              className={`flex-1 flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded-lg border transition-colors ${
                simulating
                  ? "bg-primary/15 text-primary border-primary/30"
                  : "border-border/60 text-muted-foreground"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {simulating ? "Simulating" : "Simulate"}
            </button>
          </div>
          <div className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-primary" : "bg-muted-foreground"}`} />
            {connected ? "Realtime connected" : "Connecting…"}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin">
          {loading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : cursorList.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No active visitors right now.
              <br />
              Open the demo site to generate live traffic.
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {cursorList.map((c) => {
                const meta = active.find((a) => a.id === c.sessionId)
                return (
                  <div
                    key={c.sessionId}
                    className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-card/40"
                  >
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: c.color }} />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium font-mono truncate">
                        {c.visitorId.slice(0, 12)}
                      </div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                        {meta ? (
                          <>
                            <DeviceIcon device={meta.device} />
                            {meta.city}
                          </>
                        ) : (
                          <>
                            <Monitor className="h-2.5 w-2.5" />
                            {c.url}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: live viewport */}
      <div className="flex-1 overflow-auto scroll-thin bg-[#0a0b0d] p-6">
        <div className="flex items-center justify-between mb-4 max-w-[1280px] mx-auto">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <MousePointer2 className="h-4 w-4 text-primary" />
            Real-time cursor activity
          </div>
          <DemoSiteButton projectId={projectId} />
        </div>
        <div className="relative shadow-2xl mx-auto" style={{ width: 1280 }}>
          <PageMock url="/" width={1280} />
          {/* cursor overlay */}
          {cursorList.map((c) => (
            <Cursor key={c.sessionId} c={c} />
          ))}
          {cursorList.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Card className="p-6 bg-black/70 backdrop-blur border-white/10 flex flex-col items-center gap-3">
                <Zap className="h-6 w-6 text-primary" />
                <div className="text-sm font-medium">Waiting for visitors…</div>
                <DemoSiteButton projectId={projectId} />
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  )
})

/**
 * Renders one live cursor: fading click ripples + the cursor arrow + label.
 * Ripples fade over CLICK_RIPPLE_MS; the parent re-renders every ~60ms
 * (simulation tick) or on every live-event, so opacity stays fresh.
 */
function Cursor({ c }: { c: LiveCursor }) {
  const now = Date.now()
  return (
    <>
      {c.clicks.map((ck, i) => {
        const age = now - ck.t
        const op = Math.max(0, 1 - age / CLICK_RIPPLE_MS)
        if (op <= 0) return null
        const size = 12 + (age / CLICK_RIPPLE_MS) * 30
        return (
          <div
            key={i}
            className="absolute pointer-events-none"
            style={{ left: ck.x, top: ck.y, transform: "translate(-50%, -50%)" }}
          >
            <div
              className="rounded-full border-2"
              style={{
                width: size,
                height: size,
                borderColor: c.color,
                background: c.color + "33",
                opacity: op,
              }}
            />
          </div>
        )
      })}
      <div
        className="absolute pointer-events-none transition-all duration-100"
        style={{ left: c.x, top: c.y }}
      >
        <svg width="20" height="20" viewBox="0 0 22 22" fill="none">
          <path
            d="M3 2L19 11L11 13L8 20L3 2Z"
            fill={c.color}
            stroke="white"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
        <div
          className="absolute top-5 left-3 text-[10px] px-1.5 py-0.5 rounded text-white whitespace-nowrap font-mono"
          style={{ background: c.color }}
        >
          {c.visitorId.slice(0, 8)}
        </div>
      </div>
    </>
  )
}

function DemoSiteButton({ projectId }: { projectId: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={() => {
        window.dispatchEvent(new CustomEvent("open-demo-site", { detail: { projectId } }))
      }}
    >
      <ExternalLink className="h-3.5 w-3.5" />
      Open demo site
    </Button>
  )
}

function DeviceIcon({ device }: { device: string }) {
  if (device === "mobile") return <Smartphone className="h-2.5 w-2.5" />
  if (device === "tablet") return <Tablet className="h-2.5 w-2.5" />
  return <Monitor className="h-2.5 w-2.5" />
}
