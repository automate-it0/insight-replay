import { create } from "zustand"

export type View = "dashboard" | "project"
export type Tab =
  | "overview"
  | "dashboards"
  | "recordings"
  | "heatmaps"
  | "live"
  | "funnels"
  | "journeys"
  | "experiments"
  | "visitors"
  | "retention"
  | "goals"
  | "alerts"
  | "insights"
  | "errors"
  | "settings"
export type Range = "1" | "7" | "30"

export interface Filters {
  device?: string
  browser?: string
  country?: string
  utmSource?: string
  isNewVisitor?: boolean | null
  hasRageClick?: boolean
  hasDeadClick?: boolean
  hasError?: boolean
  convertedGoal?: string
}

interface AppState {
  view: View
  activeProjectId: string | null
  tab: Tab
  range: Range
  filters: Filters
  setView: (v: View) => void
  openProject: (id: string) => void
  setTab: (t: Tab) => void
  setRange: (r: Range) => void
  setFilters: (f: Filters) => void
  resetFilters: () => void
  goHome: () => void
}

export const useApp = create<AppState>((set) => ({
  view: "dashboard",
  activeProjectId: null,
  tab: "overview",
  range: "7",
  filters: {},
  setView: (view) => set({ view }),
  openProject: (id) => set({ view: "project", activeProjectId: id, tab: "overview", filters: {} }),
  setTab: (tab) => set({ tab }),
  setRange: (range) => set({ range }),
  setFilters: (filters) => set({ filters }),
  resetFilters: () => set({ filters: {} }),
  goHome: () => set({ view: "dashboard", activeProjectId: null, filters: {} }),
}))
