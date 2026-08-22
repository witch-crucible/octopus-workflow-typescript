import { useCallback, useEffect, useState } from "react"

import {
  isCompactWorkspace,
  persistWorkspacePanels,
  preferredWorkspacePanels,
  type WorkspacePanels,
} from "@/lib/theme"

export type UseWorkspacePanelsResult = {
  sidebarCollapsed: boolean
  inspectorCollapsed: boolean
  isCompact: boolean
  setSidebarCollapsed: (collapsed: boolean, persist?: boolean) => void
  setInspectorCollapsed: (collapsed: boolean, persist?: boolean) => void
  toggleSidebar: () => void
  toggleInspector: () => void
}

export function useWorkspacePanels(): UseWorkspacePanelsResult {
  const [panels, setPanels] = useState<WorkspacePanels>(() => preferredWorkspacePanels())
  const [isCompact, setIsCompact] = useState(() => isCompactWorkspace())

  const applyPanel = useCallback(
    (side: "sidebar" | "inspector", collapsed: boolean, persist = true) => {
      setPanels((prev) => {
        const next: WorkspacePanels =
          side === "sidebar"
            ? { sidebarCollapsed: collapsed, inspectorCollapsed: prev.inspectorCollapsed }
            : { sidebarCollapsed: prev.sidebarCollapsed, inspectorCollapsed: collapsed }
        if (persist && !isCompactWorkspace()) persistWorkspacePanels(next)
        return next
      })
    },
    [],
  )

  const setSidebarCollapsed = useCallback(
    (collapsed: boolean, persist = true) => applyPanel("sidebar", collapsed, persist),
    [applyPanel],
  )

  const setInspectorCollapsed = useCallback(
    (collapsed: boolean, persist = true) => applyPanel("inspector", collapsed, persist),
    [applyPanel],
  )

  const toggleSidebar = useCallback(() => {
    setPanels((prev) => {
      const next = {
        sidebarCollapsed: !prev.sidebarCollapsed,
        inspectorCollapsed: prev.inspectorCollapsed,
      }
      if (!isCompactWorkspace()) persistWorkspacePanels(next)
      return next
    })
  }, [])

  const toggleInspector = useCallback(() => {
    setPanels((prev) => {
      const next = {
        sidebarCollapsed: prev.sidebarCollapsed,
        inspectorCollapsed: !prev.inspectorCollapsed,
      }
      if (!isCompactWorkspace()) persistWorkspacePanels(next)
      return next
    })
  }, [])

  useEffect(() => {
    let compactApplied = isCompactWorkspace()
    if (compactApplied) {
      setPanels({ sidebarCollapsed: true, inspectorCollapsed: true })
      setIsCompact(true)
    }

    const onResize = () => {
      const compact = isCompactWorkspace()
      setIsCompact(compact)
      if (compact && !compactApplied) {
        compactApplied = true
        setPanels({ sidebarCollapsed: true, inspectorCollapsed: true })
      } else if (!compact && compactApplied) {
        compactApplied = false
        setPanels(preferredWorkspacePanels())
      }
    }

    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  return {
    sidebarCollapsed: panels.sidebarCollapsed,
    inspectorCollapsed: panels.inspectorCollapsed,
    isCompact,
    setSidebarCollapsed,
    setInspectorCollapsed,
    toggleSidebar,
    toggleInspector,
  }
}
