/** Theme and workspace chrome preferences (localStorage + document). */

export const THEME_STORAGE_KEY = "octopus.ui.theme"
export const PANEL_STORAGE_KEY = "octopus.ui.workspacePanels"
export const META_STORAGE_KEY = "octopus.ui.workspaceMetaCollapsed"
export const COMPACT_WIDTH = 1280
export const COMPACT_HEIGHT = 840

export type UiTheme = "light" | "dark"

export type WorkspacePanels = {
  sidebarCollapsed: boolean
  inspectorCollapsed: boolean
}

export function preferredTheme(): UiTheme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === "light" || saved === "dark") return saved
  } catch {
    // ignore storage errors（隐私模式等）
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export function applyTheme(theme: string): UiTheme {
  const next: UiTheme = theme === "dark" ? "dark" : "light"
  document.documentElement.setAttribute("data-theme", next)
  document.documentElement.classList.toggle("dark", next === "dark")
  document.documentElement.style.colorScheme = next
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // ignore
  }
  return next
}

export function preferredWorkspacePanels(): WorkspacePanels {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY)
    if (!raw) return { sidebarCollapsed: false, inspectorCollapsed: false }
    const parsed = JSON.parse(raw) as Partial<WorkspacePanels> | null
    return {
      sidebarCollapsed: Boolean(parsed?.sidebarCollapsed),
      inspectorCollapsed: Boolean(parsed?.inspectorCollapsed),
    }
  } catch {
    return { sidebarCollapsed: false, inspectorCollapsed: false }
  }
}

export function persistWorkspacePanels(panels: WorkspacePanels): void {
  try {
    localStorage.setItem(
      PANEL_STORAGE_KEY,
      JSON.stringify({
        sidebarCollapsed: panels.sidebarCollapsed,
        inspectorCollapsed: panels.inspectorCollapsed,
      }),
    )
  } catch {
    // ignore storage errors
  }
}

export function preferredMetaCollapsed(): boolean | null {
  try {
    const raw = localStorage.getItem(META_STORAGE_KEY)
    if (raw === "1") return true
    if (raw === "0") return false
  } catch {
    // ignore storage errors
  }
  return null
}

export function persistMetaCollapsed(metaCollapsed: boolean): void {
  try {
    localStorage.setItem(META_STORAGE_KEY, metaCollapsed ? "1" : "0")
  } catch {
    // ignore storage errors
  }
}

export function isCompactWorkspace(
  width: number = typeof window !== "undefined" ? window.innerWidth : COMPACT_WIDTH,
  height: number = typeof window !== "undefined" ? window.innerHeight : COMPACT_HEIGHT,
): boolean {
  return width < COMPACT_WIDTH || height < COMPACT_HEIGHT
}
