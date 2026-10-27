"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { Target, Plus, Trash2, TrendingUp, DollarSign } from "lucide-react"

interface Goal {
  id: string
  name: string
  type: string
  match: string
  url: string
  eventName: string
  value: number
  conversions?: number
  conversionRate?: number
}

export const GoalsTab = memo(function GoalsTab({ projectId, range }: { projectId: string; range: string }) {
  const [goals, setGoals] = useState<Goal[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [newUrl, setNewUrl] = useState("")
  const [newMatch, setNewMatch] = useState("equals")
  const [newValue, setNewValue] = useState("0")

  async function load() {
    setLoading(true)
    try {
      const d = await api<{ goals: Goal[] }>(`/api/projects/${projectId}/goals?range=${range}`)
      setGoals(d.goals)
    } catch {
      setGoals([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [projectId, range])

  async function handleCreate() {
    if (!newName.trim() || !newUrl.trim()) {
      toast.error("Name and URL required")
      return
    }
    try {
      await api(`/api/projects/${projectId}/goals`, {
        method: "POST",
        body: JSON.stringify({ name: newName, type: "url", match: newMatch, url: newUrl, value: parseFloat(newValue) || 0 }),
      })
      setCreateOpen(false)
      setNewName(""); setNewUrl(""); setNewMatch("equals"); setNewValue("0")
      toast.success("Goal created")
      void load()
    } catch {
      toast.error("Failed to create goal")
    }
  }

  async function handleDelete(id: string) {
    try {
      await api(`/api/projects/${projectId}/goals/${id}`, { method: "DELETE" })
      setGoals((g) => g.filter((x) => x.id !== id))
      toast.success("Goal deleted")
    } catch {
      toast.error("Failed to delete")
    }
  }

  const { totalConversions, totalValue, avgRate, maxConversions } = useMemo(() => {
    const totalConversions = goals.reduce((a, g) => a + (g.conversions || 0), 0)
    const totalValue = goals.reduce((a, g) => a + (g.conversions || 0) * g.value, 0)
    const avgRate = goals.length ? goals.reduce((a, g) => a + (g.conversionRate || 0), 0) / goals.length : 0
    const maxConversions = Math.max(...goals.map((x) => x.conversions || 0), 1)
    return { totalConversions, totalValue, avgRate, maxConversions }
  }, [goals])

  return (
    <div className="h-full overflow-y-auto scroll-thin p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-semibold">Goals & conversions</h2>
            <p className="text-xs text-muted-foreground">Track URL-based conversion goals</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2" size="sm">
          <Plus className="h-4 w-4" aria-hidden="true" /> New goal
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Card className="p-4">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Target className="h-3.5 w-3.5" /> Total conversions
          </div>
          <div className="text-2xl font-semibold mt-1.5">{totalConversions}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <DollarSign className="h-3.5 w-3.5" /> Estimated value
          </div>
          <div className="text-2xl font-semibold mt-1.5">${totalValue.toFixed(0)}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" /> Avg conversion rate
          </div>
          <div className="text-2xl font-semibold mt-1.5">{avgRate.toFixed(1)}%</div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="px-5 py-3 border-b border-border/60">
          <h3 className="font-semibold text-sm">Goals</h3>
        </div>
        {loading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
          </div>
        ) : goals.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No goals yet. Create a goal to track conversions.
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {goals.map((g) => (
              <div key={g.id} className="px-5 py-4 flex items-center gap-4 group">
                <div className="h-10 w-10 rounded-lg bg-emerald-500/15 flex items-center justify-center shrink-0">
                  <Target className="h-4 w-4 text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-sm">{g.name}</div>
                  <div className="text-xs text-muted-foreground font-mono mt-0.5">
                    {g.match} "{g.url}" · ${g.value} value
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-background/60 overflow-hidden">
                    <div className="h-full bg-emerald-500/60 rounded-full" style={{ width: `${((g.conversions || 0) / maxConversions) * 100}%` }} />
                  </div>
                </div>
                <div className="text-right shrink-0 w-24">
                  <div className="text-lg font-semibold">{g.conversions || 0}</div>
                  <div className="text-[11px] text-muted-foreground">{(g.conversionRate || 0).toFixed(1)}% rate</div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 opacity-0 group-hover:opacity-100"
                  onClick={() => handleDelete(g.id)}
                  aria-label={`Delete goal ${g.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create goal</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="goal-name">Goal name</Label>
              <Input id="goal-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Signup" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="goal-match">Match type</Label>
                <Select value={newMatch} onValueChange={setNewMatch}>
                  <SelectTrigger id="goal-match"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="equals">Equals</SelectItem>
                    <SelectItem value="contains">Contains</SelectItem>
                    <SelectItem value="startsWith">Starts with</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="goal-value">Value ($)</Label>
                <Input id="goal-value" value={newValue} onChange={(e) => setNewValue(e.target.value)} type="number" placeholder="0" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="goal-url">URL</Label>
              <Input id="goal-url" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="/signup" className="font-mono text-sm" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate}>Create goal</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
