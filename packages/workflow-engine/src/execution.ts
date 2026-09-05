/**
 * 工作流节点调度服务。
 *
 * 负责依赖门控、运行记录、后台 worker 生命周期与当前节点派生视图；具体
 * 命令执行由 @octopus/executor 的 worker 完成。
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs"
import { join, resolve } from "node:path"
import type { PersistenceStore } from "@octopus/context/index.js"
import {
  loadWorkflowDefinition,
  resolveWorkflowNodeKey,
  syncWorkflowWorkspace,
} from "@octopus/context/workflow.js"
import type {
  IntegrationHealth,
  NodeRun,
  NodeRunStatus,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowExecutionSnapshot,
} from "@octopus/core/execution.js"
import { TaskStatus } from "@octopus/core/task.js"
import type { WorkflowState } from "@octopus/core/workflow.js"
import { launchWorker, terminateWorker } from "@octopus/executor/index.js"

export interface RunNodeOptions {
  readonly force?: boolean
}

export interface RunWorkflowOptions {
  readonly maxParallel?: number
  readonly pollIntervalMs?: number
  readonly force?: boolean
  /** Agent 模式：AI 自动完成 manual 节点；隐含 autoAdvance=true */
  readonly agentMode?: boolean
  /** 自动推进阶段边界（agentMode 隐含 true） */
  readonly autoAdvance?: boolean
}

/** Agent 模式单次运行的汇总结果。 */
export interface AgentRunSummary {
  status: "COMPLETED" | "PARTIAL" | "BLOCKED"
  autoCompleted: Array<{ nodeId: string; nodeName: string; completedBy: string }>
  blocked: Array<{ nodeId: string; nodeName: string; reason: string }>
  failed: Array<{ nodeId: string; nodeName: string; error: string }>
  highRiskNodes: Array<{ nodeId: string; riskReportPath: string }>
  reportPath: string
}

/**
 * Agent 模式返回的扩展快照：在 WorkflowExecutionSnapshot 基础上挂载
 * agentSummary。非 agentMode 时 agentSummary 为 undefined，保持向后兼容。
 */
export interface AgentWorkflowExecutionSnapshot extends WorkflowExecutionSnapshot {
  agentSummary?: AgentRunSummary
}

export interface ReadRunLogsOptions {
  readonly stream?: "stdout" | "stderr"
  readonly offset?: number
  readonly maxBytes?: number
}

export interface RunLogSlice {
  readonly runId: string
  readonly nodeId: string
  readonly status: NodeRunStatus
  readonly stream: "stdout" | "stderr"
  readonly exists: boolean
  readonly size: number
  readonly offset: number
  readonly nextOffset: number
  readonly truncated: boolean
  readonly content: string
}

const MAX_TIMER_DELAY_MS = 2_147_483_647
const DEFAULT_LOG_MAX_BYTES = 262_144
const ABSOLUTE_LOG_MAX_BYTES = 1_048_576

export class NodeExecutionService {
  private static readonly retentionDays = 30
  private readonly executions
  private readonly storeDir: string

  constructor(
    private readonly store: PersistenceStore,
    private readonly loadDefinition: (
      projectRoot: string,
    ) => WorkflowDefinition = loadWorkflowDefinition,
  ) {
    this.storeDir = resolve(store.getStorePath())
    this.executions = store
  }

