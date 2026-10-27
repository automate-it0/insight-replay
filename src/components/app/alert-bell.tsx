"use client"

import { useEffect, useState } from "react"
import { api, fmtRelative } from "@/lib/api"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Bell, AlertTriangle, Check } from "lucide-react"
import { useApp } from "@/store/app"

interface AlertHistoryItem {
  id: string
  alertId: string
  triggeredAt: string
  value: number
  message: string
  acknowledged: boolean
  alert?: { name: string }
}

export function AlertBell({ projectId }: { projectId: string }) {
  const [history, setHistory] = useState<AlertHistoryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const { setTab } = useApp()

  async function load() {
    setLoading(true)
    try {
      const d = await api<{ history: AlertHistoryItem[] }>(
        `/api/projects/${projectId}/alerts/history`
      )
      setHistory(d.history)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [projectId])

  const unack = history.filter((h) => !h.acknowledged)

  async function acknowledge(hid: string) {
    try {
      await api(`/api/projects/${projectId}/alerts/history/${hid}`, { method: "PATCH" })
      setHistory((h) => h.map((x) => (x.id === hid ? { ...x, acknowledged: true } : x)))
    } catch {}
  }

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) void load() }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 relative"
          aria-label={`Alerts${unack.length > 0 ? `, ${unack.length} unread` : ""}`}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {unack.length > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-semibold flex items-center justify-center"
              aria-hidden="true"
            >
              {unack.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="end" role="dialog" aria-label="Recent alerts">
        <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
          <span className="text-sm font-semibold flex items-center gap-1.5">
            <Bell className="h-3.5 w-3.5" aria-hidden="true" /> Alerts
          </span>
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setTab("alerts")}>
            Manage
          </Button>
        </div>
        <div className="max-h-80 overflow-y-auto scroll-thin" role="region" aria-label="Alert history list" aria-live="polite">
          {loading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : history.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No alerts triggered yet.
            </div>
          ) : (
            <div className="divide-y divide-border/40">
              {history.slice(0, 20).map((h) => (
                <div key={h.id} className={`px-3 py-2.5 ${h.acknowledged ? "opacity-50" : ""}`}>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-medium">{h.alert?.name || "Alert"}</div>
                      <div className="text-[11px] text-muted-foreground mt-0.5">{h.message}</div>
                      <div className="text-[10px] text-muted-foreground mt-1">{fmtRelative(h.triggeredAt)}</div>
                    </div>
                    {!h.acknowledged && (
                      <button
                        type="button"
                        onClick={() => acknowledge(h.id)}
                        className="text-muted-foreground hover:text-primary"
                        aria-label={`Acknowledge alert: ${h.alert?.name || "alert"}`}
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
