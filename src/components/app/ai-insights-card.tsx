"use client"

import { useEffect, useState } from "react"
import { api } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Markdown } from "./markdown"
import { Sparkles, RefreshCw, AlertCircle } from "lucide-react"

export function AiInsightsCard({ projectId, range }: { projectId: string; range: string }) {
  const [analysis, setAnalysis] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const d = await api<{ analysis: string | null; error?: string }>(
        `/api/projects/${projectId}/ai?range=${range}`
      )
      if (d.analysis) setAnalysis(d.analysis)
      else setError(d.error || "No analysis available")
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [projectId, range])

  return (
    <Card className="p-5 relative overflow-hidden">
      <div className="absolute -top-16 -right-16 h-40 w-40 rounded-full bg-primary/10 blur-3xl pointer-events-none" aria-hidden="true" />
      <div className="flex items-center justify-between mb-3 relative">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary/30 to-primary/10 flex items-center justify-center" aria-hidden="true">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h3 className="font-semibold text-sm">AI Insights</h3>
            <p className="text-[11px] text-muted-foreground">Auto-generated analysis of recent activity</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={load} disabled={loading} aria-label="Refresh AI insights">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
        </Button>
      </div>
      <div className="relative" aria-live="polite" aria-busy={loading}>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : error ? (
          <div className="flex items-start gap-2 text-sm text-muted-foreground" role="alert">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <p>Couldn't generate AI insights right now.</p>
              <p className="text-xs mt-1">{error}</p>
            </div>
          </div>
        ) : analysis ? (
          <Markdown content={analysis} />
        ) : null}
      </div>
    </Card>
  )
}
