# ADR-0003: LLM-Powered AI Features via z-ai-web-dev-sdk

## Status
Accepted (2025-01-01)

## Context
Insight Replay ships three AI-powered features:

1. **Project-level AI insights** — a card on the Overview tab that ingests the project's
   totals, top pages, breakdowns, recent frustration signals, and daily series, then
   returns a markdown analysis with sections `## Overview`, `## Key trends`,
   `## Frustration signals`, `## Top opportunities`, `## Recommended actions`.
2. **Per-session AI analysis** — an "Ask AI" button on the Recording Player that
   compiles a compact description of one session (visitor, environment, page flow, click
   targets, scroll depth, frustration signals, JS errors) and returns a markdown
   analysis with sections `## Summary`, `## What happened`, `## Pain points`,
   `## Recommendations`.
3. **Natural-language session search** — a search bar in the Recordings tab that takes
   queries like "mobile users who raged on pricing last week" and returns matching
   sessions. The LLM is used purely to convert the natural-language query into a
   structured JSON filter object, which is then translated into a Prisma `where` clause.

Forces:

- **Backend-only constraint.** The LLM provider credentials must never be exposed to the
  browser. All three features must be implemented as Next.js route handlers that call
  the LLM server-side.
- **Latency tolerance.** These are not real-time features — users click a button and wait
  1–5 seconds for a response. They are *not* on the tracking ingest path.
- **Graceful degradation.** If the LLM is unavailable (rate limit, network, bad JSON),
  the dashboard must not crash. Each feature returns `200` with an `error` field and a
  fallback UI.
- **Structured prompts.** Each feature needs a different output shape: project / session
  analysis need free-form markdown; NL search needs strict JSON. The prompts must
  constrain the model accordingly.
- **Cost / dependency.** The team is building on the z-ai-web-dev-sdk stack already
  present in `package.json`. Adding OpenAI or Anthropic would require new credentials,
  new billing, and a new vendor relationship.

## Decision
Use **`z-ai-web-dev-sdk`** as the LLM provider, imported lazily inside each route
handler via `await import("z-ai-web-dev-sdk")` so the SDK only loads server-side and
only when the route is actually called.

The three routes are:

- `GET /api/projects/[id]/ai?range=N` — project-level analysis
- `POST /api/projects/[id]/ai/session` body `{ sessionId }` — per-session analysis
- `POST /api/projects/[id]/ai-search` body `{ query, range? }` — NL search

All three follow the same defensive pattern:

```ts
try {
  const ZAIModule = await import("z-ai-web-dev-sdk")
  const ZAI = ZAIModule.default ?? (ZAIModule as unknown as { create: () => Promise<unknown> })
  const zai = await ZAI.create()
  const completion = await zai.chat.completions.create({
    messages: [
      { role: "assistant", content: SYSTEM_PROMPT },  // or "system" — backend uses "assistant"
      { role: "user", content: compiledDescriptionOrQuery },
    ],
    thinking: { type: "disabled" },
  })
  const result = completion.choices?.[0]?.message?.content ?? ""
  return NextResponse.json({ analysis: result || null })
} catch (e) {
  // Always return 200 with { analysis: null, error } so the UI can show a fallback
  return NextResponse.json(
    { analysis: null, error: String(e instanceof Error ? e.message : e) },
    { status: 200 },
  )
}
```

Key implementation choices:

- **System prompts are role-stamped as `assistant`** (the SDK's expected role for
  instructions) and contain explicit output contracts:
  - project / session analysis: "Respond in clean markdown with sections: ## …"
  - NL search: "Respond with ONLY valid JSON, no markdown, no explanation. Available
    filter fields: …" plus a worked example.
- **NL search strips markdown fences** (`\`\`\`json` / bare `\`\`\``) before
  `JSON.parse`. LLMs occasionally wrap JSON in fences despite instructions.
- **Thinking is disabled** (`thinking: { type: "disabled" }`) for both speed and cost.
- **Compiled descriptions are short.** The session description builder caps at ~2KB;
  the project description builder caps at the natural size of the aggregated stats.
