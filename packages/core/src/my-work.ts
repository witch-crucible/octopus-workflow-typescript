import type { Phase } from "./phase.js"
import type { MilestoneSummary } from "./milestone.js"
import type { TaskStatus } from "./task.js"

export type MyWorkKind = "requirement" | "node"

export interface MyWorkItem {
  kind: MyWorkKind
  projectId: string
  projectName: string
  requirementId: string
  requirementName: string
  phase: Phase
  owner?: string
  nextMilestone?: MilestoneSummary
  plannedEnd?: string
  nodeId?: string
  nodeName?: string
  status?: TaskStatus
  assignedTo?: string
  overdue: boolean
}

export interface MyWorkList {
  identity: string
  requirements: MyWorkItem[]
  nodes: MyWorkItem[]
}

/** 项目概览（只读投影，从 state 派生，不另存统计表）。 */
export interface ProjectOverview {
  projectId: string
  projectName: string
  requirementCount: number
  /** PHASE_ORDER 全列，含 0 */
  byPhase: Array<{ phase: Phase; count: number }>
  unscheduledCount: number
  unboundTbCount: number
  milestonePlanned: number
  milestoneReached: number
  milestoneOverdue: number
  heinrich: { major: number; minor: number; trivial: number }
  readyNodeCount: number
  waitingNodeCount: number
  ownerlessCount: number
}