  async initialize(): Promise<void> {
    const cutoff = new Date(
      Date.now() - NodeExecutionService.retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString()
    await this.executions.purge(cutoff)
  }

  /**
   * 在 PersistenceStore 事务中完成读改写，具体并发控制由存储层负责。
   */
  private async transactionalUpdate(
    requirementId: string,
    updater: (state: WorkflowState) => WorkflowState,
  ): Promise<WorkflowState> {
    return this.store.update(requirementId, updater)
  }

  async getSnapshot(requirementId: string): Promise<WorkflowExecutionSnapshot> {
    const state = await this.store.load(requirementId)
    const runs = await this.executions.listRuns(requirementId)
    const activeRuns = runs.filter((run) => run.status === "QUEUED" || run.status === "RUNNING")
    const runningIds = new Set(activeRuns.map((run) => run.nodeId))
    const readyNodeIds: string[] = []
    const waitingNodeIds: string[] = []
    for (const step of state.steps) {
      if (step.status !== TaskStatus.PENDING) continue
      const dependenciesReady = step.dependsOn.every((dependency) => {
        const target = state.steps.find((candidate) => candidate.id === dependency)
        return target?.status === TaskStatus.COMPLETED
      })
      if (!dependenciesReady) continue
      if ((step.actions ?? []).every((action) => action.type === "manual"))
        waitingNodeIds.push(step.id)
      else readyNodeIds.push(step.id)
    }
    const currentNodeIds = [...new Set([...runningIds, ...readyNodeIds, ...waitingNodeIds])]
    const hasBlocked = state.steps.some((step) => step.status === TaskStatus.BLOCKED)
    const allDone =
      state.steps.length > 0 &&
      state.steps.every(
        (step) => step.status === TaskStatus.COMPLETED || step.status === TaskStatus.SKIPPED,
      )
    const schedulerStatus =
      activeRuns.length > 0
        ? "RUNNING"
        : allDone
          ? "COMPLETED"
          : waitingNodeIds.length > 0
            ? "PAUSED"
            : hasBlocked && readyNodeIds.length === 0
              ? "BLOCKED"
              : "IDLE"
    return {
      requirementId,
      currentNodeIds,
      readyNodeIds,
      waitingNodeIds,
      activeRuns,
      schedulerStatus,
      updatedAt: new Date().toISOString(),
    }
  }

  async runNode(
    requirementId: string,
    nodeId: string,
    options: RunNodeOptions = {},
  ): Promise<NodeRun> {
    const state = await this.store.load(requirementId)
    const step = state.steps.find((candidate) => candidate.id === nodeId)
    if (!step) throw new Error(`节点不存在: ${nodeId}`)
    const active = (await this.executions.listRuns(requirementId, nodeId)).find(
      (run) => run.status === "QUEUED" || run.status === "RUNNING",
    )
    if (active) throw new Error(`节点 ${nodeId} 已有活动运行: ${active.id}`)
    const unmet = step.dependsOn.filter((dependency) => {
      const target = state.steps.find((candidate) => candidate.id === dependency)
      return target?.status !== TaskStatus.COMPLETED
    })
    if (unmet.length > 0 && !options.force) {
      throw new Error(`节点 ${nodeId} 依赖未满足: ${unmet.join(", ")}`)
    }
    if ((step.actions ?? []).every((action) => action.type === "manual")) {
      throw new Error(`节点 ${nodeId} 是手动节点，请使用 node complete`)
    }
    const projectRoot = state.projectRoot
    if (!projectRoot) throw new Error(`需求 ${requirementId} 未配置源码根目录，请重新 init --root`)
    const definition = this.loadDefinition(projectRoot)
    const workspace = syncWorkflowWorkspace(projectRoot, definition)
    const nodeKey = resolveWorkflowNodeKey(definition, nodeId)
    const runDir = join(this.storeDir, "runs", requirementId, nodeId.replaceAll("/", "_"))
    mkdirSync(runDir, { recursive: true })
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const run = await this.executions.createRun({
      id: runId,
      requirementId,
      nodeId,
      forced: options.force === true,
      stdoutPath: join(runDir, `${runId}.stdout.log`),
      stderrPath: join(runDir, `${runId}.stderr.log`),
    })
    await this.transactionalUpdate(requirementId, (current) => {
      const target = current.steps.find((candidate) => candidate.id === nodeId)
      if (target) {
        target.status = TaskStatus.IN_PROGRESS
        target.updatedAt = new Date().toISOString()
        target.notes = `workspace=${workspace.nodePath(nodeKey)}`
      }
      return current
    })
    await this.appendEvent(requirementId, run, "RUN_QUEUED", {
      forced: run.forced,
      workspace: workspace.nodePath(nodeKey),
    })
    const startedAt = new Date().toISOString()
    await this.executions.updateRun(run.id, {
      status: "RUNNING",
      startedAt,
      heartbeatAt: startedAt,
    })
    let pid: number
    try {
      pid = launchWorker({ storeDir: this.storeDir, requirementId, run })
    } catch (cause) {
      const error = (cause as Error).message
      const failed = await this.executions.updateRun(run.id, {
        status: "FAILED",
        finishedAt: new Date().toISOString(),
        error,
      })
      await this.transactionalUpdate(requirementId, (current) => {
        const target = current.steps.find((candidate) => candidate.id === nodeId)
        if (target) {
          target.status = TaskStatus.BLOCKED
          target.notes = error
          target.updatedAt = new Date().toISOString()
        }
        return current
      })
      await this.appendEvent(requirementId, failed, "RUN_FAILED", { error })
      throw cause
    }
    const started = await this.executions.updateRun(run.id, { pid })
    await this.appendEvent(requirementId, started, "RUN_STARTED", { pid })
    return started
  }

  async completeManualNode(
    requirementId: string,
    nodeId: string,
    force = false,
  ): Promise<WorkflowState> {
    const state = await this.transactionalUpdate(requirementId, (current) => {
      const step = current.steps.find((candidate) => candidate.id === nodeId)
      if (!step) throw new Error(`节点不存在: ${nodeId}`)
      if (!(step.actions ?? []).every((action) => action.type === "manual")) {
        throw new Error(`节点 ${nodeId} 不是手动节点`)
      }
      const unmet = step.dependsOn.filter((dependency) => {
        const target = current.steps.find((candidate) => candidate.id === dependency)
        return target?.status !== TaskStatus.COMPLETED
      })
      if (unmet.length > 0 && !force)
        throw new Error(`节点 ${nodeId} 依赖未满足: ${unmet.join(", ")}`)
      step.status = TaskStatus.COMPLETED
      step.completedAt = new Date().toISOString()
      step.updatedAt = new Date().toISOString()
      return current
    })
    await this.executions.appendEvent({
      requirementId,
      nodeId,
      type: "RUN_FINISHED",
      payload: { manual: true, status: "SUCCEEDED" },
      createdAt: new Date().toISOString(),
    })
    return state
  }

  /**
   * Agent 模式下的 manual 节点自动完成。
   *
   * 校验逻辑与 completeManualNode 一致（节点必须全 manual actions），但在
   * transactionalUpdate 中额外写入 completedBy="agent" 与 notes="[agent-auto] ..."，
   * 并发出 payload 含 agent:true 的 RUN_FINISHED 事件，便于审计。
   *
   * MVP 不引入 AIClient：直接标记完成，payload 中注明 aiSkipped:true。
   * 失败（节点不存在/非 manual/依赖未满足）按原有语义抛错，由 runWorkflow 汇总为 BLOCKED。
   */
  async completeManualNodeAsAgent(
    requirementId: string,
    nodeId: string,
    force = true,
  ): Promise<WorkflowState> {
    const state = await this.transactionalUpdate(requirementId, (current) => {
      const step = current.steps.find((candidate) => candidate.id === nodeId)
      if (!step) throw new Error(`节点不存在: ${nodeId}`)
      if (!(step.actions ?? []).every((action) => action.type === "manual")) {
        throw new Error(`节点 ${nodeId} 不是手动节点`)
      }
      const unmet = step.dependsOn.filter((dependency) => {
        const target = current.steps.find((candidate) => candidate.id === dependency)
        return target?.status !== TaskStatus.COMPLETED
      })
      if (unmet.length > 0 && !force)
        throw new Error(`节点 ${nodeId} 依赖未满足: ${unmet.join(", ")}`)
      step.status = TaskStatus.COMPLETED
      step.completedAt = new Date().toISOString()
      step.updatedAt = new Date().toISOString()
      step.completedBy = "agent"
      step.notes = "[agent-auto] AI 自动完成 manual 节点"
      return current
    })
    await this.executions.appendEvent({
      requirementId,
      nodeId,
      type: "RUN_FINISHED",
      payload: { manual: true, agent: true, status: "SUCCEEDED", aiSkipped: true },
      createdAt: new Date().toISOString(),
    })
    return state
  }

  async cancelRun(requirementId: string, runId: string): Promise<NodeRun> {
    const run = await this.executions.getRun(runId)
    if (!run || run.requirementId !== requirementId) throw new Error(`运行不存在: ${runId}`)
    if (run.status !== "QUEUED" && run.status !== "RUNNING") return run
    const canceled = await this.executions.transitionRun(runId, ["QUEUED", "RUNNING"], {
      status: "CANCELED",
      finishedAt: new Date().toISOString(),
    })
    if (!canceled) return (await this.executions.getRun(runId)) ?? run
    let finalRun = canceled
    try {
      if (canceled.pid) terminateWorker(canceled)
    } catch (cause) {
      finalRun = await this.executions.updateRun(runId, {
        error: `运行已取消，但终止 worker 失败: ${(cause as Error).message}`,
      })
    }
    await this.transactionalUpdate(requirementId, (state) => {
      const step = state.steps.find((candidate) => candidate.id === canceled.nodeId)
      if (step && step.status === TaskStatus.IN_PROGRESS) {
        step.status = TaskStatus.BLOCKED
        step.notes = "运行已取消"
        step.updatedAt = new Date().toISOString()
      }
      return state
    })
    await this.appendEvent(requirementId, finalRun, "RUN_CANCELED", {
      requested: true,
      ...(finalRun.error ? { terminationError: finalRun.error } : {}),
    })
    return finalRun
  }

  async retryRun(
    requirementId: string,
    runId: string,
    options: RunNodeOptions = {},
  ): Promise<NodeRun> {
    const run = await this.executions.getRun(runId)
    if (!run || run.requirementId !== requirementId) throw new Error(`运行不存在: ${runId}`)
    if (["QUEUED", "RUNNING"].includes(run.status)) throw new Error(`运行仍在执行: ${runId}`)
    await this.transactionalUpdate(requirementId, (state) => {
      const step = state.steps.find((candidate) => candidate.id === run.nodeId)
      if (step) {
        step.status = TaskStatus.PENDING
        delete step.completedAt
        step.updatedAt = new Date().toISOString()
      }
      return state
    })
    return this.runNode(
      requirementId,
      run.nodeId,
      options.force === undefined ? {} : { force: options.force },
    )
  }

  async listRuns(requirementId: string, nodeId?: string): Promise<NodeRun[]> {
    return this.executions.listRuns(requirementId, nodeId)
  }

  async eventsAfter(requirementId: string, sequence = 0): Promise<WorkflowEvent[]> {
    return this.executions.eventsAfter(requirementId, sequence)
  }

  /**
   * 追加需求级事件（无 run 上下文，如 REQUIREMENT_CHANGED/BRD_UPDATED/ARTIFACT_CREATED），
   * 返回追加后的事件总数，供调用方推导事件序列号。
   */
  async emitRequirementEvent(
    requirementId: string,
    type: WorkflowEvent["type"],
    payload: Record<string, unknown>,
    nodeId?: string,
  ): Promise<number> {
    await this.executions.appendEvent({
      requirementId,
      ...(nodeId !== undefined ? { nodeId } : {}),
      type,
      payload,
      createdAt: new Date().toISOString(),
    })
    return (await this.executions.eventsAfter(requirementId, 0)).length
  }

  /**
   * 读取一次节点运行的 stdout/stderr 片段。
   * 仅允许通过已持久化的 run 记录定位文件，客户端不能传入任意路径。
   */
  async readRunLogs(
    requirementId: string,
    runId: string,
    options: ReadRunLogsOptions = {},
  ): Promise<RunLogSlice> {
    const run = await this.executions.getRun(runId)
    if (!run || run.requirementId !== requirementId) throw new Error(`运行不存在: ${runId}`)

    const stream = options.stream === "stderr" ? "stderr" : "stdout"
    const path = stream === "stderr" ? run.stderrPath : run.stdoutPath
    const offset = normalizeLogOffset(options.offset)
    const maxBytes = normalizeLogMaxBytes(options.maxBytes)
    const slice = readLogFileSlice(path, offset, maxBytes)

    return {
      runId: run.id,
      nodeId: run.nodeId,
      status: run.status,
      stream,
      exists: slice.exists,
      size: slice.size,
      offset: slice.offset,
      nextOffset: slice.nextOffset,
      truncated: slice.truncated,
      content: slice.content,
    }
  }

  /**
   * 恢复僵死运行：heartbeatAt 早于阈值的 RUNNING 运行会被中断，
   * 并同步把对应节点标记为 BLOCKED（事务化），同时写入 RUN_FAILED 事件。
   * @returns 本次恢复（中断）的运行数量
   */
  async recoverStaleRuns(requirementId: string, staleAfterMs = 30_000): Promise<number> {
    const cutoff = Date.now() - staleAfterMs
    const staleRuns = (await this.executions.listRuns(requirementId)).filter((run) => {
      if (run.status !== "RUNNING") return false
      if (run.heartbeatAt === undefined) return true
      const heartbeat = new Date(run.heartbeatAt).getTime()
      return Number.isNaN(heartbeat) || heartbeat < cutoff
    })

    for (const run of staleRuns) {
      const interrupted = await this.executions.transitionRun(run.id, ["RUNNING"], {
        status: "INTERRUPTED",
        finishedAt: new Date().toISOString(),
        error: "运行超过心跳超时未上报，判定为僵死",
      })
      if (!interrupted) continue
      await this.transactionalUpdate(requirementId, (current) => {
        const step = current.steps.find((candidate) => candidate.id === interrupted.nodeId)
        if (step) {
          step.status = TaskStatus.BLOCKED
          step.notes = "运行超过心跳超时未上报，判定为僵死"
          step.updatedAt = new Date().toISOString()
        }
        return current
      })
      await this.appendEvent(requirementId, interrupted, "RUN_FAILED", {
        status: "INTERRUPTED",
        error: interrupted.error,
      })
    }
    return staleRuns.length
  }

  async saveIntegrationHealth(health: IntegrationHealth): Promise<void> {
    await this.executions.saveIntegrationHealth(health)
  }

  async listIntegrationHealth(): Promise<IntegrationHealth[]> {
    return this.executions.listIntegrationHealth()
  }

  /** 自动并行执行 READY 节点，直到完成、阻塞或遇到手动节点。 */
  async runWorkflow(
    requirementId: string,
    options: RunWorkflowOptions = {},
  ): Promise<WorkflowExecutionSnapshot> {
    const maxParallel = options.maxParallel ?? 4
    const pollIntervalMs = options.pollIntervalMs ?? 500
    const agentMode = options.agentMode === true
    // autoAdvance 由 agentMode 隐含；阶段边界推进复用 WorkflowEngine.advancePhase（index.ts），
    // 此处循环打通 READY/waiting 即等价推进，无需额外 phase 逻辑。
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
      throw new Error("maxParallel 必须是正整数")
    }
    if (
      !Number.isSafeInteger(pollIntervalMs) ||
      pollIntervalMs < 100 ||
      pollIntervalMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error(`pollIntervalMs 必须是 100 至 ${MAX_TIMER_DELAY_MS}ms 的整数`)
    }
    const summary: AgentRunSummary = {
      status: "COMPLETED",
      autoCompleted: [],
      blocked: [],
      failed: [],
      highRiskNodes: [],
      reportPath: "",
    }
    let progressed = false
    while (true) {
      // 每次轮询先恢复僵死运行，避免卡住调度器
      await this.recoverStaleRuns(requirementId)
      const snapshot = await this.getSnapshot(requirementId)
      const capacity = maxParallel - snapshot.activeRuns.length
      let launchError: unknown
      if (capacity > 0) {
        for (const nodeId of snapshot.readyNodeIds.slice(0, capacity)) {
          try {
            await this.runNode(
              requirementId,
              nodeId,
              options.force === undefined ? {} : { force: options.force },
            )
            progressed = true
          } catch (cause) {
            launchError ??= cause
            if (agentMode) {
              summary.failed.push({
                nodeId,
                nodeName: nodeId,
                error: cause instanceof Error ? cause.message : String(cause),
              })
              summary.status = "PARTIAL"
            }
          }
        }
      }
      if (agentMode) {
        for (const nodeId of snapshot.waitingNodeIds) {
          try {
            const state = await this.completeManualNodeAsAgent(requirementId, nodeId)
            const step = state.steps.find((candidate) => candidate.id === nodeId)
            summary.autoCompleted.push({ nodeId, nodeName: nodeId, completedBy: "agent" })
            if (isHighRiskNode(nodeId, step?.name)) {
              summary.highRiskNodes.push({ nodeId, riskReportPath: "" })
            }
            progressed = true
          } catch (cause) {
            summary.blocked.push({
              nodeId,
              nodeName: nodeId,
              reason: cause instanceof Error ? cause.message : String(cause),
            })
            summary.status = "PARTIAL"
          }
        }
      }
      const next = await this.getSnapshot(requirementId)
      if (next.activeRuns.length === 0 && next.readyNodeIds.length === 0) {
        if (!agentMode) return next
        if (next.waitingNodeIds.length === 0 || !progressed) {
          return withAgentSummary(next, finalizeAgentSummary(summary, next))
        }
        progressed = false
        continue
      }
      if (launchError && next.activeRuns.length === 0 && !agentMode) throw launchError
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
    }
  }

