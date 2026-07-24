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
import { Phase, PhaseLock, getPhaseIndex, getNextPhase, getPreviousPhase, PHASE_ORDER, getPhaseDef } from "@octopus/core/phase.js"
import type { Task, TaskFilter, TaskProgress } from "@octopus/core/task.js"
import { TaskStatus } from "@octopus/core/task.js"
import { StageStatus, StageProgress, StageInfo } from "@octopus/core/task.js"
import type { Checklist, ChecklistItem } from "@octopus/core/checklist.js"
import { ChecklistItemStatus } from "@octopus/core/checklist.js"
import type { HeinrichRecord, HeinrichObservation, QualityAssessment } from "@octopus/core/risk.js"
import { QualityVerdict, HEINRICH_IDEAL_RATIO, createEmptyHeinrichRecord, HeinrichLevel } from "@octopus/core/risk.js"
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
import type { AIEventHandler, AIEventPayload, AIGateResult } from "@octopus/core/agent.js"

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
  /** 是否启用严格权限校验 */
  strictPermissions?: boolean
  /** AI 门控开关 */
  aiGatingEnabled?: boolean
  /** 海因里希条数阈值 */
  heinrichThreshold?: number
}

/**
 * 工作流引擎 —— 所有阶段/任务/清单/风险/制品操作的统一入口。
 */
export class WorkflowEngine {
  private readonly store: StateStore
  private readonly aiClient: AIClient | undefined
  private readonly strictPermissions: boolean
  private readonly aiGatingEnabled: boolean
  private readonly heinrichThreshold: number
  private aiHandlers: Array<(event: {
    type: "onPhaseAdvance" | "onPhaseRollback"
    from: Phase
    to: Phase
    state: WorkflowState
  }) => Promise<{ allowed: boolean; reason?: string }> | { allowed: boolean; reason?: string }> = []

