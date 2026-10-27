"use client"

import { memo, useEffect, useMemo, useState } from "react"
import { api } from "@/lib/api"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { toast } from "sonner"
import { Copy, Check, Code2, Trash2, KeyRound, Hash, Link2, Plus, Eye, EyeOff } from "lucide-react"
import { useApp } from "@/store/app"

interface Project {
  id: string
  name: string
  siteUrl: string
  trackingId: string
  createdAt: string
}

export const SettingsTab = memo(function SettingsTab({ project }: { project: Project }) {
  const [copied, setCopied] = useState(false)
  const { goHome } = useApp()

  // Tracking snippet string derived from the project id + the current window
  // origin. Memoized so the pre/textarea below doesn't change identity on
  // every re-render (e.g. when the copied state flips).
  const snippet = useMemo(
    () => `<!-- Insight Replay tracking snippet -->
<script async src="${typeof window !== "undefined" ? window.location.origin : "https://your-host"}/api/track/script.js?pid=${project.id}&port=3004"></script>`,
    [project.id]
  )

  const copy = () => {
    void navigator.clipboard.writeText(snippet)
    setCopied(true)
    toast.success("Snippet copied to clipboard")
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleDelete() {
    try {
      await api(`/api/projects/${project.id}`, { method: "DELETE" })
      toast.success("Project deleted")
      goHome()
    } catch {
      toast.error("Failed to delete project")
    }
  }

  return (
    <div className="h-full overflow-y-auto scroll-thin p-6 max-w-3xl space-y-5">
      <Card className="p-5">
        <h3 className="font-semibold text-sm mb-4">Project details</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="settings-project-name">Project name</Label>
            <Input id="settings-project-name" value={project.name} readOnly className="bg-background/40" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-site-url">Site URL</Label>
            <Input id="settings-site-url" value={project.siteUrl || "—"} readOnly className="bg-background/40" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-project-id" className="flex items-center gap-1"><Hash className="h-3 w-3" aria-hidden="true" /> Project ID</Label>
            <Input id="settings-project-id" value={project.id} readOnly className="bg-background/40 font-mono text-xs" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-tracking-id" className="flex items-center gap-1"><KeyRound className="h-3 w-3" aria-hidden="true" /> Tracking ID</Label>
            <Input id="settings-tracking-id" value={project.trackingId} readOnly className="bg-background/40 font-mono text-xs" />
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-1">
          <Code2 className="h-4 w-4 text-primary" aria-hidden="true" />
          <h3 className="font-semibold text-sm">Install the tracking snippet</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Paste this snippet into the <code className="text-foreground">&lt;head&gt;</code> of every
          page you want to track. It captures mouse moves, clicks, scrolls, keystrokes and page
          views — and streams live activity to the dashboard.
        </p>
        <div className="relative rounded-lg bg-black/40 border border-border/60 overflow-hidden">
          <pre className="p-4 text-xs font-mono text-emerald-300 overflow-x-auto scroll-thin whitespace-pre-wrap break-all">
            {snippet}
          </pre>
          <Button
            size="sm"
            variant="secondary"
            className="absolute top-2 right-2 gap-1.5"
            onClick={copy}
            aria-label="Copy tracking snippet"
          >
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <div className="mt-4 grid sm:grid-cols-3 gap-2 text-xs">
          <Feature label="Session recordings" desc="Replay any visitor click-by-click" />
          <Feature label="Click & move heatmaps" desc="Density-mapped visual overlays" />
          <Feature label="Real-time live view" desc="Watch active visitors instantly" />
        </div>
      </Card>

      <UtmBuilder />
      <ApiKeysSection projectId={project.id} />

      <Card className="p-5 border-destructive/30">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
              Delete project
            </h3>
            <p className="text-xs text-muted-foreground mt-1">
              Permanently remove this project and all its sessions, events and insights.
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm">
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {project.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete all session recordings, heatmaps data and insights
                  for this project. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete project
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </Card>
    </div>
  )
})

function Feature({ label, desc }: { label: string; desc: string }) {
  return (
    <div className="rounded-lg bg-background/40 p-3 border border-border/40">
      <div className="font-medium text-foreground">{label}</div>
      <div className="text-muted-foreground mt-0.5">{desc}</div>
    </div>
  )
}

function UtmBuilder() {
  const [url, setUrl] = useState("")
  const [source, setSource] = useState("")
  const [medium, setMedium] = useState("")
  const [campaign, setCampaign] = useState("")
  const [term, setTerm] = useState("")
  const [content, setContent] = useState("")
  const [copied, setCopied] = useState(false)

  const built = (() => {
    try {
      const u = new URL(url || "https://example.com")
      if (source) u.searchParams.set("utm_source", source)
      if (medium) u.searchParams.set("utm_medium", medium)
      if (campaign) u.searchParams.set("utm_campaign", campaign)
      if (term) u.searchParams.set("utm_term", term)
      if (content) u.searchParams.set("utm_content", content)
      return u.toString()
    } catch {
      return ""
    }
  })()

  const copy = () => {
    if (!built) return
    void navigator.clipboard.writeText(built)
    setCopied(true)
    toast.success("UTM link copied")
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-1">
        <Link2 className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="font-semibold text-sm">UTM link builder</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-4">Generate tagged campaign URLs for attribution tracking.</p>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="utm-url">Destination URL</Label>
          <Input id="utm-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yoursite.com/landing" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="utm-source">utm_source *</Label>
          <Input id="utm-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder="google, newsletter, twitter" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="utm-medium">utm_medium</Label>
          <Input id="utm-medium" value={medium} onChange={(e) => setMedium(e.target.value)} placeholder="cpc, email, social" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="utm-campaign">utm_campaign</Label>
          <Input id="utm-campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="spring_sale" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="utm-term">utm_term</Label>
          <Input id="utm-term" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="optional" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="utm-content">utm_content</Label>
          <Input id="utm-content" value={content} onChange={(e) => setContent(e.target.value)} placeholder="optional" />
        </div>
      </div>
      {built && (
        <div className="mt-4 relative rounded-lg bg-black/40 border border-border/60 overflow-hidden">
          <pre className="p-3 text-xs font-mono text-emerald-300 overflow-x-auto scroll-thin whitespace-pre-wrap break-all">{built}</pre>
          <Button size="sm" variant="secondary" className="absolute top-2 right-2 gap-1.5" onClick={copy} aria-label="Copy UTM link">
            {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
    </Card>
  )
}

function ApiKeysSection({ projectId }: { projectId: string }) {
  const [keys, setKeys] = useState<{ id: string; name: string; key?: string; keyMasked?: string; createdAt: string; lastUsed: string | null }[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState("")
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})

  async function load() {
    setLoading(true)
    try {
      const d = await api<{ apiKeys: { id: string; name: string; keyMasked: string; createdAt: string; lastUsed: string | null }[] }>(`/api/projects/${projectId}/apikeys`)
      setKeys(d.apiKeys || [])
    } catch {} finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [projectId])

  async function create() {
    if (!newName.trim()) {
      toast.error("Name required")
      return
    }
    try {
      const d = await api<{ apiKey: { id: string; name: string; key: string; keyMasked: string; createdAt: string; lastUsed: null } }>(`/api/projects/${projectId}/apikeys`, {
        method: "POST",
        body: JSON.stringify({ name: newName.trim() }),
      })
      setKeys((k) => [{ ...d.apiKey }, ...k])
      setRevealed({ [d.apiKey.id]: true })
      setNewName("")
      toast.success("API key created — copy it now, it won't be shown again")
    } catch { toast.error("Failed to create key") }
  }

  async function remove(id: string) {
    try {
      await api(`/api/projects/${projectId}/apikeys/${id}`, { method: "DELETE" })
      setKeys((k) => k.filter((x) => x.id !== id))
      toast.success("Key revoked")
    } catch {}
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="font-semibold text-sm">API keys</h3>
      </div>
      <p className="text-xs text-muted-foreground mb-4">Access project data programmatically via the REST API.</p>

      <div className="flex gap-2 mb-4">
        <label htmlFor="new-api-key-name" className="sr-only">New API key name</label>
        <Input id="new-api-key-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Key name (e.g. Data pipeline)" aria-label="New API key name" className="h-9" onKeyDown={(e) => e.key === "Enter" && create()} />
        <Button size="sm" className="gap-1.5" onClick={create}><Plus className="h-3.5 w-3.5" aria-hidden="true" /> Create</Button>
      </div>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : keys.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">No API keys yet.</div>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => {
            const display = revealed[k.id] && k.key ? k.key : (k.keyMasked || "ir_••••")
            return (
              <div key={k.id} className="flex items-center gap-3 rounded-lg border border-border/50 p-3">
                <KeyRound className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{k.name}</div>
                  <div className="text-xs font-mono text-muted-foreground flex items-center gap-1">
                    <span aria-label={`API key value: ${display}`}>{display}</span>
                    {k.key && (
                      <button
                        type="button"
                        onClick={() => setRevealed((r) => ({ ...r, [k.id]: !r[k.id] }))}
                        className="text-muted-foreground hover:text-primary"
                        aria-label={revealed[k.id] ? `Hide ${k.name} API key` : `Reveal ${k.name} API key`}
                        aria-pressed={revealed[k.id]}
                      >
                        {revealed[k.id] ? <EyeOff className="h-3 w-3" aria-hidden="true" /> : <Eye className="h-3 w-3" aria-hidden="true" />}
                      </button>
                    )}
                  </div>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(k.id)} aria-label={`Revoke API key ${k.name}`}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
