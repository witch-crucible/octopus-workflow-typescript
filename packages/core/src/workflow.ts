/**
 * 工作流状态 —— 单个「需求（Requirement）」的运行时状态定义。
 *
 * 需求隶属于上层「项目（Project）」容器。单一真相源为 `steps`（StepRuntime[]）。
 * `Task` / `StageInfo` 通过 stepToTask / stepToStageInfo 派生，供前端复用。
 * 通过 PersistenceStore 持久化为事务化 PostgreSQL 聚合。
 */

import type { ProjectId, RequirementId, TaskId } from "./branded-ids.js"
import { Phase, PhaseLock } from "./phase.js"
import type { Task, TaskFilter, TaskProgress, StageInfo, Subtask } from "./task.js"
import { TaskStatus, StageStatus } from "./task.js"
import type { StepRuntime } from "./step.js"
import type { Checklist, ChecklistItem } from "./checklist.js"
import type { HeinrichRecord, HeinrichObservation, HeinrichLevel } from "./risk.js"
import { createEmptyHeinrichRecord } from "./risk.js"
import type { Artifact, ArtifactType } from "./artifact.js"
import { Role } from "./role.js"
import type { MilestoneSummary, RequirementMilestone } from "./milestone.js"

/**
 * 当前状态结构版本。
 * v8 需求负责人 owner；v9 需求级 teambitionVersion 绑定；v10 需求子任务。
 */
export const CURRENT_SCHEMA_VERSION = 10

/** 需求级 Teambition 任务绑定 */
export interface RequirementTeambitionBinding {
  taskId?: string
  taskRef?: string
  statusId?: string
  statusName?: string
  url?: string
  lastSyncedAt?: string
}

/** 需求级 Teambition 版本绑定（多对一；一条需求同一时刻最多一个版本） */
export interface RequirementVersionBinding {
  versionId: string
  versionName?: string
  repoId?: string
  url?: string
  lastSyncedAt?: string
}

