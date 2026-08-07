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

import type { WorkflowState, ProjectStatusSummary } from "@octopus/core/workflow.js"
import { Phase, PhaseLock, getPhaseIndex, getNextPhase, getPreviousPhase, PHASE_ORDER } from "@octopus/core/phase.js"
import type { Task, TaskFilter, TaskProgress } from "@octopus/core/task.js"
import { TaskStatus } from "@octopus/core/task.js"
import { StageStatus } from "@octopus/core/task.js"
import type { StageProgress, StageInfo } from "@octopus/core/task.js"
import type { Checklist, ChecklistItem } from "@octopus/core/checklist.js"
import { ChecklistItemStatus } from "@octopus/core/checklist.js"
import type { HeinrichRecord, HeinrichObservation, QualityAssessment } from "@octopus/core/risk.js"
import { QualityVerdict, HEINRICH_IDEAL_RATIO, createEmptyHeinrichRecord, HeinrichLevel } from "@octopus/core/risk.js"
import type { Artifact, ArtifactType } from "@octopus/core/artifact.js"
import type { ProjectId } from "@octopus/core/branded-ids.js"
import { PhaseId, TaskId, ChecklistItemId, ObservationId, ArtifactId } from "@octopus/core/branded-ids.js"
import { Role } from "@octopus/core/role.js"
import { InvalidPhaseTransitionError, PhaseLockedError } from "@octopus/core/errors.js"
import { createEmptyState, stepToTask, stepToStageInfo } from "@octopus/core/workflow.js"
import type { StepRuntime } from "@octopus/core/step.js"
import { createEmptyChecklist } from "@octopus/core/checklist.js"
import type { StateStore } from "@octopus/context/index.js"
import { createStateStore } from "@octopus/context/index.js"
import { initializeWorkflowFile, loadWorkflowDefinition } from "@octopus/context/workflow.js"
import type { OctopusConfig } from "@octopus/context/config.js"
import { toAIClientConfig } from "@octopus/context/config.js"
import { createStepsForPhase, createStepsFromDefinition } from "@octopus/task-library/index.js"
import type { AIClient } from "@octopus/agent-layer/index.js"
import { createAIClient } from "@octopus/agent-layer/index.js"
import type { AIEventHandler, AIEventPayload, AIGateResult } from "@octopus/core/agent.js"
import type { IntegrationService } from "@octopus/integration/index.js"
import { CapabilityRegistry } from "./capabilities.js"
import type { CapabilityContext } from "./capabilities.js"
import { NodeExecutionService } from "./execution.js"
import type { IntegrationHealth, NodeRun, WorkflowExecutionSnapshot } from "@octopus/core/execution.js"
import type { RunNodeOptions, RunWorkflowOptions } from "./execution.js"

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
  /** 外部集成服务表（capability 的 integration handler 按 service 名解析） */
  integrations?: Record<string, IntegrationService>
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
  private readonly registry: CapabilityRegistry
  private readonly integrations: Record<string, IntegrationService>
  private readonly nodeExecution: NodeExecutionService
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
    this.registry = new CapabilityRegistry()
    this.integrations = config.integrations ?? {}
    this.nodeExecution = new NodeExecutionService(this.store)
  }

  /** 节点运行与监控服务。 */
  get execution(): NodeExecutionService {
    return this.nodeExecution
  }

  /** 获取当前节点、READY 节点和活动运行摘要。 */
  getExecutionSnapshot(projectId: string): WorkflowExecutionSnapshot {
    return this.nodeExecution.getSnapshot(projectId)
  }

  /** 独立运行一个节点。 */
  runNode(projectId: string, nodeId: string, options?: RunNodeOptions): NodeRun {
    return this.nodeExecution.runNode(projectId, nodeId, options)
  }

  /** 自动并行运行所有 READY 节点。 */
  runWorkflow(projectId: string, options?: RunWorkflowOptions): Promise<WorkflowExecutionSnapshot> {
    return this.nodeExecution.runWorkflow(projectId, options)
  }

  /** 检查已注入的集成并持久化健康度。 */
  async checkIntegrationHealth(): Promise<IntegrationHealth[]> {
    const results: IntegrationHealth[] = []
    for (const [serviceName, service] of Object.entries(this.integrations)) {
      const startedAt = Date.now()
      try {
        const result = await service.healthCheck()
        const health: IntegrationHealth = {
          service: serviceName,
          healthy: result.success,
          latencyMs: Date.now() - startedAt,
          message: result.message,
          checkedAt: new Date().toISOString(),
        }
        this.nodeExecution.saveIntegrationHealth(health)
        results.push(health)
      } catch (cause) {
        const health: IntegrationHealth = {
          service: serviceName,
          healthy: false,
          latencyMs: Date.now() - startedAt,
          message: (cause as Error).message,
          checkedAt: new Date().toISOString(),
        }
        this.nodeExecution.saveIntegrationHealth(health)
        results.push(health)
      }
    }
    return results
  }

  getIntegrationHealth(): IntegrationHealth[] {
    return this.nodeExecution.listIntegrationHealth()
  }

  /** 暴露 capability 注册表以便注册自定义处理器 */
  get capabilities(): CapabilityRegistry {
    return this.registry
  }

  /**
   * 分发某步骤声明的 capabilities（AI / 集成 / Heinrich）。
   * 改 spec 步骤上的 capability 即可增删行为，无需改本方法。
   */
  async runStepCapabilities(projectId: string, stepId: string): Promise<WorkflowState> {
    const state = this.getState(projectId)
    const step = state.steps.find((s) => s.id === stepId)
    if (!step) {
      throw new Error(`步骤不存在: ${stepId}`)
    }

    const caps = step.capabilities ?? []
    if (caps.length === 0) {
      return state
    }

    const ctx: CapabilityContext = {
      state,
      step,
      aiClient: this.aiClient,
      integrations: this.integrations,
    }
    const runs = step.capabilityRuns ?? []
    for (const ref of caps) {
      const result = await this.registry.dispatch(ref, ctx)
      runs.push({
        kind: result.kind,
        ref: result.ref,
        ok: result.ok,
        at: new Date().toISOString(),
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
      })
    }
    step.capabilityRuns = runs
    step.updatedAt = new Date().toISOString()

    // capability 可能改变 Heinrich 条数，检查审计触发
    this.checkHeinrichAuditTrigger(state, step.phase)

    this.store.save(state)
    return state
  }

  // ── 项目生命周期 ──

  /** 初始化新项目 */
  initProject(name: string, description?: string, projectRoot?: string): WorkflowState {
    const definition = projectRoot
      ? (initializeWorkflowFile(projectRoot), loadWorkflowDefinition(projectRoot))
      : undefined
    const state = this.store.createProject(name, description, projectRoot)

    // 为当前阶段生成步骤（唯一真相源：tasks 与 stages 已统一为 steps）
    state.steps = definition
      ? createStepsFromDefinition(state.projectId, definition, state.currentPhase)
      : createStepsForPhase(state.projectId, state.currentPhase)
    state.checklists[state.currentPhase] = createEmptyChecklist(state.currentPhase)
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
      totalTasks: state.steps.length,
      completedTasks: state.steps.filter((s) => s.status === TaskStatus.COMPLETED).length,
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

  /** 触发 AI 门控事件（同步门控；异步处理器暂不支持，跳过） */
  private emitAIEvent(payload: AIEventPayload): AIGateResult {
    for (const handler of this.aiHandlers) {
      const result = handler(payload)
      if (result instanceof Promise) continue
      if (!result.allowed) {
        return result
      }
    }
    return { allowed: true }
  }

  // ── Stage 生命周期 ──

  /** 更新步骤状态（按步骤 id；status 沿用 StageStatus 值域，与 TaskStatus 等价） */
  updateStageStatus(projectId: string, stageId: string, status: StageStatus): WorkflowState {
    const state = this.getState(projectId)
    const step = state.steps.find((s) => s.id === stageId)

    if (!step) {
      throw new Error(`阶段步骤不存在: ${stageId}`)
    }

    step.status = status as unknown as TaskStatus
    step.updatedAt = new Date().toISOString()
    if (status === StageStatus.COMPLETED) {
      step.completedAt = new Date().toISOString()
    }

    this.store.save(state)
    return state
  }

  /** 获取步骤运行态视图（StageInfo，从 steps 派生） */
  getStageInfos(projectId: string, phase?: Phase): StageInfo[] {
    const state = this.getState(projectId)
    const steps = phase ? state.steps.filter((s) => s.phase === phase) : state.steps
    return steps.map(stepToStageInfo)
  }

  /** 获取单个步骤运行态视图 */
  getStageInfo(projectId: string, stageId: string): StageInfo | undefined {
    const state = this.getState(projectId)
    const step = state.steps.find((s) => s.id === stageId)
    return step ? stepToStageInfo(step) : undefined
  }

  /** 检查步骤依赖是否满足（与任务门控读取同一 steps 真相源） */
  private checkStageDependencies(state: WorkflowState, phase: Phase): GateCheckResult {
    const reasons: string[] = []
    const phaseSteps = state.steps.filter((s) => s.phase === phase)

    for (const step of phaseSteps) {
      if (step.status === TaskStatus.SKIPPED) continue
      if (step.dependsOn.length === 0) continue

      const unmet = step.dependsOn.filter((depId) => {
        const dep = state.steps.find((s) => s.id === depId)
        return !dep || dep.status !== TaskStatus.COMPLETED
      })

      if (unmet.length > 0) {
        reasons.push(`阶段步骤 ${step.id} 依赖未满足: ${unmet.join(", ")}`)
      }
    }

    return { allowed: reasons.length === 0, reasons }
  }

  /** 获取阶段步骤进度 */
  getStageProgress(projectId: string, phase: Phase): StageProgress {
    const state = this.getState(projectId)
    const phaseSteps = state.steps.filter((s) => s.phase === phase)
    const total = phaseSteps.length
    const completed = phaseSteps.filter((s) => s.status === TaskStatus.COMPLETED).length
    const inProgress = phaseSteps.filter((s) => s.status === TaskStatus.IN_PROGRESS).length
    const blocked = phaseSteps.filter((s) => s.status === TaskStatus.BLOCKED).length
    const pending = phaseSteps.filter((s) => s.status === TaskStatus.PENDING).length
    const skipped = phaseSteps.filter((s) => s.status === TaskStatus.SKIPPED).length

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

    // 2. 检查当前阶段所有步骤是否已完成
    const phaseSteps = state.steps.filter((s) => s.phase === currentPhase)
    const pendingSteps = phaseSteps.filter((s) => s.status !== TaskStatus.COMPLETED && s.status !== TaskStatus.SKIPPED)
    if (pendingSteps.length > 0) {
      reasons.push(`有 ${pendingSteps.length} 个任务未完成`)
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
  advancePhase(projectId: string, skipAiGating?: boolean): WorkflowState {
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
          ...(aiResult.reason !== undefined ? { reason: aiResult.reason } : {}),
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

    // 生成下一阶段的步骤（唯一真相源）
    const existingIds = new Set(state.steps.map((s) => s.id))
    const definition = state.projectRoot ? loadWorkflowDefinition(state.projectRoot) : undefined
    const nextSteps = definition
      ? createStepsFromDefinition(state.projectId, definition, next)
      : createStepsForPhase(state.projectId, next)
    for (const step of nextSteps) {
      if (!existingIds.has(step.id)) {
        state.steps.push(step)
      }
    }

    // 初始化下一阶段的清单
    if (!state.checklists[next]) {
      state.checklists[next] = createEmptyChecklist(next)
    }

    // Checklist 继承
    this.inheritChecklist(state, state.currentPhase)

    // 海因里希三角：阶段前进时记录条数触发计数
    state.heinrich.triggerCounts[next] = (state.heinrich.triggerCounts[next] ?? 0) + 1

    // Heinrich 条数审计触发
    this.checkHeinrichAuditTrigger(state, next)

    // 注：阶段前进时的 AI Checklist 增量推荐已迁移为 spec 步骤 capability，
    // 由 runStepCapabilities 显式触发（见 Phase 3），此处不再内联异步调用。

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
          ...(aiResult.reason !== undefined ? { reason: aiResult.reason } : {}),
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

  /** 获取任务列表（从 steps 派生 Task 视图） */
  getTasks(projectId: string, filter?: TaskFilter): Task[] {
    const state = this.getState(projectId)
    let tasks = state.steps.map(stepToTask)

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

  /** 完成任务（按 taskId 定位对应步骤） */
  completeTask(projectId: string, taskId: string, role?: Role): WorkflowState {
    const state = this.getState(projectId)
    const step = state.steps.find((s) => s.taskId === taskId)

    if (!step) {
      throw new Error(`任务不存在: ${taskId}`)
    }

    if (role) {
      this.requireRole(projectId, taskId, role, step.responsibleRole)
    }

    step.status = TaskStatus.COMPLETED
    step.completedAt = new Date().toISOString()
    step.updatedAt = new Date().toISOString()

    this.store.save(state)
    return state
  }

  /** 设置任务状态 */
  setTaskStatus(projectId: string, taskId: string, status: TaskStatus): WorkflowState {
    const state = this.getState(projectId)
    const step = state.steps.find((s) => s.taskId === taskId)

    if (!step) {
      throw new Error(`任务不存在: ${taskId}`)
    }

    step.status = status
    step.updatedAt = new Date().toISOString()
    if (status === TaskStatus.COMPLETED) {
      step.completedAt = new Date().toISOString()
    }

    this.store.save(state)
    return state
  }

  /** 获取某阶段任务进度 */
  getPhaseProgress(state: WorkflowState, phase: Phase): TaskProgress {
    const steps = state.steps.filter((s) => s.phase === phase)
    const total = steps.length
    const completed = steps.filter((s) => s.status === TaskStatus.COMPLETED).length
    const inProgress = steps.filter((s) => s.status === TaskStatus.IN_PROGRESS).length
    const blocked = steps.filter((s) => s.status === TaskStatus.BLOCKED).length
    const pending = steps.filter((s) => s.status === TaskStatus.PENDING).length
    const skipped = steps.filter((s) => s.status === TaskStatus.SKIPPED).length

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
      const now = new Date().toISOString()
      const auditId = `heinrich.audit.${phase}`
      // 幂等：同阶段审计步骤只创建一次
      if (state.steps.some((s) => s.id === auditId)) return
      const auditStep: StepRuntime = {
        id: auditId,
        taskId: TaskId(`heinrich_audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        phase,
        name: `Heinrich 质量审计 - ${phase}`,
        description: `阶段 ${phase} 的 Heinrich 条数已达到阈值 ${this.heinrichThreshold}，需进行质量评估。`,
        responsibleRole: Role.HEI,
        status: TaskStatus.PENDING,
        dependsOn: [],
        artifactIds: [],
        createdAt: now,
        updatedAt: now,
      }

      state.steps.push(auditStep)
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

/**
 * 从配置创建 WorkflowEngine 实例。
 *
 * 组合根：装配 StateStore + AIClient。放在引擎包内以避免
 * context 反向依赖 workflow-engine 造成的循环依赖。
 */
export function createWorkflowEngineFromConfig(config: OctopusConfig): WorkflowEngine {
  const store = createStateStore({ storeDir: config.storeDir })
  return new WorkflowEngine({
    store,
    aiClient: createAIClient(toAIClientConfig(config)),
    strictPermissions: config.workflow.strictPermissions,
    aiGatingEnabled: config.workflow.aiGatingEnabled,
    heinrichThreshold: config.workflow.heinrichThreshold,
  })
}
