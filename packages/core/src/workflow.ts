/**
 * 工作流状态 —— 整个项目的运行时状态定义。
 *
 * 单一真相源为 `steps`（StepRuntime[]）：取代原先并行的 tasks[] + stages{}。
 * `Task` / `StageInfo` 通过 stepToTask / stepToStageInfo 派生，供前端零改动复用。
 * 通过 StateStore 持久化为事务化 SQLite 聚合。
 */

import type { ProjectId, TaskId } from "./branded-ids.js"
import { Phase, PhaseLock } from "./phase.js"
import type { Task, TaskFilter, TaskProgress, StageInfo } from "./task.js"
import { TaskStatus, StageStatus } from "./task.js"
import type { StepRuntime } from "./step.js"
import type { Checklist, ChecklistItem } from "./checklist.js"
import type { HeinrichRecord, HeinrichObservation, HeinrichLevel } from "./risk.js"
import { createEmptyHeinrichRecord } from "./risk.js"
import type { Artifact, ArtifactType } from "./artifact.js"
import { Role } from "./role.js"

/** 当前状态结构版本（v3 = 节点工作区与声明式动作） */
export const CURRENT_SCHEMA_VERSION = 3

/** 工作流运行时状态 */
export interface WorkflowState {
  /** 状态结构版本 */
  schemaVersion: number
  /** 项目 ID */
  projectId: ProjectId
  /** 项目名称 */
  projectName: string
  /** 项目描述 */
  description: string
  /** 项目源码根目录（节点执行器用于解析 workflow/ 目录） */
  projectRoot?: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 最后更新时间（ISO 8601） */
  updatedAt: string
  /** 当前活动阶段 */
  currentPhase: Phase
  /** 各阶段锁定状态 */
  phaseStatus: Record<Phase, PhaseLock>
  /** 所有步骤（唯一真相源） */
  steps: StepRuntime[]
  /** 各阶段清单 */
  checklists: Partial<Record<Phase, Checklist>>
  /** 海因里希三角记录 */
  heinrich: HeinrichRecord
  /** 所有制品 */
  artifacts: Artifact[]
  /** 扩展元数据 */
  metadata: Record<string, string>
  /** AI 门控开关 */
  aiGatingEnabled: boolean
  /** AI 门控审计记录 */
  aiGateResults: Array<{
    phase: Phase
    allowed: boolean
    reason?: string
    timestamp: string
  }>
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

/** 项目管理中心列表项（比 ProjectStatusSummary 更轻，含描述与路径） */
export interface ProjectSummary {
  projectId: ProjectId
  projectName: string
  description: string
  currentPhase: Phase
  totalTasks: number
  completedTasks: number
  projectRoot?: string
  updatedAt: string
}

// ── 派生视图 ──

/** 把 StepRuntime 派生为 Task 视图（供前端与旧 API 兼容） */
export function stepToTask(step: StepRuntime): Task {
  return {
    id: step.taskId,
    stageId: step.id,
    phase: step.phase,
    title: step.name,
    description: step.description,
    responsibleRole: step.responsibleRole,
    status: step.status,
    artifactIds: step.artifactIds,
    ...(step.assignedTo !== undefined ? { assignedTo: step.assignedTo } : {}),
    createdAt: step.createdAt,
    ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
    ...(step.notes !== undefined ? { notes: step.notes } : {}),
  }
}

/** 把 StepRuntime 派生为 StageInfo 视图 */
export function stepToStageInfo(step: StepRuntime): StageInfo {
  return {
    stageId: step.id,
    phase: step.phase,
    status: step.status as unknown as StageStatus,
    dependsOn: step.dependsOn,
    responsibleRole: step.responsibleRole,
    createdAt: step.createdAt,
    updatedAt: step.updatedAt,
    ...(step.completedAt !== undefined ? { completedAt: step.completedAt } : {}),
  }
}

/** 创建一个空白工作流状态 */
export function createEmptyState(
  projectId: ProjectId,
  projectName: string,
  description: string,
  projectRoot?: string,
): WorkflowState {
  const now = new Date().toISOString()
  const phaseStatus = {} as Record<Phase, PhaseLock>

  // 初始状态：REQUIREMENTS 激活，其余锁定
  const phases = Object.values(Phase)
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]
    if (phase === undefined) continue
    phaseStatus[phase] = i === 0 ? PhaseLock.ACTIVE : PhaseLock.LOCKED
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectId,
    projectName,
    description,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    createdAt: now,
    updatedAt: now,
    currentPhase: Phase.REQUIREMENTS_ANALYSIS,
    phaseStatus,
    steps: [],
    checklists: {},
    heinrich: createEmptyHeinrichRecord(),
    artifacts: [],
    metadata: {},
    aiGatingEnabled: false,
    aiGateResults: [],
  }
}

