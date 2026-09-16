import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  HERMES_BRD_SKILL,
  readBrdHistory,
  runBrdCheck,
  runBrdGenerate,
  runBrdOptimize,
  type BrdNodeRuntime,
} from "../src/index.js"

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
  const hermesCalls: Array<{ skill: string; input: string; projectRoot: string }> = []
  const runtime: BrdNodeRuntime = {
    callAssistant: async (assistant) => {
      calls.push(assistant)
      return { result: assistant === "BRD_GENERATE" ? "# BRD\n生成内容" : "# 检查报告\n完整" }
    },
    runHermesSkill: async (skill, hermesInput, options) => {
      hermesCalls.push({ skill, input: hermesInput, projectRoot: options.projectRoot })
      return { result: "# 优化后的 BRD\n\n## 背景与目标\n可验收内容" }
    },
    createArtifact: (_requirementId, params) => {
      artifacts.push(params)
    },
  }
  return { runtime, calls, hermesCalls, artifacts }
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

  it("optimize 使用 Hermes Skill 无头结果并登记 BRD Artifact", async () => {
    const { runtime, calls, hermesCalls, artifacts } = recordingRuntime()
    const result = await runBrdOptimize(input(), runtime)
    expect(result).toMatchObject({ agent: "hermes", skill: HERMES_BRD_SKILL, dryRun: false })
    expect(calls).toEqual([])
    expect(hermesCalls).toHaveLength(1)
    expect(hermesCalls[0]).toMatchObject({ skill: HERMES_BRD_SKILL, projectRoot })
    expect(hermesCalls[0]!.input).toContain("不要调用终端或修改文件")
    expect(readFileSync(join(projectRoot, "docs/brd.md"), "utf8")).toContain("优化后的 BRD")
    expect(artifacts).toEqual([expect.objectContaining({ type: "BRD", filePath: "docs/brd.md" })])
  })

  it("optimize dry-run 不调用 Hermes 或写文件", async () => {
    const { runtime, hermesCalls, artifacts } = recordingRuntime()
    const result = await runBrdOptimize(input(), runtime, { dryRun: true })
    expect(result).toMatchObject({ agent: "hermes", skill: HERMES_BRD_SKILL, dryRun: true })
    expect(hermesCalls).toEqual([])
    expect(artifacts).toEqual([])
    expect(existsSync(join(projectRoot, "docs/brd.md"))).toBe(false)
  })

  it("optimize 在 Hermes 输出不符合 Markdown 契约时不覆盖文件", async () => {
    const { runtime } = recordingRuntime()
    runtime.runHermesSkill = async () => ({ result: "这不是 BRD" })
    await expect(runBrdOptimize(input(), runtime)).rejects.toThrow(/一级标题/)
    expect(existsSync(join(projectRoot, "docs/brd.md"))).toBe(false)
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

  it("两次 generate 串联历史，snapshot.previousSha 指向上一版", async () => {
    const { runtime, artifacts } = recordingRuntime()
    const first = await runBrdGenerate(input(), runtime)
    let callCount = 0
    runtime.callAssistant = async (assistant) => {
      callCount += 1
      return { result: `# BRD\n生成内容 v${callCount + 1}` }
    }
    const second = await runBrdGenerate(input(), runtime)

    expect(first.snapshot?.previousSha).toBeNull()
    expect(second.snapshot?.previousSha).toBe(first.snapshot?.sha)
    expect(artifacts[0]?.source).toMatchObject({ fileHash: first.snapshot?.sha })
    expect(artifacts[1]?.source).toMatchObject({ fileHash: second.snapshot?.sha })

    const history = readBrdHistory(join(projectRoot, "docs/brd.md"))
    expect(history.entries.map((entry) => entry.source)).toEqual(["generate", "generate"])
  })

  it("两次 generate 之间的手工修改被记为独立的 manual 版本", async () => {
    const { runtime } = recordingRuntime()
    await runBrdGenerate(input(), runtime)
    writeFileSync(join(projectRoot, "docs/brd.md"), "# BRD\n手工追加内容", "utf8")
    await runBrdGenerate(input(), runtime)

    const history = readBrdHistory(join(projectRoot, "docs/brd.md"))
    expect(history.entries.map((entry) => entry.source)).toEqual(["generate", "manual", "generate"])
  })

  it("check 在有上一版本时提示词包含变更 diff，且检查报告登记为 Artifact", async () => {
    const { runtime, artifacts } = recordingRuntime()
    await runBrdGenerate(input(), runtime)
    writeFileSync(join(projectRoot, "docs/brd.md"), "# BRD\n生成内容\n新增一行", "utf8")

    const result = await runBrdCheck(input(), runtime)
    const checkPrompt = result.promptsUsed.find((item) => item.id === "check")

    expect(checkPrompt?.prompt).toContain("+ 新增一行")
    expect(result.checkedSha).toBeDefined()
    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "BRD_CHECK_REPORT",
          source: { fileHash: result.checkedSha },
        }),
      ]),
    )

    const history = readBrdHistory(join(projectRoot, "docs/brd.md"))
    expect(history.entries[history.entries.length - 1]?.sha).toBe(result.checkedSha)
  })
})
