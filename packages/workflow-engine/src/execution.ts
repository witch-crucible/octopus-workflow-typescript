/**
 * 工作流节点调度服务。
 *
 * 负责依赖门控、运行记录、后台 worker 生命周期与当前节点派生视图；具体
 * 命令执行由 @octopus/executor 的 worker 完成。
 */

import { mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { StateStore } from "@octopus/context/index.js"
import { createExecutionStore } from "@octopus/context/execution.js"
import type { WorkflowDefinition } from "@octopus/core/execution.js"
import {
  loadWorkflowDefinition,
  resolveWorkflowNodeKey,
  syncWorkflowWorkspace,
} from "@octopus/context/workflow.js"
import { launchWorker, terminateWorker } from "@octopus/executor/index.js"
import type { IntegrationHealth, NodeRun, WorkflowEvent, WorkflowExecutionSnapshot } from "@octopus/core/execution.js"
import { TaskStatus } from "@octopus/core/task.js"
import type { WorkflowState } from "@octopus/core/workflow.js"

export interface RunNodeOptions {
  readonly force?: boolean
}

export interface RunWorkflowOptions {
  readonly maxParallel?: number
  readonly pollIntervalMs?: number
  readonly force?: boolean
}

const MAX_TIMER_DELAY_MS = 2_147_483_647

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

export class NodeExecutionService {
  private static readonly retentionDays = 30
  private readonly executions
  private readonly storeDir: string

  constructor(
    private readonly store: StateStore,
    private readonly loadDefinition: (projectRoot: string) => WorkflowDefinition = loadWorkflowDefinition,
  ) {
    this.storeDir = resolve(store.getStorePath())
    this.executions = createExecutionStore(this.storeDir)
    const cutoff = new Date(Date.now() - NodeExecutionService.retentionDays * 24 * 60 * 60 * 1000).toISOString()
    this.executions.purge(cutoff)
  }

  /**
   * 在单个 SQLite 事务内完成读改写；并发写锁冲突（SQLITE_BUSY）时按指数
   * 退避重试整个事务，避免跨进程并发写入互相覆盖或互相死锁。
   */
  private transactionalUpdate(
    projectId: string,
    updater: (state: WorkflowState) => WorkflowState,
  ): WorkflowState {
    let attempt = 0
    for (;;) {
      try {
        return this.store.update(projectId, updater)
      } catch (cause) {
        if (!isWriteLockError(cause) || attempt >= 30) throw cause
        attempt++
        // 抖动退避：避免多个进程以相同节奏反复碰撞
        sleep(1 + Math.floor(Math.random() * (2 ** Math.min(attempt, 7))))
      }
    }
  }

  getSnapshot(projectId: string): WorkflowExecutionSnapshot {
    const state = this.store.load(projectId)
    const runs = this.executions.listRuns(projectId)
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
      if ((step.actions ?? []).every((action) => action.type === "manual")) waitingNodeIds.push(step.id)
      else readyNodeIds.push(step.id)
    }
    const currentNodeIds = [...new Set([...runningIds, ...readyNodeIds, ...waitingNodeIds])]
    const hasBlocked = state.steps.some((step) => step.status === TaskStatus.BLOCKED)
    const allDone = state.steps.length > 0 && state.steps.every(
      (step) => step.status === TaskStatus.COMPLETED || step.status === TaskStatus.SKIPPED,
    )
    const schedulerStatus = activeRuns.length > 0
      ? "RUNNING"
      : allDone
        ? "COMPLETED"
        : waitingNodeIds.length > 0
          ? "PAUSED"
          : hasBlocked && readyNodeIds.length === 0
            ? "BLOCKED"
            : "IDLE"
    return {
      projectId,
      currentNodeIds,
      readyNodeIds,
      waitingNodeIds,
      activeRuns,
      schedulerStatus,
      updatedAt: new Date().toISOString(),
    }
  }

  runNode(projectId: string, nodeId: string, options: RunNodeOptions = {}): NodeRun {
    const state = this.store.load(projectId)
    const step = state.steps.find((candidate) => candidate.id === nodeId)
    if (!step) throw new Error(`节点不存在: ${nodeId}`)
    const active = this.executions.listRuns(projectId, nodeId).find(
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
    if (!projectRoot) throw new Error(`项目 ${projectId} 未配置源码根目录，请重新 init --root`)
    const definition = this.loadDefinition(projectRoot)
    const workspace = syncWorkflowWorkspace(projectRoot, definition)
    const nodeKey = resolveWorkflowNodeKey(definition, nodeId)
    const runDir = join(this.storeDir, "runs", projectId, nodeId.replaceAll("/", "_"))
    mkdirSync(runDir, { recursive: true })
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const run = this.executions.createRun({
      id: runId,
      projectId,
      nodeId,
      forced: options.force === true,
      stdoutPath: join(runDir, `${runId}.stdout.log`),
      stderrPath: join(runDir, `${runId}.stderr.log`),
    })
    this.transactionalUpdate(projectId, (current) => {
      const target = current.steps.find((candidate) => candidate.id === nodeId)
      if (target) {
        target.status = TaskStatus.IN_PROGRESS
        target.updatedAt = new Date().toISOString()
        target.notes = `workspace=${workspace.nodePath(nodeKey)}`
      }
      return current
    })
    this.appendEvent(projectId, run, "RUN_QUEUED", { forced: run.forced, workspace: workspace.nodePath(nodeKey) })
    const startedAt = new Date().toISOString()
    this.executions.updateRun(run.id, { status: "RUNNING", startedAt, heartbeatAt: startedAt })
    let pid: number
    try {
      pid = launchWorker({ storeDir: this.storeDir, projectId, run })
    } catch (cause) {
      const error = (cause as Error).message
      const failed = this.executions.updateRun(run.id, {
        status: "FAILED",
        finishedAt: new Date().toISOString(),
        error,
      })
      this.transactionalUpdate(projectId, (current) => {
        const target = current.steps.find((candidate) => candidate.id === nodeId)
        if (target) {
          target.status = TaskStatus.BLOCKED
          target.notes = error
          target.updatedAt = new Date().toISOString()
        }
        return current
      })
      this.appendEvent(projectId, failed, "RUN_FAILED", { error })
      throw cause
    }
    const started = this.executions.updateRun(run.id, { pid })
    this.appendEvent(projectId, started, "RUN_STARTED", { pid })
    return started
  }

  completeManualNode(projectId: string, nodeId: string, force = false): WorkflowState {
    const state = this.transactionalUpdate(projectId, (current) => {
      const step = current.steps.find((candidate) => candidate.id === nodeId)
      if (!step) throw new Error(`节点不存在: ${nodeId}`)
      if (!(step.actions ?? []).every((action) => action.type === "manual")) {
        throw new Error(`节点 ${nodeId} 不是手动节点`)
      }
      const unmet = step.dependsOn.filter((dependency) => {
        const target = current.steps.find((candidate) => candidate.id === dependency)
        return target?.status !== TaskStatus.COMPLETED
      })
      if (unmet.length > 0 && !force) throw new Error(`节点 ${nodeId} 依赖未满足: ${unmet.join(", ")}`)
      step.status = TaskStatus.COMPLETED
      step.completedAt = new Date().toISOString()
      step.updatedAt = new Date().toISOString()
      return current
    })
    this.executions.appendEvent({
      projectId,
      nodeId,
      type: "RUN_FINISHED",
      payload: { manual: true, status: "SUCCEEDED" },
      createdAt: new Date().toISOString(),
    })
    return state
  }

  cancelRun(projectId: string, runId: string): NodeRun {
    const run = this.executions.getRun(runId)
    if (!run || run.projectId !== projectId) throw new Error(`运行不存在: ${runId}`)
    if (run.status !== "QUEUED" && run.status !== "RUNNING") return run
    const canceled = this.executions.transitionRun(runId, ["QUEUED", "RUNNING"], {
      status: "CANCELED",
      finishedAt: new Date().toISOString(),
    })
    if (!canceled) return this.executions.getRun(runId) ?? run
    let finalRun = canceled
    try {
      if (canceled.pid) terminateWorker(canceled)
    } catch (cause) {
      finalRun = this.executions.updateRun(runId, {
        error: `运行已取消，但终止 worker 失败: ${(cause as Error).message}`,
      })
    }
    this.transactionalUpdate(projectId, (state) => {
      const step = state.steps.find((candidate) => candidate.id === canceled.nodeId)
      if (step && step.status === TaskStatus.IN_PROGRESS) {
        step.status = TaskStatus.BLOCKED
        step.notes = "运行已取消"
        step.updatedAt = new Date().toISOString()
      }
      return state
    })
    this.appendEvent(projectId, finalRun, "RUN_CANCELED", {
      requested: true,
      ...(finalRun.error ? { terminationError: finalRun.error } : {}),
    })
    return finalRun
  }

  retryRun(projectId: string, runId: string, options: RunNodeOptions = {}): NodeRun {
    const run = this.executions.getRun(runId)
    if (!run || run.projectId !== projectId) throw new Error(`运行不存在: ${runId}`)
    if (["QUEUED", "RUNNING"].includes(run.status)) throw new Error(`运行仍在执行: ${runId}`)
    this.transactionalUpdate(projectId, (state) => {
      const step = state.steps.find((candidate) => candidate.id === run.nodeId)
      if (step) {
        step.status = TaskStatus.PENDING
        delete step.completedAt
        step.updatedAt = new Date().toISOString()
      }
      return state
    })
    return this.runNode(projectId, run.nodeId, options.force === undefined ? {} : { force: options.force })
  }

  listRuns(projectId: string, nodeId?: string): NodeRun[] {
    return this.executions.listRuns(projectId, nodeId)
  }

  eventsAfter(projectId: string, sequence = 0): WorkflowEvent[] {
    return this.executions.eventsAfter(projectId, sequence)
  }

  /**
   * 恢复僵死运行：heartbeatAt 早于阈值的 RUNNING 运行会被中断，
   * 并同步把对应节点标记为 BLOCKED（事务化），同时写入 RUN_FAILED 事件。
   * @returns 本次恢复（中断）的运行数量
   */
  recoverStaleRuns(projectId: string, staleAfterMs = 30_000): number {
    const cutoff = Date.now() - staleAfterMs
    const staleRuns = this.executions.listRuns(projectId).filter((run) => {
      if (run.status !== "RUNNING") return false
      if (run.heartbeatAt === undefined) return true
      const heartbeat = new Date(run.heartbeatAt).getTime()
      return Number.isNaN(heartbeat) || heartbeat < cutoff
    })

    for (const run of staleRuns) {
      const interrupted = this.executions.transitionRun(run.id, ["RUNNING"], {
        status: "INTERRUPTED",
        finishedAt: new Date().toISOString(),
        error: "运行超过心跳超时未上报，判定为僵死",
      })
      if (!interrupted) continue
      this.transactionalUpdate(projectId, (current) => {
        const step = current.steps.find((candidate) => candidate.id === interrupted.nodeId)
        if (step) {
          step.status = TaskStatus.BLOCKED
          step.notes = "运行超过心跳超时未上报，判定为僵死"
          step.updatedAt = new Date().toISOString()
        }
        return current
      })
      this.appendEvent(projectId, interrupted, "RUN_FAILED", {
        status: "INTERRUPTED",
        error: interrupted.error,
      })
    }
    return staleRuns.length
  }

  saveIntegrationHealth(health: IntegrationHealth): void {
    this.executions.saveIntegrationHealth(health)
  }

  listIntegrationHealth(): IntegrationHealth[] {
    return this.executions.listIntegrationHealth()
  }

  /** 自动并行执行 READY 节点，直到完成、阻塞或遇到手动节点。 */
  async runWorkflow(projectId: string, options: RunWorkflowOptions = {}): Promise<WorkflowExecutionSnapshot> {
    const maxParallel = options.maxParallel ?? 4
    const pollIntervalMs = options.pollIntervalMs ?? 500
    if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
      throw new Error("maxParallel 必须是正整数")
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`pollIntervalMs 必须是 100 至 ${MAX_TIMER_DELAY_MS}ms 的整数`)
    }
    while (true) {
      // 每次轮询先恢复僵死运行，避免卡住调度器
      this.recoverStaleRuns(projectId)
      const snapshot = this.getSnapshot(projectId)
      const capacity = maxParallel - snapshot.activeRuns.length
      let launchError: unknown
      if (capacity > 0) {
        for (const nodeId of snapshot.readyNodeIds.slice(0, capacity)) {
          try {
            this.runNode(projectId, nodeId, options.force === undefined ? {} : { force: options.force })
          } catch (cause) {
            launchError ??= cause
          }
        }
      }
      const next = this.getSnapshot(projectId)
      if (next.activeRuns.length === 0 && next.readyNodeIds.length === 0) return next
      if (launchError && next.activeRuns.length === 0) throw launchError
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs))
    }
  }

  private appendEvent(projectId: string, run: NodeRun, type: WorkflowEvent["type"], payload: Record<string, unknown>): void {
    this.executions.appendEvent({
      projectId,
      runId: run.id,
      nodeId: run.nodeId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    })
  }
}
