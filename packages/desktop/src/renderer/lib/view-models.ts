/** Structured view models for hub / requirement / kanban lists (DOM-free). */

import { PHASE_ORDER, phaseLabel } from "./labels.js"

export type HubProjectItem = {
  projectId: string
  name?: string | null
  description?: string | null
  requirementCount?: number | null
  teambitionProjectId?: string | null
  updatedAt?: string | null
}

export type HubCardView = HubProjectItem & {
  displayName: string
  displayDescription: string
  requirementCount: number
  teambitionBound: boolean
  updatedAtLabel: string
  highlight: boolean
}

export type HubCardsModel =
  | { kind: "empty"; filtered: HubCardView[]; items: HubCardView[] }
  | { kind: "nomatch"; filtered: HubCardView[]; items: HubCardView[]; filter: string }
  | { kind: "cards"; filtered: HubCardView[]; items: HubCardView[] }

export type MilestoneSummaryLike = {
  id?: string
  name: string
  date: string
  overdue?: boolean
}

export type RequirementListItem = {
  requirementId: string
  requirementName?: string | null
  description?: string | null
  currentPhase?: string | null
  completedTasks?: number | null
  totalTasks?: number | null
  projectRoot?: string | null
  updatedAt?: string | null
  teambitionTaskId?: string | null
  teambitionStatusId?: string | null
  teambitionStatusName?: string | null
  teambitionVersionId?: string | null
  teambitionVersionName?: string | null
  teambitionVersionStale?: boolean | null
  plannedStart?: string | null
  plannedEnd?: string | null
  owner?: string | null
  milestoneCount?: number | null
  nextMilestone?: MilestoneSummaryLike | null
}

export type MilestoneBadgeData =
  | { kind: "next"; overdue: boolean; date: string; name: string }
  | { kind: "done" }

export type VersionBadgeData = {
  label: string
  stale: boolean
}

export type RequirementCardView = RequirementListItem & {
  displayName: string
  displayDescription: string
  phaseLabelText: string
  completedTasks: number
  totalTasks: number
  teambitionBound: boolean
  versionBadge: VersionBadgeData | null
  milestoneBadge: MilestoneBadgeData | null
  updatedAtLabel: string
  highlight: boolean
  scheduleExpanded: boolean
}

export type RequirementCardsModel =
  | { kind: "empty"; filtered: RequirementCardView[]; items: RequirementCardView[] }
  | { kind: "nomatch"; filtered: RequirementCardView[]; items: RequirementCardView[]; filter: string }
  | { kind: "cards"; filtered: RequirementCardView[]; items: RequirementCardView[] }

export type KanbanCardView = RequirementCardView & {
  scheduleText: string
  phase: string
}

export type KanbanModel =
  | { kind: "empty"; filtered: KanbanCardView[] }
  | { kind: "nomatch"; filtered: KanbanCardView[]; filter: string }
  | {
      kind: "columns"
      filtered: KanbanCardView[]
      columns: Array<{ phase: string; label: string; cards: KanbanCardView[] }>
    }

export type ListFilterOptions = {
  filter?: string
  lastCreatedId?: string
  expandedScheduleId?: string
}

export function formatUpdatedAt(value: string | null | undefined): string {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN")
}

export function formatMilestoneDate(value: string | null | undefined): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""))
  return matched ? `${matched[2]}-${matched[3]}` : String(value || "")
}

export function milestoneBadgeData(item: {
  milestoneCount?: number | null
  nextMilestone?: MilestoneSummaryLike | null
}): MilestoneBadgeData | null {
  if (!item.milestoneCount) return null
  if (item.nextMilestone) {
    return {
      kind: "next",
      overdue: Boolean(item.nextMilestone.overdue),
      date: formatMilestoneDate(item.nextMilestone.date),
      name: item.nextMilestone.name,
    }
  }
  return { kind: "done" }
}

function versionBadgeData(item: RequirementListItem): VersionBadgeData | null {
  if (!item.teambitionVersionId && !item.teambitionVersionName) return null
  return {
    label: String(item.teambitionVersionName || item.teambitionVersionId || ""),
    stale: Boolean(item.teambitionVersionStale),
  }
}

