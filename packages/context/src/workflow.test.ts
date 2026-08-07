import { afterEach, describe, expect, it } from "vitest"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import {
  appendWorkflowNode,
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
  it("项目根目录不存在时完成初始化", () => {
    const parent = createProjectRoot()
    const projectRoot = join(parent, "new-project")
    const workspace = initializeWorkflowFile(projectRoot)
    expect(existsSync(workspace.workflowFile)).toBe(true)
  })

  it("追加节点并创建工作目录", () => {
    const projectRoot = createProjectRoot()
    const workspace = appendWorkflowNode(projectRoot, {
      id: "10.doc",
      phase: Phase.REQUIREMENTS_ANALYSIS,
      name: "AI 生成文档",
      description: "生成或扩展技术文档",
      responsibleRoles: [Role.AI],
      dependsOn: ["10.1"],
      actions: [{
        type: "ai",
        assistant: AIAssistantType.DOCUMENT_SYNC,
        outputFile: "documentation.md",
        ifExists: "extend",
      }],
    })

    const saved = loadWorkflowDefinition(projectRoot)
    expect(saved.nodes.some((node) => node.id === "10.doc")).toBe(true)
    expect(existsSync(workspace.nodePath("10.doc"))).toBe(true)
  })

  it("拒绝重复节点且不改写原定义", () => {
    const projectRoot = createProjectRoot()
    const before = loadWorkflowDefinition(projectRoot)
    const existing = before.nodes[0]
    if (!existing) throw new Error("内置工作流必须包含节点")
    expect(() => appendWorkflowNode(projectRoot, existing)).toThrow("节点 ID 重复")
    expect(loadWorkflowDefinition(projectRoot).nodes).toHaveLength(before.nodes.length)
  })
})
