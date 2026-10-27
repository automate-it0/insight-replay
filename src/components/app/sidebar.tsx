"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { useApp } from "@/store/app"
import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import {
  Activity,
  Plus,
  Globe,
  Monitor,
  FlaskConical,
  ChevronRight,
  Menu,
} from "lucide-react"
import { DemoSiteDialog } from "./demo-site-dialog"

interface Project {
  id: string
  name: string
  siteUrl: string
  trackingId: string
  createdAt: string
  _count?: { sessions: number }
}

export const Sidebar = memo(function Sidebar() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [demoOpen, setDemoOpen] = useState(false)
  const [demoProjectId, setDemoProjectId] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const { view, activeProjectId, openProject, goHome } = useApp()

  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ projectId: string }>
      setDemoProjectId(ce.detail?.projectId || activeProjectId)
      setDemoOpen(true)
    }
    window.addEventListener("open-demo-site", handler)
    return () => window.removeEventListener("open-demo-site", handler)
  }, [activeProjectId])

  async function load() {
    try {
      const data = await api<{ projects: Project[] }>("/api/projects")
      setProjects(data.projects)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function handleCreate() {
    if (!name.trim()) {
      toast.error("Project name required")
      return
    }
    try {
      const { project } = await api<{ project: Project }>("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), siteUrl: url.trim() }),
      })
      setProjects((p) => [project, ...p])
      setCreateOpen(false)
      setName("")
      setUrl("")
      toast.success("Project created")
      openProject(project.id)
    } catch {
      toast.error("Failed to create project")
    }
  }

  const openProj = (id: string) => {
    openProject(id)
    setMobileOpen(false)
  }
  const goHomeClose = () => {
    goHome()
    setMobileOpen(false)
  }
  const openDemo = () => {
    setDemoProjectId(activeProjectId)
    setDemoOpen(true)
    setMobileOpen(false)
  }

  // Memoize the SidebarContent JSX so it isn't rebuilt on every Sidebar
  // re-render (e.g. when the create-project dialog opens). Deps capture every
  // value the element tree closes over — projects, loading, view,
  // activeProjectId, and the context actions openProject/goHome (assumed
  // stable from the store). Setters from useState are stable by contract.
  const content = useMemo(
    () => (
      <SidebarContent
        projects={projects}
        loading={loading}
        view={view}
        activeProjectId={activeProjectId}
        onHome={goHomeClose}
        onOpen={openProj}
        onNew={() => setCreateOpen(true)}
        onDemo={openDemo}
      />
    ),
    // openProj / goHomeClose / openDemo are recreated each render; their
    // meaningful dependencies are captured here so the memo invalidates
    // exactly when SidebarContent's props would actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projects, loading, view, activeProjectId, openProject, goHome, setCreateOpen, setDemoProjectId, setDemoOpen, setMobileOpen]
  )

  return (
    <>
      {/* Mobile top bar */}
      <div className="md:hidden flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-sidebar shrink-0">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open navigation menu">
              <Menu className="h-4 w-4" aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0 bg-sidebar border-r border-border/60">
            {content}
          </SheetContent>
        </Sheet>
        <button onClick={goHome} className="flex items-center gap-2" aria-label="Insight Replay home">
          <div className="relative h-7 w-7 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center" aria-hidden="true">
            <Activity className="h-4 w-4 text-primary" />
          </div>
          <span className="text-sm font-semibold text-gradient">Insight Replay</span>
        </button>
      </div>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 shrink-0 border-r border-border/60 bg-sidebar flex-col" aria-label="Project navigation">
        {content}
      </aside>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create a new project</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="pname">Project name</Label>
              <Input
                id="pname"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Marketing Site"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="purl">Site URL (optional)</Label>
              <Input
                id="purl"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://acme.example.com"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate}>Create project</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DemoSiteDialog
        open={demoOpen}
        onOpenChange={setDemoOpen}
        projects={projects}
        onCreated={load}
        overrideProjectId={demoProjectId}
      />
    </>
  )
})

function SidebarContent({
  projects,
  loading,
  view,
  activeProjectId,
  onHome,
  onOpen,
  onNew,
  onDemo,
}: {
  projects: Project[]
  loading: boolean
  view: string
  activeProjectId: string | null
  onHome: () => void
  onOpen: (id: string) => void
  onNew: () => void
  onDemo: () => void
}) {
  return (
    <>
      <div className="px-5 py-5 border-b border-border/60">
        <button onClick={onHome} className="flex items-center gap-2.5 group" aria-label="Insight Replay home">
          <div className="relative h-9 w-9 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center" aria-hidden="true">
            <Activity className="h-5 w-5 text-primary" />
            <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-primary pulse-ring" />
          </div>
          <div className="text-left">
            <div className="text-sm font-semibold leading-tight text-gradient">
              Insight Replay
            </div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">
              Behavioral Analytics
            </div>
          </div>
        </button>
      </div>

      <div className="px-3 py-3">
        <Button
          onClick={onNew}
          className="w-full justify-start gap-2 bg-primary/15 text-primary hover:bg-primary/25 border border-primary/30"
          variant="ghost"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          New Project
        </Button>
      </div>

      <nav aria-label="Projects list" className="flex-1 flex flex-col min-h-0">
        <div className="px-5 pb-1 pt-2">
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Projects
          </div>
        </div>

        <ScrollArea className="flex-1 px-2">
          <ul className="space-y-0.5 py-1 list-none p-0 m-0">
            {loading ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">Loading…</li>
            ) : projects.length === 0 ? (
              <li className="px-3 py-3 text-xs text-muted-foreground">
                No projects yet. Create one to start tracking.
              </li>
            ) : (
              projects.map((p) => {
                const active = view === "project" && activeProjectId === p.id
                return (
                  <li key={p.id}>
                    <button
                      onClick={() => onOpen(p.id)}
                      aria-current={active ? "page" : undefined}
                      className={`w-full text-left px-3 py-2 rounded-lg transition-colors group flex items-start gap-2.5 ${
                        active
                          ? "bg-primary/15 text-foreground"
                          : "hover:bg-sidebar-accent text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Globe
                        className={`h-4 w-4 mt-0.5 shrink-0 ${
                          active ? "text-primary" : "text-muted-foreground"
                        }`}
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">{p.name}</div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <Monitor className="h-3 w-3" aria-hidden="true" />
                          {p._count?.sessions ?? 0} sessions
                        </div>
                      </div>
                      {active && <ChevronRight className="h-4 w-4 text-primary mt-0.5" aria-hidden="true" />}
                    </button>
                  </li>
                )
              })
            )}
          </ul>
        </ScrollArea>
      </nav>

      <div className="border-t border-border/60 p-3 space-y-1">
        <button
          onClick={onDemo}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-sidebar-accent transition-colors"
        >
          <FlaskConical className="h-4 w-4" aria-hidden="true" />
          Try the Demo Site
          <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-primary/15 text-primary">
            live
          </span>
        </button>
      </div>
    </>
  )
}
