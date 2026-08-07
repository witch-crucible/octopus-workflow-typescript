import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIAssistantType } from "@octopus/core/agent.js"
import { prepareAIOutput, writeAIOutput } from "./ai-output.js"

const temporaryDirectories: string[] = []

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octopus-ai-output-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("AI 节点文件输出", () => {
  it("目标不存在时创建文档", () => {
    const nodePath = createTemporaryDirectory()
    const prepared = prepareAIOutput({
      type: "ai",
      assistant: AIAssistantType.DOCUMENT_SYNC,
      input: "生成技术文档",
      outputFile: "documentation.md",
      ifExists: "extend",
    }, nodePath)

    expect(prepared.extended).toBe(false)
    expect(prepared.outputPath).toBe(join(nodePath, "documentation.md"))
    if (!prepared.outputPath) throw new Error("测试期望 AI 输出路径")
    writeAIOutput(prepared.outputPath, "# 新文档")
    expect(readFileSync(prepared.outputPath, "utf8")).toBe("# 新文档")
  })

  it("目标存在时把原文加入 AI 输入并写回完整文档", () => {
    const nodePath = createTemporaryDirectory()
    const outputPath = join(nodePath, "documentation.md")
    writeFileSync(outputPath, "# 原文", "utf8")
    const prepared = prepareAIOutput({
      type: "ai",
      assistant: AIAssistantType.DOCUMENT_SYNC,
      input: "扩展接口章节",
      outputFile: "documentation.md",
      ifExists: "extend",
    }, nodePath)

    expect(prepared.extended).toBe(true)
    expect(prepared.input).toContain("# 原文")
    if (!prepared.outputPath) throw new Error("测试期望 AI 输出路径")
    writeAIOutput(prepared.outputPath, "# 原文\n\n## 接口")
    expect(readFileSync(outputPath, "utf8")).toContain("## 接口")
  })

  it("拒绝把结果写到节点工作目录之外", () => {
    const nodePath = createTemporaryDirectory()
    expect(() => prepareAIOutput({
      type: "ai",
      assistant: AIAssistantType.DOCUMENT_SYNC,
      outputFile: "../outside.md",
    }, nodePath)).toThrow("必须位于节点工作目录内")
  })
})
