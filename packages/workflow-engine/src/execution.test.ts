import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createStateStore } from "@octopus/context/index.js"
import type { NodeRun } from "@octopus/core/execution.js"
import { TaskStatus } from "@octopus/core/task.js"
import { WorkflowEngine } from "./index.js"

let testStoreDir: string

beforeEach(() => {
  testStoreDir = mkdtempSync(join(tmpdir(), "octopus-execution-engine-"))
})

afterEach(() => {
  rmSync(testStoreDir, { recursive: true, force: true })
})

describe("NodeExecutionService", () => {
  it("取消运行后同步把 IN_PROGRESS 节点标记为 BLOCKED", () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store })
    const state = engine.initProject("cancel_consistency")
    const step = state.steps.find((candidate) => candidate.id === "10.1")
    if (!step) throw new Error("测试节点不存在")
    store.update(state.projectId, (current) => {
      const target = current.steps.find((candidate) => candidate.id === step.id)
      if (target) target.status = TaskStatus.IN_PROGRESS
      return current
    })
    const executions = (engine.execution as unknown as {
      executions: {
        getRun(runId: string): NodeRun | undefined
        transitionRun(runId: string, from: readonly string[], patch: Partial<NodeRun>): NodeRun | undefined
        appendEvent(event: unknown): unknown
      }
    }).executions
    const run: NodeRun = {
      id: "run_cancel_test",
      projectId: state.projectId,
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

    expect(engine.execution.cancelRun(state.projectId, run.id).status).toBe("CANCELED")
    expect(engine.getState(state.projectId).steps.find((candidate) => candidate.id === step.id)).toMatchObject({
      status: TaskStatus.BLOCKED,
      notes: "运行已取消",
    })
  })

  it("拒绝超过 Node 定时器上限的轮询间隔", async () => {
    const engine = new WorkflowEngine({ store: createStateStore({ storeDir: testStoreDir }) })
    const state = engine.initProject("timer_limit")

    await expect(engine.runWorkflow(state.projectId, { pollIntervalMs: 2_147_483_648 })).rejects.toThrow(
      "pollIntervalMs 必须是 100 至 2147483647ms 的整数",
    )
  })

  it("没有活动运行时向调用方报告确定性启动错误", async () => {
    const engine = new WorkflowEngine({ store: createStateStore({ storeDir: testStoreDir }) })
    const state = engine.initProject("launch_failure")
    vi.spyOn(engine.execution, "getSnapshot").mockReturnValue({
      projectId: state.projectId,
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

    await expect(engine.runWorkflow(state.projectId)).rejects.toThrow("worker 启动失败")
    expect(launch).toHaveBeenCalledTimes(1)
  })
})
