import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStateStore } from "@octopus/context/index.js"
import type { NodeRun } from "@octopus/core/execution.js"
import { Phase } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WorkflowEngine } from "./index.js"

let testStoreDir: string

beforeEach(() => {
  testStoreDir = mkdtempSync(join(tmpdir(), "octopus-execution-engine-"))
})

afterEach(() => {
  rmSync(testStoreDir, { recursive: true, force: true })
})

/** 完成某阶段全部任务 */
function completeAllPhaseTasks(engine: WorkflowEngine, requirementId: string, phase: Phase): void {
  for (const task of engine.getTasks(requirementId, { phase })) {
    if (task.status !== TaskStatus.COMPLETED) {
      engine.completeTask(requirementId, task.id)
    }
  }
}

function initNamedRequirement(
  engine: WorkflowEngine,
  name: string,
  description?: string,
  projectRoot?: string,
) {
  const project = engine.createProject(name, description)
  return engine.initRequirement(project.projectId, name, description, projectRoot)
}

describe("NodeExecutionService", () => {
  it("取消运行后同步把 IN_PROGRESS 节点标记为 BLOCKED", () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store })
    const state = initNamedRequirement(engine, "cancel_consistency")
    const step = state.steps.find((candidate) => candidate.id === "10.1")
    if (!step) throw new Error("测试节点不存在")
    store.update(state.requirementId, (current) => {
      const target = current.steps.find((candidate) => candidate.id === step.id)
      if (target) target.status = TaskStatus.IN_PROGRESS
      return current
    })
    const executions = (
      engine.execution as unknown as {
        executions: {
          getRun(runId: string): NodeRun | undefined
          transitionRun(
            runId: string,
            from: readonly string[],
            patch: Partial<NodeRun>,
          ): NodeRun | undefined
          appendEvent(event: unknown): unknown
        }
      }
    ).executions
    const run: NodeRun = {
      id: "run_cancel_test",
      requirementId: state.requirementId,
      nodeId: step.id,
      status: "RUNNING",
      forced: false,
      pid: 99_999_999,
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log",
    }
    executions.getRun = () => run
    executions.transitionRun = (_runId, _from, patch) => ({ ...run, ...patch })
    executions.appendEvent = () => ({})

    expect(engine.execution.cancelRun(state.requirementId, run.id).status).toBe("CANCELED")
    expect(
      engine.getState(state.requirementId).steps.find((candidate) => candidate.id === step.id),
    ).toMatchObject({
      status: TaskStatus.BLOCKED,
      notes: "运行已取消",
    })
  })

  it("拒绝超过 Node 定时器上限的轮询间隔", async () => {
    const engine = new WorkflowEngine({ store: createStateStore({ storeDir: testStoreDir }) })
    const state = initNamedRequirement(engine, "timer_limit")

    await expect(
      engine.runWorkflow(state.requirementId, { pollIntervalMs: 2_147_483_648 }),
    ).rejects.toThrow("pollIntervalMs 必须是 100 至 2147483647ms 的整数")
  })

  it("没有活动运行时向调用方报告确定性启动错误", async () => {
    const engine = new WorkflowEngine({ store: createStateStore({ storeDir: testStoreDir }) })
    const state = initNamedRequirement(engine, "launch_failure")
    vi.spyOn(engine.execution, "getSnapshot").mockReturnValue({
      requirementId: state.requirementId,
      currentNodeIds: ["10.1"],
      readyNodeIds: ["10.1"],
      waitingNodeIds: [],
      activeRuns: [],
      schedulerStatus: "IDLE",
      updatedAt: new Date().toISOString(),
    })
    const launch = vi.spyOn(engine.execution, "runNode").mockImplementation(() => {
      throw new Error("worker 启动失败")
    })

    await expect(engine.runWorkflow(state.requirementId)).rejects.toThrow("worker 启动失败")
    expect(launch).toHaveBeenCalledTimes(1)
  })
})

describe("WorkflowEngine 事务化更新", () => {
  it("并发完成同一项目不同任务时不丢更新，且不再经由 save 落库", async () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const saveSpy = vi.spyOn(store, "save")
    const engine = new WorkflowEngine({ store })
    const state = initNamedRequirement(engine, "concurrent_tasks")
    saveSpy.mockClear()
    const pending = engine
      .getTasks(state.requirementId)
      .filter((t) => t.status === TaskStatus.PENDING)
    const first = pending[0]!
    const second = pending[1]!
    const concurrentEngine = new WorkflowEngine({ store })

    await Promise.all([
      Promise.resolve().then(() => engine.completeTask(state.requirementId, first.id)),
      Promise.resolve().then(() => concurrentEngine.completeTask(state.requirementId, second.id)),
    ])

    expect(saveSpy).not.toHaveBeenCalled()
    const after = engine.getTasks(state.requirementId)
    expect(after.find((t) => t.id === first.id)?.status).toBe(TaskStatus.COMPLETED)
    expect(after.find((t) => t.id === second.id)?.status).toBe(TaskStatus.COMPLETED)
  })
})

