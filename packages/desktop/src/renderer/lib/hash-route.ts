/** Hash routing helpers (pure; no location/history side effects). */

export type Route =
  | { view: "hub" }
  | { view: "mine" }
  | { view: "project"; projectId: string; projectTab: string }
  | { view: "workspace"; requirementId: string }

const PROJECT_TAB_RE =
  /^project\/([^/]+)\/(board|list|table|gantt|versions|logs|overview|settings)$/
const PROJECT_RE = /^project\/([^/]+)$/
const REQUIREMENT_RE = /^requirement\/([^/]+)$/

function stripHash(rawHash: string): string {
  return rawHash.replace(/^#/, "")
}

/**
 * Parse a location hash into a Route.
 * Accepts hashes with or without a leading `#`.
 * The legacy `list` tab is canonicalized to `table`.
 */
export function routeFromHash(rawHash: string): Route {
  const raw = stripHash(rawHash)
  if (raw === "hub" || raw === "" || raw === "/") return { view: "hub" }
  if (raw === "hub/mine") return { view: "mine" }

  const projectTabMatch = PROJECT_TAB_RE.exec(raw)
  if (projectTabMatch) {
    const encodedId = projectTabMatch[1]
    const tab = projectTabMatch[2]
    if (!encodedId || !tab) return { view: "hub" }
    const requestedTab = tab === "list" ? "table" : tab
    return {
      view: "project",
      projectId: decodeURIComponent(encodedId),
      projectTab: requestedTab,
    }
  }

  const projectMatch = PROJECT_RE.exec(raw)
  if (projectMatch) {
    const encodedId = projectMatch[1]
    if (!encodedId) return { view: "hub" }
    return {
      view: "project",
      projectId: decodeURIComponent(encodedId),
      projectTab: "board",
    }
  }

  const requirementMatch = REQUIREMENT_RE.exec(raw)
  if (requirementMatch) {
    const encodedId = requirementMatch[1]
    if (!encodedId) return { view: "hub" }
    return {
      view: "workspace",
      requirementId: decodeURIComponent(encodedId),
    }
  }

  return { view: "hub" }
}

/**
 * When the hash uses the legacy `list` tab, return the canonical hash without `#`.
 * Otherwise return null (no rewrite needed).
 */
export function canonicalizeHash(rawHash: string): string | null {
  const raw = stripHash(rawHash)
  const match = /^project\/([^/]+)\/list$/.exec(raw)
  const encodedId = match?.[1]
  if (!encodedId) return null
  return `project/${encodeURIComponent(decodeURIComponent(encodedId))}/table`
}

export function projectHash(projectId: string, tab?: string): string {
  const suffix = tab && tab !== "board" ? `/${tab}` : ""
  return `project/${encodeURIComponent(projectId)}${suffix}`
}

export function requirementHash(requirementId: string): string {
  return `requirement/${encodeURIComponent(requirementId)}`
}
