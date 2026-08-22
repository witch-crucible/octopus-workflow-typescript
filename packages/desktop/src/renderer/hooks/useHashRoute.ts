import { useEffect, useState } from "react"

import {
  projectHash,
  requirementHash,
  routeFromHash,
  type Route,
} from "@/lib/hash-route"

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash))

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash))
    window.addEventListener("hashchange", onHashChange)
    return () => window.removeEventListener("hashchange", onHashChange)
  }, [])

  return route
}

export function navigateHub(): void {
  window.location.hash = "hub"
}

export function navigateMine(): void {
  window.location.hash = "hub/mine"
}

export function navigateProject(projectId: string, tab?: string): void {
  window.location.hash = projectHash(projectId, tab)
}

export function navigateRequirement(requirementId: string): void {
  window.location.hash = requirementHash(requirementId)
}