  private async appendEvent(
    requirementId: string,
    run: NodeRun,
    type: WorkflowEvent["type"],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.executions.appendEvent({
      requirementId,
      runId: run.id,
      nodeId: run.nodeId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    })
  }
}

function normalizeLogOffset(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("offset 必须是大于等于 0 的整数")
  }
  return value
}

function normalizeLogMaxBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LOG_MAX_BYTES
  if (!Number.isSafeInteger(value) || value < 1 || value > ABSOLUTE_LOG_MAX_BYTES) {
    throw new Error(`maxBytes 必须是 1 至 ${ABSOLUTE_LOG_MAX_BYTES} 的整数`)
  }
  return value
}

const HIGH_RISK_NODE_PATTERNS = [
  "go-live-check",
  "magento-release-risk-assessment",
  "sql-execution-and-risk-check",
]

function isHighRiskNode(nodeId: string, nodeName?: string): boolean {
  const haystack = `${nodeId} ${nodeName ?? ""}`.toLowerCase()
  return HIGH_RISK_NODE_PATTERNS.some((pattern) => haystack.includes(pattern))
}

function finalizeAgentSummary(
  summary: AgentRunSummary,
  snapshot: WorkflowExecutionSnapshot,
): AgentRunSummary {
  const status: AgentRunSummary["status"] =
    snapshot.schedulerStatus === "COMPLETED"
      ? "COMPLETED"
      : summary.blocked.length > 0 || summary.failed.length > 0
        ? snapshot.schedulerStatus === "BLOCKED"
          ? "BLOCKED"
          : "PARTIAL"
        : "COMPLETED"
  return { ...summary, status }
}