function toHubCard(item: HubProjectItem, lastCreatedId: string): HubCardView {
  return {
    ...item,
    displayName: item.name || item.projectId,
    displayDescription: item.description || "暂无描述",
    requirementCount: item.requirementCount ?? 0,
    teambitionBound: Boolean(item.teambitionProjectId),
    updatedAtLabel: item.updatedAt ? formatUpdatedAt(item.updatedAt) : "",
    highlight: item.projectId === lastCreatedId,
  }
}

export function buildHubCardsModel(
  items: readonly HubProjectItem[],
  options: ListFilterOptions = {},
): HubCardsModel {
  const filter = String(options.filter || "")
  const createdId = options.lastCreatedId || ""
  const query = filter.trim().toLowerCase()
  const filteredItems = items.filter((item) => {
    if (!query) return true
    return [item.name, item.projectId, item.description].some((field) =>
      String(field || "")
        .toLowerCase()
        .includes(query),
    )
  })
  const filtered = filteredItems.map((item) => toHubCard(item, createdId))
  if (!items.length) {
    return { kind: "empty", filtered, items: filtered }
  }
  if (!filtered.length) {
    return { kind: "nomatch", filtered, items: filtered, filter }
  }
  return { kind: "cards", filtered, items: filtered }
}

function toRequirementCard(
  item: RequirementListItem,
  options: { createdId: string; scheduleId: string },
): RequirementCardView {
  return {
    ...item,
    displayName: item.requirementName || item.requirementId,
    displayDescription: item.description || "暂无描述",
    phaseLabelText: phaseLabel(item.currentPhase),
    completedTasks: item.completedTasks ?? 0,
    totalTasks: item.totalTasks ?? 0,
    teambitionBound: Boolean(item.teambitionTaskId || item.teambitionStatusName),
    versionBadge: versionBadgeData(item),
    milestoneBadge: milestoneBadgeData(item),
    updatedAtLabel: item.updatedAt ? formatUpdatedAt(item.updatedAt) : "",
    highlight: item.requirementId === options.createdId,
    scheduleExpanded: item.requirementId === options.scheduleId,
  }
}

export function buildRequirementCardsModel(
  items: readonly RequirementListItem[],
  options: ListFilterOptions = {},
): RequirementCardsModel {
  const filter = String(options.filter || "")
  const createdId = options.lastCreatedId || ""
  const scheduleId = options.expandedScheduleId || ""
  const query = filter.trim().toLowerCase()
  const filteredItems = items.filter((item) => {
    if (!query) return true
    return [item.requirementName, item.requirementId, item.description, item.projectRoot].some((field) =>
      String(field || "")
        .toLowerCase()
        .includes(query),
    )
  })
  const filtered = filteredItems.map((item) => toRequirementCard(item, { createdId, scheduleId }))
  if (!items.length) {
    return { kind: "empty", filtered, items: filtered }
  }
  if (!filtered.length) {
    return { kind: "nomatch", filtered, items: filtered, filter }
  }
  return { kind: "cards", filtered, items: filtered }
}

function toKanbanCard(
  item: RequirementListItem,
  phase: string,
  createdId: string,
): KanbanCardView {
  const base = toRequirementCard(item, { createdId, scheduleId: "" })
  const scheduleText =
    item.plannedStart && item.plannedEnd
      ? `${item.plannedStart.slice(5)} → ${item.plannedEnd.slice(5)}`
      : "未排期"
  return {
    ...base,
    displayDescription: item.description || "",
    phase,
    scheduleText,
  }
}

export function buildKanbanModel(
  items: readonly RequirementListItem[],
  options: ListFilterOptions = {},
): KanbanModel {
  const filter = String(options.filter || "")
  const createdId = options.lastCreatedId || ""
  const query = filter.trim().toLowerCase()
  const filteredItems = items.filter((item) => {
    if (!query) return true
    return [item.requirementName, item.requirementId, item.description].some((field) =>
      String(field || "")
        .toLowerCase()
        .includes(query),
    )
  })
  const filtered = filteredItems.map((item) =>
    toKanbanCard(item, String(item.currentPhase || ""), createdId),
  )
  const columns = PHASE_ORDER.map((phase) => {
    const cards = filteredItems
      .filter((item) => item.currentPhase === phase)
      .map((item) => toKanbanCard(item, phase, createdId))
    return { phase, label: phaseLabel(phase), cards }
  })
  if (!items.length) {
    return { kind: "empty", filtered }
  }
  if (!filtered.length) {
    return { kind: "nomatch", filtered, filter }
  }
  return { kind: "columns", filtered, columns }
}
