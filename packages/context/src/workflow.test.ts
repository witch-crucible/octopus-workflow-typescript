import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import {
  appendWorkflowNode,
  definitionFromBuiltInSpec,
  initializeWorkflowFile,
  loadWorkflowDefinition,
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
      key: "generate-documentation",
      phase: Phase.REQUIREMENTS_ANALYSIS,
      name: "Generate Documentation",
      description: "Generate or extend technical documentation",
      responsibleRoles: [Role.AI],
      dependsOn: ["requirements-analysis-and-brd-design"],
      actions: [{
        type: "ai",
        assistant: AIAssistantType.DOCUMENT_SYNC,
        outputFile: "documentation.md",
        ifExists: "extend",
      }],
    })

    const saved = loadWorkflowDefinition(projectRoot)
    expect(saved.nodes.some((node) => node.key === "generate-documentation")).toBe(true)
    expect(saved.nodeIdMapping["generate-documentation"]).toBe(result.nodeId)
    expect(existsSync(result.workspace.nodePath("generate-documentation"))).toBe(true)
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