// ── 迁移 ──

/** 旧版（v1）状态：tasks[] + stages{} 并行 */
interface LegacyTaskLike {
  id: TaskId
  stageId: string
  phase: Phase
  title: string
  description: string
  responsibleRole: Role
  status: TaskStatus
  artifactIds: import("./branded-ids.js").ArtifactId[]
  assignedTo?: string
  createdAt: string
  completedAt?: string
  notes?: string
}
interface LegacyStageLike {
  stageId: string
  phase: Phase
  status: StageStatus
  dependsOn: string[]
  responsibleRole: Role
  createdAt: string
  updatedAt: string
  completedAt?: string
}

/**
 * 迁移任意持久化状态到当前结构。
 * v2+ 保留 steps 并补齐版本号；v1（tasks[]+stages{}）按 stageId 归并为 steps[]。
 */
export function migrateWorkflowState(raw: unknown): WorkflowState {
  const state = raw as WorkflowState & {
    tasks?: LegacyTaskLike[]
    stages?: Record<string, LegacyStageLike>
  }

  if ((state.schemaVersion ?? 1) >= 2 && Array.isArray(state.steps)) {
    return { ...state, schemaVersion: CURRENT_SCHEMA_VERSION }
  }

  const legacyTasks = state.tasks ?? []
  const legacyStages = state.stages ?? {}
  const steps: StepRuntime[] = []
  const seen = new Set<string>()

  for (const task of legacyTasks) {
    const stage = legacyStages[task.stageId]
    seen.add(task.stageId)
    steps.push({
      id: task.stageId,
      taskId: task.id,
      phase: task.phase,
      name: task.title,
      description: task.description,
      responsibleRole: task.responsibleRole,
      status: task.status,
      dependsOn: stage?.dependsOn ?? [],
      artifactIds: task.artifactIds ?? [],
      ...(task.assignedTo !== undefined ? { assignedTo: task.assignedTo } : {}),
      createdAt: task.createdAt,
      updatedAt: stage?.updatedAt ?? task.createdAt,
      ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
      ...(task.notes !== undefined ? { notes: task.notes } : {}),
    })
  }

  // 仅有 stage、无对应 task 的步骤也纳入
  for (const stage of Object.values(legacyStages)) {
    if (seen.has(stage.stageId)) continue
    steps.push({
      id: stage.stageId,
      taskId: stage.stageId as unknown as TaskId,
      phase: stage.phase,
      name: stage.stageId,
      description: "",
      responsibleRole: stage.responsibleRole,
      status: stage.status as unknown as TaskStatus,
      dependsOn: stage.dependsOn,
      artifactIds: [],
      createdAt: stage.createdAt,
      updatedAt: stage.updatedAt,
      ...(stage.completedAt !== undefined ? { completedAt: stage.completedAt } : {}),
    })
  }

  const migrated: WorkflowState = {
    ...state,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    steps,
  }
  delete (migrated as { tasks?: unknown }).tasks
  delete (migrated as { stages?: unknown }).stages
  return migrated
}

// 为满足类型定义引用，重新导出这些类型
export type { Task, TaskFilter, TaskProgress, StageInfo, Checklist, ChecklistItem, HeinrichRecord, HeinrichObservation, HeinrichLevel, Artifact, ArtifactType, StepRuntime }
export { Role, PhaseLock }