function withAgentSummary(
  snapshot: WorkflowExecutionSnapshot,
  summary: AgentRunSummary,
): AgentWorkflowExecutionSnapshot {
  return { ...snapshot, agentSummary: summary }
}

function readLogFileSlice(
  path: string,
  offset: number,
  maxBytes: number,
): {
  exists: boolean
  size: number
  offset: number
  nextOffset: number
  truncated: boolean
  content: string
} {
  if (!existsSync(path)) {
    return { exists: false, size: 0, offset: 0, nextOffset: 0, truncated: false, content: "" }
  }

  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    if (size <= 0) {
      return { exists: true, size: 0, offset: 0, nextOffset: 0, truncated: false, content: "" }
    }
    const start = Math.min(offset, size)
    const length = Math.min(maxBytes, size - start)
    if (length <= 0) {
      return { exists: true, size, offset: start, nextOffset: start, truncated: false, content: "" }
    }
    const buffer = Buffer.allocUnsafe(length)
    const bytesRead = readSync(fd, buffer, 0, length, start)
    const content = buffer.subarray(0, bytesRead).toString("utf8")
    const nextOffset = start + bytesRead
    return {
      exists: true,
      size,
      offset: start,
      nextOffset,
      truncated: nextOffset < size,
      content,
    }
  } finally {
    closeSync(fd)
  }
}
