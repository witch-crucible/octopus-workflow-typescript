/**
 * Workflow Engine 包 —— 工作流状态机引擎。
 *
 * 阶段转换、任务生命周期与阶段门控校验均为命令式实现（不使用 xstate）。
 * 状态持久化通过 @octopus/context 的 StateStore 完成；所有读改写方法
 * 都在 store.update 的单个 SQLite 事务内执行，避免并发写入互相覆盖。
 *
 * 阶段转换规则（映射 PlantUML）：
 * - 只能按顺序前进：INTENTION → RESEARCH → DESIGN → IMPLEMENTATION → TESTING → UAT → RELEASE → MAINTENANCE → COMPLETED
 * - 可回退到任何前置阶段
 * - 前进前必须满足退出条件：所有任务已完成 + 清单已核验
 */

import type {
  WorkflowState,
  RequirementStatusSummary,
  RequirementSummary,
  RequirementTeambitionBinding,
} from "@octopus/core/workflow.js"
import type { Project, ProjectSummary, ProjectTeambitionBinding } from "@octopus/core/project.js"
import {
  BRD_DESIGN_METADATA_KEY,
  mergeBrdDesignConfig,
  parseBrdDesignConfigFromMetadata,
  serializeBrdDesignConfig,
  type ProjectBrdDesignConfig,
  type ProjectBrdDesignConfigPatch,
} from "@octopus/core/brd-design.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import { dirname } from "node:path"
import {
  encodeBrdPromptEnvelope,
  gatherBrdSourceContext,
  renderBrdPromptsForContext,
  resolveBrdCheckReportPath,
  toProjectRelative,
  type BrdRenderedPrompt,
} from "./brd-context.js"
import { Phase, PhaseLock, getPhaseIndex, getNextPhase, getPreviousPhase, PHASE_ORDER } from "@octopus/core/phase.js"
import type {
  Task,
  TaskExportDocument,
  TaskFilter,
  TaskImportResult,
  TaskProgress,
} from "@octopus/core/task.js"
import { TaskStatus } from "@octopus/core/task.js"
import { StageStatus } from "@octopus/core/task.js"
import type { StageProgress, StageInfo } from "@octopus/core/task.js"
import type { Checklist } from "@octopus/core/checklist.js"
import { ChecklistItemStatus } from "@octopus/core/checklist.js"
import type { HeinrichRecord, HeinrichObservation, QualityAssessment } from "@octopus/core/risk.js"
import { QualityVerdict, HEINRICH_IDEAL_RATIO, createEmptyHeinrichRecord, HeinrichLevel } from "@octopus/core/risk.js"
import { ArtifactType, type Artifact } from "@octopus/core/artifact.js"
import { PhaseId, TaskId, ChecklistItemId, ObservationId, ArtifactId, MilestoneId } from "@octopus/core/branded-ids.js"
import { Role } from "@octopus/core/role.js"
import { InvalidPhaseTransitionError, PhaseLockedError } from "@octopus/core/errors.js"
import {
  MilestoneStatus,
  assertMilestonePhase,
  isMilestoneOverdue,
  nextOpenMilestone,
  normalizeMilestoneDate,
  normalizeMilestoneName,
  normalizeMilestoneNote,
  sortMilestones,
  todayYmd,
  type ProjectMilestone,
  type RequirementMilestone,
} from "@octopus/core/milestone.js"
import type { MyWorkItem, MyWorkList, ProjectOverview } from "@octopus/core/my-work.js"
import { stepToTask, stepToStageInfo } from "@octopus/core/workflow.js"
import type { StepRuntime } from "@octopus/core/step.js"
import { createEmptyChecklist } from "@octopus/core/checklist.js"
import type { StateStore } from "@octopus/context/index.js"
import { createStateStore } from "@octopus/context/index.js"
import {
  appendWorkflowNode,
  initializeWorkflowFile,
  loadWorkflowDefinition,
  loadResolvedWorkflowDefinition,
  loadWorkflowPluginRefs,
  resolveWorkflowNodeId,
  resolveWorkflowNodeKey,
} from "@octopus/context/workflow.js"
import type { OctopusConfig } from "@octopus/context/config.js"
import { toAIClientConfig, loadConfig } from "@octopus/context/config.js"
import {
  createStepFromNode,
  createStepsForPhase,
  createStepsFromDefinition,
} from "@octopus/task-library/index.js"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import type { AIClient } from "@octopus/agent-layer/index.js"
import { createAIClient } from "@octopus/agent-layer/index.js"
import type { AIEventHandler, AIEventPayload, AIGateResult } from "@octopus/core/agent.js"
import type { IntegrationService } from "@octopus/integration/index.js"
import {
  TeambitionClient,
  createTeambitionClient,
  type WorkflowStatus,
  type TbTask,
} from "@octopus/integration/index.js"
import {
  parseOmniPlanActual,
  buildOmniPlanActual,
  buildTocXml,
  packOplx,
  unpackOplx,
  resolveOmniPlanFolder,
  resolveOmniPlanFileName,
  validateOmniPlanName,
  omniPlanIsoToDate,
  type OmniPlanBuildInput,
  type OmniPlanImportResult,
} from "@octopus/integration/index.js"
import type { PluginHost } from "@octopus/plugin/index.js"
import { emptyPluginHost, loadPlugins } from "@octopus/plugin/index.js"
import { CapabilityRegistry } from "./capabilities.js"
import type { CapabilityContext } from "./capabilities.js"
import { NodeExecutionService } from "./execution.js"
import type {
  IntegrationHealth,
  NodeRun,
  WorkflowDefinition,
  WorkflowExecutionSnapshot,
  WorkflowNodeSpec,
} from "@octopus/core/execution.js"
import type { RunNodeOptions, RunWorkflowOptions } from "./execution.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 同步阻塞休眠（微秒级退避用；Node 主线程可用） */
function sleep(ms: number): void {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    // busy wait
  }
}

/** 是否 SQLite 并发写锁冲突（可重试） */
function isWriteLockError(cause: unknown): boolean {
  const err = cause as { code?: string; message?: string }
  return err?.code === "SQLITE_BUSY" || (typeof err?.message === "string" && err.message.includes("database is locked"))
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function requirementMilestoneSummary(state: WorkflowState): {
  milestoneCount?: number
  nextMilestone?: { id: string; name: string; date: string; overdue: boolean }
} {
  const milestones = state.milestones ?? []
  if (milestones.length === 0) return {}
  const next = nextOpenMilestone(milestones)
  return {
    milestoneCount: milestones.length,
    ...(next
      ? {
          nextMilestone: {
            id: next.id,
            name: next.name,
            date: next.date,
            overdue: isMilestoneOverdue(next),
          },
        }
      : {}),
  }
}

/** 本地日历日 YYYY-MM-DD（不做时区换算）。 */
function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [yearText, monthText, dayText] = value.split("-")
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

function identityMatches(value: string | undefined, identity: string): boolean {
  return (value ?? "").trim().toLowerCase() === identity.trim().toLowerCase()
}

function validateTaskExportDocument(document: unknown): TaskExportDocument {
  if (!isRecord(document)) {
    throw new Error("任务导入文件必须是 JSON 对象")
  }
  if (document["format"] !== "octopus.tasks") {
    throw new Error("不支持的任务导入文件格式")
  }
  if (document["version"] !== 1) {
    throw new Error(`不支持的任务导入文件版本: ${String(document["version"])}`)
  }
  if (!isIsoDate(document["exportedAt"])) {
    throw new Error("任务导入文件的 exportedAt 无效")
  }

  const sourceRequirement = document["sourceRequirement"] ?? document["sourceProject"]
  if (!isRecord(sourceRequirement)) {
    throw new Error("任务导入文件的 sourceRequirement 无效")
  }
  const hasRequirementShape =
    typeof sourceRequirement["requirementId"] === "string"
    && sourceRequirement["requirementId"].length > 0
    && typeof sourceRequirement["requirementName"] === "string"
    && typeof sourceRequirement["projectId"] === "string"
    && sourceRequirement["projectId"].length > 0
  const hasLegacyProjectShape =
    typeof sourceRequirement["projectId"] === "string"
    && sourceRequirement["projectId"].length > 0
    && typeof sourceRequirement["projectName"] === "string"
  if (!hasRequirementShape && !hasLegacyProjectShape) {
    throw new Error("任务导入文件的 sourceRequirement 无效")
  }
  if (hasLegacyProjectShape && !hasRequirementShape) {
    document["sourceRequirement"] = {
      projectId: sourceRequirement["projectId"],
      requirementId: sourceRequirement["projectId"],
      requirementName: sourceRequirement["projectName"],
    }
  } else {
    document["sourceRequirement"] = {
      projectId: sourceRequirement["projectId"],
      requirementId: sourceRequirement["requirementId"],
      requirementName: sourceRequirement["requirementName"],
    }
  }

  const tasks = document["tasks"]
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("任务导入文件必须包含至少一条任务")
  }

  const seenStageIds = new Set<string>()
  for (const [index, value] of tasks.entries()) {
    if (!isRecord(value)) {
      throw new Error(`任务导入文件第 ${index + 1} 条任务无效`)
    }

    const stageId = value["stageId"]
    if (typeof stageId !== "string" || stageId.length === 0) {
      throw new Error(`任务导入文件第 ${index + 1} 条任务缺少 stageId`)
    }
    if (seenStageIds.has(stageId)) {
      throw new Error(`任务导入文件包含重复的 stageId: ${stageId}`)
    }
    seenStageIds.add(stageId)

    if (typeof value["taskId"] !== "string" || value["taskId"].length === 0) {
      throw new Error(`任务 ${stageId} 的 taskId 无效`)
    }
    if (!Object.values(Phase).includes(value["phase"] as Phase)) {
      throw new Error(`任务 ${stageId} 的 phase 无效`)
    }
    if (typeof value["title"] !== "string" || typeof value["description"] !== "string") {
      throw new Error(`任务 ${stageId} 的标题或描述无效`)
    }
    if (!Object.values(Role).includes(value["responsibleRole"] as Role)) {
      throw new Error(`任务 ${stageId} 的 responsibleRole 无效`)
    }
    if (!Object.values(TaskStatus).includes(value["status"] as TaskStatus)) {
      throw new Error(`任务 ${stageId} 的 status 无效`)
    }
    if (!Array.isArray(value["artifactIds"])
      || !value["artifactIds"].every((id) => typeof id === "string")) {
      throw new Error(`任务 ${stageId} 的 artifactIds 无效`)
    }
    if (value["assignedTo"] !== null && typeof value["assignedTo"] !== "string") {
      throw new Error(`任务 ${stageId} 的 assignedTo 无效`)
    }
    if (!isIsoDate(value["createdAt"])) {
      throw new Error(`任务 ${stageId} 的 createdAt 无效`)
    }
    if (value["completedAt"] !== null && !isIsoDate(value["completedAt"])) {
      throw new Error(`任务 ${stageId} 的 completedAt 无效`)
    }
    if (value["notes"] !== null && typeof value["notes"] !== "string") {
      throw new Error(`任务 ${stageId} 的 notes 无效`)
    }
  }

  return document as unknown as TaskExportDocument
}

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
  /** 已激活的插件宿主；缺省为空，主路径与现在一致 */
  pluginHost?: PluginHost
  /** Teambition 写操作默认 operatorId（x-operator-id） */
  teambitionOperatorId?: string
}

