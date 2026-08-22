export type GanttScale = "day" | "week" | "month"

export type SchedulePayload = {
  plannedStart?: string | null
  plannedEnd?: string | null
  date?: string
}

export type ScheduleKind = "node" | "requirement" | "milestone"

export type GanttCallbacks = {
  onSchedule?: (id: string, schedule: SchedulePayload, kind?: ScheduleKind) => void | Promise<void>
  onSelect?: (id: string) => void
  onSelectRequirement?: (id: string) => void
  onSelectMilestone?: (id: string, requirementId?: string) => void
  onReach?: (id: string, requirementId?: string) => void | Promise<void>
  onExportOmniPlan?: () => void | Promise<void>
  onImportOmniPlan?: () => void | Promise<void>
  onAddMilestone?: () => void
}

export type GanttLabels = {
  phaseOrder?: string[]
  phaseLabel?: (phase: string) => string
  roleLabel?: (role: string) => string
  statusLabel?: (status: string) => string
  nodeName?: (node: { name?: string }) => string
}

export type GanttStepLike = Record<string, unknown> & { id: string }
export type GanttMilestoneLike = Record<string, unknown> & { id: string; date?: string; name?: string }
export type GanttRequirementLike = Record<string, unknown> & {
  id?: string
  requirementId?: string
}

export type GanttRenderInput = {
  mode?: "nodes" | "requirements"
  steps?: GanttStepLike[]
  requirements?: GanttRequirementLike[]
  milestones?: GanttMilestoneLike[]
  labels?: GanttLabels
  [key: string]: unknown
}

export type GanttViewModel = {
  rows: Array<Record<string, unknown>>
  [key: string]: unknown
}

export function buildRequirementsModel(
  requirements: GanttRequirementLike[],
  options?: Record<string, unknown>,
): GanttViewModel

export function milestoneDiamondPoints(cx: number, cy: number, r?: number): string

export const OctopusGantt: {
  mount: (el: HTMLElement, opts?: GanttCallbacks) => void
  unmount: () => void
  render: (input: GanttRenderInput) => void
  isDragging: () => boolean
  getUiState: () => Record<string, unknown>
  setUiState: (patch: Record<string, unknown>) => void
  scrollToToday: () => void
}
