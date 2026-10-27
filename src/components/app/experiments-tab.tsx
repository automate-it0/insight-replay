"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { api, fmtRelative } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { FlaskConical, Plus, Trash2, Trophy, TrendingUp, TrendingDown, Users, Target, Sparkles } from "lucide-react"

interface Variant {
  name: string
  weight: number
  description: string
}
interface Experiment {
  id: string
  name: string
  hypothesis: string
  variants: Variant[]
  goalName: string
  status: string
  startDate: string
  endDate: string | null
}
interface Analysis {
  experiment: Experiment
  variants: {
    name: string
    description: string
    sessions: number
    conversions: number
    conversionRate: number
    avgDuration: number
    z: number
    pValue: number
    significant: boolean
    lift: number
  }[]
  winner: string | null
  isSignificant: boolean
  totalSessions: number
}

export const ExperimentsTab = memo(function ExperimentsTab({ projectId, range }: { projectId: string; range: string }) {
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [active, setActive] = useState<Experiment | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState({ name: "", hypothesis: "", goalName: "signup" })

  async function load() {
    setLoading(true)
    try {
      const d = await api<{ experiments: Experiment[] }>(`/api/projects/${projectId}/experiments`)
      setExperiments(d.experiments)
      if (d.experiments.length && !active) {
        setActive(d.experiments[0])
        void analyze(d.experiments[0])
      }
    } catch {
      setExperiments([])
    } finally {
      setLoading(false)
    }
  }

  async function analyze(exp: Experiment) {
    setActive(exp)
    setAnalyzing(true)
    setAnalysis(null)
    try {
      const d = await api<Analysis>(`/api/projects/${projectId}/experiments/${exp.id}/analyze`)
      setAnalysis(d)
    } catch {
      toast.error("Failed to analyze experiment")
    } finally {
      setAnalyzing(false)
    }
  }

  useEffect(() => { void load() }, [projectId])
  useEffect(() => { if (active) void analyze(active) }, [range])

  async function handleCreate() {
    if (!form.name.trim()) {
      toast.error("Name required")
      return
    }
    try {
      const { experiment } = await api<{ experiment: Experiment }>(`/api/projects/${projectId}/experiments`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          hypothesis: form.hypothesis.trim(),
          goalName: form.goalName,
          variants: [
            { name: "control", weight: 50, description: "Current version" },
            { name: "variant_a", weight: 50, description: "Test variant" },
          ],
          status: "running",
        }),
      })
      setExperiments((e) => [experiment, ...e])
      setCreateOpen(false)
      setForm({ name: "", hypothesis: "", goalName: "signup" })
      toast.success("Experiment created")
      void analyze(experiment)
    } catch {
      toast.error("Failed to create experiment")
    }
  }

  async function removeExp(id: string) {
    try {
      await api(`/api/projects/${projectId}/experiments/${id}`, { method: "DELETE" })
      setExperiments((e) => e.filter((x) => x.id !== id))
      if (active?.id === id) { setActive(null); setAnalysis(null) }
    } catch {}
  }

  async function setStatus(exp: Experiment, status: string) {
    try {
      await api(`/api/projects/${projectId}/experiments/${exp.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, endDate: status === "completed" ? new Date().toISOString() : null }),
      })
      setExperiments((e) => e.map((x) => (x.id === exp.id ? { ...x, status } : x)))
      if (active?.id === exp.id) setActive({ ...exp, status })
      toast.success(`Experiment ${status}`)
    } catch {}
  }

  // Derive per-variant display data (winner flag, control flag) plus the
  // grid-template-columns string in one pass. Memoized on `analysis` so the
  // lookups don't re-run on every keystroke in the create-experiment dialog.
  const variantRows = useMemo(() => {
    if (!analysis) return []
    return analysis.variants.map((v, i) => ({
      variant: v,
      isWinner: analysis.winner === v.name,
      isControl: i === 0,
    }))
  }, [analysis])
  const gridTemplateColumns = useMemo(
    () => (analysis ? `repeat(${analysis.variants.length}, 1fr)` : undefined),
    [analysis]
  )

  return (
    <div className="h-full flex">
      <div className="w-64 shrink-0 border-r border-border/60 flex flex-col">
        <div className="p-3 border-b border-border/60">
          <Button onClick={() => setCreateOpen(true)} className="w-full gap-2" size="sm">
            <Plus className="h-4 w-4" aria-hidden="true" /> New experiment
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto scroll-thin p-2 space-y-1">
          {loading ? (
            <div className="p-3 space-y-2"><Skeleton className="h-14" /><Skeleton className="h-14" /></div>
          ) : experiments.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">No experiments yet.</div>
          ) : (
            experiments.map((e) => (
              <div
                key={e.id}
                role="button"
                tabIndex={0}
                onClick={() => analyze(e)}
                aria-pressed={active?.id === e.id}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault()
                    void analyze(e)
                  }
                }}
                aria-label={`Analyze experiment ${e.name}`}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors group cursor-pointer ${
                  active?.id === e.id ? "bg-primary/15" : "hover:bg-card/40"
                }`}
              >
                <div className="flex items-center gap-2">
                  <FlaskConical className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
                  <span className="text-sm font-medium truncate flex-1">{e.name}</span>
                  <button
                    type="button"
                    aria-label={`Delete experiment ${e.name}`}
                    className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive p-0.5 -m-0.5"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      void removeExp(e.id)
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  <Badge variant={e.status === "running" ? "default" : e.status === "completed" ? "secondary" : "outline"} className="text-[9px]">
                    {e.status}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">{e.variants.length} variants</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin p-6">
        {!active ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
            Select or create an experiment
          </div>
        ) : analyzing ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : analysis ? (
          <div className="max-w-4xl space-y-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold">{analysis.experiment.name}</h2>
                  <Badge variant={analysis.experiment.status === "running" ? "default" : "secondary"}>
                    {analysis.experiment.status}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1 max-w-2xl">{analysis.experiment.hypothesis}</p>
                <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><Target className="h-3 w-3" /> Goal: {analysis.experiment.goalName}</span>
                  <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {analysis.totalSessions} sessions</span>
                  <span>Started {fmtRelative(analysis.experiment.startDate)}</span>
                </div>
              </div>
              {analysis.experiment.status === "running" && (
                <Button variant="outline" size="sm" onClick={() => setStatus(active, "completed")}>End experiment</Button>
              )}
            </div>

            {/* Significance banner */}
            {analysis.isSignificant && analysis.winner ? (
              <Card className="p-5 border-emerald-500/40 bg-emerald-500/5">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                    <Trophy className="h-5 w-5 text-emerald-400" />
                  </div>
                  <div>
                    <div className="font-semibold text-sm">We have a winner! 🎉</div>
                    <div className="text-xs text-muted-foreground">
                      Variant <span className="font-mono text-emerald-400">{analysis.winner}</span> is statistically significant (p &lt; 0.05)
                    </div>
                  </div>
                </div>
              </Card>
            ) : (
              <Card className="p-5 border-amber-500/30 bg-amber-500/5">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                    <Sparkles className="h-5 w-5 text-amber-400" />
                  </div>
                  <div>
                    <div className="font-semibold text-sm">Not yet significant</div>
                    <div className="text-xs text-muted-foreground">Keep collecting data — need more sessions to reach statistical significance.</div>
                  </div>
                </div>
              </Card>
            )}

            {/* Variant comparison */}
            <div className="grid gap-3" style={{ gridTemplateColumns }}>
              {variantRows.map(({ variant: v, isWinner, isControl }) => {
                return (
                  <Card key={v.name} className={`p-5 ${isWinner ? "border-emerald-500/50 bg-emerald-500/5" : ""}`}>
                    <div className="flex items-center gap-2 mb-3">
                      {isWinner && <Trophy className="h-4 w-4 text-emerald-400" />}
                      <span className="font-semibold text-sm">{v.name}</span>
                      {isControl && <Badge variant="outline" className="text-[9px]">control</Badge>}
                      {isWinner && <Badge className="text-[9px] bg-emerald-500/20 text-emerald-400">winner</Badge>}
                    </div>
                    <div className="text-2xl font-semibold">{v.conversionRate.toFixed(1)}%</div>
                    <div className="text-[11px] text-muted-foreground mt-0.5">conversion rate</div>
                    <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                      <div>
                        <div className="text-muted-foreground text-[10px]">Sessions</div>
                        <div className="font-medium">{v.sessions}</div>
                      </div>
                      <div>
                        <div className="text-muted-foreground text-[10px]">Conversions</div>
                        <div className="font-medium">{v.conversions}</div>
                      </div>
                    </div>
                    {!isControl && (
                      <div className="mt-3 pt-3 border-t border-border/40">
                        <div className="flex items-center gap-1.5 text-xs">
                          {v.lift >= 0 ? <TrendingUp className="h-3.5 w-3.5 text-emerald-400" /> : <TrendingDown className="h-3.5 w-3.5 text-red-400" />}
                          <span className={v.lift >= 0 ? "text-emerald-400" : "text-red-400"}>
                            {v.lift >= 0 ? "+" : ""}{v.lift.toFixed(1)}% lift
                          </span>
                          {v.significant && <Badge className="text-[9px] bg-emerald-500/20 text-emerald-400 ml-auto">p={v.pValue.toFixed(3)}</Badge>}
                        </div>
                      </div>
                    )}
                  </Card>
                )
              })}
            </div>

            {/* Variant descriptions */}
            <Card className="p-5">
              <h3 className="font-semibold text-sm mb-3">Variant details</h3>
              <div className="space-y-2">
                {analysis.variants.map((v) => (
                  <div key={v.name} className="flex items-center gap-3 text-xs">
                    <span className="font-mono w-24 shrink-0">{v.name}</span>
                    <span className="text-muted-foreground">{v.description}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        ) : null}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create experiment</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="experiment-name">Experiment name</Label>
              <Input id="experiment-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Pricing CTA color" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="experiment-hypothesis">Hypothesis</Label>
              <Textarea id="experiment-hypothesis" value={form.hypothesis} onChange={(e) => setForm({ ...form, hypothesis: e.target.value })} placeholder="Changing X will increase Y by Z%" className="min-h-[60px]" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="experiment-goal">Goal (conversion name)</Label>
              <Input id="experiment-goal" value={form.goalName} onChange={(e) => setForm({ ...form, goalName: e.target.value })} placeholder="signup" />
            </div>
            <div className="text-xs text-muted-foreground bg-background/40 p-3 rounded-lg">
              Two variants (control + variant_a) will be created with 50/50 split. Sessions are assigned deterministically by visitor ID.
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create experiment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
