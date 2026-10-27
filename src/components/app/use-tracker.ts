"use client"

import { useEffect, useRef } from "react"
import { io, Socket } from "socket.io-client"

// Client-side tracker hook used by the in-app demo site.
// Mirrors the standalone SDK but runs inside React.
export function useTracker(projectId: string | null | undefined) {
  const wsRef = useRef<Socket | null>(null)
  const bufRef = useRef<any[]>([])
  const idsRef = useRef<{ visitorId: string; sessionId: string; startTs: number } | null>(null)

  useEffect(() => {
    if (!projectId) return
    let visitorId = localStorage.getItem("ir_visitor") || "v_" + Math.random().toString(36).slice(2, 10)
    localStorage.setItem("ir_visitor", visitorId)
    let sessionId = sessionStorage.getItem("ir_session") || "s_" + Math.random().toString(36).slice(2, 10)
    sessionStorage.setItem("ir_session", sessionId)
    const startTs = Date.now()
    idsRef.current = { visitorId, sessionId, startTs }

    const API = "/api/track/events"
    const lastPointer = { x: 0, y: 0 }
    let lastMove = 0
    let lastScroll = 0
    const errorBuf: { message: string; stack?: string; url?: string; line?: number; t?: number }[] = []

    // UTM + entry capture
    const getQuery = (name: string) => {
      const m = new RegExp("[?&]" + name + "=([^&#]*)").exec(location.search)
      return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : ""
    }
    const utmSource = getQuery("utm_source") || (document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, "") : "")
    const utmMedium = getQuery("utm_medium") || (document.referrer ? "referral" : "")
    const utmCampaign = getQuery("utm_campaign") || ""
    const entryUrl = location.pathname + location.search

    const push = (type: string, extra: any = {}) => {
      const ev = {
        type,
        t: Date.now() - startTs,
        x: lastPointer.x,
        y: lastPointer.y,
        scrollX: window.scrollX || 0,
        scrollY: window.scrollY || 0,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        pageUrl: location.pathname + location.search,
        ...extra,
      }
      bufRef.current.push(ev)
      const ws = wsRef.current
      if (ws && ws.connected && (type === "mousemove" || type === "click" || type === "scroll")) {
        try {
          ws.emit("live", { sessionId, projectId, ev })
        } catch {}
      }
      if (bufRef.current.length >= 30) flush()
    }

    const onMove = (e: MouseEvent) => {
      lastPointer.x = e.clientX
      lastPointer.y = e.clientY
      const t = Date.now()
      if (t - lastMove < 70) return
      lastMove = t
      push("mousemove")
    }
    const onClick = (e: MouseEvent) => {
      lastPointer.x = e.clientX
      lastPointer.y = e.clientY
      const t = (e.target as HTMLElement)?.innerText || ""
      push("click", { data: { tag: (e.target as HTMLElement)?.tagName, text: t.slice(0, 40) } })
    }
    const onScroll = () => {
      const t = Date.now()
      if (t - lastScroll < 150) return
      lastScroll = t
      push("scroll")
    }
    const onKey = (e: KeyboardEvent) => {
      push("keypress", { data: { key: e.key.length === 1 ? "*" : e.key, code: e.code } })
    }
    const onResize = () => push("resize")
    const onVis = () => push("visibility", { data: { hidden: document.hidden } })

    const flush = () => {
      if (!bufRef.current.length && !errorBuf.length) return
      const events = bufRef.current.splice(0, bufRef.current.length)
      const errors = errorBuf.splice(0, errorBuf.length)
      const body = {
        projectId,
        visitorId,
        sessionId,
        userAgent: navigator.userAgent,
        language: navigator.language,
        referrer: document.referrer,
        utmSource,
        utmMedium,
        utmCampaign,
        entryUrl,
        screenWidth: screen.width,
        screenHeight: screen.height,
        startedAt: startTs,
        events,
        errors,
      }
      try {
        fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: true,
        }).catch(() => {})
      } catch {}
    }

    // Capture JS errors
    const onError = (e: ErrorEvent) => {
      errorBuf.push({
        message: (e.message || "Error") + (e.filename ? ` (${e.filename}:${e.lineno})` : ""),
        stack: e.error?.stack ? String(e.error.stack).slice(0, 2000) : "",
        url: location.pathname,
        line: e.lineno || 0,
        t: Date.now() - startTs,
      })
      flush()
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      let msg = "Unhandled Promise Rejection"
      try {
        msg = "Promise rejection: " + (e.reason?.message ? e.reason.message : String(e.reason)).slice(0, 300)
      } catch {}
      errorBuf.push({ message: msg, stack: "", url: location.pathname, line: 0, t: Date.now() - startTs })
      flush()
    }

    // websocket
    const ws = io("/?XTransformPort=3004", { transports: ["websocket", "polling"], forceNew: true })
    wsRef.current = ws
    ws.on("connect", () => {
      ws.emit("register", { sessionId, projectId, visitorId, url: location.pathname })
    })

    push("pageview", { data: { title: document.title, url: location.pathname } })
    window.addEventListener("mousemove", onMove, { passive: true })
    window.addEventListener("click", onClick, { passive: true })
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("keydown", onKey, { passive: true })
    window.addEventListener("resize", onResize, { passive: true })
    document.addEventListener("visibilitychange", onVis)
    window.addEventListener("error", onError, true)
    window.addEventListener("unhandledrejection", onRejection, true)

    const flushInterval = setInterval(flush, 3500)
    const onUnload = () => {
      push("unload")
      flush()
      const body = {
        projectId,
        visitorId,
        sessionId,
        end: true,
        events: bufRef.current.splice(0, bufRef.current.length),
      }
      try {
        fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: true,
        }).catch(() => {})
      } catch {}
    }
    window.addEventListener("beforeunload", onUnload)

    return () => {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("click", onClick)
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", onResize)
      window.removeEventListener("beforeunload", onUnload)
      window.removeEventListener("error", onError, true)
      window.removeEventListener("unhandledrejection", onRejection, true)
      document.removeEventListener("visibilitychange", onVis)
      clearInterval(flushInterval)
      flush()
      ws.disconnect()
    }
  }, [projectId])
}
