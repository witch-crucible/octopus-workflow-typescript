/**
 * Workflow Engine 包 —— 工作流状态机引擎。
 *
 * 使用 xstate v5 定义阶段转换、任务生命周期、阶段门控校验。
 * 状态持久化通过 @octopus/context 的 StateStore 实现。
 *
 * 阶段转换规则（映射 PlantUML）：
 * - 只能按顺序前进：REQUIREMENTS → DESIGN → DEVELOPMENT → TESTING → DEPLOYMENT → MAINTENANCE
 * - 可回退到任何前置阶段
 * - 前进前必须满足退出条件：所有任务已完成 + 清单已核验
 */

import { createMachine } from "xstate"
import type { WorkflowState, ProjectStatusSummary } from "@octopus/core/workflow.js"
import { Phase, PhaseLock, getPhaseIndex, getNextPhase, getPreviousPhase, PHASE_ORDER } from "@octopus/core/phase.js"
import type { Task, TaskFilter, TaskProgress } from "@octopus/core/task.js"
import { TaskStatus } from "@octopus/core/task.js"
import type { Checklist, ChecklistItem } from "@octopus/core/checklist.js"
import { ChecklistItemStatus } from "@octopus/core/checklist.js"
import type { HeinrichRecord, HeinrichObservation, HeinrichLevel, QualityAssessment } from "@octopus/core/risk.js"
import { QualityVerdict, HEINRICH_IDEAL_RATIO, createEmptyHeinrichRecord } from "@octopus/core/risk.js"
import type { Artifact, ArtifactType } from "@octopus/core/artifact.js"
import type { ProjectId } from "@octopus/core/branded-ids.js"
import { PhaseId, TaskId, ChecklistItemId, ObservationId, ArtifactId } from "@octopus/core/branded-ids.js"
import { Role } from "@octopus/core/role.js"
import { InvalidPhaseTransitionError, PhaseLockedError } from "@octopus/core/errors.js"
import { createEmptyState } from "@octopus/core/workflow.js"
import { createEmptyChecklist } from "@octopus/core/checklist.js"
import type { StateStore } from "@octopus/context/index.js"
import { createTasksForPhase } from "@octopus/task-library/index.js"
import type { AIClient } from "@octopus/agent-layer/index.js"

/** xstate v5 状态机定义 */
const workflowMachine = createMachine({
  id: "octopus-workflow",
  initial: Phase.REQUIREMENTS_ANALYSIS,
  states: {
    [Phase.REQUIREMENTS_ANALYSIS]: { on: { ADVANCE: Phase.DESIGN } },
    [Phase.DESIGN]: { on: { ADVANCE: Phase.DEVELOPMENT } },
    [Phase.DEVELOPMENT]: { on: { ADVANCE: Phase.TESTING } },
    [Phase.TESTING]: { on: { ADVANCE: Phase.DEPLOYMENT } },
    [Phase.DEPLOYMENT]: { on: { ADVANCE: Phase.MAINTENANCE } },
    [Phase.MAINTENANCE]: { type: "final" },
  },
})

/** 门控检查结果 */
export interface GateCheckResult {
  allowed: boolean
  reasons: string[]
}

/** WorkflowEngine 配置 */
export interface WorkflowEngineConfig {
  store: StateStore
  aiClient?: AIClient
}

/**
 * 工作流引擎 —— 所有阶段/任务/清单/风险/制品操作的统一入口。
 */
export class WorkflowEngine {
  private readonly store: StateStore
  private readonly aiClient: AIClient | undefined

  constructor(config: WorkflowEngineConfig) {
    this.store = config.store
    this.aiClient = config.aiClient
  }

  // ── 项目生命周期 ──

  /** 初始化新项目 */
  initProject(name: string, description?: string): WorkflowState {
    const state = this.store.createProject(name, description)

    // 为当前阶段（REQUIREMENTS）生成默认任务
    const tasks = createTasksForPhase(state.projectId, state.currentPhase)
    state.tasks = tasks
    state.checklists[Phase.REQUIREMENTS_ANALYSIS] = createEmptyChecklist(Phase.REQUIREMENTS_ANALYSIS)

    // 初始化海因里希记录
    state.heinrich = createEmptyHeinrichRecord()

    this.store.save(state)
    return state
  }

  /** 获取项目状态 */
  getState(projectId: string): WorkflowState {
    return this.store.load(projectId)
  }

