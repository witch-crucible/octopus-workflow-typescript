import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AIAssistantType } from "@octopus/core/agent.js"
import {
  prepareAIOutput,
  resolveAIOutputPath,
  writeAIOutput,
  writeCrossReviewReports,
} from "./ai-output.js"

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
  it("未显式配置 input 时使用节点回退输入", () => {
    const prepared = prepareAIOutput({
      type: "ai",
      assistant: AIAssistantType.MEETING_MINUTES,
    }, createTemporaryDirectory(), "AI Meeting Minutes：Generate meeting minutes")

    expect(prepared.input).toBe("AI Meeting Minutes：Generate meeting minutes")
  })

  it("显式 input 优先于节点回退输入", () => {
    const prepared = prepareAIOutput({
      type: "ai",
      assistant: AIAssistantType.MEETING_MINUTES,
      input: "会议原文",
    }, createTemporaryDirectory(), "AI Meeting Minutes：Generate meeting minutes")

    expect(prepared.input).toBe("会议原文")
  })

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

  it("拒绝通过节点目录内的符号链接写到外部", () => {
    const nodePath = createTemporaryDirectory()
    const outsidePath = createTemporaryDirectory()
    symlinkSync(outsidePath, join(nodePath, "reviews"), "dir")

    expect(() => resolveAIOutputPath(nodePath, "reviews/ocr.md")).toThrow("必须位于节点工作目录内")
  })

  it("按 requirement 隔离原始报告并同时发布 latest 汇总", () => {
    const nodePath = createTemporaryDirectory()
    const written = writeCrossReviewReports(nodePath, {
      result: "# aggregate",
      successCount: 1,
      durationMs: 5,
      reviews: [
        { agent: "ocr", ok: true, output: "OCR finding", durationMs: 1 },
        { agent: "commandcode", ok: false, output: "partial", error: "failed", durationMs: 2 },
      ],
    }, {
      outputFile: "cross-review.md",
      reviewOutputDir: "reviews",
      scope: "req/example",
    })

    expect(written.reviewOutputDir).toBe("reviews/req_example")
    expect(readFileSync(join(nodePath, "reviews/req_example/ocr.md"), "utf8")).toBe("OCR finding")
    expect(readFileSync(join(nodePath, "reviews/req_example/commandcode.md"), "utf8")).toContain("partial")
    expect(readFileSync(join(nodePath, "reviews/req_example/cross-review.md"), "utf8")).toBe("# aggregate")
    expect(readFileSync(join(nodePath, "cross-review.md"), "utf8")).toBe("# aggregate")
  })
})
