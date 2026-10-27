"use client"

// Inspired by react-hot-toast library
//
// P41-A refactor: this file previously did
//   `import type { ToastActionElement, ToastProps } from "@/components/ui/toast"`
// — a cross-layer violation (a hook reaching into a UI component module). The
// hook is the lower-level layer; the component layer should depend on it,
// never the reverse. The toast-state logic has been extracted into a pure
// factory `createToastStore()` that returns toast state + actions, the
// removal-queue side effect has been moved out of the reducer (the reducer is
// now strictly pure), and the UI-coupled type aliases `ToastProps` /
// `ToastActionElement` are defined locally as structural subsets that stay
// compatible with the radix-based `<Toast>` rendered by the consumer
// (`@/components/ui/toaster`). The consumer keeps its own
// `@/components/ui/toast` import; the hook no longer imports it.
import * as React from "react"

// ---------------------------------------------------------------------------
// Toast types — defined locally so this hook does NOT depend on the UI layer.
//
// These are intentionally minimal structural subsets of the props accepted by
// the radix-based `<Toast>` component exported from `@/components/ui/toast`.
// TypeScript uses structural typing, so a value of `ToastProps` defined here is
// assignable to `React.ComponentPropsWithoutRef<typeof Toast>` and the spread
// `<Toast {...props} />` in `Toaster` continues to type-check. The consumer
// remains the only place that needs the real UI module — the hook no longer
// touches it.
// ---------------------------------------------------------------------------

/**
 * Minimal subset of the props accepted by the radix `<Toast>` component.
 * Keep in sync with `@/components/ui/toast` (ToastProps) — but only the keys
 * this hook ever sets or reads.
 */
export type ToastProps = {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  forceMount?: true
  variant?: "default" | "destructive" | null
  className?: string
}

/**
 * Action slot rendered inside a toast. The original alias was
 * `React.ReactElement<typeof ToastAction>` from the UI module; here we widen it
 * to a plain `React.ReactElement` so the hook stays UI-agnostic. The actual
 * `<ToastAction>` element produced by the consumer is structurally a
 * `React.ReactElement`, so consumer-supplied actions remain assignable.
 */
export type ToastActionElement = React.ReactElement

export type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
}

// ---------------------------------------------------------------------------
// Reducer types + pure reducer (no side effects)
// ---------------------------------------------------------------------------

const TOAST_LIMIT = 1
const TOAST_REMOVE_DELAY = 1000000

const actionTypes = {
  ADD_TOAST: "ADD_TOAST",
  UPDATE_TOAST: "UPDATE_TOAST",
  DISMISS_TOAST: "DISMISS_TOAST",
  REMOVE_TOAST: "REMOVE_TOAST",
} as const

let count = 0

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}

type ActionType = typeof actionTypes

type Action =
  | {
    type: ActionType["ADD_TOAST"]
    toast: ToasterToast
  }
  | {
    type: ActionType["UPDATE_TOAST"]
    toast: Partial<ToasterToast>
  }
  | {
    type: ActionType["DISMISS_TOAST"]
    // `| undefined` is explicit (rather than just `?`) so that callers may pass
    // an `undefined` value (not just omit the key) when dismissing all toasts.
    // Required for `exactOptionalPropertyTypes: true` — see tsconfig.json.
    toastId?: ToasterToast["id"] | undefined
  }
  | {
    type: ActionType["REMOVE_TOAST"]
    toastId?: ToasterToast["id"] | undefined
  }

interface State {
  toasts: ToasterToast[]
}

/**
 * Pure reducer. The original implementation scheduled a removal-queue timer
 * as a side effect inside the `DISMISS_TOAST` branch; that side effect has been
 * hoisted into the store's `dispatch` (see `createToastStore` below) so the
 * reducer is now strictly `(state, action) -> state` and trivially testable.
 */
export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "ADD_TOAST":
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      }

    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      }

    case "DISMISS_TOAST": {
      const { toastId } = action
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
              ...t,
              open: false,
            }
            : t
        ),
      }
    }
    case "REMOVE_TOAST":
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        }
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      }
  }
}

