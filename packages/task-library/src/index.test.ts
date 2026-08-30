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
      phase: Phase.IMPLEMENTATION,
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

    const step = createStepsFromDefinition("proj_test", definition, Phase.IMPLEMENTATION)[0]!

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
      phase: Phase.IMPLEMENTATION,
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

    const step = createStepsFromDefinition("proj_test", definition, Phase.IMPLEMENTATION)[0]!
    expect(step.capabilities).toBeUndefined()
  })

  it("交叉评审配置在 action 与 capability 之间完整保留", () => {
    const node: WorkflowNodeSpec = {
      key: "cross-review-node",
      phase: Phase.RELEASE,
      name: "Cross Review Node",
      description: "Runs independent reviewers",
      responsibleRoles: [Role.AI],
      dependsOn: [],
      actions: [{
        type: "ai",
        assistant: AIAssistantType.CODE_REVIEW,
        reviewers: ["ocr", "commandcode", "codex"],
        minimumSuccessfulReviewers: 2,
        outputFile: "cross-review.md",
        reviewOutputDir: "reviews",
      }],
    }
    const definition: WorkflowDefinition = {
      version: 2,
      name: "Cross Review Test",
      nodeIdMapping: { [node.key]: "node-cross-review" },
      nodes: [node],
    }

    const step = createStepsFromDefinition("proj_test", definition, Phase.RELEASE)[0]!

    expect(step.capabilities?.[0]).toMatchObject({
      reviewers: ["ocr", "commandcode", "codex"],
      minimumSuccessfulReviewers: 2,
      reviewOutputDir: "reviews",
    })
  })
})

describe("createStepsForPhase", () => {
  it("INTENTION 阶段生成2个步骤", () => {
    const steps = createStepsForPhase("proj_test", Phase.INTENTION)
    expect(steps.length).toBe(2)
    expect(steps[0]!.phase).toBe(Phase.INTENTION)
    expect(steps[0]!.status).toBe(TaskStatus.PENDING)
  })

  it("RESEARCH 阶段生成11个步骤", () => {
    const steps = createStepsForPhase("proj_test", Phase.RESEARCH)
    expect(steps.length).toBe(11)
    expect(steps[0]!.phase).toBe(Phase.RESEARCH)
  })

  it("DESIGN 阶段生成9个步骤（含 20.2a）", () => {
    const steps = createStepsForPhase("proj_test", Phase.DESIGN)
    expect(steps.length).toBe(9)
  })

  it("每个步骤都有必填字段", () => {
    const steps = createStepsForPhase("proj_test", Phase.IMPLEMENTATION)
    for (const step of steps) {
      expect(step.id).toBeTruthy()
      expect(step.taskId).toBeTruthy()
      expect(step.name).toBeTruthy()
      expect(step.responsibleRole).toBeTruthy()
    }
  })

  it("文档生成节点配置为存在时扩展文档", () => {
    const step = createStepsForPhase("proj_test", Phase.IMPLEMENTATION)
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
  it("为所有9个阶段生成步骤映射", () => {
    const all = createAllSteps("proj_test")
    expect(Object.keys(all)).toHaveLength(9)
    expect(all[Phase.COMPLETED]).toEqual([])
  })
})

describe("getStepsByRole", () => {
  it("按角色过滤步骤", () => {
    const steps = createStepsForPhase("proj_test", Phase.INTENTION)
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