  /** 获取项目摘要 */
  getProjectStatus(projectId: string): ProjectStatusSummary {
    const state = this.getState(projectId)
    const phaseProgress = PHASE_ORDER.map((phase) => ({
      phase,
      lock: state.phaseStatus[phase] ?? PhaseLock.LOCKED,
      progress: this.getPhaseProgress(state, phase),
    }))

    let totalChecklist = 0
    let verifiedChecklist = 0
    let pendingChecklist = 0
    for (const phase of PHASE_ORDER) {
      const cl = state.checklists[phase]
      if (cl) {
        totalChecklist += cl.items.length
        verifiedChecklist += cl.items.filter(
          (i) => i.status === ChecklistItemStatus.VERIFIED || i.status === ChecklistItemStatus.NA,
        ).length
        pendingChecklist += cl.items.filter((i) => i.status === ChecklistItemStatus.PENDING).length
      }
    }

    return {
      projectId: state.projectId,
      projectName: state.projectName,
      currentPhase: state.currentPhase,
      phaseProgress,
      heinrichSummary: {
        major: state.heinrich.majorDefects,
        minor: state.heinrich.minorDefects,
        trivial: state.heinrich.trivialDefects,
      },
      totalTasks: state.tasks.length,
      completedTasks: state.tasks.filter((t) => t.status === TaskStatus.COMPLETED).length,
      checklistStats: { total: totalChecklist, verified: verifiedChecklist, pending: pendingChecklist },
    }
  }

  // ── 阶段转换 ──

  /** 检查是否可前进到下一阶段 */
  canAdvance(projectId: string): GateCheckResult {
    const state = this.getState(projectId)
    return this.checkAdvanceGate(state)
  }

  private checkAdvanceGate(state: WorkflowState): GateCheckResult {
    const reasons: string[] = []
    const currentPhase = state.currentPhase

    // 1. 检查当前阶段是否为最终阶段
    const next = getNextPhase(currentPhase)
    if (!next) {
      return { allowed: false, reasons: ["已是最终阶段，无法继续前进"] }
    }

    // 2. 检查当前阶段所有任务是否已完成
    const phaseTasks = state.tasks.filter((t) => t.phase === currentPhase)
    const pendingTasks = phaseTasks.filter((t) => t.status !== TaskStatus.COMPLETED && t.status !== TaskStatus.SKIPPED)
    if (pendingTasks.length > 0) {
      reasons.push(`有 ${pendingTasks.length} 个任务未完成`)
    }

    // 3. 检查当前阶段清单是否已全部核验
    const checklist = state.checklists[currentPhase]
    if (checklist) {
      const pendingItems = checklist.items.filter((i) => i.status === ChecklistItemStatus.PENDING)
      if (pendingItems.length > 0) {
        reasons.push(`有 ${pendingItems.length} 项清单未核验`)
      }
    }

    return { allowed: reasons.length === 0, reasons }
  }

  /** 前进到下一阶段 */
  advancePhase(projectId: string): WorkflowState {
    const state = this.getState(projectId)
    const gate = this.checkAdvanceGate(state)

    if (!gate.allowed) {
      throw new PhaseLockedError(state.currentPhase, gate.reasons)
    }

    const next = getNextPhase(state.currentPhase)
    if (!next) {
      throw new InvalidPhaseTransitionError(state.currentPhase, "NEXT", "已是最终阶段")
    }

    // 标记当前阶段为 COMPLETED
    state.phaseStatus[state.currentPhase] = PhaseLock.COMPLETED
    // 激活下一阶段
    state.phaseStatus[next] = PhaseLock.ACTIVE
    state.currentPhase = next

    // 生成下一阶段的任务
    const nextTasks = createTasksForPhase(state.projectId, next)
    state.tasks.push(...nextTasks)

    // 初始化下一阶段的清单
    if (!state.checklists[next]) {
      state.checklists[next] = createEmptyChecklist(next)
    }

    // 海因里希三角：阶段前进时记录计数
    state.heinrich.majorDefects += 1

    this.store.save(state)
    return state
  }