describe("Heinrich 审计步骤自动完成", () => {
  it("assessQuality 成功后将当前阶段的 heinrich.audit.<phase> 步骤标记为 COMPLETED", () => {
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      heinrichThreshold: 1,
    })
    const state = initNamedRequirement(engine, "heinrich_audit_auto")
    completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
    // 阶段前进会给下一阶段计数 +1，达到阈值 1 时创建审计步骤
    const research = engine.advancePhase(state.requirementId)
    expect(research.currentPhase).toBe(Phase.RESEARCH)
    const auditId = `heinrich.audit.${Phase.RESEARCH}`
    const auditStep = engine.getState(state.requirementId).steps.find((s) => s.id === auditId)
    expect(auditStep).toBeDefined()
    expect(auditStep?.status).toBe(TaskStatus.PENDING)

    engine.assessQuality(state.requirementId)

    const completed = engine.getState(state.requirementId).steps.find((s) => s.id === auditId)
    expect(completed?.status).toBe(TaskStatus.COMPLETED)
    expect(completed?.completedAt).toBeTruthy()
  })

  it("无审计步骤时 assessQuality 幂等，不影响原评估结果", () => {
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      heinrichThreshold: 100,
    })
    const state = initNamedRequirement(engine, "heinrich_audit_none")
    const assessment = engine.assessQuality(state.requirementId)
    expect(assessment.verdict).toBe("INSUFFICIENT_DATA")
    const auditStep = engine
      .getState(state.requirementId)
      .steps.find((s) => s.id === `heinrich.audit.${state.currentPhase}`)
    expect(auditStep).toBeUndefined()
  })
})

describe("recoverStaleRuns", () => {
  function executionsOf(engine: WorkflowEngine): {
    createRun(input: {
      id: string
      requirementId: string
      nodeId: string
      forced: boolean
      stdoutPath: string
      stderrPath: string
    }): NodeRun
    updateRun(runId: string, patch: Partial<NodeRun>): NodeRun
    appendEvent(event: unknown): unknown
  } {
    return (
      engine.execution as unknown as {
        executions: {
          createRun(input: {
            id: string
            requirementId: string
            nodeId: string
            forced: boolean
            stdoutPath: string
            stderrPath: string
          }): NodeRun
          updateRun(runId: string, patch: Partial<NodeRun>): NodeRun
          appendEvent(event: unknown): unknown
        }
      }
    ).executions
  }

  it("心跳超时的 RUNNING 运行被中断，节点置 BLOCKED 并写入 RUN_FAILED 事件", () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store })
    const state = initNamedRequirement(engine, "stale_runs")
    const step = state.steps.find((candidate) => candidate.id === "10.1")
    if (!step) throw new Error("测试节点不存在")
    const executions = executionsOf(engine)
    const staleRun = executions.createRun({
      id: "run_stale_1",
      requirementId: state.requirementId,
      nodeId: step.id,
      forced: false,
      stdoutPath: "stale.out",
      stderrPath: "stale.err",
    })
    const oldHeartbeat = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    executions.updateRun(staleRun.id, { status: "RUNNING", heartbeatAt: oldHeartbeat })
    store.update(state.requirementId, (current) => {
      const target = current.steps.find((candidate) => candidate.id === step.id)
      if (target) target.status = TaskStatus.IN_PROGRESS
      return current
    })

    const recovered = engine.recoverStaleRuns(state.requirementId)

    expect(recovered).toBe(1)
    expect(
      engine.execution.listRuns(state.requirementId).find((run) => run.id === staleRun.id)?.status,
    ).toBe("INTERRUPTED")
    expect(
      engine.getState(state.requirementId).steps.find((candidate) => candidate.id === step.id),
    ).toMatchObject({
      status: TaskStatus.BLOCKED,
      notes: "运行超过心跳超时未上报，判定为僵死",
    })
    const failedEvents = engine.execution
      .eventsAfter(state.requirementId)
      .filter((event) => event.type === "RUN_FAILED")
    expect(failedEvents).toHaveLength(1)
    expect(failedEvents[0]?.payload).toMatchObject({ status: "INTERRUPTED" })
  })

  it("心跳新鲜的 RUNNING 运行不会被误杀", () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store })
    const state = initNamedRequirement(engine, "fresh_runs")
    const step = state.steps.find((candidate) => candidate.id === "10.1")
    if (!step) throw new Error("测试节点不存在")
    const executions = executionsOf(engine)
    const freshRun = executions.createRun({
      id: "run_fresh_1",
      requirementId: state.requirementId,
      nodeId: step.id,
      forced: false,
      stdoutPath: "fresh.out",
      stderrPath: "fresh.err",
    })
    executions.updateRun(freshRun.id, { status: "RUNNING", heartbeatAt: new Date().toISOString() })

    const recovered = engine.recoverStaleRuns(state.requirementId, 30_000)

    expect(recovered).toBe(0)
    expect(
      engine.execution.listRuns(state.requirementId).find((run) => run.id === freshRun.id)?.status,
    ).toBe("RUNNING")
  })
})

