/**
 * 工作流状态 —— 整个项目的运行时状态定义。
 *
 * 包含所有运行时数据：当前阶段、任务、清单、风险记录、制品等。
 * 通过 StateStore 持久化为 JSON 文件。
 */

import type { ProjectId, TaskId, ArtifactId } from "./branded-ids.js"
import { Phase, PhaseLock } from "./phase.js"
import type { Task, TaskFilter, TaskProgress } from "./task.js"
import type { Checklist, ChecklistItem } from "./checklist.js"
import type { HeinrichRecord, HeinrichObservation, HeinrichLevel } from "./risk.js"
import type { Artifact, ArtifactType } from "./artifact.js"
import { Role } from "./role.js"

/** 工作流运行时状态 */
export interface WorkflowState {
  /** 项目 ID */
  projectId: ProjectId
  /** 项目名称 */
  projectName: string
  /** 项目描述 */
  description: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 最后更新时间（ISO 8601） */
  updatedAt: string
  /** 当前活动阶段 */
  currentPhase: Phase
  /** 各阶段锁定状态 */
  phaseStatus: Record<Phase, PhaseLock>
  /** 所有任务 */
  tasks: Task[]
  /** 各阶段清单 */
  checklists: Partial<Record<Phase, Checklist>>
  /** 海因里希三角记录 */
  heinrich: HeinrichRecord
  /** 所有制品 */
  artifacts: Artifact[]
  /** 扩展元数据 */
  metadata: Record<string, string>
}

/** 项目状态摘要（用于 CLI 输出） */
export interface ProjectStatusSummary {
  projectId: ProjectId
  projectName: string
  currentPhase: Phase
  phaseProgress: Array<{
    phase: Phase
    lock: PhaseLock
    progress: TaskProgress
  }>
  heinrichSummary: {
    major: number
    minor: number
    trivial: number
  }
  totalTasks: number
  completedTasks: number
  checklistStats: {
    total: number
    verified: number
    pending: number
  }
}

/** 创建一个空白工作流状态 */
export function createEmptyState(
  projectId: ProjectId,
  projectName: string,
  description: string,
): WorkflowState {
  const now = new Date().toISOString()
  const phaseStatus = {} as Record<Phase, PhaseLock>

  // 初始状态：REQUIREMENTS 激活，其余锁定
  const phases = Object.values(Phase)
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]
    if (phase === undefined) continue
    if (i === 0) {
      phaseStatus[phase] = PhaseLock.ACTIVE
    } else {
      phaseStatus[phase] = PhaseLock.LOCKED
    }
  }

  return {
    projectId,
    projectName,
    description,
    createdAt: now,
    updatedAt: now,
    currentPhase: Phase.REQUIREMENTS_ANALYSIS,
    phaseStatus,
    tasks: [],
    checklists: {},
    heinrich: { majorDefects: 0, minorDefects: 0, trivialDefects: 0, observations: [] },
    artifacts: [],
    metadata: {},
  }
}

// 为满足编译器中 noUnusedLocals 需要，声明这些类型的引用（它们在类型定义中被使用）
export type { Task, TaskFilter, TaskProgress, Checklist, ChecklistItem, HeinrichRecord, HeinrichObservation, HeinrichLevel, Artifact, ArtifactType }
export { Role, PhaseLock }