  /** 回退到指定阶段 */
  rollbackTo(projectId: string, targetPhase: Phase): WorkflowState {
    const state = this.getState(projectId)
    const currentIdx = getPhaseIndex(state.currentPhase)
    const targetIdx = getPhaseIndex(targetPhase)

    if (targetIdx > currentIdx) {
      throw new InvalidPhaseTransitionError(
        state.currentPhase,
        targetPhase,
        "不能回退到后续阶段",
      )
    }

    // 锁定当前阶段后的所有阶段
    for (let i = currentIdx; i >= 0; i--) {
      const phase = PHASE_ORDER[i]
      if (!phase) continue
      if (i > targetIdx) {
        state.phaseStatus[phase] = PhaseLock.LOCKED
      } else if (i === targetIdx) {
        state.phaseStatus[phase] = PhaseLock.ACTIVE
      }
    }

    state.currentPhase = targetPhase
    this.store.save(state)
    return state
  }

  // ── 任务操作 ──

  /** 获取任务列表 */
  getTasks(projectId: string, filter?: TaskFilter): Task[] {
    const state = this.getState(projectId)
    let tasks = [...state.tasks]

    if (filter?.phase) {
      tasks = tasks.filter((t) => t.phase === filter.phase)
    }
    if (filter?.status) {
      tasks = tasks.filter((t) => t.status === filter.status)
    }
    if (filter?.responsibleRole) {
      tasks = tasks.filter((t) => t.responsibleRole === filter.responsibleRole)
    }
    if (filter?.stageId) {
      tasks = tasks.filter((t) => t.stageId === filter.stageId)
    }

    return tasks
  }

  /** 完成任务 */
  completeTask(projectId: string, taskId: string): WorkflowState {
    const state = this.getState(projectId)
    const task = state.tasks.find((t) => t.id === taskId)

    if (!task) {
      throw new Error(`任务不存在: ${taskId}`)
    }

    task.status = TaskStatus.COMPLETED
    task.completedAt = new Date().toISOString()

    this.store.save(state)
    return state
  }

  /** 设置任务状态 */
  setTaskStatus(projectId: string, taskId: string, status: TaskStatus): WorkflowState {
    const state = this.getState(projectId)
    const task = state.tasks.find((t) => t.id === taskId)

    if (!task) {
      throw new Error(`任务不存在: ${taskId}`)
    }

    task.status = status
    if (status === TaskStatus.COMPLETED) {
      task.completedAt = new Date().toISOString()
    }

    this.store.save(state)
    return state
  }

  /** 获取某阶段任务进度 */
  getPhaseProgress(state: WorkflowState, phase: Phase): TaskProgress {
    const tasks = state.tasks.filter((t) => t.phase === phase)
    const total = tasks.length
    const completed = tasks.filter((t) => t.status === TaskStatus.COMPLETED).length
    const inProgress = tasks.filter((t) => t.status === TaskStatus.IN_PROGRESS).length
    const blocked = tasks.filter((t) => t.status === TaskStatus.BLOCKED).length
    const pending = tasks.filter((t) => t.status === TaskStatus.PENDING).length
    const skipped = tasks.filter((t) => t.status === TaskStatus.SKIPPED).length

    return {
      total,
      completed,
      inProgress,
      blocked,
      pending,
      skipped,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    }
  }

  // ── 清单操作 ──

  /** 获取某阶段清单 */
  getChecklist(projectId: string, phase: Phase): Checklist {
    const state = this.getState(projectId)
    return state.checklists[phase] ?? createEmptyChecklist(phase)
  }

  /** 核验清单项 */
  verifyChecklistItem(projectId: string, phase: Phase, itemId: string, role?: Role): WorkflowState {
    const state = this.getState(projectId)
    const checklist = state.checklists[phase]

    if (!checklist) {
      throw new Error(`阶段 ${phase} 没有清单`)
    }

    const item = checklist.items.find((i) => i.id === itemId)
    if (!item) {
      throw new Error(`清单项不存在: ${itemId}`)
    }

    item.status = ChecklistItemStatus.VERIFIED
    if (role) {
      item.verifiedBy = role
    }
    item.verifiedAt = new Date().toISOString()

    this.store.save(state)
    return state
  }

