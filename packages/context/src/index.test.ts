import { describe, it, expect, afterEach } from "vitest"
import { existsSync, rmSync } from "node:fs"
import { createStateStore } from "./index.js"
import { Phase } from "@octopus/core/phase.js"

const TEST_STORE_DIR = ".octo_test"

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
})
