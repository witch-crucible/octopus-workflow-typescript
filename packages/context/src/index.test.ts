import { afterEach, describe, expect, it } from "vitest"
import { Phase } from "@octopus/core/phase.js"
import type { PersistenceStore } from "./persistence.js"
import { STORE_SCHEMA_VERSION } from "./persistence.js"
import { createTestPersistenceStore } from "./testing.js"

const stores: PersistenceStore[] = []

async function createStore(): Promise<PersistenceStore> {
  const { store } = await createTestPersistenceStore()
  stores.push(store)
  return store
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
})

describe("PersistenceStore 状态聚合", () => {
  it("保留配置与日志目录路径", async () => {
    const store = await createStore()
    expect(store.getStorePath()).toBe(".octo_test")
  })

  it("创建项目并在其下创建需求，JSON 可往返", async () => {
    const store = await createStore()
    const project = await store.createProject("测试项目", "项目描述")
    const state = await store.createRequirement(project.projectId, "测试需求", "需求描述")

    expect(state.requirementName).toBe("测试需求")
    expect(state.projectId).toBe(project.projectId)
    expect(state.currentPhase).toBe(Phase.INTENTION)
    await store.update(state.requirementId, (current) => {
      current.metadata["roundTrip"] = "ok"
      return current
    })

    const loaded = await store.load(state.requirementId)
    expect(loaded.metadata["roundTrip"]).toBe("ok")
    expect(loaded.projectId).toBe(project.projectId)
  })

  it("按更新时间列出项目与需求", async () => {
    const store = await createStore()
    const first = await store.createProject("项目A")
    const second = await store.createProject("项目B")
    await store.createRequirement(first.projectId, "需求1")
    await store.createRequirement(first.projectId, "需求2")

    expect(await store.listProjects()).toEqual(
      expect.arrayContaining([second.projectId, first.projectId]),
    )
    expect(await store.listRequirements(first.projectId)).toHaveLength(2)
  })

  it("并发需求更新通过锁行事务避免整包 JSON 丢失", async () => {
    const store = await createStore()
    const project = await store.createProject("并发项目")
    const state = await store.createRequirement(project.projectId, "并发需求")

    await Promise.all(
      Array.from({ length: 8 }, () =>
        store.update(state.requirementId, (current) => {
          const count = Number(current.metadata["counter"] ?? "0")
          current.metadata["counter"] = String(count + 1)
          return current
        }),
      ),
    )

    expect((await store.load(state.requirementId)).metadata["counter"]).toBe("8")
  })

  it("缺失项目和需求保留领域错误文案", async () => {
    const store = await createStore()
    await expect(store.load("req_missing")).rejects.toThrow("无法加载需求 req_missing")
    await expect(store.loadProject("proj_missing")).rejects.toThrow("无法加载项目 proj_missing")
  })

  it("删除需求级联清理运行记录与事件", async () => {
    const store = await createStore()
    const project = await store.createProject("级联删除")
    const state = await store.createRequirement(project.projectId, "需求")
    const run = await store.createRun({
      id: "run_cascade",
      requirementId: state.requirementId,
      nodeId: "step_test",
      forced: false,
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log",
    })
    await store.appendEvent({
      requirementId: state.requirementId,
      runId: run.id,
      nodeId: run.nodeId,
      type: "RUN_STARTED",
      payload: {},
      createdAt: "2026-08-12T08:00:00.000Z",
    })

    await store.deleteRequirement(state.requirementId)

    expect(await store.listRuns(state.requirementId)).toHaveLength(0)
    expect(await store.eventsAfter(state.requirementId, 0)).toHaveLength(0)
    expect(await store.listRequirements()).not.toContain(state.requirementId)
  })

  it("删除项目级联删除需求与执行数据", async () => {
    const store = await createStore()
    const project = await store.createProject("待删项目")
    const state = await store.createRequirement(project.projectId, "子需求")
    await store.deleteProject(project.projectId)

    expect(await store.listProjects()).not.toContain(project.projectId)
    expect(await store.listRequirements()).not.toContain(state.requirementId)
  })

  it("生产 migration 写入 schema 版本", async () => {
    const { client, store } = await createTestPersistenceStore()
    stores.push(store)
    const result = await client.query<{ value: string }>(
      "select value from capy_octopus_meta where key = 'schema_version'",
    )
    expect(result.rows[0]?.value).toBe(STORE_SCHEMA_VERSION)
  })
})
