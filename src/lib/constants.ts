/**
 * @file src/lib/constants.ts
 *
 * Shared application constants. Centralised here so the same magic number is
 * not duplicated across route handlers (see cluster-42-A: previously the
 * `30000` AI timeout was hard-coded in 3 separate API routes, which made it
 * easy to bump one and silently leave the others at the old value).
 */

/**
 * Hard cap on how long an AI (LLM) request is allowed to run before we give
 * up and reject the promise with `AI_TIMEOUT`.
 *
 * Why 30s:
 *  - All three AI routes (project insights, ai-search parse, session summary)
 *    wrap the LLM call in `Promise.race([completionPromise, timeoutPromise])`
 *    so a stalled/zombied SDK request can never hang the route handler
 *    indefinitely. If the LLM has not answered in 30s we assume it is stuck
 *    and fall back to a graceful "AI analysis unavailable" 200 response so
 *    the UI keeps working.
 *  - 30s is comfortably above the SDK's typical 3–8s response time for these
 *    prompts but well under Next.js' default function timeout (which on
 *    Vercel is 10s on Hobby / 60s+ on Pro; in self-hosted dev it is
 *    effectively unlimited). Picking a value much larger than 30s risks
 *    the user staring at a spinner for nearly a minute on a stuck request;
 *    picking one much smaller than 30s starts cutting off legitimate slow
 *    responses under load.
 *  - The value is expressed as `30 * 1000` (not the literal `30000`) so the
 *    unit is self-documenting and grep can still find every site that uses
 *    it via the symbol `AI_TIMEOUT_MS`.
 *
 * Consumer contract: import { AI_TIMEOUT_MS } from "@/lib/constants" and pass
 * it as the second argument to `setTimeout(..., AI_TIMEOUT_MS)` inside the
 * timeout branch of `Promise.race`.
 */
export const AI_TIMEOUT_MS = 30 * 1000