  constructor(config: WorkflowEngineConfig) {
    this.store = config.store
    this.aiClient = config.aiClient
    this.strictPermissions = config.strictPermissions ?? false
    this.aiGatingEnabled = config.aiGatingEnabled ?? false
    this.heinrichThreshold = config.heinrichThreshold ?? 3
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

    // 初始化阶段步骤运行态
    const phaseDef = getPhaseDef(state.currentPhase)
    for (const stage of phaseDef.stages) {
      state.stages[stage.id] = {
        stageId: stage.id,
        phase: state.currentPhase,
        status: StageStatus.PENDING,
        dependsOn: stage.dependsOn,
        responsibleRole: stage.responsibleRoles[0] ?? Role.AI,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    }

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

  // ── AI 门控 ──

  /** 注册 AI 门控处理器 */
  registerAIHandler(handler: AIEventHandler): void {
    this.aiHandlers.push(handler)
  }

  /** 触发 AI 门控事件 */
  private emitAIEvent(payload: AIEventPayload): AIGateResult {
    for (const handler of this.aiHandlers) {
      const result = handler(payload)
      if (result && !result.allowed) {
        return result
      }
    }
    return { allowed: true }
  }

  // ── Stage 生命周期 ──

  /** 更新阶段步骤状态 */
  updateStageStatus(projectId: string, stageId: string, status: StageStatus): WorkflowState {
    const state = this.getState(projectId)
    const stage = state.stages[stageId]

    if (!stage) {
      throw new Error(`阶段步骤不存在: ${stageId}`)
    }

    stage.status = status
    stage.updatedAt = new Date().toISOString()
    if (status === StageStatus.COMPLETED) {
      stage.completedAt = new Date().toISOString()
    }

    this.store.save(state)
    return state
  }

  /** 检查阶段步骤依赖是否满足 */
  private checkStageDependencies(state: WorkflowState, phase: Phase): GateCheckResult {
    const reasons: string[] = []
    const phaseStages = Object.values(state.stages).filter((s) => s.phase === phase)

    for (const stage of phaseStages) {
      if (stage.status === StageStatus.SKIPPED) continue
      if (stage.dependsOn.length === 0) continue

      const unmet = stage.dependsOn.filter((depId) => {
        const dep = state.stages[depId]
        return !dep || dep.status !== StageStatus.COMPLETED
      })

      if (unmet.length > 0) {
        reasons.push(`阶段步骤 ${stage.stageId} 依赖未满足: ${unmet.join(", ")}`)
      }
    }

    return { allowed: reasons.length === 0, reasons }
  }

  /** 获取阶段步骤进度 */
  getStageProgress(projectId: string, phase: Phase): StageProgress {
    const state = this.getState(projectId)
    const phaseStages = Object.values(state.stages).filter((s) => s.phase === phase)
    const total = phaseStages.length
    const completed = phaseStages.filter((s) => s.status === StageStatus.COMPLETED).length
    const inProgress = phaseStages.filter((s) => s.status === StageStatus.IN_PROGRESS).length
    const blocked = phaseStages.filter((s) => s.status === StageStatus.BLOCKED).length
    const pending = phaseStages.filter((s) => s.status === StageStatus.PENDING).length
    const skipped = phaseStages.filter((s) => s.status === StageStatus.SKIPPED).length

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
  async advancePhase(projectId: string, skipAiGating?: boolean): Promise<WorkflowState> {
    const state = this.getState(projectId)
    const gate = this.checkAdvanceGate(state)

    if (!gate.allowed) {
      throw new PhaseLockedError(state.currentPhase, gate.reasons)
    }

    // Stage 依赖检查
    const stageGate = this.checkStageDependencies(state, state.currentPhase)
    if (!stageGate.allowed) {
      throw new PhaseLockedError(state.currentPhase, stageGate.reasons)
    }

    const next = getNextPhase(state.currentPhase)
    if (!next) {
      throw new InvalidPhaseTransitionError(state.currentPhase, "NEXT", "已是最终阶段")
    }

    // AI 门控
    if (this.aiGatingEnabled && !skipAiGating) {
      const aiResult = this.emitAIEvent({
        type: "onPhaseAdvance",
        from: state.currentPhase,
        to: next,
        state,
      })

      if (!aiResult.allowed) {
        state.aiGateResults.push({
          phase: state.currentPhase,
          allowed: false,
          reason: aiResult.reason,
          timestamp: new Date().toISOString(),
        })
        this.store.save(state)
        throw new PhaseLockedError(state.currentPhase, [`AI 门控拒绝: ${aiResult.reason ?? "未通过预检查"}`])
      }

      state.aiGateResults.push({
        phase: state.currentPhase,
        allowed: true,
        timestamp: new Date().toISOString(),
      })
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

    // Checklist 继承
    this.inheritChecklist(state, state.currentPhase)

    // 初始化下一阶段 Stage 运行态
    const nextPhaseDef = getPhaseDef(next)
    for (const stage of nextPhaseDef.stages) {
      if (!state.stages[stage.id]) {
        state.stages[stage.id] = {
          stageId: stage.id,
          phase: next,
          status: StageStatus.PENDING,
          dependsOn: stage.dependsOn,
          responsibleRole: stage.responsibleRoles[0] ?? Role.AI,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
      }
    }

    // 海因里希三角：阶段前进时记录条数触发计数
    state.heinrich.triggerCounts[next] = (state.heinrich.triggerCounts[next] ?? 0) + 1

    // Heinrich 条数审计触发
    this.checkHeinrichAuditTrigger(state, next)

    // AI checklist 增量推荐（尽力而为，不阻塞）
    if (this.aiClient) {
      try {
        const scope = `Phase transition from ${state.currentPhase} to ${next}`
        const recommendation = await this.aiClient.recommendChecklistItems(scope)
        const parsed = JSON.parse(recommendation.result ?? "[]") as Array<{ category: string; description: string }>
        const target = state.checklists[next]
        if (target && Array.isArray(parsed)) {
          for (const item of parsed) {
            target.items.push({
              id: ChecklistItemId(`cl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
              category: item.category ?? "AI Recommended",
              description: item.description,
              status: ChecklistItemStatus.PENDING,
              inherited: false,
            })
          }
        }
      } catch {
        // AI 推荐失败不影响阶段前进
      }
    }

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

    // AI 门控
    if (this.aiGatingEnabled) {
      const aiResult = this.emitAIEvent({
        type: "onPhaseRollback",
        from: state.currentPhase,
        to: targetPhase,
        state,
      })

      if (!aiResult.allowed) {
        state.aiGateResults.push({
          phase: state.currentPhase,
          allowed: false,
          reason: aiResult.reason,
          timestamp: new Date().toISOString(),
        })
        this.store.save(state)
        throw new PhaseLockedError(state.currentPhase, [`AI 门控拒绝回退: ${aiResult.reason ?? "未通过预检查"}`])
      }

      state.aiGateResults.push({
        phase: state.currentPhase,
        allowed: true,
        timestamp: new Date().toISOString(),
      })
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

  // ── 权限校验 ──

  /** 校验当前操作角色是否有权限 */
  private requireRole(projectId: string, taskId: string, userRole: Role, requiredRole: Role): void {
    if (!this.strictPermissions) return
    if (userRole !== requiredRole) {
      throw new Error(`权限不足: 需要角色 ${requiredRole}，当前角色 ${userRole}`)
    }
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
  completeTask(projectId: string, taskId: string, role?: Role): WorkflowState {
    const state = this.getState(projectId)
    const task = state.tasks.find((t) => t.id === taskId)

    if (!task) {
      throw new Error(`任务不存在: ${taskId}`)
    }

    if (role) {
      this.requireRole(projectId, taskId, role, task.responsibleRole)
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

    if (role && this.strictPermissions) {
      if (item.verifiedBy && role !== item.verifiedBy) {
        throw new Error(`权限不足: 清单项需要角色 ${item.verifiedBy}，当前角色 ${role}`)
      }
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

  /** 记录海因里希条数标记 */
  logHeinrichMarker(projectId: string, phase: Phase, description?: string): WorkflowState {
    const state = this.getState(projectId)
    state.heinrich.triggerCounts[phase] = (state.heinrich.triggerCounts[phase] ?? 0) + 1

    state.heinrich.observations.push({
      id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      phase,
      level: HeinrichLevel.TRIVIAL,
      description: description ?? `Heinrich marker at ${phase}`,
      notedAt: new Date().toISOString(),
    })

    this.store.save(state)
    return state
  }

  /** 检查 Heinrich 条数是否达到审计阈值 */
  private checkHeinrichAuditTrigger(state: WorkflowState, phase: Phase): void {
    const count = state.heinrich.triggerCounts[phase] ?? 0
    if (count >= this.heinrichThreshold) {
      const auditTask: Task = {
        id: TaskId(`heinrich_audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        stageId: `heinrich.audit.${phase}`,
        phase,
        title: `Heinrich 质量审计 - ${phase}`,
        description: `阶段 ${phase} 的 Heinrich 条数已达到阈值 ${this.heinrichThreshold}，需进行质量评估。`,
        responsibleRole: Role.HEI,
        status: TaskStatus.PENDING,
        artifactIds: [],
        createdAt: new Date().toISOString(),
      }

      state.tasks.push(auditTask)
    }
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
      const assessment = {
        expectedMinor: 0,
        expectedTrivial: 0,
        actualMinor: heinrich.minorDefects,
        actualTrivial: heinrich.trivialDefects,
        minorRatio: 0,
        trivialRatio: 0,
        verdict: QualityVerdict.INSUFFICIENT_DATA,
      }

      state.heinrich.observations.push({
        id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        phase: state.currentPhase,
        level: HeinrichLevel.TRIVIAL,
        description: `Quality assessment: ${assessment.verdict}`,
        notedAt: new Date().toISOString(),
      })

      this.store.save(state)
      return assessment
    }

    if (heinrich.minorDefects === 0 && heinrich.trivialDefects === 0) {
      const assessment = {
        expectedMinor: 0,
        expectedTrivial: 0,
        actualMinor: heinrich.minorDefects,
        actualTrivial: heinrich.trivialDefects,
        minorRatio: 0,
        trivialRatio: 0,
        verdict: QualityVerdict.INSUFFICIENT_DATA,
      }

      state.heinrich.observations.push({
        id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        phase: state.currentPhase,
        level: HeinrichLevel.TRIVIAL,
        description: `Quality assessment: ${assessment.verdict}`,
        notedAt: new Date().toISOString(),
      })

      this.store.save(state)
      return assessment
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

    const assessment = {
      expectedMinor,
      expectedTrivial,
      actualMinor: heinrich.minorDefects,
      actualTrivial: heinrich.trivialDefects,
      minorRatio,
      trivialRatio,
      verdict,
    }

    state.heinrich.observations.push({
      id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      phase: state.currentPhase,
      level: HeinrichLevel.TRIVIAL,
      description: `Quality assessment: ${verdict} (minorRatio=${minorRatio.toFixed(2)}, trivialRatio=${trivialRatio.toFixed(2)})`,
      notedAt: new Date().toISOString(),
    })

    this.store.save(state)
    return assessment
  }

  // ── Checklist 继承 ──

  /** 继承上一阶段清单到当前阶段 */
  private inheritChecklist(state: WorkflowState, currentPhase: Phase): void {
    const previous = getPreviousPhase(currentPhase)
    if (!previous) return

    const source = state.checklists[previous]
    if (!source) return

    if (!state.checklists[currentPhase]) {
      state.checklists[currentPhase] = createEmptyChecklist(currentPhase)
    }

    const target = state.checklists[currentPhase]
    if (!target) return

    for (const item of source.items) {
      if (item.status === ChecklistItemStatus.VERIFIED || item.status === ChecklistItemStatus.NA) {
        target.items.push({
          ...item,
          id: ChecklistItemId(`cl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
          status: item.status,
          inherited: true,
          notes: `${item.notes ?? ""} Inherited from ${previous}`.trim(),
        })
      }
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
