/**
 * @file src/lib/utils.ts
 *
 * Small UI-only helper module. Currently exports a single function:
 *
 * - `cn(...inputs: ClassValue[]): string` — merges conditional class names
 *   (clsx) and resolves Tailwind class conflicts (tailwind-merge). This is
 *   the standard shadcn/ui helper that every UI component in
 *   `src/components/ui/*` imports to compose `className` props safely:
 *   clsx handles conditional/short-circuit join (`cn("a", cond && "b")`),
 *   tailwind-merge dedupes conflicting Tailwind utilities so the
 *   last-write-wins rule applies (e.g. `cn("p-2", "p-4")` → `"p-4"`).
 *
 * Scope: client-side string munging only — no DB, no env reads, no I/O.
 * If a helper grows beyond class-name composition it should live in its
 * own focused module (e.g. `format.ts`, `guards.ts`) rather than accrete
 * here.
 */

import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
