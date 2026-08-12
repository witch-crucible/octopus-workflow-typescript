import { describe, it, expect } from "vitest"
import { Phase } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { Role } from "@octopus/core/role.js"
import type { WorkflowDefinition, WorkflowNodeSpec } from "@octopus/core/execution.js"
import {
  createStepsFromDefinition,
  createStepsForPhase,
  createAllSteps,
  getStepsByRole,
  getPendingSteps,
} from "./index.js"

describe("createStepsFromDefinition", () => {
  it("从 workflow actions 恢复 AI、integration 与 Heinrich capabilities", () => {
    const node: WorkflowNodeSpec = {
      key: "compatibility-node",
      phase: Phase.DEVELOPMENT,
      name: "Compatibility Node",
      description: "Restores capabilities from actions",
      responsibleRoles: [Role.DEV],
      dependsOn: [],
      actions: [
        { type: "manual", instructions: "人工确认" },
        { type: "command", executable: "node", args: ["--version"] },
        {
          type: "ai",
          assistant: AIAssistantType.DOCUMENT_SYNC,
          input: "同步文档",
          outputFile: "documentation.md",
          ifExists: "extend",
        },
        { type: "integration", service: "sonar", operation: "runScan" },
        { type: "heinrich", delta: 2, level: HeinrichLevel.MINOR },
      ],
    }
    const definition: WorkflowDefinition = {
      version: 2,
      name: "Compatibility Test",
      nodeIdMapping: { [node.key]: "node-compatibility" },
      nodes: [node],
    }

    const step = createStepsFromDefinition("proj_test", definition, Phase.DEVELOPMENT)[0]!

    expect(step.actions).toBe(node.actions)
    expect(step.capabilities).toEqual([
      {
        kind: "ai",
        assistant: AIAssistantType.DOCUMENT_SYNC,
        input: "同步文档",
        outputFile: "documentation.md",
        ifExists: "extend",
      },
      { kind: "integration", service: "sonar", op: "runScan" },
      { kind: "heinrich", delta: 2, level: HeinrichLevel.MINOR },
    ])
  })

  it("manual 与 command actions 不生成 capabilities", () => {
    const node: WorkflowNodeSpec = {
      key: "execution-only-node",
      phase: Phase.DEVELOPMENT,
      name: "Execution Only Node",
      description: "Keeps execution-only actions",
      responsibleRoles: [Role.DEV],
      dependsOn: [],
      actions: [
        { type: "manual" },
        { type: "command", executable: "node", args: ["--version"] },
      ],
    }
    const definition: WorkflowDefinition = {
      version: 2,
      name: "Execution Test",
      nodeIdMapping: { [node.key]: "node-execution-only" },
      nodes: [node],
    }

    const step = createStepsFromDefinition("proj_test", definition, Phase.DEVELOPMENT)[0]!
    expect(step.capabilities).toBeUndefined()
  })
})

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