- **Lazy import.** `await import("z-ai-web-dev-sdk")` keeps the SDK out of the Next.js
  client bundle and out of cold-start for non-AI routes.

## Consequences

**Positive**

- All three AI features work end-to-end with zero new infrastructure. The SDK is
  already in `package.json`, no API keys to manage.
- Lazy import means a non-AI dashboard request never pays the SDK's cold-start cost.
- The 200-on-error contract means the UI can always show a fallback message instead of
  a broken page. The recording player continues to work even if the AI button fails.
- Server-side execution means the LLM never sees anything it shouldn't, and credentials
  never reach the browser.
- NL search returning structured JSON (rather than the LLM's prose summary of the
  results) means the dashboard renders a real session list — not an LLM hallucination
  of one.

**Negative**

- **Latency.** Each AI call adds 1–5 seconds to the request. Users see a spinner. The
  project-level analysis card is the slowest because it compiles the most context.
- **Cost / quota.** Every AI button click hits the provider. There is no caching layer
  (see ADR-0005 — caching is currently scoped to stats only, not AI).
- **Backend-only constraint enforced by lazy import.** A future contributor who adds
  `import "z-ai-web-dev-sdk"` at the top of a client component would break the build.
  The defensive pattern is documented here to prevent that.
- **Hallucination risk on NL search.** If the LLM emits a filter field we don't
  recognise, it is silently ignored. If it emits a value the wrong type (e.g. `minPages:
  "five"`), the Prisma `where` clause construction silently skips it. This is by design
  — we would rather return more sessions than no sessions — but it means the search is
  best-effort, not exact.
- **No streaming.** Each route waits for the full completion before responding. The
  dashboard shows a spinner for the whole duration. A streaming response would improve
  perceived latency but would require SSE or chunked transfer, which we did not
  implement for v1.

## Alternatives Considered

### OpenAI / Anthropic API directly
- **Pros:** Industry standard, larger model selection, streaming support, function
  calling for structured output.
- **Cons:** Requires an OpenAI / Anthropic account + API key + billing setup. Adds a
  new vendor. Breaks the "self-hosted, no external services" brief for the demo.
- **Rejected for v1.** Could be added later behind a provider abstraction (the lazy
  import already isolates the SDK choice to one file).

### Local model (Ollama / llama.cpp / vLLM)
- **Pros:** No vendor, no cost per call, no quota.
- **Cons:** Requires the host machine to have a GPU and several GB of VRAM. Not viable
  for a demo running on a small box. Setup complexity is far higher than the SDK.
- **Rejected for v1.** Plausible for a self-hosted production deployment where the
  operator has the hardware.

### No AI features
- **Pros:** Zero latency, zero cost, zero dependencies.
- **Cons:** Significantly weaker product. The AI insights card is one of the most
  visible "wow" features in the demo; per-session AI analysis is a major differentiator
  vs vanilla analytics tools; NL search removes the need for users to learn a filter UI.
- **Rejected.**

### Pre-computed insights (rule-based, no LLM)
- Considered for the project-level insights card.
- **Pros:** Deterministic, instant, free.
- **Cons:** Cannot generate prose summaries or recommendations — only fixed strings like
  "Rage clicks are up 20% week-over-week." Useful, but not the same product. We do
  compute some rule-based signals (rage-click detection, dead-click detection,
  excessive-scroll detection) and surface them in the Insights tab; the LLM features
  complement those, they do not replace them.
- **Rejected as the only AI strategy.** Kept as the underlying signal layer that the
  LLM features build on top of.

### Streaming responses
- **Pros:** Better perceived latency. User sees the analysis "typing" as it streams in.
- **Cons:** Requires SSE or chunked transfer, a different client-side fetch pattern,
  and breaks the simple `{ analysis, error }` JSON contract. More complexity for a
  marginal UX win on a feature that is clicked occasionally, not constantly.
- **Rejected for v1.** Track as a future enhancement.
