# Swarm Telemetry — Round 01 / 10
**Skill:** Quantum Sovereign Swarm Kernel
**Phase:** 1 (Audit)
**Date:** 2026-11-04T14:22:13.407611Z
**Repo:** insight-replay @ v0.7.1

## Agent 1 — Injection & XSS Assassin
Total findings: 28

### dangerouslySetInnerHTML (20)
- `eslint.config.mjs:52` — `// React security rule: forbid `dangerouslySetInnerHTML` everywhere by`
- `eslint.config.mjs:58` — `// `dangerouslySetInnerHTML` usage should be caught at lint time so the`
- `docs/accessibility-audit.md:126` — `- Renders AI-generated markdown. Verify it doesn't inject `dangerouslySetInnerHTML` without sanitization (security concern, not strictly a11y). The headings it `
- `docs/doubt-review.md:188` — `- **Sanitization (Layer 6) is dead code.** ADR-0004 itself flags this. The ingest pipeline persists `payload.events[].data` JSON-stringified directly — includin`
- `docs/security-audit.md:131` — `5. **Stored XSS: protected at the sanitization layer** (when wired). HTML-escape on every persisted string means a `<script>` payload becomes `&lt;script&gt;` i`
- `docs/security-audit.md:141` — `- Long-term: enable `react/no-danger` ESLint rule to prevent future `dangerouslySetInnerHTML` usage.`
- `tests/sanitize-html.test.ts:6` — `* `dangerouslySetInnerHTML` sites (currently only `src/components/ui/chart.tsx``
- `src/lib/sanitize.ts:10` — `*    (e.g. via dangerouslySetInnerHTML or attribute interpolation). We escape`
- `src/lib/sanitize-html.ts:2` — `* Output-side HTML sanitizer for cases where `dangerouslySetInnerHTML` is`
- `src/lib/sanitize-html.ts:58` — `*    `dangerouslySetInnerHTML` is never used for arbitrary user-supplied`
- `src/lib/sanitize-html.ts:64` — `* immediately before any `dangerouslySetInnerHTML={{ __html: ... }}` site.`
- `src/lib/sanitize-html.ts:112` — `* JSX-text auto-escaping — exported so `dangerouslySetInnerHTML` consumers`
- `src/lib/sanitize-html.ts:790` — `* Sanitize an HTML string for safe insertion via `dangerouslySetInnerHTML`.`
- `src/lib/sanitize-html.ts:824` — `* the text — this is the safest possible `dangerouslySetInnerHTML` payload`
- `src/lib/sanitize-html.ts:843` — `* `dangerouslySetInnerHTML`.`
- `src/app/api/projects/route.ts:73` — `// dashboard component renders it via dangerouslySetInnerHTML.`
- `src/app/api/projects/[id]/goals/route.ts:12` — `// stored XSS even if a downstream dangerouslySetInnerHTML consumer renders`
- `src/app/api/projects/[id]/annotations/route.ts:12` — `// dangerouslySetInnerHTML consumer renders them.`
- `src/app/api/projects/[id]/sessions/[sid]/tags/route.ts:65` — `// the persisted label/color are inert even if rendered via dangerouslySetInnerHTML.`
- `src/app/api/projects/[id]/sessions/[sid]/notes/route.ts:12` — `// dangerouslySetInnerHTML consumer renders them.`

### innerHTML assignment (0)


### eval/Function (1)
- `docs/security-audit.md:157` — `7. **CSP allows `'unsafe-inline'` and `'unsafe-eval'` for `script-src`** (`next.config.ts:7`). This weakens the CSP significantly — inline scripts and `eval()` `

### SQL template literal (7)
- `src/components/app/settings-tab.tsx:60` — `await api(`/api/projects/${project.id}`, { method: "DELETE" })`
- `src/components/app/settings-tab.tsx:292` — `await api(`/api/projects/${projectId}/apikeys/${id}`, { method: "DELETE" })`
- `src/components/app/experiments-tab.tsx:131` — `await api(`/api/projects/${projectId}/experiments/${id}`, { method: "DELETE" })`
- `src/components/app/alerts-tab.tsx:143` — `await api(`/api/projects/${projectId}/alerts/${id}`, { method: "DELETE" })`
- `src/components/app/dashboards-tab.tsx:133` — `await api(`/api/projects/${projectId}/dashboards/${id}`, { method: "DELETE" })`
- `src/components/app/funnels-tab.tsx:104` — `await api(`/api/projects/${projectId}/funnels/${f.id}`, { method: "DELETE" })`
- `src/components/app/goals-tab.tsx:79` — `await api(`/api/projects/${projectId}/goals/${id}`, { method: "DELETE" })`

## Agent 2 — Auth & Authorization Guard
Total findings: 0

### jwt.verify usage (0)
No direct jwt.verify

### searchParams.get raw consumption (20)
- `src/lib/auth.ts:151` — `const q = url.searchParams.get("apikey")`
- `src/components/app/login-form.tsx:80` — `const fromParam = searchParams.get("from") || "/"`
- `src/app/api/audit/route.ts:23` — `const limitParam = req.nextUrl.searchParams.get("limit");`
- `src/app/api/download/route.ts:118` — `// no future refactor that does `searchParams.get("file")` can ever be`
- `src/app/api/projects/[id]/stats/route.ts:25` — `const rangeParam = req.nextUrl.searchParams.get("range") || "7"`
- `src/app/api/projects/[id]/ai/route.ts:139` — `const rangeParam = req.nextUrl.searchParams.get("range") || "7"`
- `src/app/api/projects/[id]/retention/route.ts:15` — `const range = req.nextUrl.searchParams.get("range") || "30"`
- `src/app/api/projects/[id]/retention/route.ts:16` — `const cohortSizeParam = req.nextUrl.searchParams.get("cohortSize") || "7"`
- `src/app/api/projects/[id]/insights/route.ts:13` — `const range = req.nextUrl.searchParams.get("range") || "7"`
- `src/app/api/projects/[id]/goals/route.ts:43` — `range: req.nextUrl.searchParams.get("range") ?? undefined,`
- `src/app/api/projects/[id]/audit/route.ts:29` — `const limitParam = req.nextUrl.searchParams.get("limit");`
- `src/app/api/projects/[id]/export/route.ts:55` — `const rangeParam = req.nextUrl.searchParams.get("range") || "7"`
- `src/app/api/projects/[id]/export/route.ts:59` — `const filter = req.nextUrl.searchParams.get("filter") || "all"`
- `src/app/api/projects/[id]/compare/route.ts:85` — `const rangeParam = req.nextUrl.searchParams.get("range") || "7"`
- `src/app/api/projects/[id]/funnels/[fid]/analyze/route.ts:41` — `const range = req.nextUrl.searchParams.get("range") || "7"`
- `src/app/api/projects/[id]/dashboards/[did]/data/route.ts:40` — `const rangeStr = req.nextUrl.searchParams.get("range") || "7"`
- `src/app/api/track/script/route.ts:109` — `const pid = req.nextUrl.searchParams.get("pid") || ""`
- `src/app/api/track/script/route.ts:110` — `const wsPort = req.nextUrl.searchParams.get("port") || "3004"`
- `src/app/api/admin/retention-stats/route.ts:64` — `const daysParam = req.nextUrl.searchParams.get("days")`
- `src/app/api/admin/retention-purge/route.ts:79` — `const daysParam = req.nextUrl.searchParams.get("days")`

## Verdict
Audit complete — surgical patches will be applied in Phase 2 (see commit).
