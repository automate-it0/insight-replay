"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { Filter, Plus, Trash2, ArrowRight, TrendingDown, Users } from "lucide-react"

interface Funnel {
  id: string
  name: string
  steps: { url: string; name: string }[]
  createdAt: string
}
interface Analyze {
  funnel: Funnel
  steps: { name: string; url: string; count: number; rate: number; dropoff: number; dropoffPct: number }[]
  totalSessions: number
  completionRate: number
}

export const FunnelsTab = memo(function FunnelsTab({ projectId, range }: { projectId: string; range: string }) {
  const [funnels, setFunnels] = useState<Funnel[]>([])
  const [active, setActive] = useState<Funnel | null>(null)
  const [analyze, setAnalyze] = useState<Analyze | null>(null)
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newSteps, setNewSteps] = useState([{ url: "/", name: "Homepage" }])

  async function load() {
    setLoading(true)
    try {
      const d = await api<{ funnels: Funnel[] }>(`/api/projects/${projectId}/funnels`)
      setFunnels(d.funnels)
      if (d.funnels.length && !active) {
        setActive(d.funnels[0])
        void analyzeFunnel(d.funnels[0])
      }
    } finally {
      setLoading(false)
    }
  }

  async function analyzeFunnel(f: Funnel) {
    setActive(f)
    setAnalyzing(true)
    setAnalyze(null)
    try {
      const d = await api<Analyze>(`/api/projects/${projectId}/funnels/${f.id}/analyze?range=${range}`)
      setAnalyze(d)
    } catch {
      toast.error("Failed to analyze funnel")
    } finally {
      setAnalyzing(false)
    }
  }

  useEffect(() => {
    void load()
  }, [projectId])

  useEffect(() => {
    if (active) void analyzeFunnel(active)
  }, [range])

  async function handleCreate() {
    if (!newName.trim() || newSteps.length < 2) {
      toast.error("Name and 2+ steps required")
      return
    }
    try {
      const { funnel } = await api<{ funnel: Funnel }>(`/api/projects/${projectId}/funnels`, {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), steps: newSteps }),
      })
      setFunnels((f) => [funnel, ...f])
      setCreateOpen(false)
      setNewName("")
      setNewSteps([{ url: "/", name: "Homepage" }])
      toast.success("Funnel created")
      void analyzeFunnel(funnel)
    } catch {
      toast.error("Failed to create funnel")
    }
  }

  async function handleDelete(f: Funnel) {
    try {
      await api(`/api/projects/${projectId}/funnels/${f.id}`, { method: "DELETE" })
      setFunnels((fs) => fs.filter((x) => x.id !== f.id))
      if (active?.id === f.id) {
        setActive(null)
        setAnalyze(null)
      }
      toast.success("Funnel deleted")
    } catch {
      toast.error("Failed to delete")
    }
  }

  // Derived summary values from the loaded analysis. Memoized so the
  // render below doesn't re-compute the lookups on every keystroke in the
  // create-funnel dialog (which is part of the same component).
  const summary = useMemo(() => {
    if (!analyze) return { firstCount: 1, lastCount: 0, overallDropoff: 0 }
    return {
      firstCount: analyze.steps[0]?.count || 1,
      lastCount: analyze.steps[analyze.steps.length - 1]?.count || 0,
      overallDropoff: 100 - analyze.completionRate,
    }
  }, [analyze])

  return (
    <div className="h-full flex">
      <div className="w-64 shrink-0 border-r border-border/60 flex flex-col">
        <div className="p-3 border-b border-border/60">
          <Button onClick={() => setCreateOpen(true)} className="w-full gap-2" size="sm">
            <Plus className="h-4 w-4" /> New funnel
          </Button>
        </div>
          <div className="flex-1 overflow-y-auto scroll-thin p-2 space-y-1">
            {loading ? (
              <div className="p-3 space-y-2">
                <Skeleton className="h-14" />
                <Skeleton className="h-14" />
              </div>
            ) : funnels.length === 0 ? (
              <div className="p-4 text-center text-xs text-muted-foreground">
                No funnels yet. Create one to measure conversion.
              </div>
            ) : (
              <ul className="space-y-1 list-none p-0 m-0">
              {funnels.map((f) => (
              <li key={f.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => analyzeFunnel(f)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      void analyzeFunnel(f)
                    }
                  }}
                  aria-current={active?.id === f.id ? "true" : undefined}
                  className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors group cursor-pointer ${
                    active?.id === f.id ? "bg-primary/15" : "hover:bg-card/40"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Filter className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
                    <span className="text-sm font-medium truncate flex-1">{f.name}</span>
                    <button
                      type="button"
                      aria-label={`Delete funnel ${f.name}`}
                      className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive p-0.5 -m-0.5"
                      onClick={(e) => { e.stopPropagation(); void handleDelete(f) }}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-1">{f.steps.length} steps</div>
                </div>
              </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin p-6">
        {!active ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select a funnel to view its conversion analysis
          </div>
        ) : analyzing ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : analyze ? (
          <div className="max-w-3xl space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">{analyze.funnel.name}</h2>
                <p className="text-sm text-muted-foreground">
                  {analyze.totalSessions} sessions entered the funnel · {analyze.completionRate}% completed
                </p>
              </div>
            </div>

            {/* Funnel steps */}
            <Card className="p-6">
              <div className="space-y-1">
                {analyze.steps.map((s, i) => {
                  const widthPct = (s.count / summary.firstCount) * 100
                  return (
                    <div key={i}>
                      <div className="flex items-center gap-3 py-2">
                        <div className="w-7 h-7 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-semibold shrink-0">
                          {i + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-sm">{s.name}</span>
                            <span className="text-xs text-muted-foreground font-mono">{s.url}</span>
                          </div>
                          <div className="mt-1.5 h-7 rounded-md bg-background/60 overflow-hidden relative">
                            <div
                              className="h-full rounded-md flex items-center px-3 transition-all"
                              style={{
                                width: `${Math.max(widthPct, 8)}%`,
                                background: i === 0
                                  ? "linear-gradient(90deg, oklch(0.72 0.16 162), oklch(0.6 0.14 180))"
                                  : i === analyze.steps.length - 1
                                  ? "linear-gradient(90deg, oklch(0.72 0.16 162), oklch(0.78 0.18 150))"
                                  : "linear-gradient(90deg, oklch(0.65 0.15 200), oklch(0.7 0.16 170))",
                              }}
                            >
                              <span className="text-xs font-semibold text-black/80">{s.count}</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-right shrink-0 w-20">
                          <div className="text-sm font-semibold">{s.rate}%</div>
                          <div className="text-[10px] text-muted-foreground">conv. rate</div>
                        </div>
                      </div>
                      {i < analyze.steps.length - 1 && (
                        <div className="flex items-center gap-2 pl-10 py-1.5">
                          <TrendingDown className="h-3 w-3 text-destructive" />
                          <span className="text-xs text-destructive">
                            {s.dropoff} dropped ({s.dropoffPct}%)
                          </span>
                          <ArrowRight className="h-3 w-3 text-muted-foreground ml-auto" />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </Card>

            <div className="grid grid-cols-3 gap-3">
              <Stat icon={<Users className="h-4 w-4" />} label="Entered" value={String(analyze.totalSessions)} />
              <Stat icon={<ArrowRight className="h-4 w-4" />} label="Completed" value={String(summary.lastCount)} />
              <Stat icon={<TrendingDown className="h-4 w-4" />} label="Overall drop-off" value={`${summary.overallDropoff}%`} />
            </div>
          </div>
        ) : null}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create funnel</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="funnel-name">Funnel name</Label>
              <Input id="funnel-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Homepage → Signup" />
            </div>
            <div className="space-y-2">
              <div className="text-sm font-medium" id="funnel-steps-label">Steps</div>
              <div className="space-y-2" role="group" aria-labelledby="funnel-steps-label">
                {newSteps.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs shrink-0" aria-hidden="true">{i + 1}</span>
                    <label htmlFor={`step-name-${i}`} className="sr-only">Step {i + 1} name</label>
                    <Input
                      id={`step-name-${i}`}
                      value={s.name}
                      onChange={(e) => setNewSteps((p) => p.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                      placeholder="Step name"
                      aria-label={`Step ${i + 1} name`}
                      className="h-8"
                    />
                    <label htmlFor={`step-url-${i}`} className="sr-only">Step {i + 1} URL path</label>
                    <Input
                      id={`step-url-${i}`}
                      value={s.url}
                      onChange={(e) => setNewSteps((p) => p.map((x, j) => j === i ? { ...x, url: e.target.value } : x))}
                      placeholder="/path"
                      aria-label={`Step ${i + 1} URL path`}
                      className="h-8 font-mono text-xs"
                    />
                    {newSteps.length > 2 && (
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setNewSteps((p) => p.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setNewSteps((p) => [...p, { url: "/", name: `Step ${p.length + 1}` }])}>
                <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add step
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create funnel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">{icon}{label}</div>
      <div className="text-xl font-semibold mt-1.5">{value}</div>
    </Card>
  )
}
