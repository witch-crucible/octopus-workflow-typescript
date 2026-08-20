import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { runBrdCheck, runBrdGenerate, type BrdNodeRuntime } from "../src/index.js"

let projectRoot: string

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "octopus-brd-node-"))
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

function input() {
  return {
    config: { sources: {}, brdOutputPath: "docs/brd.md" },
    projectRoot,
    requirementId: "req_1",
    requirementName: "支付改版",
    requirementDescription: "优化支付流程",
  }
}

function recordingRuntime() {
  const calls: string[] = []
  const artifacts: Array<{ type: string; filePath?: string }> = []
  const runtime: BrdNodeRuntime = {
    callAssistant: async (assistant) => {
      calls.push(assistant)
      return { result: assistant === "BRD_GENERATE" ? "# BRD\n生成内容" : "# 检查报告\n完整" }
    },
    createArtifact: (_requirementId, params) => {
      artifacts.push(params)
    },
  }
  return { runtime, calls, artifacts }
}

describe("requirements-analysis-and-brd-design 节点编排", () => {
  it("dry-run 只渲染 generate 提示词，不调用 AI 或写文件", async () => {
    const { runtime, calls, artifacts } = recordingRuntime()
    const result = await runBrdGenerate(input(), runtime, { dryRun: true })

    expect(result.dryRun).toBe(true)
    expect(result.promptsUsed.map((prompt) => prompt.id)).toEqual(["generate"])
    expect(calls).toEqual([])
    expect(artifacts).toEqual([])
    expect(existsSync(join(projectRoot, "docs/brd.md"))).toBe(false)
  })

  it("generate 写入 BRD 并登记 BRD Artifact", async () => {
    const { runtime, calls, artifacts } = recordingRuntime()
    const result = await runBrdGenerate(input(), runtime)

    expect(result.result).toContain("生成内容")
    expect(calls).toEqual(["BRD_GENERATE"])
    expect(readFileSync(join(projectRoot, "docs/brd.md"), "utf8")).toContain("生成内容")
    expect(artifacts).toEqual([expect.objectContaining({ type: "BRD", filePath: "docs/brd.md" })])
  })

  it("check 写独立报告且不覆盖 BRD 正文", async () => {
    const { runtime, calls } = recordingRuntime()
    await runBrdGenerate(input(), runtime)
    const original = readFileSync(join(projectRoot, "docs/brd.md"), "utf8")

    const result = await runBrdCheck(input(), runtime)

    expect(result.result).toContain("检查报告")
    expect(calls).toEqual(["BRD_GENERATE", "BRD_CHECK"])
    expect(readFileSync(join(projectRoot, "docs/brd.md"), "utf8")).toBe(original)
    expect(readFileSync(join(projectRoot, "docs/brd-check-report.md"), "utf8")).toContain("检查报告")
  })

  it("check 在 BRD 不存在时给出可诊断错误", async () => {
    const { runtime } = recordingRuntime()
    await expect(runBrdCheck(input(), runtime)).rejects.toThrow(/未找到已有 BRD/)
  })
})
