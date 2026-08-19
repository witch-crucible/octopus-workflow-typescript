import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { NodeRun } from "@octopus/core/execution.js"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { createExecutionStore } from "./execution.js"
import { createStateStore } from "./index.js"

const temporaryDirectories: string[] = []

function createRun() {
  const storeDir = mkdtempSync(join(tmpdir(), "octopus-execution-"))
  temporaryDirectories.push(storeDir)
  // workflow_runs 的 requirement_id 外键引用 requirements，需先建项目与需求。
  const stateStore = createStateStore({ storeDir })
  const project = stateStore.createProject("测试项目")
  const requirementId = stateStore.createRequirement(project.projectId, "测试需求").requirementId
  const store = createExecutionStore(storeDir)
  const run = store.createRun({
    id: "run_test",
    requirementId,
    nodeId: "node_test",
    forced: false,
    stdoutPath: join(storeDir, "stdout.log"),
    stderrPath: join(storeDir, "stderr.log"),
  })
  return { storeDir, store, run }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("ExecutionStore.updateRun", () => {
  it("heartbeatAt 局部更新不重写终态字段", () => {
    const { storeDir, store, run } = createRun()
    const finishedAt = "2026-08-12T08:00:00.000Z"
    const heartbeatAt = "2026-08-12T08:00:01.000Z"
    store.updateRun(run.id, { status: "FAILED", finishedAt, error: "worker failed" })

    const db = new Database(join(storeDir, "state.sqlite"))
    try {
      db.exec(`
        CREATE TRIGGER reject_terminal_field_rewrite
        BEFORE UPDATE OF status, finished_at, error ON workflow_runs
        BEGIN
          SELECT RAISE(ABORT, 'terminal fields must not be rewritten');
        END;
      `)
    } finally {
      db.close()
    }

    const updated = store.updateRun(run.id, { heartbeatAt })

    expect(updated).toMatchObject({
      status: "FAILED",
      finishedAt,
      error: "worker failed",
      heartbeatAt,
    })
  })

  it("显式 undefined 清空 nullable 字段", () => {
    const { store, run } = createRun()
    store.updateRun(run.id, {
      pid: 123,
      currentAction: 2,
      startedAt: "2026-08-12T08:00:00.000Z",
      finishedAt: "2026-08-12T08:01:00.000Z",
      heartbeatAt: "2026-08-12T08:00:30.000Z",
      exitCode: 1,
      error: "failed",
    })

    const updated = store.updateRun(run.id, {
      pid: undefined,
      currentAction: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      heartbeatAt: undefined,
      exitCode: undefined,
      error: undefined,
    } as unknown as Partial<NodeRun>)

    expect(updated).not.toHaveProperty("pid")
    expect(updated).not.toHaveProperty("currentAction")
    expect(updated).not.toHaveProperty("startedAt")
    expect(updated).not.toHaveProperty("finishedAt")
    expect(updated).not.toHaveProperty("heartbeatAt")
    expect(updated).not.toHaveProperty("exitCode")
    expect(updated).not.toHaveProperty("error")
  })

  it("空 patch 返回未改变的运行记录", () => {
    const { store, run } = createRun()
    const before = store.getRun(run.id)

    expect(store.updateRun(run.id, {})).toEqual(before)
  })

  it("忽略不可变字段", () => {
    const { store, run } = createRun()

    const updated = store.updateRun(run.id, {
      id: "other_run",
      requirementId: "other_requirement",
      nodeId: "other_node",
    })

    expect(updated).toMatchObject({
      id: run.id,
      requirementId: run.requirementId,
      nodeId: run.nodeId,
    })
    expect(store.getRun("other_run")).toBeUndefined()
  })

  it.each([
    ["空 patch", {}],
    ["非空 patch", { heartbeatAt: "2026-08-12T08:00:00.000Z" }],
  ] as const)("不存在的运行在%s时仍抛错", (_label, patch) => {
    const { store } = createRun()

    expect(() => store.updateRun("missing_run", patch)).toThrow("运行不存在: missing_run")
  })

  it("条件状态转换不会覆盖先到达的终态", () => {
    const { store, run } = createRun()
    const canceled = store.transitionRun(run.id, ["QUEUED", "RUNNING"], {
      status: "CANCELED",
      finishedAt: "2026-08-12T08:00:00.000Z",
    })

    expect(canceled?.status).toBe("CANCELED")
    expect(store.transitionRun(run.id, ["RUNNING"], { status: "SUCCEEDED" })).toBeUndefined()
    expect(store.getRun(run.id)?.status).toBe("CANCELED")
  })

  it("允许成功终态在聚合状态写入失败时补偿为 FAILED", () => {
    const { store, run } = createRun()
    expect(store.transitionRun(run.id, ["QUEUED"], { status: "SUCCEEDED" })?.status).toBe("SUCCEEDED")

    const compensated = store.transitionRun(run.id, ["SUCCEEDED"], {
      status: "FAILED",
      error: "运行结果写入项目状态失败",
    })

    expect(compensated).toMatchObject({
      status: "FAILED",
      error: "运行结果写入项目状态失败",
    })
  })
})

describe("ExecutionStore.purge", () => {
  it("清理过期的 integration_health 并保留新记录", () => {
    const { store } = createRun()
    store.saveIntegrationHealth({
      service: "github",
      healthy: true,
      latencyMs: 10,
      message: "ok",
      checkedAt: "2026-07-01T00:00:00.000Z",
    })
    store.saveIntegrationHealth({
      service: "gitlab",
      healthy: true,
      latencyMs: 20,
      message: "ok",
      checkedAt: "2026-08-15T00:00:00.000Z",
    })

    const purged = store.purge("2026-08-01T00:00:00.000Z")

    expect(store.listIntegrationHealth().map((health) => health.service)).toEqual(["gitlab"])
    expect(purged).toBe(0)
  })

  it("保持返回已删除运行数语义", () => {
    const { store, run } = createRun()
    store.updateRun(run.id, { status: "SUCCEEDED", finishedAt: "2026-07-10T00:00:00.000Z" })

    const purged = store.purge("2026-08-01T00:00:00.000Z")

    expect(purged).toBe(1)
    expect(store.getRun(run.id)).toBeUndefined()
  })
})