  /** 添加清单项 */
  addChecklistItem(projectId: string, phase: Phase, category: string, description: string): WorkflowState {
    const state = this.getState(projectId)
    if (!state.checklists[phase]) {
      state.checklists[phase] = createEmptyChecklist(phase)
    }

    const checklist = state.checklists[phase]
    if (!checklist) throw new Error("无法创建清单")

    const item: ChecklistItem = {
      id: ChecklistItemId(`cl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      category,
      description,
      status: ChecklistItemStatus.PENDING,
    }

    checklist.items.push(item)
    this.store.save(state)
    return state
  }

  /** 删除清单项 */
  removeChecklistItem(projectId: string, phase: Phase, itemId: string): WorkflowState {
    const state = this.getState(projectId)
    const checklist = state.checklists[phase]

    if (!checklist) throw new Error(`阶段 ${phase} 没有清单`)

    const idx = checklist.items.findIndex((i) => i.id === itemId)
    if (idx === -1) throw new Error(`清单项不存在: ${itemId}`)

    checklist.items.splice(idx, 1)
    this.store.save(state)
    return state
  }

  // ── 海因里希三角操作 ──

  /** 获取海因里希记录 */
  getHeinrichRecord(projectId: string): HeinrichRecord {
    const state = this.getState(projectId)
    return state.heinrich
  }

  /** 记录观测 */
  logObservation(projectId: string, phase: Phase, level: HeinrichLevel, description: string): WorkflowState {
    const state = this.getState(projectId)

    const observation: HeinrichObservation = {
      id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      phase,
      level,
      description,
      notedAt: new Date().toISOString(),
    }

    state.heinrich.observations.push(observation)

    // 更新计数
    if (level === "MAJOR") state.heinrich.majorDefects += 1
    else if (level === "MINOR") state.heinrich.minorDefects += 1
    else if (level === "TRIVIAL") state.heinrich.trivialDefects += 1

    this.store.save(state)
    return state
  }

  /** 解决观测 */
  resolveObservation(projectId: string, obsId: string): WorkflowState {
    const state = this.getState(projectId)
    const obs = state.heinrich.observations.find((o) => o.id === obsId)

    if (!obs) throw new Error(`观测不存在: ${obsId}`)

    obs.resolvedAt = new Date().toISOString()
    this.store.save(state)
    return state
  }

  /** 质量评估 */
  assessQuality(projectId: string): QualityAssessment {
    const state = this.getState(projectId)
    const heinrich = state.heinrich
    const idealRatio = HEINRICH_IDEAL_RATIO as unknown as Record<string, number>
    const major = idealRatio["MAJOR"]!
    const minor = idealRatio["MINOR"]!
    const trivial = idealRatio["TRIVIAL"]!

    if (heinrich.majorDefects === 0) {
      return {
        expectedMinor: 0,
        expectedTrivial: 0,
        actualMinor: heinrich.minorDefects,
        actualTrivial: heinrich.trivialDefects,
        minorRatio: 0,
        trivialRatio: 0,
        verdict: QualityVerdict.INSUFFICIENT_DATA,
      }
    }

    const expectedMinor = heinrich.majorDefects * minor / major
    const expectedTrivial = heinrich.majorDefects * trivial / major
    const minorRatio = heinrich.minorDefects / expectedMinor
    const trivialRatio = heinrich.trivialDefects / expectedTrivial

    let verdict: QualityVerdict
    if (minorRatio < 0.5 || trivialRatio < 0.5) {
      verdict = QualityVerdict.UNDER_REPORTING
    } else if (minorRatio > 2 || trivialRatio > 2) {
      verdict = QualityVerdict.OVER_REPORTING
    } else {
      verdict = QualityVerdict.HEALTHY
    }

    return {
      expectedMinor,
      expectedTrivial,
      actualMinor: heinrich.minorDefects,
      actualTrivial: heinrich.trivialDefects,
      minorRatio,
      trivialRatio,
      verdict,
    }
  }

  // ── 制品操作 ──

  /** 创建制品 */
  createArtifact(
    projectId: string,
    params: {
      type: ArtifactType
      title: string
      description: string
      phase: Phase
      createdBy: Role
      content?: string
      filePath?: string
    },
  ): WorkflowState {
    const state = this.getState(projectId)

    const artifact = {
      id: ArtifactId(`art_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      type: params.type,
      title: params.title,
      description: params.description,
      phase: params.phase,
      version: "0.1.0",
      createdBy: params.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(params.content !== undefined ? { content: params.content } : {}),
      ...(params.filePath !== undefined ? { filePath: params.filePath } : {}),
    } as Artifact

    state.artifacts.push(artifact)
    this.store.save(state)
    return state
  }

  /** 获取制品列表 */
  getArtifacts(projectId: string, phase?: Phase, type?: string): Artifact[] {
    const state = this.getState(projectId)
    let artifacts = [...state.artifacts]

    if (phase) {
      artifacts = artifacts.filter((a) => a.phase === phase)
    }
    if (type) {
      artifacts = artifacts.filter((a) => a.type === type)
    }

    return artifacts
  }
}
