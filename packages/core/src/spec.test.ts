import { describe, expect, it } from "vitest"
import { AIAssistantType } from "./agent.js"
import { ALL_ROLES, Role } from "./role.js"
import { DEFAULT_WORKFLOW_SPEC, findStepSpec } from "./spec.js"

const allSteps = DEFAULT_WORKFLOW_SPEC.phases.flatMap((phase) => phase.steps)

describe("DEFAULT_WORKFLOW_SPEC 内部一致性", () => {
  it("所有步骤 id 唯一", () => {
    const ids = allSteps.map((step) => step.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("每个步骤的 responsibleRoles 都是合法角色", () => {
    for (const step of allSteps) {
      for (const role of step.responsibleRoles) {
        expect(ALL_ROLES).toContain(role)
      }
    }
  })

  it("dependsOn 中的 id 都指向 spec 中存在的步骤", () => {
    const ids = new Set(allSteps.map((step) => step.id))
    for (const step of allSteps) {
      for (const dependency of step.dependsOn) {
        expect(ids.has(dependency), `${step.id} 依赖不存在的步骤 ${dependency}`).toBe(true)
      }
    }
  })

  it("能力引用合法", () => {
    for (const step of allSteps) {
      for (const capability of step.capabilities ?? []) {
        if (capability.kind === "ai") {
          expect(Object.values(AIAssistantType)).toContain(capability.assistant)
        } else if (capability.kind === "integration") {
          expect(capability.service.length).toBeGreaterThan(0)
          expect(capability.op.length).toBeGreaterThan(0)
        } else if (capability.kind === "heinrich") {
          expect(typeof capability.delta).toBe("number")
        } else if (capability.kind === "custom") {
          expect(capability.name.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe("generate-documentation 步骤", () => {
  it("10.doc 存在于 Research 阶段", () => {
    const step = findStepSpec("10.doc")
    expect(step).toBeDefined()
    expect(step?.name).toBe("Generate Documentation")
    expect(step?.responsibleRoles).toEqual([Role.AI])
    expect(step?.dependsOn).toEqual(["10.1"])
    const research = DEFAULT_WORKFLOW_SPEC.phases.find((phase) => phase.phase === "Research")
    expect(research?.steps.some((item) => item.id === "10.doc")).toBe(true)
  })

  it("10.doc 声明 DOCUMENT_SYNC 能力并输出 documentation.md", () => {
    const step = findStepSpec("10.doc")
    const aiCapabilities = step?.capabilities?.filter((capability) => capability.kind === "ai") ?? []
    expect(aiCapabilities).toHaveLength(1)
    const capability = aiCapabilities[0]
    if (!capability || capability.kind !== "ai") throw new Error("10.doc 应包含 ai 能力")
    expect(capability.assistant).toBe(AIAssistantType.DOCUMENT_SYNC)
    expect(capability.outputFile).toBe("documentation.md")
    expect(capability.input).toContain("Preserve valid existing content and extend changed sections.")
  })
})

describe("AI Code Review 步骤", () => {
  it("50.5 配置 OCR、Command Code、Codex 交叉评审与双成功门槛", () => {
    const step = findStepSpec("50.5")
    const capability = step?.capabilities?.find((candidate) => candidate.kind === "ai")

    expect(capability).toMatchObject({
      kind: "ai",
      assistant: AIAssistantType.CODE_REVIEW,
      reviewers: ["ocr", "commandcode", "codex"],
      minimumSuccessfulReviewers: 2,
      outputFile: "cross-review.md",
      reviewOutputDir: "reviews",
    })
  })
})

describe("上线检查步骤", () => {
  it("只有全部测试链路完成后才能进入真正发布", () => {
    const step = findStepSpec("50.7a")
    expect(step).toBeDefined()
    expect(step?.name).toBe("Go-Live Check")
    expect(step?.responsibleRoles).toEqual([Role.SA, Role.QA])
    expect(step?.dependsOn).toEqual(["30.10", "40.2", "40.3", "50.6", "50.7"])

    const release = findStepSpec("50.8")
    expect(release?.dependsOn).toEqual(["50.7a"])
  })
})
