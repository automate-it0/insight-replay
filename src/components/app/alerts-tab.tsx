"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { api, fmtRelative } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { toast } from "sonner"
import { Bell, Plus, Trash2, AlertTriangle, Check, Zap } from "lucide-react"

interface Alert {
  id: string
  name: string
  metric: string
  condition: string
  threshold: number
  windowMin: number
  channel: string
  enabled: boolean
  lastTriggered: string | null
  _count?: { history: number }
}
interface AlertHistoryItem {
  id: string
  alertId: string
  triggeredAt: string
  value: number
  message: string
  acknowledged: boolean
  alert?: { name: string }
}

const METRICS = [
  { value: "sessions", label: "Sessions" },
  { value: "rageClicks", label: "Rage clicks" },
  { value: "errors", label: "JS errors" },
  { value: "conversions", label: "Conversions" },
  { value: "bounceRate", label: "Bounce rate" },
  { value: "avgDuration", label: "Avg duration" },
]
const CONDITIONS = [
  { value: "gt", label: "exceeds" },
  { value: "lt", label: "drops below" },
  { value: "spikes", label: "spikes by %" },
  { value: "drops", label: "drops by %" },
]

export const AlertsTab = memo(function AlertsTab({ projectId }: { projectId: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [history, setHistory] = useState<AlertHistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [evaluating, setEvaluating] = useState<string | null>(null)
  const [form, setForm] = useState({ name: "", metric: "sessions", condition: "gt", threshold: "10", windowMin: "60" })

  async function load() {
    setLoading(true)
    try {
      const [a, h] = await Promise.all([
        api<{ alerts: Alert[] }>(`/api/projects/${projectId}/alerts`),
        api<{ history: AlertHistoryItem[] }>(`/api/projects/${projectId}/alerts/history`),
      ])
      setAlerts(a.alerts)
      setHistory(h.history)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    const t = setInterval(load, 20000)
    return () => clearInterval(t)
  }, [projectId])

  async function handleCreate() {
    if (!form.name.trim()) {
      toast.error("Name required")
      return
    }
    try {
      await api(`/api/projects/${projectId}/alerts`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          metric: form.metric,
          condition: form.condition,
          threshold: parseFloat(form.threshold) || 0,
          windowMin: parseInt(form.windowMin) || 60,
          channel: "inapp",
        }),
      })
      setCreateOpen(false)
      setForm({ name: "", metric: "sessions", condition: "gt", threshold: "10", windowMin: "60" })
      toast.success("Alert created")
      void load()
    } catch {
      toast.error("Failed to create alert")
    }
  }

  async function toggle(a: Alert) {
    try {
      await api(`/api/projects/${projectId}/alerts/${a.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !a.enabled }),
      })
      setAlerts((arr) => arr.map((x) => (x.id === a.id ? { ...x, enabled: !x.enabled } : x)))
    } catch {}
  }

  async function remove(id: string) {
    try {
      await api(`/api/projects/${projectId}/alerts/${id}`, { method: "DELETE" })
      setAlerts((arr) => arr.filter((x) => x.id !== id))
      toast.success("Alert deleted")
    } catch {}
  }

  async function evaluate(a: Alert) {
    setEvaluating(a.id)
    try {
      const d = await api<{ triggered: boolean; value: number; message?: string }>(
        `/api/projects/${projectId}/alerts/${a.id}/evaluate`
      )
      if (d.triggered) {
        toast.error(`🔴 ${a.name} triggered! Value: ${d.value.toFixed(1)}`)
      } else {
        toast.success(`✓ ${a.name}: ${d.value.toFixed(1)} — within normal range`)
      }
      void load()
    } catch {
      toast.error("Evaluation failed")
    } finally {
      setEvaluating(null)
    }
  }

  async function acknowledge(hid: string) {
    try {
      await api(`/api/projects/${projectId}/alerts/history/${hid}`, { method: "PATCH" })
      setHistory((h) => h.map((x) => (x.id === hid ? { ...x, acknowledged: true } : x)))
    } catch {}
  }

  // Pre-compute label lookup maps from the constant METRICS / CONDITIONS arrays
  // so the per-row find() inside .map() below is O(1) instead of O(n*m).
  const metricLabels = useMemo(
    () => Object.fromEntries(METRICS.map((m) => [m.value, m.label])) as Record<string, string>,
    []
  )
  const conditionLabels = useMemo(
    () => Object.fromEntries(CONDITIONS.map((c) => [c.value, c.label])) as Record<string, string>,
    []
  )

  return (
    <div className="h-full overflow-y-auto scroll-thin p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-primary" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">Alerts & monitoring</h2>
            <p className="text-xs text-muted-foreground">Get notified when metrics cross thresholds</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2" size="sm">
          <Plus className="h-4 w-4" aria-hidden="true" /> New alert
        </Button>
      </div>

      {/* Alert rules */}
      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border/60">
          <h3 className="font-semibold text-sm">Alert rules</h3>
        </div>
        {loading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14" />)}
          </div>
        ) : alerts.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">No alerts configured.</div>
        ) : (
          <div className="divide-y divide-border/40">
            {alerts.map((a) => (
              <div key={a.id} className="px-5 py-3 flex items-center gap-4 group">
                <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${a.enabled ? "bg-amber-500/15" : "bg-muted"}`} aria-hidden="true">
                  <Bell className={`h-4 w-4 ${a.enabled ? "text-amber-400" : "text-muted-foreground"}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm flex items-center gap-2">
                    {a.name}
                    {a.lastTriggered && (
                      <Badge variant="secondary" className="text-[10px]">last: {fmtRelative(a.lastTriggered)}</Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {metricLabels[a.metric]} {conditionLabels[a.condition]} {a.threshold} · every {a.windowMin}min
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  onClick={() => evaluate(a)}
                  disabled={evaluating === a.id}
                  aria-label={`Test alert ${a.name}`}
                >
                  <Zap className={`h-3 w-3 ${evaluating === a.id ? "animate-spin" : ""}`} aria-hidden="true" />
                  Test
                </Button>
                <Switch checked={a.enabled} onCheckedChange={() => toggle(a)} aria-label={`Toggle alert ${a.name}`} />
                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100" onClick={() => remove(a.id)} aria-label={`Delete alert ${a.name}`}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Alert history */}
      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border/60 flex items-center justify-between">
          <h3 className="font-semibold text-sm">Recent triggers</h3>
          <span className="text-xs text-muted-foreground">{history.length} events</span>
        </div>
        {history.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">No alerts triggered yet.</div>
        ) : (
          <div className="divide-y divide-border/40 max-h-96 overflow-y-auto scroll-thin" role="region" aria-label="Alert history" aria-live="polite">
            {history.map((h) => (
              <div key={h.id} className={`px-5 py-3 flex items-center gap-3 ${h.acknowledged ? "opacity-50" : ""}`}>
                <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{h.alert?.name || "Alert"}</div>
                  <div className="text-xs text-muted-foreground">{h.message}</div>
                </div>
                <div className="text-xs text-muted-foreground shrink-0">{fmtRelative(h.triggeredAt)}</div>
                {!h.acknowledged && (
                  <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => acknowledge(h.id)} aria-label={`Acknowledge alert ${h.alert?.name || ""}`}>
                    <Check className="h-3 w-3" aria-hidden="true" /> Ack
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create alert</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="alert-name">Alert name</Label>
              <Input id="alert-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Rage click surge" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="alert-metric">Metric</Label>
                <Select value={form.metric} onValueChange={(v) => setForm({ ...form, metric: v })}>
                  <SelectTrigger id="alert-metric"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {METRICS.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="alert-condition">Condition</Label>
                <Select value={form.condition} onValueChange={(v) => setForm({ ...form, condition: v })}>
                  <SelectTrigger id="alert-condition"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONDITIONS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="alert-threshold">Threshold</Label>
                <Input id="alert-threshold" value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} type="number" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="alert-window">Window (min)</Label>
                <Input id="alert-window" value={form.windowMin} onChange={(e) => setForm({ ...form, windowMin: e.target.value })} type="number" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create alert</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
