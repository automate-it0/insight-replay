"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { useApp } from "@/store/app"
import type { Filters } from "@/store/app"
import { api } from "@/lib/api"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Filter,
  Monitor,
  Smartphone,
  Tablet,
  X,
  RotateCcw,
  Flame,
  MousePointerClick,
  AlertTriangle,
  Target,
  Globe,
} from "lucide-react"

interface Stats {
  device: { name: string; value: number }[]
  browser: { name: string; value: number }[]
  country: { name: string; value: number }[]
  totals: { rageClicks: number; deadClicks: number }
}

export const FilterBar = memo(function FilterBar({ projectId, range }: { projectId: string; range: string }) {
  const { filters, setFilters, resetFilters } = useApp()
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    api<Stats>(`/api/projects/${projectId}/stats?range=${range}`)
      .then(setStats)
      .catch(() => {})
  }, [projectId, range])

  const activeCount = useMemo(
    () => Object.values(filters).filter((v) => v !== undefined && v !== null && v !== "").length,
    [filters]
  )

  const toggle = (key: keyof Filters, value: Filters[keyof Filters]) => {
    const next: Filters = { ...filters }
    if (next[key] === value) {
      delete next[key]
    } else {
      // `key` is a union of optional keys, so TypeScript cannot narrow the
      // write type of `next[key]` on its own (it resolves to `never`).
      // The cast restores the dynamic write while `Filters` keeps full
      // type safety at every call site.
      ;(next as Record<string, unknown>)[key] = value
    }
    setFilters(next)
  }

  return (
    <div
      className="border-b border-border/60 px-6 py-2 flex items-center gap-2 flex-wrap bg-card/20"
      role="group"
      aria-label="Session filters"
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-hidden="true">
        <Filter className="h-3.5 w-3.5" />
        Filters
      </div>

      {/* Device filter */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" aria-label={`Filter by device${filters.device ? `: ${filters.device}` : ""}`} aria-haspopup="listbox">
            <DeviceIcon device={filters.device} />
            {filters.device || "Device"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start" role="listbox" aria-label="Device options">
          {stats?.device.map((d) => (
            <button
              key={d.name}
              onClick={() => toggle("device", d.name)}
              role="option"
              aria-selected={filters.device === d.name}
              className={`w-full flex items-center justify-between px-2 py-1.5 text-xs rounded hover:bg-accent ${
                filters.device === d.name ? "bg-primary/15 text-primary" : ""
              }`}
            >
              <span className="flex items-center gap-1.5 capitalize">
                <DeviceIcon device={d.name} />
                {d.name}
              </span>
              <span className="text-muted-foreground">{d.value}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Browser filter */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs" aria-label={`Filter by browser${filters.browser ? `: ${filters.browser}` : ""}`} aria-haspopup="listbox">
            {filters.browser || "Browser"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start" role="listbox" aria-label="Browser options">
          {stats?.browser.map((b) => (
            <button
              key={b.name}
              onClick={() => toggle("browser", b.name)}
              role="option"
              aria-selected={filters.browser === b.name}
              className={`w-full flex items-center justify-between px-2 py-1.5 text-xs rounded hover:bg-accent ${
                filters.browser === b.name ? "bg-primary/15 text-primary" : ""
              }`}
            >
              <span>{b.name}</span>
              <span className="text-muted-foreground">{b.value}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Country filter */}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" aria-label={`Filter by country${filters.country ? `: ${filters.country}` : ""}`} aria-haspopup="listbox">
            <Globe className="h-3 w-3" aria-hidden="true" />
            {filters.country || "Country"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-1 max-h-72 overflow-y-auto scroll-thin" align="start" role="listbox" aria-label="Country options">
          {stats?.country.map((c) => (
            <button
              key={c.name}
              onClick={() => toggle("country", c.name)}
              role="option"
              aria-selected={filters.country === c.name}
              className={`w-full flex items-center justify-between px-2 py-1.5 text-xs rounded hover:bg-accent ${
                filters.country === c.name ? "bg-primary/15 text-primary" : ""
              }`}
            >
              <span className="truncate">{c.name}</span>
              <span className="text-muted-foreground">{c.value}</span>
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {/* Visitor type */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => toggle("isNewVisitor", filters.isNewVisitor === true ? null : true)}
        aria-pressed={filters.isNewVisitor === true}
        className={`h-7 text-xs ${filters.isNewVisitor === true ? "bg-primary/15 text-primary border-primary/30" : ""}`}
      >
        New visitors
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => toggle("isNewVisitor", filters.isNewVisitor === false ? null : false)}
        aria-pressed={filters.isNewVisitor === false}
        className={`h-7 text-xs ${filters.isNewVisitor === false ? "bg-primary/15 text-primary border-primary/30" : ""}`}
      >
        Returning
      </Button>

      <div className="h-5 w-px bg-border mx-1" aria-hidden="true" />

      {/* Behavioral filters */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => toggle("hasRageClick", !filters.hasRageClick)}
        aria-pressed={filters.hasRageClick === true}
        className={`h-7 text-xs gap-1.5 ${filters.hasRageClick ? "bg-destructive/15 text-destructive border-destructive/30" : ""}`}
      >
        <Flame className="h-3 w-3" aria-hidden="true" /> Rage
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => toggle("hasDeadClick", !filters.hasDeadClick)}
        aria-pressed={filters.hasDeadClick === true}
        className={`h-7 text-xs gap-1.5 ${filters.hasDeadClick ? "bg-amber-500/15 text-amber-500 border-amber-500/30" : ""}`}
      >
        <MousePointerClick className="h-3 w-3" aria-hidden="true" /> Dead
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => toggle("hasError", !filters.hasError)}
        aria-pressed={filters.hasError === true}
        className={`h-7 text-xs gap-1.5 ${filters.hasError ? "bg-red-500/15 text-red-400 border-red-500/30" : ""}`}
      >
        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Errors
      </Button>

      <Button
        variant="outline"
        size="sm"
        onClick={() => toggle("convertedGoal", filters.convertedGoal ? "" : "any")}
        aria-pressed={filters.convertedGoal === "any"}
        className={`h-7 text-xs gap-1.5 ${filters.convertedGoal ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : ""}`}
      >
        <Target className="h-3 w-3" aria-hidden="true" /> Converted
      </Button>

      {activeCount > 0 && (
        <Button variant="ghost" size="sm" onClick={resetFilters} className="h-7 text-xs gap-1.5 ml-auto" aria-label={`Clear all filters (${activeCount} active)`}>
          <RotateCcw className="h-3 w-3" aria-hidden="true" /> Clear ({activeCount})
        </Button>
      )}

      {activeCount > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          {filters.device && (
            <Badge variant="secondary" className="text-[10px] gap-1">
              {filters.device}
              <button type="button" onClick={() => toggle("device", filters.device)} aria-label={`Remove ${filters.device} device filter`} className="inline-flex items-center">
                <X className="h-2.5 w-2.5" aria-hidden="true" />
              </button>
            </Badge>
          )}
          {filters.browser && (
            <Badge variant="secondary" className="text-[10px] gap-1">
              {filters.browser}
              <button type="button" onClick={() => toggle("browser", filters.browser)} aria-label={`Remove ${filters.browser} browser filter`} className="inline-flex items-center">
                <X className="h-2.5 w-2.5" aria-hidden="true" />
              </button>
            </Badge>
          )}
          {filters.country && (
            <Badge variant="secondary" className="text-[10px] gap-1">
              {filters.country}
              <button type="button" onClick={() => toggle("country", filters.country)} aria-label={`Remove ${filters.country} country filter`} className="inline-flex items-center">
                <X className="h-2.5 w-2.5" aria-hidden="true" />
              </button>
            </Badge>
          )}
          {filters.isNewVisitor !== null && filters.isNewVisitor !== undefined && (
            <Badge variant="secondary" className="text-[10px] gap-1">
              {filters.isNewVisitor ? "New" : "Returning"}
              <button type="button" onClick={() => toggle("isNewVisitor", filters.isNewVisitor)} aria-label={`Remove ${filters.isNewVisitor ? "new" : "returning"} visitor filter`} className="inline-flex items-center">
                <X className="h-2.5 w-2.5" aria-hidden="true" />
              </button>
            </Badge>
          )}
        </div>
      )}
    </div>
  )
})

function DeviceIcon({ device }: { device?: string | undefined }) {
  if (device === "mobile") return <Smartphone className="h-3 w-3" aria-hidden="true" />
  if (device === "tablet") return <Tablet className="h-3 w-3" aria-hidden="true" />
  return <Monitor className="h-3 w-3" aria-hidden="true" />
}
