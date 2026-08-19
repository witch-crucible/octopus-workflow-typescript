import { describe, it, expect } from "vitest"
import { Phase, PhaseLock } from "./phase.js"
import { createEmptyState } from "./workflow.js"
import { ProjectId, RequirementId } from "./branded-ids.js"

describe("createEmptyState", () => {
  const projectId = ProjectId("proj_test_001")
  const requirementId = RequirementId("req_test_001")
  const requirementName = "测试需求"
  const description = "这是一个测试需求"

  it("创建状态含正确的项目与需求信息", () => {
    const state = createEmptyState(projectId, requirementId, requirementName, description)
    expect(state.projectId).toBe(projectId)
    expect(state.requirementId).toBe(requirementId)
    expect(state.requirementName).toBe(requirementName)
    expect(state.description).toBe(description)
  })

  it("初始阶段为 INTENTION，且为 ACTIVE", () => {
    const state = createEmptyState(projectId, requirementId, requirementName, description)
    expect(state.currentPhase).toBe(Phase.INTENTION)
    expect(state.phaseStatus[Phase.INTENTION]).toBe(PhaseLock.ACTIVE)
  })

  it("其他阶段初始为 LOCKED", () => {
    const state = createEmptyState(projectId, requirementId, requirementName, description)
    for (const phase of Object.values(Phase)) {
      if (phase === Phase.INTENTION) continue
      expect(state.phaseStatus[phase]).toBe(PhaseLock.LOCKED)
    }
  })

  it("初始步骤列表为空", () => {
    const state = createEmptyState(projectId, requirementId, requirementName, description)
    expect(state.steps).toEqual([])
    expect(state.artifacts).toEqual([])
    expect(state.checklists).toEqual({})
    expect(state.milestones).toEqual([])
  })

  it("有创建和更新时间戳", () => {
    const state = createEmptyState(projectId, requirementId, requirementName, description)
    expect(state.createdAt).toBeTypeOf("string")
    expect(state.updatedAt).toBeTypeOf("string")
    expect(state.createdAt).toBe(state.updatedAt)
  })

  it("元数据初始为空", () => {
    const state = createEmptyState(projectId, requirementId, requirementName, description)
    expect(state.metadata).toEqual({})
  })

  it("海因里希记录初始为0", () => {
    const state = createEmptyState(projectId, requirementId, requirementName, description)
    expect(state.heinrich.majorDefects).toBe(0)
    expect(state.heinrich.minorDefects).toBe(0)
    expect(state.heinrich.trivialDefects).toBe(0)
  })
})
