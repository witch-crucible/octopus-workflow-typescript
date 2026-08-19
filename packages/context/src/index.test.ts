import { describe, it, expect, afterEach } from "vitest"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import Database from "better-sqlite3"
import { createStateStore } from "./index.js"
import { createExecutionStore } from "./execution.js"
import { Phase } from "@octopus/core/phase.js"
import { STORE_SCHEMA_VERSION } from "./schema.js"

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

  it("创建项目并在其下创建需求", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    const project = store.createProject("测试项目", "项目描述")
    const state = store.createRequirement(project.projectId, "测试需求", "需求描述")
    expect(state.requirementName).toBe("测试需求")
    expect(state.projectId).toBe(project.projectId)
    expect(state.currentPhase).toBe(Phase.INTENTION)

    const loaded = store.load(state.requirementId)
    expect(loaded.requirementName).toBe("测试需求")
    expect(loaded.projectId).toBe(project.projectId)
  })

  it("列出项目与需求", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    const project = store.createProject("项目A")
    store.createRequirement(project.projectId, "需求1")
    store.createRequirement(project.projectId, "需求2")
    expect(store.listProjects()).toHaveLength(1)
    expect(store.listRequirements(project.projectId)).toHaveLength(2)
  })

  it("保存并加载保持阶段状态", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    const project = store.createProject("保存测试")
    const state = store.createRequirement(project.projectId, "需求")
    expect(state.phaseStatus[Phase.INTENTION]).toBe("ACTIVE")

    const loaded = store.load(state.requirementId)
    expect(loaded.phaseStatus[Phase.INTENTION]).toBe("ACTIVE")
  })

  it("删除需求", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    const project = store.createProject("容器")
    const state = store.createRequirement(project.projectId, "待删除")
    store.deleteRequirement(state.requirementId)
    expect(store.listRequirements()).not.toContain(state.requirementId)
    expect(store.listProjects()).toContain(project.projectId)
  })

  it("删除项目级联删除需求", () => {
    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    const project = store.createProject("待删项目")
    const state = store.createRequirement(project.projectId, "子需求")
    store.deleteProject(project.projectId)
    expect(store.listProjects()).not.toContain(project.projectId)
    expect(store.listRequirements()).not.toContain(state.requirementId)
  })

  it("初始化写入 schema 版本且可读", () => {
    createStateStore({ storeDir: TEST_STORE_DIR })
    const db = new Database(join(TEST_STORE_DIR, "state.sqlite"))
    try {
      expect(readMeta(db, "schema_version")).toBe(STORE_SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  it("deleteRequirement 级联清理运行记录与事件", () => {
    const stateStore = createStateStore({ storeDir: TEST_STORE_DIR })
    const executionStore = createExecutionStore(TEST_STORE_DIR)
    const project = stateStore.createProject("级联删除")
    const state = stateStore.createRequirement(project.projectId, "需求")
    const run = executionStore.createRun({
      id: "run_cascade",
      requirementId: state.requirementId,
      nodeId: "step_test",
      forced: false,
      stdoutPath: "stdout.log",
      stderrPath: "stderr.log",
    })
    executionStore.appendEvent({
      requirementId: state.requirementId,
      runId: run.id,
      nodeId: run.nodeId,
      type: "RUN_STARTED",
      payload: {},
      createdAt: "2026-08-12T08:00:00.000Z",
    })

    stateStore.deleteRequirement(state.requirementId)

    expect(executionStore.listRuns(state.requirementId)).toHaveLength(0)
    expect(executionStore.eventsAfter(state.requirementId, 0)).toHaveLength(0)
    expect(stateStore.listRequirements()).not.toContain(state.requirementId)
  })

  it("迁移旧 v1 projects 表为项目+需求", () => {
    mkdirSync(TEST_STORE_DIR, { recursive: true })
    const dbPath = join(TEST_STORE_DIR, "state.sqlite")
    const db = new Database(dbPath)
    try {
      db.exec(`
        CREATE TABLE projects (
          project_id TEXT PRIMARY KEY,
          project_name TEXT NOT NULL,
          state_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE octopus_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) STRICT;
      `)
      db.prepare("INSERT INTO octopus_meta(key, value) VALUES ('schema_version', '1')").run()
      const legacyState = {
        schemaVersion: 4,
        projectId: "proj_legacy_1",
        projectName: "旧项目",
        description: "desc",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
        currentPhase: "Intention",
        phaseStatus: {},
        steps: [],
        checklists: {},
        heinrich: { majorDefects: 0, minorDefects: 0, trivialDefects: 0, observations: [], triggerCounts: {} },
        artifacts: [],
        metadata: {},
        aiGatingEnabled: false,
        aiGateResults: [],
      }
      db.prepare(
        "INSERT INTO projects(project_id, project_name, state_json, updated_at) VALUES (?, ?, ?, ?)",
      ).run("proj_legacy_1", "旧项目", JSON.stringify(legacyState), "2025-01-01T00:00:00.000Z")
    } finally {
      db.close()
    }

    const store = createStateStore({ storeDir: TEST_STORE_DIR })
    expect(store.listProjects()).toHaveLength(1)
    expect(store.listRequirements()).toEqual(["proj_legacy_1"])
    const req = store.load("proj_legacy_1")
    expect(req.requirementName).toBe("旧项目")
    expect(req.requirementId).toBe("proj_legacy_1")
    expect(req.projectId).toBeTruthy()
    expect(req.projectId).not.toBe("proj_legacy_1")
  })
})
