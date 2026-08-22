import { useEffect, useRef } from "react"

import { cn } from "@/lib/utils"

import {
  type GanttCallbacks,
  type GanttMountOptions,
  type GanttRenderInput,
  OctopusGantt,
} from "./gantt"

export type GanttHostProps = {
  className?: string
  mode: "requirements" | "nodes"
  /** Model payload expected by OctopusGantt.render */
  input: unknown
  callbacks?: Record<string, unknown>
}

function asMountOptions(callbacks: Record<string, unknown> | undefined): GanttMountOptions {
  if (!callbacks) return {}
  return callbacks as GanttCallbacks
}

function asRenderInput(mode: GanttHostProps["mode"], input: unknown): GanttRenderInput {
  const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  return {
    ...base,
    mode,
  }
}

/** Mounts the imperative OctopusGantt SVG visualization inside React. */
export function GanttHost({ className, mode, input, callbacks }: GanttHostProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const latestRef = useRef({ mode, input })
  latestRef.current = { mode, input }

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    OctopusGantt.mount(el, asMountOptions(callbacks))
    const latest = latestRef.current
    OctopusGantt.render(asRenderInput(latest.mode, latest.input))
    return () => {
      OctopusGantt.unmount()
    }
  }, [callbacks])

  useEffect(() => {
    OctopusGantt.render(asRenderInput(mode, input))
  }, [mode, input])

  return (
    <div
      ref={hostRef}
      data-testid="gantt-host"
      data-mode={mode}
      className={cn("min-h-[320px] w-full rounded-lg border bg-card", className)}
    />
  )
}
