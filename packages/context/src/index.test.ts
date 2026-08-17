import { describe, it, expect, afterEach } from "vitest"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import Database from "better-sqlite3"
import { createStateStore } from "./index.js"
import { createExecutionStore } from "./execution.js"
import { Phase } from "@octopus/core/phase.js"

const TEST_STORE_DIR = ".octo_test"

function readMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM octopus_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined
  return row?.value
}

describe("createStateStore", () => {
  afterEach(() => {
    if (existsSync(TEST_STORE_DIR)) {
      rmSync(TEST_STORE_DIR, { recursive: true, force: true })
    }
  })

  it("创建状态存储实例", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    expect(store.getStorePath()).toBe(TEST_STORE_DIR)
  })

  it("创建并读取项目", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    const state = store.createProject("测试项目", "描述")
    expect(state.projectName).toBe("测试项目")
    expect(state.currentPhase).toBe(Phase.REQUIREMENTS_ANALYSIS)

    const loaded = store.load(state.projectId)
    expect(loaded.projectName).toBe("测试项目")
  })

  it("列出项目", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    store.createProject("项目A")
    store.createProject("项目B")
    const projects = store.listProjects()
    expect(projects.length).toBe(2)
  })

  it("保存并加载保持阶段状态", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    const state = store.createProject("保存测试")
    expect(state.phaseStatus[Phase.REQUIREMENTS_ANALYSIS]).toBe("ACTIVE")

    const loaded = store.load(state.projectId)
    expect(loaded.phaseStatus[Phase.REQUIREMENTS_ANALYSIS]).toBe("ACTIVE")
  })

  it("删除项目", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    const state = store.createProject("待删除")
    store.deleteProject(state.projectId)
    const projects = store.listProjects()
    expect(projects).not.toContain(state.projectId)
  })

  it("初始化写入 schema 版本且可读", () => {
    createStateStore({ storeDir: TEST_STORE_DIR })
    const db = new Database(join(TEST_STORE_DIR, "state.sqlite"))
    try {
      expect(readMeta(db, "schema_version")).toBe("1")
    } finally {
      db.close()
    }
  })

  it("deleteProject 级联清理运行记录与事件", () => {
    const stateStore = createStateStore({ storeDir: TEST_STORE_DIR })
    const executionStore = createExecutionStore(TEST_STORE_DIR)
    const state = stateStore.createProject("级联删除")
    const run = executionStore.createRun({
      id: "run_cascade",
      projectId: state.projectId,
      nodeId: "step_test",
      forced: false,
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log",
    })
    executionStore.appendEvent({
      projectId: state.projectId,
      runId: run.id,
      nodeId: run.nodeId,
      type: "RUN_STARTED",
      payload: {},
      createdAt: "2026-08-12T08:00:00.000Z",
    })

    stateStore.deleteProject(state.projectId)

    expect(executionStore.listRuns(state.projectId)).toHaveLength(0)
    expect(executionStore.eventsAfter(state.projectId, 0)).toHaveLength(0)
    expect(stateStore.listProjects()).not.toContain(state.projectId)
  })
})