/** 创建节点后的配置及运行态结果。 */
export interface CreateNodeResult {
  readonly requirementId: string
  readonly node: WorkflowNodeSpec
  readonly activated: boolean
  readonly workspacePath: string
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
  private readonly pluginHost: PluginHost
  private readonly nodeExecution: NodeExecutionService
  private readonly teambitionOperatorId: string | undefined
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
    this.pluginHost = config.pluginHost ?? emptyPluginHost()
    this.integrations = { ...this.pluginHost.integrations, ...config.integrations }
    this.registry = new CapabilityRegistry(this.pluginHost.customHandlers)
    for (const [kind, handler] of this.pluginHost.kindHandlers) {
      this.registry.register(kind, handler)
    }
    this.nodeExecution = new NodeExecutionService(
      this.store,
      (projectRoot) => this.loadDefinition(projectRoot),
    )
    this.teambitionOperatorId = config.teambitionOperatorId
  }

  /** 已加载插件摘要。 */
  listPlugins(): readonly { id: string; version: string }[] {
    return this.pluginHost.plugins
  }

  /** 读取叠加插件与项目 overlay 后的工作流定义。 */
  getWorkflowDefinition(requirementId: string): WorkflowDefinition {
    const state = this.getState(requirementId)
    return this.loadDefinition(state.projectRoot ?? process.cwd())
  }

  private loadDefinition(projectRoot: string): WorkflowDefinition {
    return loadResolvedWorkflowDefinition(projectRoot, this.pluginHost.overlays)
  }

  /**
   * 在单个 SQLite 事务内完成读改写；并发写锁冲突（SQLITE_BUSY）时按指数
   * 退避重试整个事务，避免跨进程并发写入互相覆盖或互相死锁。
   */
  private transactionalUpdate(
    requirementId: string,
    updater: (state: WorkflowState) => WorkflowState,
  ): WorkflowState {
    let attempt = 0
    for (;;) {
      try {
        return this.store.update(requirementId, updater)
      } catch (cause) {
        if (!isWriteLockError(cause) || attempt >= 30) throw cause
        attempt++
        // 抖动退避：避免多个进程以相同节奏反复碰撞
        sleep(1 + Math.floor(Math.random() * (2 ** Math.min(attempt, 7))))
      }
    }
  }

  /** 节点运行与监控服务。 */
  get execution(): NodeExecutionService {
    return this.nodeExecution
  }

  // ── 项目容器 ──

  /** 列出状态库中的项目 ID。 */
  listProjects(): string[] {
    return this.store.listProjects()
  }

  /** 列出项目管理中心所需的项目摘要。 */
  listProjectSummaries(): ProjectSummary[] {
    return this.listProjects().map((projectId) => {
      const project = this.store.loadProject(projectId)
      const requirementIds = this.store.listRequirements(projectId)
      return {
        projectId: project.projectId,
        name: project.name,
        description: project.description,
        requirementCount: requirementIds.length,
        ...(project.teambition?.projectId !== undefined
          ? { teambitionProjectId: project.teambition.projectId }
          : {}),
        updatedAt: project.updatedAt,
      }
    })
  }

  /** 项目概览（只读投影，从 state 派生）。 */
  getProjectOverview(projectId: string): ProjectOverview {
    const project = this.store.loadProject(projectId)
    const requirementIds = this.listRequirements(projectId)
    const byPhase: Array<{ phase: Phase; count: number }> = PHASE_ORDER.map((phase) => ({ phase, count: 0 }))
    let unscheduledCount = 0, unboundTbCount = 0, ownerlessCount = 0
    let milestonePlanned = 0, milestoneReached = 0, milestoneOverdue = 0
    const heinrich = { major: 0, minor: 0, trivial: 0 }
    let readyNodeCount = 0, waitingNodeCount = 0
    const today = todayYmd()
    for (const requirementId of requirementIds) {
      const state = this.getState(requirementId)
      const idx = PHASE_ORDER.indexOf(state.currentPhase)
      if (idx >= 0 && byPhase[idx]) byPhase[idx].count++
      if (!(state.plannedStart && state.plannedEnd)) unscheduledCount++
      if (!state.teambition?.taskId) unboundTbCount++
      if (state.owner === undefined || state.owner.trim() === "") ownerlessCount++
      heinrich.major += state.heinrich.majorDefects
      heinrich.minor += state.heinrich.minorDefects
      heinrich.trivial += state.heinrich.trivialDefects
      for (const ms of state.milestones ?? []) {
        if (ms.status === MilestoneStatus.PLANNED) {
          milestonePlanned++
          if (ms.date < today) milestoneOverdue++
        } else if (ms.status === MilestoneStatus.REACHED) {
          milestoneReached++
        }
      }
      const snapshot = this.nodeExecution.getSnapshot(requirementId)
      readyNodeCount += snapshot.readyNodeIds.length
      waitingNodeCount += snapshot.waitingNodeIds.length
    }
    return {
      projectId,
      projectName: project.name,
      requirementCount: requirementIds.length,
      byPhase,
      unscheduledCount,
      unboundTbCount,
      milestonePlanned,
      milestoneReached,
      milestoneOverdue,
      heinrich,
      readyNodeCount,
      waitingNodeCount,
      ownerlessCount,
    }
  }

  /** 创建项目容器。 */
  createProject(name: string, description?: string): Project {
    return this.store.createProject(name, description)
  }

  /** 获取项目容器。 */
  getProject(projectId: string): Project {
    return this.store.loadProject(projectId)
  }

  /** 更新项目名称或描述。 */
  updateProjectMeta(projectId: string, patch: { name?: string; description?: string }): Project {
    const name = patch.name === undefined ? undefined : patch.name.trim()
    if (name !== undefined && name === "") {
      throw new Error("项目名称必须是非空字符串")
    }
    return this.store.updateProject(projectId, (current) => {
      if (name !== undefined) current.name = name
      if (patch.description !== undefined) current.description = patch.description
      return current
    })
  }

  /** 删除项目及其下需求与运行记录。 */
  deleteProject(projectId: string): void {
    this.store.loadProject(projectId)
    this.store.deleteProject(projectId)
  }

  // ── 需求生命周期 ──

  /** 列出需求 ID；可按项目过滤。 */
  listRequirements(projectId?: string): string[] {
    return this.store.listRequirements(projectId)
  }

  /** 列出需求摘要。 */
  listRequirementSummaries(projectId?: string): RequirementSummary[] {
    return this.listRequirements(projectId).map((requirementId) => {
      const state = this.getState(requirementId)
      return {
        projectId: state.projectId,
        requirementId: state.requirementId,
        requirementName: state.requirementName,
        description: state.description,
        currentPhase: state.currentPhase,
        totalTasks: state.steps.length,
        completedTasks: state.steps.filter((step) => step.status === TaskStatus.COMPLETED).length,
        ...(state.projectRoot !== undefined ? { projectRoot: state.projectRoot } : {}),
        updatedAt: state.updatedAt,
        ...(state.teambition?.taskId !== undefined ? { teambitionTaskId: state.teambition.taskId } : {}),
        ...(state.teambition?.statusName !== undefined
          ? { teambitionStatusName: state.teambition.statusName }
          : {}),
        ...(state.plannedStart !== undefined ? { plannedStart: state.plannedStart } : {}),
        ...(state.plannedEnd !== undefined ? { plannedEnd: state.plannedEnd } : {}),
        ...requirementMilestoneSummary(state),
      }
    })
  }

  /** 初始化新需求（隶属于项目），并写入当前阶段步骤。 */
  initRequirement(
    projectId: string,
    name: string,
    description?: string,
    projectRoot?: string,
  ): WorkflowState {
    const definition = projectRoot
      ? (initializeWorkflowFile(projectRoot), this.loadDefinition(projectRoot))
      : undefined
    const state = this.store.createRequirement(projectId, name, description, projectRoot)

    state.steps = definition
      ? createStepsFromDefinition(state.projectId, definition, state.currentPhase)
      : createStepsForPhase(state.projectId, state.currentPhase)
    state.checklists[state.currentPhase] = createEmptyChecklist(state.currentPhase)
    state.heinrich = createEmptyHeinrichRecord()

    this.store.save(state)
    return state
  }

  /** 更新需求名称或描述。 */
  updateRequirement(requirementId: string, patch: { name?: string; description?: string; owner?: string | null }): WorkflowState {
    const name = patch.name === undefined ? undefined : patch.name.trim()
    if (name !== undefined && name === "") {
      throw new Error("需求名称必须是非空字符串")
    }
    return this.transactionalUpdate(requirementId, (current) => {
      if (name !== undefined) current.requirementName = name
      if (patch.description !== undefined) current.description = patch.description
      if (patch.owner !== undefined) {
        if (patch.owner === null) {
          delete current.owner
        } else {
          const trimmed = patch.owner.trim()
          if (trimmed === "") {
            delete current.owner
          } else {
            if (trimmed.length > 80) throw new Error("负责人必须是 1–80 个字符")
            current.owner = trimmed
          }
        }
      }
      return current
    })
  }

  /** 删除需求状态及运行记录，不删除磁盘上的 workflow.yaml。 */
  deleteRequirement(requirementId: string): void {
    this.getState(requirementId)
    this.store.deleteRequirement(requirementId)
  }

  /** 更新节点计划起止日期（甘特图排期）。
   * 两个都空则清除排期；否则必须成对提供 YYYY-MM-DD，且结束不早于开始。
   */
  updateNodeSchedule(
    requirementId: string,
    nodeId: string,
    schedule: { plannedStart?: string | null; plannedEnd?: string | null },
  ): WorkflowState {
    const startRaw = schedule.plannedStart
    const endRaw = schedule.plannedEnd
    const startEmpty = startRaw === undefined || startRaw === null || startRaw === ""
    const endEmpty = endRaw === undefined || endRaw === null || endRaw === ""
    const clearing = startEmpty && endEmpty

    let plannedStart: string | undefined
    let plannedEnd: string | undefined
    if (!clearing) {
      if (startEmpty || endEmpty || typeof startRaw !== "string" || typeof endRaw !== "string") {
        throw new Error("计划起止日期必须成对提供，格式为 YYYY-MM-DD")
      }
      if (!isDateOnly(startRaw) || !isDateOnly(endRaw)) {
        throw new Error("计划起止日期必须成对提供，格式为 YYYY-MM-DD")
      }
      if (endRaw < startRaw) {
        throw new Error("计划结束日期不能早于开始日期")
      }
      plannedStart = startRaw
      plannedEnd = endRaw
    }

    return this.transactionalUpdate(requirementId, (current) => {
      const step = current.steps.find((item) => item.id === nodeId)
      if (!step) throw new Error(`节点不存在: ${nodeId}`)
      if (clearing || plannedStart === undefined || plannedEnd === undefined) {
        delete step.plannedStart
        delete step.plannedEnd
      } else {
        step.plannedStart = plannedStart
        step.plannedEnd = plannedEnd
      }
      step.updatedAt = new Date().toISOString()
      return current
    })
  }

  /** 为节点设置或清除负责人。 */
  assignNode(requirementId: string, nodeId: string, assignedTo: string | null): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      const step = current.steps.find((item) => item.id === nodeId)
      if (!step) throw new Error(`节点不存在: ${nodeId}`)
      if (assignedTo === null || assignedTo === "") {
        delete step.assignedTo
      } else {
        const trimmed = assignedTo.trim()
        if (trimmed.length > 80) throw new Error("负责人必须是 1–80 个字符")
        step.assignedTo = trimmed
      }
      step.updatedAt = new Date().toISOString()
      return current
    })
  }

  /** 更新需求级计划起止日期（甘特图排期）。
   * 两个都空则清除排期；否则必须成对提供 YYYY-MM-DD，且结束不早于开始。
   */
  updateRequirementSchedule(
    requirementId: string,
    schedule: { plannedStart?: string | null; plannedEnd?: string | null },
  ): WorkflowState {
    const startRaw = schedule.plannedStart
    const endRaw = schedule.plannedEnd
    const startEmpty = startRaw === undefined || startRaw === null || startRaw === ""
    const endEmpty = endRaw === undefined || endRaw === null || endRaw === ""
    const clearing = startEmpty && endEmpty

    let plannedStart: string | undefined
    let plannedEnd: string | undefined
    if (!clearing) {
      if (startEmpty || endEmpty || typeof startRaw !== "string" || typeof endRaw !== "string") {
        throw new Error("计划起止日期必须成对提供，格式为 YYYY-MM-DD")
      }
      if (!isDateOnly(startRaw) || !isDateOnly(endRaw)) {
        throw new Error("计划起止日期必须成对提供，格式为 YYYY-MM-DD")
      }
      if (endRaw < startRaw) {
        throw new Error("计划结束日期不能早于开始日期")
      }
      plannedStart = startRaw
      plannedEnd = endRaw
    }

    return this.transactionalUpdate(requirementId, (current) => {
      if (clearing || plannedStart === undefined || plannedEnd === undefined) {
        delete current.plannedStart
        delete current.plannedEnd
      } else {
        current.plannedStart = plannedStart
        current.plannedEnd = plannedEnd
      }
      current.updatedAt = new Date().toISOString()
      return current
    })
  }

  /** 移动需求到指定阶段（看板换列薄封装）。
   * to === from 时 no-op；toIdx === fromIdx+1 走 advancePhase；
   * toIdx < fromIdx 走 rollbackTo；否则抛 InvalidPhaseTransitionError。
   */
  moveRequirementPhase(requirementId: string, toPhase: Phase): WorkflowState {
    const state = this.getState(requirementId)
    const from = state.currentPhase
    if (toPhase === from) return state
    if (!PHASE_ORDER.includes(toPhase)) {
      throw new Error("未知阶段")
    }
    const fromIdx = getPhaseIndex(from)
    const toIdx = getPhaseIndex(toPhase)
    if (toIdx === fromIdx + 1) {
      return this.advancePhase(requirementId)
    }
    if (toIdx < fromIdx) {
      return this.rollbackTo(requirementId, toPhase)
    }
    throw new InvalidPhaseTransitionError(from, toPhase, "看板只能前进到下一阶段，或回退到已到达的阶段")
  }

  /** 列出需求里程碑（按日期、创建时间排序）。 */
  listMilestones(requirementId: string): RequirementMilestone[] {
    return sortMilestones(this.getState(requirementId).milestones ?? [])
  }

  /** 列出项目下全部需求的里程碑（投影，按日期 / 需求名 / id）。 */
  listProjectMilestones(projectId: string): ProjectMilestone[] {
    this.store.loadProject(projectId)
    const items: ProjectMilestone[] = []
    for (const requirementId of this.listRequirements(projectId)) {
      const state = this.getState(requirementId)
      for (const milestone of state.milestones ?? []) {
        items.push({
          ...milestone,
          requirementId: state.requirementId,
          requirementName: state.requirementName,
        })
      }
    }
    return items.sort((a, b) =>
      a.date.localeCompare(b.date)
      || a.requirementName.localeCompare(b.requirementName)
      || a.id.localeCompare(b.id))
  }

  /** 按身份（姓名/邮箱等）查询分配给自己的需求与节点。 */
  listMyWork(identity: string, projectId?: string): MyWorkList {
    if (identity.trim() === "") return { identity: "", requirements: [], nodes: [] }
    const requirements: MyWorkItem[] = []
    const nodes: MyWorkItem[] = []
    const requirementIds = projectId ? this.listRequirements(projectId) : this.listRequirements()
    for (const requirementId of requirementIds) {
      const state = this.getState(requirementId)
      const projectName = this.store.loadProject(state.projectId).name
      const base = {
        projectId: state.projectId,
        projectName,
        requirementId: state.requirementId,
        requirementName: state.requirementName,
      }
      const next = requirementMilestoneSummary(state).nextMilestone
      const plannedEnd = state.plannedEnd
      const overdue = (next?.overdue === true) || (plannedEnd !== undefined && plannedEnd < todayYmd())
      if (identityMatches(state.owner, identity)) {
        requirements.push({
          kind: "requirement",
          ...base,
          phase: state.currentPhase,
          ...(state.owner !== undefined ? { owner: state.owner } : {}),
          ...(next ? { nextMilestone: next } : {}),
          ...(plannedEnd !== undefined ? { plannedEnd } : {}),
          overdue,
        })
      }
      for (const step of state.steps) {
        if (identityMatches(step.assignedTo, identity) && (step.status === TaskStatus.PENDING || step.status === TaskStatus.IN_PROGRESS || step.status === TaskStatus.BLOCKED)) {
          nodes.push({
            kind: "node",
            ...base,
            phase: step.phase,
            ...(state.owner !== undefined ? { owner: state.owner } : {}),
            nodeId: step.id,
            nodeName: step.name,
            status: step.status,
            ...(step.assignedTo !== undefined ? { assignedTo: step.assignedTo } : {}),
            ...(step.plannedEnd !== undefined ? { plannedEnd: step.plannedEnd } : {}),
            overdue: step.plannedEnd !== undefined && step.plannedEnd < todayYmd(),
          })
        }
      }
    }
    const sortFn = (a: MyWorkItem, b: MyWorkItem): number => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
      const dateA = a.plannedEnd ?? ("nextMilestone" in a && a.nextMilestone ? a.nextMilestone.date : "") ?? ""
      const dateB = b.plannedEnd ?? ("nextMilestone" in b && b.nextMilestone ? b.nextMilestone.date : "") ?? ""
      const dateCmp = dateA.localeCompare(dateB)
      if (dateCmp !== 0) return dateCmp
      return a.requirementName.localeCompare(b.requirementName)
    }
    return {
      identity: identity.trim(),
      requirements: requirements.sort(sortFn),
      nodes: nodes.sort(sortFn),
    }
  }

  /** 新增需求里程碑。 */
  addMilestone(
    requirementId: string,
    input: { name: string; date: string; phase?: Phase; nodeId?: string; note?: string },
  ): RequirementMilestone {
    const name = normalizeMilestoneName(input.name)
    const date = normalizeMilestoneDate(input.date)
    const phase = input.phase === undefined ? undefined : assertMilestonePhase(input.phase)
    const note = input.note === undefined ? undefined : normalizeMilestoneNote(input.note)
    const now = new Date().toISOString()
    const created: RequirementMilestone = {
      id: MilestoneId(`ms_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      name,
      date,
      status: MilestoneStatus.PLANNED,
      createdAt: now,
      updatedAt: now,
      ...(phase !== undefined ? { phase } : {}),
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
      ...(note !== undefined ? { note } : {}),
    }

    this.transactionalUpdate(requirementId, (current) => {
      if (created.nodeId !== undefined && !current.steps.some((step) => step.id === created.nodeId)) {
        throw new Error(`节点不存在: ${created.nodeId}`)
      }
      current.milestones = [...(current.milestones ?? []), created]
      return current
    })
    return created
  }

  /** 更新里程碑字段；日期不能清空。 */
  updateMilestone(
    requirementId: string,
    milestoneId: string,
    patch: {
      name?: string
      date?: string | null
      phase?: Phase | null
      nodeId?: string | null
      note?: string | null
    },
  ): RequirementMilestone {
    let updated: RequirementMilestone | undefined
    this.transactionalUpdate(requirementId, (current) => {
      const milestones = [...(current.milestones ?? [])]
      const index = milestones.findIndex((item) => item.id === milestoneId)
      if (index === -1) throw new Error(`里程碑不存在: ${milestoneId}`)
      const currentMilestone = milestones[index]
      if (!currentMilestone) throw new Error(`里程碑不存在: ${milestoneId}`)

      if (patch.date !== undefined && (patch.date === null || patch.date === "")) {
        throw new Error("里程碑日期必须是 YYYY-MM-DD")
      }
      if (patch.nodeId) {
        if (!current.steps.some((step) => step.id === patch.nodeId)) {
          throw new Error(`节点不存在: ${patch.nodeId}`)
        }
      }

      const next: RequirementMilestone = { ...currentMilestone, updatedAt: new Date().toISOString() }
      if (patch.name !== undefined) next.name = normalizeMilestoneName(patch.name)
      if (typeof patch.date === "string") next.date = normalizeMilestoneDate(patch.date)
      if (patch.phase === null) delete next.phase
      else if (patch.phase !== undefined) next.phase = assertMilestonePhase(patch.phase)
      if (patch.nodeId === null) delete next.nodeId
      else if (patch.nodeId !== undefined) next.nodeId = patch.nodeId
      if (patch.note === null) delete next.note
      else if (patch.note !== undefined) next.note = normalizeMilestoneNote(patch.note)

      milestones[index] = next
      current.milestones = milestones
      updated = next
      return current
    })
    if (!updated) throw new Error(`里程碑不存在: ${milestoneId}`)
    return updated
  }

  /** 标记里程碑已达成。已达成则 no-op。 */
  reachMilestone(requirementId: string, milestoneId: string): RequirementMilestone {
    return this.setMilestoneReached(requirementId, milestoneId, true)
  }

  /** 取消达成。计划中则 no-op。 */
  unreachMilestone(requirementId: string, milestoneId: string): RequirementMilestone {
    return this.setMilestoneReached(requirementId, milestoneId, false)
  }

  /** 删除里程碑。 */
  deleteMilestone(requirementId: string, milestoneId: string): void {
    this.transactionalUpdate(requirementId, (current) => {
      const milestones = current.milestones ?? []
      if (!milestones.some((item) => item.id === milestoneId)) {
        throw new Error(`里程碑不存在: ${milestoneId}`)
      }
      current.milestones = milestones.filter((item) => item.id !== milestoneId)
      return current
    })
  }

  private setMilestoneReached(
    requirementId: string,
    milestoneId: string,
    reached: boolean,
  ): RequirementMilestone {
    let result: RequirementMilestone | undefined
    this.transactionalUpdate(requirementId, (current) => {
      const milestones = [...(current.milestones ?? [])]
      const index = milestones.findIndex((item) => item.id === milestoneId)
      if (index === -1) throw new Error(`里程碑不存在: ${milestoneId}`)
      const currentMilestone = milestones[index]
      if (!currentMilestone) throw new Error(`里程碑不存在: ${milestoneId}`)

      if (reached) {
        if (currentMilestone.status === MilestoneStatus.REACHED) {
          result = currentMilestone
          return current
        }
        const now = new Date().toISOString()
        const next: RequirementMilestone = {
          ...currentMilestone,
          status: MilestoneStatus.REACHED,
          reachedAt: now,
          updatedAt: now,
        }
        milestones[index] = next
        result = next
      } else {
        if (currentMilestone.status === MilestoneStatus.PLANNED) {
          result = currentMilestone
          return current
        }
        const next: RequirementMilestone = {
          ...currentMilestone,
          status: MilestoneStatus.PLANNED,
          updatedAt: new Date().toISOString(),
        }
        delete next.reachedAt
        milestones[index] = next
        result = next
      }
      current.milestones = milestones
      return current
    })
    if (!result) throw new Error(`里程碑不存在: ${milestoneId}`)
    return result
  }

  /** 获取当前节点、READY 节点和活动运行摘要。 */
  getExecutionSnapshot(requirementId: string): WorkflowExecutionSnapshot {
    return this.nodeExecution.getSnapshot(requirementId)
  }

  /** 恢复僵死运行（心跳超时的 RUNNING → INTERRUPTED，节点置 BLOCKED），返回恢复数量。 */
  recoverStaleRuns(requirementId: string, staleAfterMs?: number): number {
    return this.nodeExecution.recoverStaleRuns(requirementId, staleAfterMs)
  }

  /** 独立运行一个节点。 */
  runNode(requirementId: string, nodeKey: string, options?: RunNodeOptions): NodeRun {
    return this.nodeExecution.runNode(requirementId, this.resolveNodeId(requirementId, nodeKey), options)
  }

  /** 使用英文节点键完成手动节点。 */
  completeManualNode(requirementId: string, nodeKey: string, force = false): WorkflowState {
    return this.nodeExecution.completeManualNode(requirementId, this.resolveNodeId(requirementId, nodeKey), force)
  }

  /** 将英文节点键解析为内部运行态 ID。 */
  resolveNodeId(requirementId: string, nodeKey: string): string {
    const state = this.getState(requirementId)
    if (!state.projectRoot) throw new Error(`需求 ${requirementId} 未配置源码根目录，请重新 init --root`)
    return resolveWorkflowNodeId(this.loadDefinition(state.projectRoot), nodeKey)
  }

  /** 将内部运行态 ID 反查为英文节点键。 */
  resolveNodeKey(requirementId: string, nodeId: string): string {
    const state = this.getState(requirementId)
    if (!state.projectRoot) throw new Error(`需求 ${requirementId} 未配置源码根目录，请重新 init --root`)
    return resolveWorkflowNodeKey(this.loadDefinition(state.projectRoot), nodeId)
  }

  /** 自动并行运行所有 READY 节点。 */
  runWorkflow(requirementId: string, options?: RunWorkflowOptions): Promise<WorkflowExecutionSnapshot> {
    return this.nodeExecution.runWorkflow(requirementId, options)
  }

  /**
   * 创建项目级节点。
   *
   * 当前阶段节点会立即加入运行态；未来阶段节点只写入定义，在阶段推进时激活。
   */
  createNode(requirementId: string, node: WorkflowNodeSpec): CreateNodeResult {
    const state = this.getState(requirementId)
    if (!state.projectRoot) throw new Error(`需求 ${requirementId} 未配置源码根目录，请重新 init --root`)

    const currentPhaseIndex = getPhaseIndex(state.currentPhase)
    const nodePhaseIndex = getPhaseIndex(node.phase)
    if (nodePhaseIndex < currentPhaseIndex) {
      throw new Error(`不能向已完成阶段 ${node.phase} 创建节点`)
    }

    const resolved = this.loadDefinition(state.projectRoot)
    if (resolved.nodes.some((candidate) => candidate.key === node.key)) {
      throw new Error(`节点已存在: ${node.key}`)
    }
    const definition = loadWorkflowDefinition(state.projectRoot)
    const nodesByKey = new Map(definition.nodes.map((candidate) => [candidate.key, candidate]))
    if (nodesByKey.has(node.key)) throw new Error(`节点已存在: ${node.key}`)
    for (const dependencyKey of node.dependsOn) {
      const dependency = nodesByKey.get(dependencyKey)
      if (!dependency) throw new Error(`节点 ${node.key} 依赖不存在: ${dependencyKey}`)
      if (getPhaseIndex(dependency.phase) > nodePhaseIndex) {
        throw new Error(`节点 ${node.key} 不能依赖后续阶段节点 ${dependencyKey}`)
      }
    }

    const appended = appendWorkflowNode(state.projectRoot, node)
    const activated = node.phase === state.currentPhase
    if (activated) {
      this.transactionalUpdate(requirementId, (current) => {
        if (current.steps.some((step) => step.id === appended.nodeId)) throw new Error(`节点已存在: ${node.key}`)
        current.steps.push(createStepFromNode(requirementId, node, appended.definition))
        return current
      })
    }

    return {
      requirementId,
      node,
      activated,
      workspacePath: appended.workspace.nodePath(node.key),
    }
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
   * @param input 可选显式输入：传给该步骤声明的 AI 模块；未提供时回退为“步骤名称：步骤描述”
   * 外部调用期间若聚合状态发生并发变化，本次结果不会覆盖最新状态，而是要求调用方重试。
   */
  async runStepCapabilities(requirementId: string, stepId: string, input?: string): Promise<WorkflowState> {
    const state = this.getState(requirementId)
    const expectedState = JSON.stringify(state)
    const step = state.steps.find((s) => s.id === stepId)
    if (!step) {
      throw new Error(`步骤不存在: ${stepId}`)
    }

    const caps = step.capabilities ?? []
    if (caps.length === 0) {
      return state
    }

    // 在克隆上执行全部 capability 副作用：并发校验失败时不污染调用方持有的 state
    const working = structuredClone(state)
    const workingStep = working.steps.find((s) => s.id === stepId)!
    const ctx: CapabilityContext = {
      state: working,
      step: workingStep,
      aiClient: this.aiClient,
      integrations: this.integrations,
      ...(input !== undefined ? { input } : {}),
    }
    const runs = workingStep.capabilityRuns ?? []
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
    workingStep.capabilityRuns = runs
    workingStep.updatedAt = new Date().toISOString()

    // capability 可能改变 Heinrich 条数，检查审计触发
    this.checkHeinrichAuditTrigger(working, workingStep.phase)

    // 乐观校验：仅当本次读取的原始快照仍是最新时才落库，否则交由调用方重试
    return this.transactionalUpdate(requirementId, (current) => {
      if (JSON.stringify(current) !== expectedState) {
        throw new Error(`步骤 ${stepId} 执行期间需求状态已变更，请确认最新状态后重试`)
      }
      return working
    })
  }

  /** 获取需求状态 */
  getState(requirementId: string): WorkflowState {
    return this.store.load(requirementId)
  }

  /** 获取需求状态摘要 */
  getRequirementStatus(requirementId: string): RequirementStatusSummary {
    const state = this.getState(requirementId)
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
      requirementId: state.requirementId,
      requirementName: state.requirementName,
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
      ...(state.teambition !== undefined ? { teambition: state.teambition } : {}),
    }
  }

  // ── 阶段转换 ──

  /** 检查是否可前进到下一阶段 */
  canAdvance(requirementId: string): GateCheckResult {
    const state = this.getState(requirementId)
    return this.checkAdvanceGate(state)
  }

  // ── AI 门控 ──

  /** 注册 AI 门控处理器 */
  registerAIHandler(handler: AIEventHandler): void {
    this.aiHandlers.push(handler)
  }

  /** 触发 AI 门控事件（当前阶段转换 API 为同步契约，异步处理器必须明确拒绝）。 */
  private emitAIEvent(payload: AIEventPayload): AIGateResult {
    for (const handler of this.aiHandlers) {
      const result = handler(payload)
      if (result && typeof (result as PromiseLike<AIGateResult>).then === "function") {
        void Promise.resolve(result).catch(() => undefined)
        throw new Error("当前阶段转换不支持异步 AI 门控处理器")
      }
      const gateResult = result as AIGateResult
      if (!gateResult.allowed) {
        return gateResult
      }
    }
    return { allowed: true }
  }

  // ── Stage 生命周期 ──

  /** 更新步骤状态（按步骤 id；status 沿用 StageStatus 值域，与 TaskStatus 等价） */
  updateStageStatus(requirementId: string, stageId: string, status: StageStatus): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      const step = current.steps.find((s) => s.id === stageId)

      if (!step) {
        throw new Error(`阶段步骤不存在: ${stageId}`)
      }

      step.status = status as unknown as TaskStatus
      step.updatedAt = new Date().toISOString()
      if (status === StageStatus.COMPLETED) {
        step.completedAt = new Date().toISOString()
      }

      return current
    })
  }

  /** 获取步骤运行态视图（StageInfo，从 steps 派生） */
  getStageInfos(requirementId: string, phase?: Phase): StageInfo[] {
    const state = this.getState(requirementId)
    const steps = phase ? state.steps.filter((s) => s.phase === phase) : state.steps
    return steps.map(stepToStageInfo)
  }

  /** 获取单个步骤运行态视图 */
  getStageInfo(requirementId: string, stageId: string): StageInfo | undefined {
    const state = this.getState(requirementId)
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
  getStageProgress(requirementId: string, phase: Phase): StageProgress {
    const state = this.getState(requirementId)
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
  advancePhase(requirementId: string, skipAiGating?: boolean): WorkflowState {
    // 只读快照上做门控检查；真实变更在事务内基于最新状态完成
    const state = this.getState(requirementId)
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

    // AI 门控（handler 收到的是旧快照，保持现有行为）
    let aiAllowed = false
    if (this.aiGatingEnabled && !skipAiGating) {
      const aiResult = this.emitAIEvent({
        type: "onPhaseAdvance",
        from: state.currentPhase,
        to: next,
        state,
      })

      if (!aiResult.allowed) {
        this.transactionalUpdate(requirementId, (current) => {
          current.aiGateResults.push({
            phase: current.currentPhase,
            allowed: false,
            ...(aiResult.reason !== undefined ? { reason: aiResult.reason } : {}),
            timestamp: new Date().toISOString(),
          })
          return current
        })
        throw new PhaseLockedError(state.currentPhase, [`AI 门控拒绝: ${aiResult.reason ?? "未通过预检查"}`])
      }

      aiAllowed = true
    }

    return this.transactionalUpdate(requirementId, (current) => {
      if (aiAllowed) {
        current.aiGateResults.push({
          phase: current.currentPhase,
          allowed: true,
          timestamp: new Date().toISOString(),
        })
      }

      // 标记当前阶段为 COMPLETED
      current.phaseStatus[current.currentPhase] = PhaseLock.COMPLETED
      // 激活下一阶段
      const transitionTo = getNextPhase(current.currentPhase)
      if (!transitionTo) {
        throw new InvalidPhaseTransitionError(current.currentPhase, "NEXT", "已是最终阶段")
      }
      current.phaseStatus[transitionTo] = PhaseLock.ACTIVE
      current.currentPhase = transitionTo

      // 生成下一阶段的步骤（唯一真相源）
      const existingIds = new Set(current.steps.map((s) => s.id))
      const definition = current.projectRoot ? this.loadDefinition(current.projectRoot) : undefined
      const nextSteps = definition
        ? createStepsFromDefinition(current.projectId, definition, transitionTo)
        : createStepsForPhase(current.projectId, transitionTo)
      for (const step of nextSteps) {
        if (!existingIds.has(step.id)) {
          current.steps.push(step)
        }
      }

      // 初始化下一阶段的清单
      if (!current.checklists[transitionTo]) {
        current.checklists[transitionTo] = createEmptyChecklist(transitionTo)
      }

      // Checklist 继承
      this.inheritChecklist(current, current.currentPhase)

      // 海因里希三角：阶段前进时记录条数触发计数
      current.heinrich.triggerCounts[transitionTo] = (current.heinrich.triggerCounts[transitionTo] ?? 0) + 1

      // Heinrich 条数审计触发
      this.checkHeinrichAuditTrigger(current, transitionTo)

      // 注：阶段前进时的 AI Checklist 增量推荐已迁移为 spec 步骤 capability，
      // 由 runStepCapabilities 显式触发（见 Phase 3），此处不再内联异步调用。

      return current
    })
  }

  /** 回退到指定阶段 */
  rollbackTo(requirementId: string, targetPhase: Phase): WorkflowState {
    // 只读快照上做校验；真实变更在事务内基于最新状态完成
    const state = this.getState(requirementId)
    const currentIdx = getPhaseIndex(state.currentPhase)
    const targetIdx = getPhaseIndex(targetPhase)

    if (targetIdx > currentIdx) {
      throw new InvalidPhaseTransitionError(
        state.currentPhase,
        targetPhase,
        "不能回退到后续阶段",
      )
    }

    // AI 门控（handler 收到的是旧快照，保持现有行为）
    let aiAllowed = false
    if (this.aiGatingEnabled) {
      const aiResult = this.emitAIEvent({
        type: "onPhaseRollback",
        from: state.currentPhase,
        to: targetPhase,
        state,
      })

      if (!aiResult.allowed) {
        this.transactionalUpdate(requirementId, (current) => {
          current.aiGateResults.push({
            phase: current.currentPhase,
            allowed: false,
            ...(aiResult.reason !== undefined ? { reason: aiResult.reason } : {}),
            timestamp: new Date().toISOString(),
          })
          return current
        })
        throw new PhaseLockedError(state.currentPhase, [`AI 门控拒绝回退: ${aiResult.reason ?? "未通过预检查"}`])
      }

      aiAllowed = true
    }

    return this.transactionalUpdate(requirementId, (current) => {
      if (aiAllowed) {
        current.aiGateResults.push({
          phase: current.currentPhase,
          allowed: true,
          timestamp: new Date().toISOString(),
        })
      }

      const currentIdx = getPhaseIndex(current.currentPhase)
      if (getPhaseIndex(targetPhase) > currentIdx) {
        throw new InvalidPhaseTransitionError(current.currentPhase, targetPhase, "不能回退到后续阶段")
      }

      // 锁定当前阶段后的所有阶段
      for (let i = currentIdx; i >= 0; i--) {
        const phase = PHASE_ORDER[i]
        if (!phase) continue
        if (i > targetIdx) {
          current.phaseStatus[phase] = PhaseLock.LOCKED
        } else if (i === targetIdx) {
          current.phaseStatus[phase] = PhaseLock.ACTIVE
        }
      }

      current.currentPhase = targetPhase
      return current
    })
  }

  // ── 权限校验 ──

  /** 校验当前操作角色是否有权限 */
  private requireRole(requirementId: string, taskId: string, userRole: Role, requiredRole: Role): void {
    if (!this.strictPermissions) return
    if (userRole !== requiredRole) {
      throw new Error(`权限不足: 需要角色 ${requiredRole}，当前角色 ${userRole}`)
    }
  }

  // ── 任务操作 ──

  /** 获取任务列表（从 steps 派生 Task 视图） */
  getTasks(requirementId: string, filter?: TaskFilter): Task[] {
    const state = this.getState(requirementId)
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

  /** 导出需求中当前已经生成的全部任务 */
  exportTasks(requirementId: string): TaskExportDocument {
    const state = this.getState(requirementId)
    return {
      format: "octopus.tasks",
      version: 1,
      exportedAt: new Date().toISOString(),
      sourceRequirement: {
        projectId: state.projectId,
        requirementId: state.requirementId,
        requirementName: state.requirementName,
      },
      tasks: state.steps.map((step) => {
        const task = stepToTask(step)
        return {
          taskId: task.id,
          stageId: task.stageId,
          phase: task.phase,
          title: task.title,
          description: task.description,
          responsibleRole: task.responsibleRole,
          status: task.status,
          artifactIds: task.artifactIds,
          assignedTo: task.assignedTo ?? null,
          createdAt: task.createdAt,
          completedAt: task.completedAt ?? null,
          notes: task.notes ?? null,
        }
      }),
    }
  }

  /** 按 stageId 合并任务进度与执行信息 */
  importTasks(requirementId: string, document: unknown): TaskImportResult {
    // 文档格式校验为只读校验（事务外完成）
    const imported = validateTaskExportDocument(document)
    let matched = 0
    let updated = 0
    const saved = this.transactionalUpdate(requirementId, (current) => {
      const stepsById = new Map<string, StepRuntime>()

      for (const step of current.steps) {
        if (stepsById.has(step.id)) {
          throw new Error(`目标需求包含重复的 stageId: ${step.id}`)
        }
        stepsById.set(step.id, step)
      }

      const matches = imported.tasks.map((task) => {
        const step = stepsById.get(task.stageId)
        if (!step) {
          throw new Error(`目标需求不存在任务 stageId: ${task.stageId}`)
        }
        if (step.phase !== task.phase) {
          throw new Error(`任务 ${task.stageId} 的阶段不匹配: ${task.phase} != ${step.phase}`)
        }
        return { task, step }
      })

      const importedAt = new Date().toISOString()
      let localUpdated = 0
      for (const { task, step } of matches) {
        const assignedTo = step.assignedTo ?? null
        const notes = step.notes ?? null
        const completedAt = step.completedAt ?? null
        if (step.status === task.status
          && assignedTo === task.assignedTo
          && notes === task.notes
          && completedAt === task.completedAt) {
          continue
        }

        step.status = task.status
        if (task.assignedTo === null) delete step.assignedTo
        else step.assignedTo = task.assignedTo
        if (task.notes === null) delete step.notes
        else step.notes = task.notes
        if (task.completedAt === null) delete step.completedAt
        else step.completedAt = task.completedAt
        step.updatedAt = importedAt
        localUpdated++
      }

      matched = matches.length
      updated = localUpdated
      return current
    })

    return {
      projectId: saved.projectId,
      requirementId: saved.requirementId,
      matched,
      updated,
      unchanged: matched - updated,
    }
  }

  /** 完成任务（按 taskId 定位对应步骤） */
  completeTask(requirementId: string, taskId: string, role?: Role): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      const step = current.steps.find((s) => s.taskId === taskId)

      if (!step) {
        throw new Error(`任务不存在: ${taskId}`)
      }

      if (role) {
        this.requireRole(requirementId, taskId, role, step.responsibleRole)
      }

      step.status = TaskStatus.COMPLETED
      step.completedAt = new Date().toISOString()
      step.updatedAt = new Date().toISOString()

      return current
    })
  }

  /** 设置任务状态 */
  setTaskStatus(requirementId: string, taskId: string, status: TaskStatus): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      const step = current.steps.find((s) => s.taskId === taskId)

      if (!step) {
        throw new Error(`任务不存在: ${taskId}`)
      }

      step.status = status
      step.updatedAt = new Date().toISOString()
      if (status === TaskStatus.COMPLETED) {
        step.completedAt = new Date().toISOString()
      }

      return current
    })
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
  getChecklist(requirementId: string, phase: Phase): Checklist {
    const state = this.getState(requirementId)
    return state.checklists[phase] ?? createEmptyChecklist(phase)
  }

  /** 核验清单项 */
  verifyChecklistItem(requirementId: string, phase: Phase, itemId: string, role?: Role): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      const checklist = current.checklists[phase]

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

      return current
    })
  }

  /** 添加清单项 */
  addChecklistItem(requirementId: string, phase: Phase, category: string, description: string): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      if (!current.checklists[phase]) {
        current.checklists[phase] = createEmptyChecklist(phase)
      }

      const checklist = current.checklists[phase]
      if (!checklist) throw new Error("无法创建清单")

      checklist.items.push({
        id: ChecklistItemId(`cl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        category,
        description,
        status: ChecklistItemStatus.PENDING,
      })

      return current
    })
  }

  /** 删除清单项 */
  removeChecklistItem(requirementId: string, phase: Phase, itemId: string): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      const checklist = current.checklists[phase]

      if (!checklist) throw new Error(`阶段 ${phase} 没有清单`)

      const idx = checklist.items.findIndex((i) => i.id === itemId)
      if (idx === -1) throw new Error(`清单项不存在: ${itemId}`)

      checklist.items.splice(idx, 1)
      return current
    })
  }

  // ── 海因里希三角操作 ──

  /** 获取海因里希记录 */
  getHeinrichRecord(requirementId: string): HeinrichRecord {
    const state = this.getState(requirementId)
    return state.heinrich
  }

  /** 记录海因里希条数标记 */
  logHeinrichMarker(requirementId: string, phase: Phase, description?: string): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      current.heinrich.triggerCounts[phase] = (current.heinrich.triggerCounts[phase] ?? 0) + 1

      current.heinrich.observations.push({
        id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        phase,
        level: HeinrichLevel.TRIVIAL,
        description: description ?? `Heinrich marker at ${phase}`,
        notedAt: new Date().toISOString(),
      })

      return current
    })
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
  logObservation(requirementId: string, phase: Phase, level: HeinrichLevel, description: string): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      const observation: HeinrichObservation = {
        id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        phase,
        level,
        description,
        notedAt: new Date().toISOString(),
      }

      current.heinrich.observations.push(observation)

      // 更新计数
      if (level === "MAJOR") current.heinrich.majorDefects += 1
      else if (level === "MINOR") current.heinrich.minorDefects += 1
      else if (level === "TRIVIAL") current.heinrich.trivialDefects += 1

      return current
    })
  }

  /** 解决观测 */
  resolveObservation(requirementId: string, obsId: string): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      const obs = current.heinrich.observations.find((o) => o.id === obsId)

      if (!obs) throw new Error(`观测不存在: ${obsId}`)

      obs.resolvedAt = new Date().toISOString()
      return current
    })
  }

  /** 质量评估 */
  assessQuality(requirementId: string): QualityAssessment {
    let assessment: QualityAssessment | undefined
    this.transactionalUpdate(requirementId, (current) => {
      assessment = this.computeQualityAssessment(current.heinrich)
      current.heinrich.observations.push({
        id: ObservationId(`obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
        phase: current.currentPhase,
        level: HeinrichLevel.TRIVIAL,
        description: this.assessmentObservationDescription(assessment),
        notedAt: new Date().toISOString(),
      })
      // 审计步骤自动完成：assessQuality 成功即视为该阶段 Heinrich 审计已满足
      this.completeHeinrichAuditStep(current, current.currentPhase)
      return current
    })
    return assessment!
  }

  /** 根据海因里希记录计算质量评估（纯函数，供事务内调用） */
  private computeQualityAssessment(heinrich: HeinrichRecord): QualityAssessment {
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

    if (heinrich.minorDefects === 0 && heinrich.trivialDefects === 0) {
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

  /** 生成质量评估的观测描述 */
  private assessmentObservationDescription(assessment: QualityAssessment): string {
    if (assessment.verdict === QualityVerdict.INSUFFICIENT_DATA) {
      return `Quality assessment: ${assessment.verdict}`
    }
    return `Quality assessment: ${assessment.verdict} (minorRatio=${assessment.minorRatio.toFixed(2)}, trivialRatio=${assessment.trivialRatio.toFixed(2)})`
  }

  /** 自动完成当前阶段的 Heinrich 审计步骤（幂等：无审计步骤时不产生影响） */
  private completeHeinrichAuditStep(state: WorkflowState, phase: Phase): void {
    const auditId = `heinrich.audit.${phase}`
    const auditStep = state.steps.find((s) => s.id === auditId)
    if (!auditStep) return
    const now = new Date().toISOString()
    auditStep.status = TaskStatus.COMPLETED
    auditStep.completedAt = now
    auditStep.updatedAt = now
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
    requirementId: string,
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
    return this.transactionalUpdate(requirementId, (current) => {
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

      current.artifacts.push(artifact)
      return current
    })
  }

  /** 获取制品列表 */
  getArtifacts(requirementId: string, phase?: Phase, type?: string): Artifact[] {
    const state = this.getState(requirementId)
    let artifacts = [...state.artifacts]

    if (phase) {
      artifacts = artifacts.filter((a) => a.phase === phase)
    }
    if (type) {
      artifacts = artifacts.filter((a) => a.type === type)
    }

    return artifacts
  }

  // ── Teambition 编排 ──

  private requireTeambition(): TeambitionClient {
    const client = this.integrations["teambition"]
    if (!client || !(client instanceof TeambitionClient)) {
      throw new Error("未配置 Teambition 集成（需要 integrations.teambition）")
    }
    return client
  }

  /** 绑定项目到 Teambition 项目（直接传 projectId，或用 prefix 解析）。 */
  async bindProjectTeambition(
    projectId: string,
    opts: { projectId?: string; prefix?: string },
  ): Promise<Project> {
    const tb = this.requireTeambition()
    let tbProjectId = opts.projectId
    let tbName: string | undefined
    const prefix = opts.prefix

    if (!tbProjectId) {
      if (!prefix) throw new Error("绑定 Teambition 项目需要提供 projectId 或 prefix")
      const resolved = await tb.resolveProject(prefix)
      if (!resolved.success) throw new Error(resolved.message)
      const data = resolved.data as { id?: string; name?: string } | null
      if (!data?.id) throw new Error(resolved.message || `无法解析 Teambition 项目前缀: ${prefix}`)
      tbProjectId = data.id
      tbName = data.name
    }

    const binding: ProjectTeambitionBinding = {
      projectId: tbProjectId,
      ...(tbName !== undefined ? { name: tbName } : {}),
      ...(prefix !== undefined ? { uniqueIdPrefix: prefix } : {}),
    }
    return this.store.updateProject(projectId, (current) => {
      current.teambition = binding
      return current
    })
  }

  /** 解除项目的 Teambition 绑定。 */
  unbindProjectTeambition(projectId: string): Project {
    return this.store.updateProject(projectId, (current) => {
      delete current.teambition
      return current
    })
  }

  /** 列出项目绑定的 Teambition 工作流卡片状态。 */
  async listTeambitionCardStatuses(projectId: string): Promise<WorkflowStatus[]> {
    const project = this.store.loadProject(projectId)
    const tbProjectId = project.teambition?.projectId
    if (!tbProjectId) throw new Error(`项目 ${projectId} 未绑定 Teambition 项目`)
    const result = await this.requireTeambition().projectStatuses(tbProjectId)
    if (!result.success) throw new Error(result.message)
    return (result.data as WorkflowStatus[] | undefined) ?? []
  }

  /** 绑定需求到 Teambition 任务（taskRef 或 taskId）。 */
  async bindRequirementTask(
    requirementId: string,
    opts: { taskRef?: string; taskId?: string },
  ): Promise<WorkflowState> {
    const tb = this.requireTeambition()
    const state = this.getState(requirementId)
    const project = this.store.loadProject(state.projectId)
    const tbProjectId = project.teambition?.projectId

    let task: TbTask | null = null
    if (opts.taskRef) {
      const resolved = await tb.resolveTask(opts.taskRef, tbProjectId)
      if (!resolved.success) throw new Error(resolved.message)
      task = (resolved.data as TbTask | null) ?? null
      if (!task) throw new Error(`未找到 Teambition 任务: ${opts.taskRef}`)
    } else if (opts.taskId) {
      const resolved = await tb.resolveTask(opts.taskId, tbProjectId)
      if (!resolved.success) throw new Error(resolved.message)
      task = (resolved.data as TbTask | null) ?? null
      if (!task?.taskId) {
        task = {
          ref: opts.taskId,
          taskId: opts.taskId,
          projectId: tbProjectId ?? null,
          title: "",
          description: "",
          status: "",
          parentTaskId: null,
          dueDate: null,
          fields: {},
          url: `https://www.teambition.com/task/${opts.taskId}`,
          source: "teambition",
        }
      }
    } else {
      throw new Error("绑定 Teambition 任务需要提供 taskRef 或 taskId")
    }

    const binding: RequirementTeambitionBinding = {
      ...(task.taskId ? { taskId: task.taskId } : opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.taskRef ? { taskRef: opts.taskRef } : task.ref ? { taskRef: task.ref } : {}),
      ...(task.status ? { statusName: task.status } : {}),
      ...(task.url ? { url: task.url } : {}),
      lastSyncedAt: new Date().toISOString(),
    }

    return this.transactionalUpdate(requirementId, (current) => {
      current.teambition = binding
      return current
    })
  }

  /** 解除需求的 Teambition 任务绑定。 */
  unbindRequirementTask(requirementId: string): WorkflowState {
    return this.transactionalUpdate(requirementId, (current) => {
      delete current.teambition
      return current
    })
  }

  /** 读取需求绑定任务的最新 Teambition 状态并回写缓存。 */
  async getRequirementTeambitionStatus(requirementId: string): Promise<RequirementTeambitionBinding> {
    const state = this.getState(requirementId)
    const binding = state.teambition
    if (!binding?.taskId && !binding?.taskRef) {
      throw new Error(`需求 ${requirementId} 未绑定 Teambition 任务`)
    }
    const tb = this.requireTeambition()
    const project = this.store.loadProject(state.projectId)
    const ref = binding.taskRef ?? binding.taskId!
    const resolved = await tb.resolveTask(ref, project.teambition?.projectId)
    if (!resolved.success) throw new Error(resolved.message)
    const task = resolved.data as TbTask | null
    if (!task) throw new Error(`未找到 Teambition 任务: ${ref}`)

    const next: RequirementTeambitionBinding = {
      ...binding,
      ...(task.taskId ? { taskId: task.taskId } : {}),
      ...(task.status ? { statusName: task.status } : {}),
      ...(task.url ? { url: task.url } : {}),
      lastSyncedAt: new Date().toISOString(),
    }
    this.transactionalUpdate(requirementId, (current) => {
      current.teambition = next
      return current
    })
    return next
  }

  /** 更新需求绑定任务的 Teambition 工作流状态。 */
  async updateRequirementTeambitionStatus(
    requirementId: string,
    statusId: string,
    operatorId?: string,
  ): Promise<RequirementTeambitionBinding> {
    const state = this.getState(requirementId)
    const binding = state.teambition
    if (!binding?.taskId) {
      throw new Error(`需求 ${requirementId} 未绑定 Teambition 任务 ID`)
    }
    const op = operatorId ?? this.teambitionOperatorId
    if (!op) throw new Error("更新 Teambition 状态需要 operatorId")

    const tb = this.requireTeambition()
    const result = await tb.updateTask({ taskId: binding.taskId, statusId, operatorId: op })
    if (!result.success) throw new Error(result.message)

    const statuses = await this.listTeambitionCardStatuses(state.projectId)
    const matched = statuses.find((item) => item.id === statusId)
    const next: RequirementTeambitionBinding = {
      ...binding,
      statusId,
      ...(matched ? { statusName: matched.name } : {}),
      lastSyncedAt: new Date().toISOString(),
    }
    this.transactionalUpdate(requirementId, (current) => {
      current.teambition = next
      return current
    })
    return next
  }

  // ── OmniPlan 导入导出 ──

  /**
   * 更新项目的 OmniPlan 元数据（仅允许 omniplanFolder / omniplanIdMap / omniplanFileName 三个键）。
   */
  setProjectOmniPlanMeta(
    projectId: string,
    patch: { omniplanFolder?: string; omniplanIdMap?: string; omniplanFileName?: string },
  ): Project {
    const allowedKeys = new Set(["omniplanFolder", "omniplanIdMap", "omniplanFileName"])
    const invalidKeys = Object.keys(patch).filter((k) => !allowedKeys.has(k))
    if (invalidKeys.length > 0) {
      throw new Error(`不允许修改以下 OmniPlan 元数据键: ${invalidKeys.join(", ")}`)
    }

    return this.store.updateProject(projectId, (current) => {
      if (!current.metadata) current.metadata = {}
      if (patch.omniplanFolder !== undefined) {
        validateOmniPlanName(patch.omniplanFolder, "folder")
        current.metadata["omniplanFolder"] = patch.omniplanFolder
      }
      if (patch.omniplanIdMap !== undefined) {
        current.metadata["omniplanIdMap"] = patch.omniplanIdMap
      }
      if (patch.omniplanFileName !== undefined) {
        current.metadata["omniplanFileName"] = patch.omniplanFileName
      }
      return current
    })
  }

  // ── BRD 设计（项目配置 + AI 生成/检查）──

  /** 读取项目 BRD 设计配置（无配置时返回空对象） */
  getProjectBrdDesignConfig(projectId: string): ProjectBrdDesignConfig {
    const project = this.store.loadProject(projectId)
    return parseBrdDesignConfigFromMetadata(project.metadata)
  }

  /** 深合并更新项目 BRD 设计配置；空串字段表示清除 */
  setProjectBrdDesignConfig(projectId: string, patch: ProjectBrdDesignConfigPatch): Project {
    return this.store.updateProject(projectId, (current) => {
      if (!current.metadata) current.metadata = {}
      const merged = mergeBrdDesignConfig(
        parseBrdDesignConfigFromMetadata(current.metadata),
        patch,
      )
      const serialized = serializeBrdDesignConfig(merged)
      if (serialized === undefined) {
        delete current.metadata[BRD_DESIGN_METADATA_KEY]
      } else {
        current.metadata[BRD_DESIGN_METADATA_KEY] = serialized
      }
      return current
    })
  }

  /** 预览已渲染提示词（不调用 AI） */
  previewBrdPrompts(
    projectId: string,
    requirementId: string,
    options?: { mode?: "generate" | "check" | "all"; includeSummarize?: boolean },
  ): { prompts: BrdRenderedPrompt[]; warnings: string[]; outputPath: string } {
    const { config, context } = this.prepareBrdContext(projectId, requirementId)
    const prompts = renderBrdPromptsForContext(
      config,
      context,
      options?.mode ?? "all",
      options?.includeSummarize === true ? { includeSummarize: true } : undefined,
    )
    return { prompts, warnings: context.warnings, outputPath: context.outputPath }
  }

  /** AI 生成 BRD；dryRun 只返回提示词不写文件 */
  async generateBrd(
    projectId: string,
    requirementId: string,
    options?: { dryRun?: boolean },
  ): Promise<{
    outputPath: string
    result?: string
    promptsUsed: BrdRenderedPrompt[]
    warnings: string[]
    dryRun: boolean
  }> {
    const { config, context, state } = this.prepareBrdContext(projectId, requirementId)
    const promptsUsed = renderBrdPromptsForContext(config, context, "generate")
    const generatePrompt = promptsUsed.find((item) => item.id === "generate")
    if (!generatePrompt) {
      throw new Error("未找到 generate 提示词")
    }
    if (options?.dryRun) {
      return {
        outputPath: context.outputPath,
        promptsUsed,
        warnings: context.warnings,
        dryRun: true,
      }
    }
    if (!this.aiClient) {
      throw new Error("未配置 AI 客户端，无法生成 BRD")
    }
    const envelope = encodeBrdPromptEnvelope(generatePrompt.system, generatePrompt.prompt)
    const response = await this.aiClient.callAssistant(AIAssistantType.BRD_GENERATE, envelope)
    mkdirSync(dirname(context.absoluteOutputPath), { recursive: true })
    writeFileSync(context.absoluteOutputPath, response.result, "utf8")
    this.createArtifact(requirementId, {
      type: ArtifactType.BRD,
      title: `${state.requirementName} BRD`,
      description: "AI 生成的商业需求文档",
      phase: Phase.INTENTION,
      createdBy: Role.AI,
      content: response.result.slice(0, 4_000),
      filePath: toProjectRelative(state.projectRoot || ".", context.absoluteOutputPath),
    })
    return {
      outputPath: context.outputPath,
      result: response.result,
      promptsUsed,
      warnings: context.warnings,
      dryRun: false,
    }
  }

  /** AI 检查 BRD；dryRun 只返回提示词；缺少已有 BRD 时抛错 */
  async checkBrd(
    projectId: string,
    requirementId: string,
    options?: { dryRun?: boolean },
  ): Promise<{
    reportPath: string
    result?: string
    promptsUsed: BrdRenderedPrompt[]
    warnings: string[]
    dryRun: boolean
  }> {
    const { config, context, state } = this.prepareBrdContext(projectId, requirementId)
    if (!context.existingBrd.trim()) {
      throw new Error(
        `未找到已有 BRD（${context.outputPath}）。请先运行 brd generate，或将 BRD 放入该路径后再检查。`,
      )
    }
    const promptsUsed = renderBrdPromptsForContext(config, context, "check")
    const checkPrompt = promptsUsed.find((item) => item.id === "check")
    if (!checkPrompt) {
      throw new Error("未找到 check 提示词")
    }
    const reportAbsolute = resolveBrdCheckReportPath(context.absoluteOutputPath)
    const reportPath = toProjectRelative(state.projectRoot || ".", reportAbsolute)
    if (options?.dryRun) {
      return {
        reportPath,
        promptsUsed,
        warnings: context.warnings,
        dryRun: true,
      }
    }
    if (!this.aiClient) {
      throw new Error("未配置 AI 客户端，无法检查 BRD")
    }
    const envelope = encodeBrdPromptEnvelope(checkPrompt.system, checkPrompt.prompt)
    const response = await this.aiClient.callAssistant(AIAssistantType.BRD_CHECK, envelope)
    mkdirSync(dirname(reportAbsolute), { recursive: true })
    writeFileSync(reportAbsolute, response.result, "utf8")
    return {
      reportPath,
      result: response.result,
      promptsUsed,
      warnings: context.warnings,
      dryRun: false,
    }
  }

  private prepareBrdContext(projectId: string, requirementId: string): {
    config: ProjectBrdDesignConfig
    context: ReturnType<typeof gatherBrdSourceContext>
    state: WorkflowState
  } {
    const project = this.store.loadProject(projectId)
    const state = this.getState(requirementId)
    if (state.projectId !== project.projectId) {
      throw new Error(`需求 ${requirementId} 不属于项目 ${projectId}`)
    }
    const projectRoot = state.projectRoot
    if (!projectRoot) {
      throw new Error(`需求 ${requirementId} 未设置 projectRoot，无法采集 BRD 上下文`)
    }
    const config = parseBrdDesignConfigFromMetadata(project.metadata)
    const context = gatherBrdSourceContext(config, projectRoot, {
      name: state.requirementName,
      description: state.description,
    })
    return { config, context, state }
  }

  /**
   * 导出项目为 OmniPlan .oplx 文件。
   */
  exportProjectOmniPlan(
    projectId: string,
    options?: { fileName?: string | undefined; rootDir?: string | undefined },
  ): { path: string; taskCount: number; folder: string } {
    const project = this.store.loadProject(projectId)
    const requirementIds = this.store.listRequirements(projectId)

    // Resolve root directory
    const config = loadConfig()
    const rootDir = options?.rootDir ?? config.omniplan?.rootDir ?? "/Users/ben/Documents/OmniPlan"

    // Resolve folder
    const folder = resolveOmniPlanFolder(project.name, projectId, project.metadata)

    // Resolve file name
    const projectsDir = `${rootDir}/Projects/${folder}`
    let existingFiles: string[] | undefined
    if (existsSync(projectsDir)) {
      try {
        existingFiles = readdirSync(projectsDir)
          .filter((f) => f.endsWith(".oplx"))
          .map((f) => f)
      } catch {
        // ignore read errors
      }
    }

    const fileName = resolveOmniPlanFileName(
      project.name,
      project.metadata,
      options?.fileName,
      existingFiles,
    )

    // Build requirements data
    const requirements: OmniPlanBuildInput["requirements"] = []
    let totalTaskCount = 0

    for (const reqId of requirementIds) {
      const state = this.getState(reqId)
      const nodes = state.steps.map((step) => ({
        id: step.id,
        name: step.name,
        nodeId: step.id,
        requirementId: reqId,
        plannedStart: step.plannedStart,
        plannedEnd: step.plannedEnd,
        dependsOn: step.dependsOn,
      }))
      totalTaskCount += nodes.length

      requirements.push({
        id: reqId,
        name: state.requirementName,
        plannedStart: state.plannedStart,
        plannedEnd: state.plannedEnd,
        nodes,
        milestones: (state.milestones ?? []).map((ms) => ({
          id: ms.id,
          name: ms.name,
          date: ms.date,
        })),
      })
    }

    // Parse existing ID map
    let idMap: Record<string, string> = {}
    if (project.metadata?.["omniplanIdMap"]) {
      try {
        idMap = JSON.parse(project.metadata["omniplanIdMap"]) as Record<string, string>
      } catch {
        // ignore parse errors
      }
    }

    // Generate scenario ID
    const scenarioId = `op-${folder.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`

    // Build Actual.xml
    const actualXml = buildOmniPlanActual({
      projectName: project.name,
      scenarioId,
      startDate: requirements.find((r) => r.plannedStart)?.plannedStart,
      requirements,
      idMap,
    })

    // Build TOC.xml
    const tocXml = buildTocXml(scenarioId)

    // Pack and write
    const oplxBuffer = packOplx(actualXml, tocXml)

    // Ensure directory exists
    if (!existsSync(projectsDir)) {
      mkdirSync(projectsDir, { recursive: true })
    }

    const filePath = `${projectsDir}/${fileName}`
    writeFileSync(filePath, oplxBuffer)

    // Save updated ID map
    const updatedIdMap = JSON.stringify(idMap)
    this.store.updateProject(projectId, (current) => {
      if (!current.metadata) current.metadata = {}
      current.metadata["omniplanFolder"] = folder
      current.metadata["omniplanIdMap"] = updatedIdMap
      current.metadata["omniplanFileName"] = fileName
      return current
    })

    return { path: filePath, taskCount: totalTaskCount, folder }
  }

  /**
   * 导入 OmniPlan .oplx 文件到项目。
   */
  importProjectOmniPlan(
    projectId: string,
    options?: { fileName?: string | undefined; path?: string | undefined; rootDir?: string | undefined },
  ): OmniPlanImportResult {
    const project = this.store.loadProject(projectId)
    const requirementIds = this.store.listRequirements(projectId)

    // Resolve root directory
    const config = loadConfig()
    const rootDir = options?.rootDir ?? config.omniplan?.rootDir ?? "/Users/ben/Documents/OmniPlan"

    // Resolve file path
    let filePath: string
    if (options?.path) {
      // Absolute path bypasses mapping
      filePath = options.path
    } else {
      const folder = resolveOmniPlanFolder(project.name, projectId, project.metadata)
      const projectsDir = `${rootDir}/Projects/${folder}`
      let existingFiles: string[] | undefined
      if (existsSync(projectsDir)) {
        try {
          existingFiles = readdirSync(projectsDir)
            .filter((f) => f.endsWith(".oplx"))
            .map((f) => f)
        } catch {
          // ignore read errors
        }
      }

      const fileName = resolveOmniPlanFileName(
        project.name,
        project.metadata,
        options?.fileName,
        existingFiles,
      )

      filePath = `${projectsDir}/${fileName}`
    }

    // Read and parse the .oplx file
    const buffer = readFileSync(filePath)
    const { actualXml } = unpackOplx(buffer)
    const doc = parseOmniPlanActual(actualXml)

    // Parse existing ID map
    let idMap: Record<string, string> = {}
    if (project.metadata?.["omniplanIdMap"]) {
      try {
        idMap = JSON.parse(project.metadata["omniplanIdMap"]) as Record<string, string>
      } catch {
        // ignore parse errors
      }
    }

    // Build reverse maps
    const noteToTask = new Map<string, typeof doc.tasks[0]>()
    const titleToTask = new Map<string, typeof doc.tasks[0]>()
    const omniIdToTask = new Map<string, typeof doc.tasks[0]>()

    for (const task of doc.tasks) {
      if (task.note) {
        noteToTask.set(task.note, task)
      }
      if (task.title) {
        const parentKey = `${task.title}`
        titleToTask.set(parentKey, task)
      }
      omniIdToTask.set(task.id, task)
    }

    // Map octopus keys to OmniPlan tasks
    const requirementMap = new Map<string, typeof doc.tasks[0]>()
    const nodeMap = new Map<string, typeof doc.tasks[0]>()
    const milestoneMap = new Map<string, typeof doc.tasks[0]>()
    const unmatched: string[] = []
    const skipped: string[] = []

    // Match by note first
    for (const reqId of requirementIds) {
      const note = `octopus:requirement:${reqId}`
      const task = noteToTask.get(note)
      if (task) {
        requirementMap.set(reqId, task)
        continue
      }
      unmatched.push(`requirement:${reqId}`)
    }

    // Match nodes by note
    for (const reqId of requirementIds) {
      const state = this.getState(reqId)
      for (const step of state.steps) {
        const nodeNote = `octopus:node:${reqId}:${step.id}`
        const task = noteToTask.get(nodeNote)
        if (task) {
          nodeMap.set(step.id, task)
          continue
        }

        // Try title match in same parent group
        const reqTask = requirementMap.get(reqId)
        if (reqTask) {
          const childTasks = doc.tasks.filter((t) =>
            reqTask.childIds.includes(t.id) ||
            reqTask.childIds.some((cid) => {
              const parent = omniIdToTask.get(cid)
              return parent?.childIds.includes(t.id)
            }),
          )
          const titleMatch = childTasks.find((t) => t.title === step.name)
          if (titleMatch) {
            nodeMap.set(step.id, titleMatch)
            continue
          }
        }

        unmatched.push(`node:${reqId}:${step.id}`)
      }
    }

    // Match milestones by note → idMap → title+type=milestone (unique)
    for (const reqId of requirementIds) {
      const state = this.getState(reqId)
      const octopusMsIds = new Set<string>((state.milestones ?? []).map((ms) => ms.id))

      // Track which Octopus milestones matched
      const matchedMsIds = new Set<string>()

      for (const ms of state.milestones ?? []) {
        // 1. note match
        const msNote = `octopus:milestone:${reqId}:${ms.id}`
        const noteTask = noteToTask.get(msNote)
        if (noteTask) {
          milestoneMap.set(ms.id, noteTask)
          matchedMsIds.add(ms.id)
          continue
        }

        // 2. idMap match
        const msKey = `milestone:${reqId}:${ms.id}`
        const omniId = idMap[msKey]
        if (omniId) {
          const omniTask = omniIdToTask.get(omniId)
          if (omniTask) {
            milestoneMap.set(ms.id, omniTask)
            matchedMsIds.add(ms.id)
            continue
          }
        }

        // 3. title match: unique milestone with same name in same requirement group
        const reqTask = requirementMap.get(reqId)
        if (reqTask) {
          const childTasks = doc.tasks.filter((t) =>
            reqTask.childIds.includes(t.id) ||
            reqTask.childIds.some((cid) => {
              const parent = omniIdToTask.get(cid)
              return parent?.childIds.includes(t.id)
            }),
          )
          const sameName = childTasks.filter(
            (t) => t.type === "milestone" && t.title === ms.name,
          )
          if (sameName.length === 1) {
            milestoneMap.set(ms.id, sameName[0]!)
            matchedMsIds.add(ms.id)
            continue
          }
        }

        // 4. no match → skipped
        skipped.push(`milestone:${reqId}:${ms.id}`)
      }

      // 5. OmniPlan milestones with no Octopus counterpart → skipped
      if (requirementMap.has(reqId)) {
        const reqTask = requirementMap.get(reqId)!
        for (const task of doc.tasks) {
          if (task.type !== "milestone") continue
          if (!task.note?.startsWith(`octopus:milestone:${reqId}:`)) continue
          const omniMsId = task.note.split(":")[3]
          if (omniMsId && !octopusMsIds.has(omniMsId)) {
            skipped.push(`milestone:${reqId}:${omniMsId}`)
          }
        }
      }
    }

    // Import dates
    let updatedRequirements = 0
    let updatedNodes = 0
    let updatedMilestones = 0

    for (const reqId of requirementIds) {
      const reqTask = requirementMap.get(reqId)
      if (!reqTask) continue

      // Import requirement schedule
      if (reqTask.lockedStartDate) {
        const start = omniPlanIsoToDate(reqTask.lockedStartDate)
        if (reqTask.effort) {
          const days = Math.ceil(reqTask.effort / 28800)
          const endDate = new Date(start)
          endDate.setDate(endDate.getDate() + days - 1)
          const end = endDate.toISOString().slice(0, 10)

          try {
            this.updateRequirementSchedule(reqId, { plannedStart: start, plannedEnd: end })
            updatedRequirements++
          } catch {
            // Skip if invalid dates
          }
        }
      }

      // Import node schedules
      const state = this.getState(reqId)
      for (const step of state.steps) {
        const nodeTask = nodeMap.get(step.id)
        if (!nodeTask) continue

        if (!nodeTask.lockedStartDate) {
          skipped.push(`node:${reqId}:${step.id}`)
          continue
        }

        const start = omniPlanIsoToDate(nodeTask.lockedStartDate)
        let end: string | undefined
        if (nodeTask.effort) {
          const days = Math.ceil(nodeTask.effort / 28800)
          const endDate = new Date(start)
          endDate.setDate(endDate.getDate() + days - 1)
          end = endDate.toISOString().slice(0, 10)
        }

        if (start && end) {
          try {
            this.updateNodeSchedule(reqId, step.id, { plannedStart: start, plannedEnd: end })
            updatedNodes++
          } catch {
            // Skip if invalid dates
          }
        } else {
          skipped.push(`node:${reqId}:${step.id}`)
        }
      }

      // Import milestone dates
      const state2 = this.getState(reqId)
      for (const ms of state2.milestones ?? []) {
        const msTask = milestoneMap.get(ms.id)
        if (!msTask) continue

        if (!msTask.lockedStartDate) {
          skipped.push(`milestone:${reqId}:${ms.id}`)
          continue
        }

        try {
          const start = omniPlanIsoToDate(msTask.lockedStartDate)
          this.updateMilestone(reqId, ms.id, { date: start })
          updatedMilestones++
        } catch {
          // Skip if invalid dates
        }
      }
    }

    // Save updated ID map
    const updatedIdMap = JSON.stringify(idMap)
    this.store.updateProject(projectId, (current) => {
      if (!current.metadata) current.metadata = {}
      current.metadata["omniplanIdMap"] = updatedIdMap
      return current
    })

    return {
      updatedRequirements,
      updatedNodes,
      updatedMilestones,
      unmatched,
      skipped,
      path: filePath,
    }
  }
}

function firstProjectRoot(store: StateStore): string | undefined {
  const requirementId = store.listRequirements()[0]
  if (!requirementId) return undefined
  return store.load(requirementId).projectRoot
}

/**
 * 从配置创建 WorkflowEngine 实例。
 *
 * 组合根：装配 StateStore + AIClient + 项目插件 + 可选 Teambition。无插件时与旧行为等价。
 */
export async function createWorkflowEngineFromConfig(
  config: OctopusConfig,
  options?: { projectRoot?: string },
): Promise<WorkflowEngine> {
  const store = createStateStore({ storeDir: config.storeDir })
  const projectRoot = options?.projectRoot ?? firstProjectRoot(store) ?? process.cwd()
  const pluginHost = await loadPlugins(
    [...loadWorkflowPluginRefs(projectRoot), ...config.plugins],
    { projectRoot },
  )
  const integrations: Record<string, IntegrationService> = { ...pluginHost.integrations }
  const teambition = config.teambition
  if (teambition?.appId && teambition.appSecret && teambition.orgId) {
    integrations["teambition"] = createTeambitionClient({
      appId: teambition.appId,
      appSecret: teambition.appSecret,
      orgId: teambition.orgId,
      ...(teambition.gatewayBase !== undefined ? { gatewayBase: teambition.gatewayBase } : {}),
      ...(teambition.refStrategy !== undefined ? { refStrategy: teambition.refStrategy } : {}),
      ...(teambition.timeoutMs !== undefined ? { timeoutMs: teambition.timeoutMs } : {}),
    })
  }
  return new WorkflowEngine({
    store,
    aiClient: createAIClient(toAIClientConfig(config)),
    strictPermissions: config.workflow.strictPermissions,
    aiGatingEnabled: config.workflow.aiGatingEnabled,
    heinrichThreshold: config.workflow.heinrichThreshold,
    integrations,
    pluginHost,
    ...(teambition?.operatorId !== undefined ? { teambitionOperatorId: teambition.operatorId } : {}),
  })
}