// ---------------------------------------------------------------------------
// Toast store — pure factory returning toast state + actions.
//
// `createToastStore()` is "pure" in the sense that it has no module-level
// side effects of its own: all mutable state (the in-memory store, the
// listeners list, the removal-queue timers) is created *inside* the factory
// and returned as a closed-over handle. The module-level `toastStore`
// singleton below is just one particular instance of this factory, kept as a
// singleton so the imperative `toast(...)` API can dispatch from anywhere.
// Tests or alternate consumers are free to call `createToastStore()` to get
// an isolated store.
// ---------------------------------------------------------------------------

export interface ToastStore {
  /** Read the current state snapshot. */
  getState: () => State
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe: (listener: (state: State) => void) => () => void
  /** Dispatch a new toast. Returns `{ id, dismiss, update }` for the caller. */
  toast: (props: Toast) => {
    id: string
    dismiss: () => void
    update: (props: ToasterToast) => void
  }
  /** Dismiss one toast (by id) or all toasts (when id omitted). */
  dismiss: (toastId?: string) => void
  /** Dispatch a raw action (advanced API; mirrors the previous `dispatch`). */
  dispatch: (action: Action) => void
}

export type Toast = Omit<ToasterToast, "id">

export function createToastStore(): ToastStore {
  const listeners: Array<(state: State) => void> = []
  let memoryState: State = { toasts: [] }
  const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

  function addToRemoveQueue(toastId: string) {
    if (toastTimeouts.has(toastId)) {
      return
    }

    const timeout = setTimeout(() => {
      toastTimeouts.delete(toastId)
      dispatch({
        type: "REMOVE_TOAST",
        toastId: toastId,
      })
    }, TOAST_REMOVE_DELAY)

    toastTimeouts.set(toastId, timeout)
  }

  function dispatch(action: Action) {
    // Schedule deferred removal whenever toasts are dismissed. This side
    // effect used to live inside the reducer; it is hoisted here so the
    // reducer stays pure and the store owns its timers.
    if (action.type === "DISMISS_TOAST") {
      if (action.toastId) {
        addToRemoveQueue(action.toastId)
      } else {
        memoryState.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id)
        })
      }
    }

    memoryState = reducer(memoryState, action)
    listeners.forEach((listener) => {
      listener(memoryState)
    })
  }

  function subscribe(listener: (state: State) => void) {
    listeners.push(listener)
    return () => {
      const index = listeners.indexOf(listener)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }

  function getState() {
    return memoryState
  }

  function toast({ ...props }: Toast) {
    const id = genId()

    const update = (props: ToasterToast) =>
      dispatch({
        type: "UPDATE_TOAST",
        toast: { ...props, id },
      })
    const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id })

    dispatch({
      type: "ADD_TOAST",
      toast: {
        ...props,
        id,
        open: true,
        onOpenChange: (open) => {
          if (!open) dismiss()
        },
      },
    })

    return {
      id: id,
      dismiss,
      update,
    }
  }

  function dismiss(toastId?: string) {
    dispatch({ type: "DISMISS_TOAST", toastId })
  }

  return {
    getState,
    subscribe,
    toast,
    dismiss,
    dispatch,
  }
}

// Module-level singleton store — preserves the previous imperative API surface
// so existing callers (`toast(...)` from anywhere in the app) keep working
// without touching them.
const toastStore = createToastStore()

// ---------------------------------------------------------------------------
// Public hook + imperative exports
// ---------------------------------------------------------------------------

/**
 * React hook. Subscribes to the toast store and returns the current toast
 * state plus the `toast` / `dismiss` actions.
 *
 * `toast` and `dismiss` are stable references (they come from the singleton
 * store), so they are safe to use in `useEffect` / `useCallback` deps.
 */
function useToast() {
  const [state, setState] = React.useState<State>(toastStore.getState())

  React.useEffect(() => {
    // Sync any state changes that happened before this component subscribed,
    // so a toast dispatched before mount is not lost on the first paint.
    setState(toastStore.getState())
    return toastStore.subscribe(setState)
  }, [state])

  return {
    ...state,
    toast: toastStore.toast,
    dismiss: toastStore.dismiss,
  }
}

// Imperative API — `toast(...)` can be called from anywhere (event handlers,
// non-React modules, etc.) and will dispatch into the singleton store.
export const toast = toastStore.toast

export { useToast }
