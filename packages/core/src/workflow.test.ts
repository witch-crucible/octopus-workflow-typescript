import { describe, it, expect } from "vitest"
import { Phase, PhaseLock } from "./phase.js"
import { createEmptyState } from "./workflow.js"
import { ProjectId } from "./branded-ids.js"

describe("createEmptyState", () => {
  const projectId = ProjectId("proj_test_001")
  const projectName = "测试项目"
  const description = "这是一个测试项目"

  it("创建状态含正确的项目信息", () => {
    const state = createEmptyState(projectId, projectName, description)
    expect(state.projectId).toBe(projectId)
    expect(state.projectName).toBe(projectName)
    expect(state.description).toBe(description)
  })

  it("初始阶段为 REQUIREMENTS_ANALYSIS，且为 ACTIVE", () => {
    const state = createEmptyState(projectId, projectName, description)
    expect(state.currentPhase).toBe(Phase.REQUIREMENTS_ANALYSIS)
    expect(state.phaseStatus[Phase.REQUIREMENTS_ANALYSIS]).toBe(PhaseLock.ACTIVE)
  })

  it("其他阶段初始为 LOCKED", () => {
    const state = createEmptyState(projectId, projectName, description)
    for (const phase of Object.values(Phase)) {
      if (phase === Phase.REQUIREMENTS_ANALYSIS) continue
      expect(state.phaseStatus[phase]).toBe(PhaseLock.LOCKED)
    }
  })

  it("初始任务列表为空", () => {
    const state = createEmptyState(projectId, projectName, description)
    expect(state.tasks).toEqual([])
    expect(state.artifacts).toEqual([])
    expect(state.checklists).toEqual({})
  })

  it("有创建和更新时间戳", () => {
    const state = createEmptyState(projectId, projectName, description)
    expect(state.createdAt).toBeTypeOf("string")
    expect(state.updatedAt).toBeTypeOf("string")
    expect(state.createdAt).toBe(state.updatedAt)
  })

  it("元数据初始为空", () => {
    const state = createEmptyState(projectId, projectName, description)
    expect(state.metadata).toEqual({})
  })

  it("海因里希记录初始为0", () => {
    const state = createEmptyState(projectId, projectName, description)
    expect(state.heinrich.majorDefects).toBe(0)
    expect(state.heinrich.minorDefects).toBe(0)
    expect(state.heinrich.trivialDefects).toBe(0)
  })
})
