import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskStatus } from "@octopus/core/task.js"
import { createTestPersistenceStore } from "@octopus/context/testing.js"
import type { PersistenceStore } from "@octopus/context/index.js"
import { WorkflowEngine } from "./index.js"

const engines: WorkflowEngine[] = []
const roots: string[] = []

async function setup() {
  const storeDir = mkdtempSync(join(tmpdir(), "octopus-execution-"))
  roots.push(storeDir)
  const { store } = await createTestPersistenceStore(storeDir)
  const engine = new WorkflowEngine({ store })
  await engine.initialize()
  engines.push(engine)
  const project = await engine.createProject("P")
  const state = await engine.initRequirement(project.projectId, "R")
  return { store, storeDir, engine, state }
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("NodeExecutionService", () => {
  it("派生 READY、等待和调度状态", async () => {
    const { engine, state } = await setup()
    const snapshot = await engine.execution.getSnapshot(state.requirementId)
    expect(snapshot.requirementId).toBe(state.requirementId)
    expect(snapshot.readyNodeIds.length + snapshot.waitingNodeIds.length).toBeGreaterThan(0)
  })

  it("手动节点完成写回步骤并追加事件", async () => {
    const { store, engine, state } = await setup()
    const manual = state.steps.find((step) =>
      (step.actions ?? []).every((action) => action.type === "manual"),
    )
    if (!manual) throw new Error("内置工作流应包含手动节点")
    const completed = await engine.execution.completeManualNode(
      state.requirementId,
      manual.id,
      true,
    )
    expect(completed.steps.find((step) => step.id === manual.id)?.status).toBe(TaskStatus.COMPLETED)
    expect(
      (await store.eventsAfter(state.requirementId, 0)).some(
        (event) => event.type === "RUN_FINISHED",
      ),
    ).toBe(true)
  })

  it("取消运行使用 CAS 且把节点置 BLOCKED", async () => {
    const { store, engine, state } = await setup()
    const node = state.steps[0]!
    await store.update(state.requirementId, (current) => {
      current.steps[0]!.status = TaskStatus.IN_PROGRESS
      return current
    })
    const run = await store.createRun({
      requirementId: state.requirementId,
      nodeId: node.id,
      forced: false,
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log",
    })
    expect((await engine.execution.cancelRun(state.requirementId, run.id)).status).toBe("CANCELED")
    expect((await store.load(state.requirementId)).steps[0]?.status).toBe(TaskStatus.BLOCKED)
  })

  it("恢复过期 RUNNING 运行并写失败事件", async () => {
    const { store, engine, state } = await setup()
    const run = await store.createRun({
      requirementId: state.requirementId,
      nodeId: state.steps[0]!.id,
      forced: false,
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log",
    })
    await store.transitionRun(run.id, ["QUEUED"], {
      status: "RUNNING",
      heartbeatAt: "2020-01-01T00:00:00.000Z",
    })
    expect(await engine.execution.recoverStaleRuns(state.requirementId, 1)).toBe(1)
    expect((await store.getRun(run.id))?.status).toBe("INTERRUPTED")
  })

  it("日志读取只能通过持久化 run 路径", async () => {
    const { store, storeDir, engine, state } = await setup()
    const stdoutPath = join(storeDir, "run.stdout.log")
    writeFileSync(stdoutPath, "abcdef", "utf8")
    const run = await store.createRun({
      requirementId: state.requirementId,
      nodeId: state.steps[0]!.id,
      forced: false,
      stdoutPath,
      stderrPath: join(storeDir, "run.stderr.log"),
    })
    const slice = await engine.execution.readRunLogs(state.requirementId, run.id, { maxBytes: 3 })
    expect(slice.content).toBe("abc")
    expect(slice.nextOffset).toBe(3)
  })
})
