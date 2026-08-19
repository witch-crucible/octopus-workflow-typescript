/**
 * 需求级里程碑 —— 挂在单个需求上的单日、零工期检查点。
 * 不参与阶段机与 DAG；逾期由 date + status 派生，不单独持久化。
 */

import type { MilestoneId } from "./branded-ids.js"
import { PHASE_ORDER, type Phase } from "./phase.js"

export const MilestoneStatus = {
  PLANNED: "planned",
  REACHED: "reached",
} as const

export type MilestoneStatus = (typeof MilestoneStatus)[keyof typeof MilestoneStatus]

export const MILESTONE_NAME_MAX = 80
export const MILESTONE_NOTE_MAX = 500

/** 需求里程碑 */
export interface RequirementMilestone {
  id: MilestoneId
  name: string
  date: string
  status: MilestoneStatus
  phase?: Phase
  nodeId?: string
  note?: string
  createdAt: string
  updatedAt: string
  reachedAt?: string
}

export interface MilestoneSummary {
  id: string
  name: string
  date: string
  overdue: boolean
}

export interface ProjectMilestone extends RequirementMilestone {
  requirementId: string
  requirementName: string
}

/** 本地日历日 YYYY-MM-DD（不做时区换算）。 */
export function todayYmd(now = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

/** 本地日历日校验（与引擎排期字段同一规则）。 */
export function isMilestoneDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [yearText, monthText, dayText] = value.split("-")
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

export function isMilestoneOverdue(
  milestone: Pick<RequirementMilestone, "status" | "date">,
  today = todayYmd(),
): boolean {
  return milestone.status === MilestoneStatus.PLANNED && milestone.date < today
}

export function sortMilestones<T extends { date: string; createdAt: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt),
  )
}

export function nextOpenMilestone(
  milestones: readonly RequirementMilestone[],
  _today = todayYmd(),
): RequirementMilestone | undefined {
  return sortMilestones(milestones.filter((item) => item.status === MilestoneStatus.PLANNED))[0]
}

export function normalizeMilestoneName(name: string): string {
  const trimmed = name.trim()
  if (trimmed.length < 1 || trimmed.length > MILESTONE_NAME_MAX) {
    throw new Error("里程碑名称必须是 1–80 个字符")
  }
  return trimmed
}

export function normalizeMilestoneDate(date: string): string {
  if (!isMilestoneDate(date)) {
    throw new Error("里程碑日期必须是 YYYY-MM-DD")
  }
  return date
}

export function normalizeMilestoneNote(note: string): string {
  if (note.length > MILESTONE_NOTE_MAX) {
    throw new Error("备注不能超过 500 个字符")
  }
  return note
}

export function assertMilestonePhase(phase: string): Phase {
  if (!PHASE_ORDER.includes(phase as Phase)) {
    throw new Error("未知阶段")
  }
  return phase as Phase
}