/** 工作流运行时状态（一个需求实例） */
export interface WorkflowState {
  /** 状态结构版本 */
  schemaVersion: number
  /** 所属项目 ID */
  projectId: ProjectId
  /** 需求 ID */
  requirementId: RequirementId
  /** 需求名称 */
  requirementName: string
  /** 需求描述 */
  description: string
  /** 源码根目录（节点执行器用于解析 workflow/ 目录） */
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
  /** 需求下用户维护的子任务；不参与工作流阶段门控。 */
  subtasks: Subtask[]
  /** 各阶段清单 */
  checklists: Partial<Record<Phase, Checklist>>
  /** 海因里希三角记录 */
  heinrich: HeinrichRecord
  /** 所有制品 */
  artifacts: Artifact[]
  /** 扩展元数据 */
  metadata: Record<string, string>
  /** Teambition 任务绑定 */
  teambition?: RequirementTeambitionBinding
  /** Teambition 版本绑定 */
  teambitionVersion?: RequirementVersionBinding
  /** 需求级计划开始日期（YYYY-MM-DD） */
  plannedStart?: string
  /** 需求级计划结束日期（YYYY-MM-DD） */
  plannedEnd?: string
  /** 需求负责人 */
  owner?: string
  /** 需求级单日里程碑 */
  milestones?: RequirementMilestone[]
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

/** 需求状态摘要（用于 CLI 输出） */
export interface RequirementStatusSummary {
  projectId: ProjectId
  requirementId: RequirementId
  requirementName: string
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
  teambition?: RequirementTeambitionBinding
}

/** @deprecated 使用 RequirementStatusSummary */
export type ProjectStatusSummary = RequirementStatusSummary

/** 需求列表项（比 RequirementStatusSummary 更轻） */
export interface RequirementSummary {
  projectId: ProjectId
  requirementId: RequirementId
  requirementName: string
  description: string
  currentPhase: Phase
  totalTasks: number
  completedTasks: number
  projectRoot?: string
  updatedAt: string
  teambitionTaskId?: string
  teambitionStatusName?: string
  teambitionVersionId?: string
  teambitionVersionName?: string
  /** 仅 true 时输出。未知（从未 sync / UNCONFIRMED / error）不要给 false */
  teambitionVersionStale?: boolean
  plannedStart?: string
  plannedEnd?: string
  /** 需求负责人 */
  owner?: string
  milestoneCount?: number
  nextMilestone?: MilestoneSummary
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

/** 创建一个空白需求工作流状态 */
export function createEmptyState(
  projectId: ProjectId,
  requirementId: RequirementId,
  requirementName: string,
  description: string,
  projectRoot?: string,
): WorkflowState {
  const now = new Date().toISOString()
  const phaseStatus = {} as Record<Phase, PhaseLock>

  // 初始状态：意向激活，其余锁定
  const phases = Object.values(Phase)
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]
    if (phase === undefined) continue
    phaseStatus[phase] = i === 0 ? PhaseLock.ACTIVE : PhaseLock.LOCKED
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectId,
    requirementId,
    requirementName,
    description,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    createdAt: now,
    updatedAt: now,
    currentPhase: Phase.INTENTION,
    phaseStatus,
    steps: [],
    subtasks: [],
    checklists: {},
    heinrich: createEmptyHeinrichRecord(),
    artifacts: [],
    metadata: {},
    milestones: [],
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

const INTENTION_STEP_IDS = new Set(["10.1", "10.2"])
const UAT_STEP_IDS = new Set(["40.3", "40.4"])

/** 旧 Phase 字符串 → 新 Phase（不含按步骤细分的情况） */
const LEGACY_PHASE_REMAP: Record<string, Phase> = {
  RequirementsAnalysis: Phase.INTENTION,
  Development: Phase.IMPLEMENTATION,
  Deployment: Phase.RELEASE,
  Intention: Phase.INTENTION,
  Research: Phase.RESEARCH,
  Design: Phase.DESIGN,
  Implementation: Phase.IMPLEMENTATION,
  Testing: Phase.TESTING,
  UAT: Phase.UAT,
  Release: Phase.RELEASE,
  Maintenance: Phase.MAINTENANCE,
  Completed: Phase.COMPLETED,
}

/** 按步骤 id 推断所属阶段（覆盖旧 RequirementsAnalysis / Testing 拆分） */
function phaseForStepId(stepId: string, fallback: string | Phase): Phase {
  if (INTENTION_STEP_IDS.has(stepId)) return Phase.INTENTION
  if (stepId.startsWith("10.")) return Phase.RESEARCH
  if (UAT_STEP_IDS.has(stepId)) return Phase.UAT
  const remapped = LEGACY_PHASE_REMAP[String(fallback)]
  if (remapped) return remapped
  if (Object.values(Phase).includes(fallback as Phase)) return fallback as Phase
  return Phase.INTENTION
}

function remapLegacyPhaseKey(key: string): Phase {
  if (key === "RequirementsAnalysis") return Phase.RESEARCH
  return (
    LEGACY_PHASE_REMAP[key] ??
    (Object.values(Phase).includes(key as Phase) ? (key as Phase) : Phase.INTENTION)
  )
}

function remapCurrentPhase(
  rawPhase: string,
  steps: readonly { id: string; phase: Phase; status?: string }[],
): Phase {
  if (rawPhase === "RequirementsAnalysis") {
    const hasResearchStep = steps.some(
      (step) => step.id.startsWith("10.") && !INTENTION_STEP_IDS.has(step.id),
    )
    return hasResearchStep ? Phase.RESEARCH : Phase.INTENTION
  }
  if (rawPhase === "Testing") {
    const testSteps = steps.filter((s) => s.id === "40.1" || s.id === "40.2")
    const testDone =
      testSteps.length > 0 &&
      testSteps.every((s) => s.status === TaskStatus.COMPLETED || s.status === TaskStatus.SKIPPED)
    if (testDone && steps.some((s) => UAT_STEP_IDS.has(s.id))) return Phase.UAT
    return Phase.TESTING
  }
  return remapLegacyPhaseKey(rawPhase)
}

function remapPhaseStatus(
  raw: Partial<Record<string, PhaseLock>> | undefined,
  currentPhase: Phase,
): Record<Phase, PhaseLock> {
  const result = {} as Record<Phase, PhaseLock>
  for (const phase of Object.values(Phase)) {
    result[phase] = PhaseLock.LOCKED
  }

  const legacy = raw ?? {}
  const req = legacy["RequirementsAnalysis"]
  if (req === PhaseLock.COMPLETED) {
    result[Phase.INTENTION] = PhaseLock.COMPLETED
    result[Phase.RESEARCH] = PhaseLock.COMPLETED
  } else if (req === PhaseLock.ACTIVE) {
    result[currentPhase === Phase.RESEARCH ? Phase.RESEARCH : Phase.INTENTION] = PhaseLock.ACTIVE
    if (currentPhase === Phase.RESEARCH) result[Phase.INTENTION] = PhaseLock.COMPLETED
  }

  const testing = legacy["Testing"]
  if (testing === PhaseLock.COMPLETED) {
    result[Phase.TESTING] = PhaseLock.COMPLETED
    // 旧模型 UAT 含在 Testing 内；若已完成 Testing 且已进入更后阶段，UAT 也视为完成
  } else if (testing === PhaseLock.ACTIVE) {
    result[currentPhase === Phase.UAT ? Phase.UAT : Phase.TESTING] = PhaseLock.ACTIVE
    if (currentPhase === Phase.UAT) result[Phase.TESTING] = PhaseLock.COMPLETED
  }

  const simple: Array<[string, Phase]> = [
    ["Design", Phase.DESIGN],
    ["Development", Phase.IMPLEMENTATION],
    ["Implementation", Phase.IMPLEMENTATION],
    ["Deployment", Phase.RELEASE],
    ["Release", Phase.RELEASE],
    ["Maintenance", Phase.MAINTENANCE],
    ["Intention", Phase.INTENTION],
    ["Research", Phase.RESEARCH],
    ["UAT", Phase.UAT],
    ["Completed", Phase.COMPLETED],
  ]
  for (const [key, phase] of simple) {
    const lock = legacy[key]
    if (lock) result[phase] = lock
  }

  // 以 currentPhase 为准校正 ACTIVE
  for (const phase of Object.values(Phase)) {
    if (phase === currentPhase) result[phase] = PhaseLock.ACTIVE
    else if (result[phase] === PhaseLock.ACTIVE) result[phase] = PhaseLock.LOCKED
  }
  // 当前阶段之前的未标记阶段视为已完成
  const order = Object.values(Phase)
  const currentIdx = order.indexOf(currentPhase)
  for (let i = 0; i < currentIdx; i++) {
    const phase = order[i]
    if (phase && result[phase] !== PhaseLock.COMPLETED) result[phase] = PhaseLock.COMPLETED
  }

  return result
}

function remapChecklists(
  checklists: Partial<Record<string, Checklist>> | undefined,
): Partial<Record<Phase, Checklist>> {
  if (!checklists) return {}
  const result: Partial<Record<Phase, Checklist>> = {}
  for (const [key, checklist] of Object.entries(checklists)) {
    if (!checklist) continue
    const phase = remapLegacyPhaseKey(key)
    result[phase] = { ...checklist, phase }
  }
  return result
}

function remapHeinrichPhases<T extends { triggerCounts?: Partial<Record<string, number>> }>(
  heinrich: T,
): T {
  if (!heinrich?.triggerCounts) return heinrich
  const counts: Partial<Record<Phase, number>> = {}
  for (const phase of Object.values(Phase)) counts[phase] = 0
  for (const [key, value] of Object.entries(heinrich.triggerCounts)) {
    const phase = remapLegacyPhaseKey(key)
    counts[phase] = (counts[phase] ?? 0) + (value ?? 0)
  }
  return { ...heinrich, triggerCounts: counts }
}

/**
 * 迁移任意持久化状态到当前结构。
 * v2+ 保留 steps 并补齐版本号；v1（tasks[]+stages{}）按 stageId 归并为 steps[]。
 * v4 将旧六段 Phase 映射为九段生命周期。
 * v5 将旧「项目」字段下沉为「需求」，并要求所属 projectId。
 * v7 补齐 milestones[]。
 * v9 需求级 teambitionVersion 绑定；v10 补齐 subtasks[]。
 */
export function migrateWorkflowState(
  raw: unknown,
  options?: { projectId?: ProjectId },
): WorkflowState {
  const state = raw as WorkflowState & {
    tasks?: LegacyTaskLike[]
    stages?: Record<string, LegacyStageLike>
    projectName?: string
  }

  let steps: StepRuntime[]

  if ((state.schemaVersion ?? 1) >= 2 && Array.isArray(state.steps)) {
    steps = state.steps.map((step) => ({
      ...step,
      phase: phaseForStepId(step.id, step.phase),
    }))
  } else {
    const legacyTasks = state.tasks ?? []
    const legacyStages = state.stages ?? {}
    steps = []
    const seen = new Set<string>()

    for (const task of legacyTasks) {
      const stage = legacyStages[task.stageId]
      seen.add(task.stageId)
      steps.push({
        id: task.stageId,
        taskId: task.id,
        phase: phaseForStepId(task.stageId, task.phase),
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
        phase: phaseForStepId(stage.stageId, stage.phase),
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
  }

  const currentPhase = remapCurrentPhase(String(state.currentPhase ?? Phase.INTENTION), steps)
  const phaseStatus = remapPhaseStatus(
    state.phaseStatus as Partial<Record<string, PhaseLock>>,
    currentPhase,
  )
  const checklists = remapChecklists(state.checklists as Partial<Record<string, Checklist>>)
  const heinrich = remapHeinrichPhases(state.heinrich ?? createEmptyHeinrichRecord())
  const aiGateResults = (state.aiGateResults ?? []).map((item) => ({
    ...item,
    phase: remapLegacyPhaseKey(String(item.phase)),
  }))

  // v5：旧 projectId/projectName 下沉为 requirementId/requirementName
  const legacyProjectId = (state as { projectId?: string }).projectId
  const legacyProjectName = state.projectName
  const requirementId = (state.requirementId ??
    legacyProjectId ??
    `req_${Date.now()}`) as RequirementId
  const requirementName = state.requirementName ?? legacyProjectName ?? "未命名需求"
  const projectId = (options?.projectId ??
    state.projectId ??
    legacyProjectId ??
    `proj_${Date.now()}`) as ProjectId

  const migrated: WorkflowState = {
    ...state,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projectId,
    requirementId,
    requirementName,
    currentPhase,
    phaseStatus,
    steps,
    subtasks: Array.isArray((state as { subtasks?: unknown }).subtasks)
      ? ((state as { subtasks: Subtask[] }).subtasks ?? [])
      : [],
    checklists,
    heinrich,
    aiGateResults,
    ...(state.teambition !== undefined ? { teambition: state.teambition } : {}),
    milestones: Array.isArray(state.milestones) ? state.milestones : [],
  }
  delete (migrated as { tasks?: unknown }).tasks
  delete (migrated as { stages?: unknown }).stages
  delete (migrated as { projectName?: unknown }).projectName
  return migrated
}

// 为满足类型定义引用，重新导出这些类型
export type {
  Task,
  TaskFilter,
  TaskProgress,
  StageInfo,
  Checklist,
  ChecklistItem,
  HeinrichRecord,
  HeinrichObservation,
  HeinrichLevel,
  Artifact,
  ArtifactType,
  StepRuntime,
}
export { Role, PhaseLock }