describe("readRunLogs", () => {
  function executionsOf(engine: WorkflowEngine): {
    createRun(input: {
      id: string
      requirementId: string
      nodeId: string
      forced: boolean
      stdoutPath: string
      stderrPath: string
    }): NodeRun
    updateRun(runId: string, patch: Partial<NodeRun>): NodeRun
  } {
    return (
      engine.execution as unknown as {
        executions: {
          createRun(input: {
            id: string
            requirementId: string
            nodeId: string
            forced: boolean
            stdoutPath: string
            stderrPath: string
          }): NodeRun
          updateRun(runId: string, patch: Partial<NodeRun>): NodeRun
        }
      }
    ).executions
  }

  it("读取 stdout/stderr 片段，支持截断与 offset 续读", () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store })
    const state = initNamedRequirement(engine, "read_logs")
    const step = state.steps.find((candidate) => candidate.id === "10.1")
    if (!step) throw new Error("测试节点不存在")

    const stdoutPath = join(testStoreDir, "run_logs.stdout.log")
    const stderrPath = join(testStoreDir, "run_logs.stderr.log")
    writeFileSync(stdoutPath, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "utf8")
    writeFileSync(stderrPath, "stderr-line\n", "utf8")

    const executions = executionsOf(engine)
    const run = executions.createRun({
      id: "run_logs_1",
      requirementId: state.requirementId,
      nodeId: step.id,
      forced: false,
      stdoutPath,
      stderrPath,
    })
    executions.updateRun(run.id, { status: "SUCCEEDED" })

    const first = engine.execution.readRunLogs(state.requirementId, run.id, { maxBytes: 10 })
    expect(first).toMatchObject({
      runId: run.id,
      nodeId: step.id,
      status: "SUCCEEDED",
      stream: "stdout",
      exists: true,
      size: 26,
      offset: 0,
      nextOffset: 10,
      truncated: true,
      content: "ABCDEFGHIJ",
    })

    const second = engine.execution.readRunLogs(state.requirementId, run.id, {
      offset: first.nextOffset,
      maxBytes: 10,
    })
    expect(second.content).toBe("KLMNOPQRST")
    expect(second.offset).toBe(10)
    expect(second.nextOffset).toBe(20)
    expect(second.truncated).toBe(true)

    const stderr = engine.execution.readRunLogs(state.requirementId, run.id, { stream: "stderr" })
    expect(stderr).toMatchObject({
      stream: "stderr",
      exists: true,
      truncated: false,
      content: "stderr-line\n",
    })
    expect(stderr).not.toHaveProperty("stdoutPath")
    expect(stderr).not.toHaveProperty("stderrPath")
  })

  it("日志文件不存在时返回 exists=false 而不抛错", () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store })
    const state = initNamedRequirement(engine, "missing_logs")
    const step = state.steps.find((candidate) => candidate.id === "10.1")
    if (!step) throw new Error("测试节点不存在")
    const executions = executionsOf(engine)
    const run = executions.createRun({
      id: "run_missing_1",
      requirementId: state.requirementId,
      nodeId: step.id,
      forced: false,
      stdoutPath: join(testStoreDir, "does-not-exist.stdout.log"),
      stderrPath: join(testStoreDir, "does-not-exist.stderr.log"),
    })

    expect(engine.execution.readRunLogs(state.requirementId, run.id)).toMatchObject({
      exists: false,
      size: 0,
      content: "",
      truncated: false,
    })
  })

  it("拒绝不存在或跨需求的 runId，并校验 offset/maxBytes", () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store })
    const state = initNamedRequirement(engine, "logs_guard")
    const other = initNamedRequirement(engine, "logs_guard_other")
    const step = state.steps.find((candidate) => candidate.id === "10.1")
    if (!step) throw new Error("测试节点不存在")
    const executions = executionsOf(engine)
    const run = executions.createRun({
      id: "run_guard_1",
      requirementId: state.requirementId,
      nodeId: step.id,
      forced: false,
      stdoutPath: join(testStoreDir, "guard.stdout.log"),
      stderrPath: join(testStoreDir, "guard.stderr.log"),
    })
    writeFileSync(run.stdoutPath, "ok", "utf8")

    expect(() => engine.execution.readRunLogs(state.requirementId, "missing")).toThrow("运行不存在")
    expect(() => engine.execution.readRunLogs(other.requirementId, run.id)).toThrow("运行不存在")
    expect(() => engine.execution.readRunLogs(state.requirementId, run.id, { offset: -1 })).toThrow(
      "offset",
    )
    expect(() =>
      engine.execution.readRunLogs(state.requirementId, run.id, { maxBytes: 0 }),
    ).toThrow("maxBytes")
    expect(() =>
      engine.execution.readRunLogs(state.requirementId, run.id, { maxBytes: 1_048_577 }),
    ).toThrow("maxBytes")
  })
})
