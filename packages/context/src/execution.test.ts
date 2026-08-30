import { afterEach, describe, expect, it } from "vitest"
import type { NodeRun } from "@octopus/core/execution.js"
import type { PersistenceStore } from "./persistence.js"
import { createTestPersistenceStore } from "./testing.js"

const stores: PersistenceStore[] = []

async function createRun(): Promise<{ store: PersistenceStore; run: NodeRun }> {
  const { store } = await createTestPersistenceStore()
  stores.push(store)
  const project = await store.createProject("测试项目")
  const state = await store.createRequirement(project.projectId, "测试需求")
  const run = await store.createRun({
    id: "run_test",
    requirementId: state.requirementId,
    nodeId: "node_test",
    forced: false,
    stdoutPath: "stdout.log",
    stderrPath: "stderr.log",
  })
  return { store, run }
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
})

describe("ExecutionStore", () => {
  it("局部更新不重写未提供的终态字段", async () => {
    const { store, run } = await createRun()
    const finishedAt = "2026-08-12T08:00:00.000Z"
    await store.updateRun(run.id, { status: "FAILED", finishedAt, error: "worker failed" })
    const updated = await store.updateRun(run.id, { heartbeatAt: "2026-08-12T08:00:01.000Z" })
    expect(updated).toMatchObject({ status: "FAILED", finishedAt, error: "worker failed" })
  })

  it("显式 undefined 清空 nullable 字段", async () => {
    const { store, run } = await createRun()
    await store.updateRun(run.id, {
      pid: 123,
      currentAction: 2,
      startedAt: "2026-08-12T08:00:00.000Z",
      error: "failed",
    })
    const updated = await store.updateRun(run.id, {
      pid: undefined,
      currentAction: undefined,
      startedAt: undefined,
      error: undefined,
    } as unknown as Partial<NodeRun>)
    expect(updated).not.toHaveProperty("pid")
    expect(updated).not.toHaveProperty("currentAction")
    expect(updated).not.toHaveProperty("startedAt")
    expect(updated).not.toHaveProperty("error")
  })

  it("空 patch 返回未改变的运行记录", async () => {
    const { store, run } = await createRun()
    expect(await store.updateRun(run.id, {})).toEqual(await store.getRun(run.id))
  })

  it("忽略不可变字段，缺失运行明确报错", async () => {
    const { store, run } = await createRun()
    const updated = await store.updateRun(run.id, {
      id: "other_run",
      requirementId: "other_requirement",
      nodeId: "other_node",
    })
    expect(updated).toMatchObject({
      id: run.id,
      requirementId: run.requirementId,
      nodeId: run.nodeId,
    })
    expect(await store.getRun("other_run")).toBeUndefined()
    await expect(store.updateRun("missing_run", {})).rejects.toThrow("运行不存在: missing_run")
  })

  it("条件状态转换不会覆盖先到达的终态", async () => {
    const { store, run } = await createRun()
    const canceled = await store.transitionRun(run.id, ["QUEUED", "RUNNING"], {
      status: "CANCELED",
      finishedAt: "2026-08-12T08:00:00.000Z",
    })
    expect(canceled?.status).toBe("CANCELED")
    expect(await store.transitionRun(run.id, ["RUNNING"], { status: "SUCCEEDED" })).toBeUndefined()
  })

  it("事件序列递增且查询保持升序", async () => {
    const { store, run } = await createRun()
    const first = await store.appendEvent({
      requirementId: run.requirementId,
      runId: run.id,
      type: "RUN_STARTED",
      payload: {},
      createdAt: "2026-08-12T08:00:00.000Z",
    })
    const second = await store.appendEvent({
      requirementId: run.requirementId,
      runId: run.id,
      type: "RUN_FINISHED",
      payload: {},
      createdAt: "2026-08-12T08:01:00.000Z",
    })
    expect(second.sequence).toBe(first.sequence + 1)
    expect((await store.eventsAfter(run.requirementId, 0)).map((event) => event.sequence)).toEqual([
      first.sequence,
      second.sequence,
    ])
  })

  it("健康记录 upsert，purge 在一个事务中清理过期数据", async () => {
    const { store, run } = await createRun()
    await store.updateRun(run.id, { status: "SUCCEEDED", finishedAt: "2026-07-10T00:00:00.000Z" })
    await store.saveIntegrationHealth({
      service: "github",
      healthy: true,
      latencyMs: 10,
      message: "ok",
      checkedAt: "2026-07-01T00:00:00.000Z",
    })
    await store.saveIntegrationHealth({
      service: "github",
      healthy: false,
      latencyMs: 20,
      message: "down",
      checkedAt: "2026-08-15T00:00:00.000Z",
    })
    expect(await store.purge("2026-08-01T00:00:00.000Z")).toBe(1)
    expect(await store.getRun(run.id)).toBeUndefined()
    expect(await store.listIntegrationHealth()).toEqual([
      {
        service: "github",
        healthy: false,
        latencyMs: 20,
        message: "down",
        checkedAt: "2026-08-15T00:00:00.000Z",
      },
    ])
  })
})
