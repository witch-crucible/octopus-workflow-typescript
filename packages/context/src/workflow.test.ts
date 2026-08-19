import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import { getWorkflowSpec } from "@octopus/core/spec.js"
import {
  appendWorkflowNode,
  definitionFromBuiltInSpec,
  initializeWorkflowFile,
  loadResolvedWorkflowDefinition,
  loadWorkflowDefinition,
  loadWorkflowPluginRefs,
  saveWorkflowDefinition,
} from "./workflow.js"

const temporaryDirectories: string[] = []

function createProjectRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "octopus-workflow-"))
  temporaryDirectories.push(directory)
  initializeWorkflowFile(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("项目工作流节点写入", () => {
  it("内置节点使用英文 key 和英文内容且不暴露内部 ID", () => {
    const definition = definitionFromBuiltInSpec()
    for (const node of definition.nodes) {
      expect(node.key).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
      expect(node.name).toMatch(/^[\x00-\x7F]+$/)
      expect(node.description).toMatch(/^[\x00-\x7F]+$/)
      expect("id" in node).toBe(false)
      expect(definition.nodeIdMapping[node.key]).toBeTruthy()
    }
  })

  it("项目根目录不存在时完成初始化", () => {
    const parent = createProjectRoot()
    const projectRoot = join(parent, "new-project")
    const workspace = initializeWorkflowFile(projectRoot)
    expect(existsSync(workspace.workflowFile)).toBe(true)
  })

  it("追加节点并创建工作目录", () => {
    const projectRoot = createProjectRoot()
    const result = appendWorkflowNode(projectRoot, {
      key: "generate-report",
      phase: Phase.INTENTION,
      name: "Generate Report",
      description: "Generate a one-off delivery report",
      responsibleRoles: [Role.AI],
      dependsOn: ["requirements-analysis-and-brd-design"],
      actions: [{
        type: "ai",
        assistant: AIAssistantType.DOCUMENT_SYNC,
        outputFile: "report.md",
        ifExists: "extend",
      }],
    })

    const saved = loadWorkflowDefinition(projectRoot)
    expect(saved.nodes.some((node) => node.key === "generate-report")).toBe(true)
    expect(saved.nodeIdMapping["generate-report"]).toBe(result.nodeId)
    expect(existsSync(result.workspace.nodePath("generate-report"))).toBe(true)
  })

  it("拒绝重复节点且不改写原定义", () => {
    const projectRoot = createProjectRoot()
    const before = loadWorkflowDefinition(projectRoot)
    const existing = before.nodes[0]
    if (!existing) throw new Error("内置工作流必须包含节点")
    expect(() => appendWorkflowNode(projectRoot, existing)).toThrow("节点 key 重复")
    expect(loadWorkflowDefinition(projectRoot).nodes).toHaveLength(before.nodes.length)
  })
})

describe("工作流叠加", () => {
  it("无 overlay 文件时 resolved 与基础定义相同", () => {
    const projectRoot = createProjectRoot()
    const base = loadWorkflowDefinition(projectRoot)
    expect(loadResolvedWorkflowDefinition(projectRoot)).toEqual(base)
  })

  it("读取并回写 workflow.yaml 的 plugins 字段", () => {
    const projectRoot = createProjectRoot()
    const definition = loadWorkflowDefinition(projectRoot)
    saveWorkflowDefinition(projectRoot, { ...definition, plugins: ["./octopus-plugins/acme.js"] })
    expect(loadWorkflowPluginRefs(projectRoot)).toEqual(["./octopus-plugins/acme.js"])
    expect(loadWorkflowDefinition(projectRoot).plugins).toEqual(["./octopus-plugins/acme.js"])
  })

  it("应用 workflow.overlay.yaml 的 add / disable", () => {
    const projectRoot = createProjectRoot()
    writeFileSync(join(projectRoot, "workflow.overlay.yaml"), [
      "disable:",
      "  - weekly-feature-demo",
      "add:",
      "  - key: extra-qa-gate",
      "    phase: Testing",
      "    name: Extra QA Gate",
      "    description: Overlay extra gate",
      "    responsibleRoles:",
      "      - QA",
      "    dependsOn:",
      "      - smoke-demo-validation",
      "    actions:",
      "      - type: manual",
      "",
    ].join("\n"))
    const resolved = loadResolvedWorkflowDefinition(projectRoot)
    expect(resolved.nodes.some((node) => node.key === "weekly-feature-demo")).toBe(false)
    expect(resolved.nodes.some((node) => node.key === "extra-qa-gate")).toBe(true)
    expect(resolved.nodeIdMapping["extra-qa-gate"]).toBe("overlay:extra-qa-gate")
    const afterDemo = resolved.nodes.find((node) => node.dependsOn.includes("weekly-feature-demo"))
    expect(afterDemo).toBeUndefined()
  })
})

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url))

describe("内置 spec 与 workflow.yaml 一致性", () => {
  it("spec 步骤 id 集合与 workflow.yaml nodeIdMapping 双向一致", () => {
    const definition = loadWorkflowDefinition(REPO_ROOT)
    const specIds = new Set(getWorkflowSpec().phases.flatMap((phase) => phase.steps.map((step) => step.id)))
    const yamlIds = new Set(Object.values(definition.nodeIdMapping))
    expect([...specIds].sort()).toEqual([...yamlIds].sort())
  })

  it("spec 每阶段步骤数与 workflow.yaml 对应阶段节点数一致", () => {
    const definition = loadWorkflowDefinition(REPO_ROOT)
    const spec = getWorkflowSpec()
    const byPhase = new Map(spec.phases.map((phase) => [phase.phase, phase.steps.length]))
    for (const node of definition.nodes) {
      const expected = byPhase.get(node.phase)
      expect(expected, `节点 ${node.key} 阶段 ${node.phase} 的 spec 步骤数缺失`).toBeDefined()
      byPhase.set(node.phase, (byPhase.get(node.phase) ?? 0) - 1)
    }
    for (const [phase, remaining] of byPhase) {
      expect(remaining, `阶段 ${phase} 的 spec 步骤数与 workflow.yaml 节点数不一致`).toBe(0)
    }
  })
})

describe("definitionFromBuiltInSpec 生成 generate-documentation", () => {
  it("包含 generate-documentation 节点且 actions 映射正确", () => {
    const definition = definitionFromBuiltInSpec()
    const node = definition.nodes.find((candidate) => candidate.key === "generate-documentation")
    expect(node).toBeDefined()
    expect(node?.phase).toBe(Phase.RESEARCH)
    expect(node?.responsibleRoles).toEqual([Role.AI])
    expect(node?.dependsOn).toEqual(["requirements-analysis-and-brd-design"])
    expect(definition.nodeIdMapping["generate-documentation"]).toBe("10.doc")
    const aiActions = node?.actions.filter((action) => action.type === "ai") ?? []
    expect(aiActions).toHaveLength(1)
    const action = aiActions[0]
    if (!action || action.type !== "ai") throw new Error("generate-documentation 应包含 ai 动作")
    expect(action.assistant).toBe(AIAssistantType.DOCUMENT_SYNC)
    expect(action.outputFile).toBe("documentation.md")
    expect(action.input).toContain("Preserve valid existing content and extend changed sections.")
  })
})
