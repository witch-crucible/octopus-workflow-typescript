import { describe, it, expect } from "vitest"
import { Phase } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import {
  createStepsForPhase,
  createAllSteps,
  getStepsByRole,
  getPendingSteps,
} from "./index.js"

describe("createStepsForPhase", () => {
  it("REQUIREMENTS_ANALYSIS 阶段生成12个步骤", () => {
    const steps = createStepsForPhase("proj_test", Phase.REQUIREMENTS_ANALYSIS)
    expect(steps.length).toBe(12)
    expect(steps[0]!.phase).toBe(Phase.REQUIREMENTS_ANALYSIS)
    expect(steps[0]!.status).toBe(TaskStatus.PENDING)
  })

  it("DESIGN 阶段生成9个步骤（含 20.2a）", () => {
    const steps = createStepsForPhase("proj_test", Phase.DESIGN)
    expect(steps.length).toBe(9)
  })

  it("每个步骤都有必填字段", () => {
    const steps = createStepsForPhase("proj_test", Phase.DEVELOPMENT)
    for (const step of steps) {
      expect(step.id).toBeTruthy()
      expect(step.taskId).toBeTruthy()
      expect(step.name).toBeTruthy()
      expect(step.responsibleRole).toBeTruthy()
    }
  })

  it("文档生成节点配置为存在时扩展文档", () => {
    const step = createStepsForPhase("proj_test", Phase.DEVELOPMENT)
      .find((candidate) => candidate.id === "30.9")
    expect(step?.actions).toEqual([expect.objectContaining({
      type: "ai",
      assistant: "DOCUMENT_SYNC",
      outputFile: "documentation.md",
      ifExists: "extend",
    })])
  })
})

describe("createAllSteps", () => {
  it("为所有6个阶段生成步骤", () => {
    const all = createAllSteps("proj_test")
    expect(Object.keys(all)).toHaveLength(6)
  })
})

describe("getStepsByRole", () => {
  it("按角色过滤步骤", () => {
    const steps = createStepsForPhase("proj_test", Phase.REQUIREMENTS_ANALYSIS)
    const pmSteps = getStepsByRole(steps, "PM")
    for (const s of pmSteps) {
      expect(s.responsibleRole).toBe("PM")
    }
  })
})

describe("getPendingSteps", () => {
  it("返回待处理的步骤", () => {
    const steps = createStepsForPhase("proj_test", Phase.DESIGN)
    const pending = getPendingSteps(steps)
    expect(pending.length).toBe(steps.length) // all are PENDING initially
  })
})
