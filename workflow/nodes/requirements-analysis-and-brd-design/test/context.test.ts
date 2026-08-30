import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createEmptyBrdDesignConfig } from "@octopus/core/brd-design.js"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  encodeBrdPromptEnvelope,
  gatherBrdSourceContext,
  renderBrdPromptsForContext,
} from "../src/context.js"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "octopus-brd-ctx-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("gatherBrdSourceContext", () => {
  it("未配置源时给出警告并使用默认规范", () => {
    const context = gatherBrdSourceContext(createEmptyBrdDesignConfig(), root, {
      name: "需求A",
      description: "描述A",
    })
    expect(context.warnings.some((w) => w.includes("未配置"))).toBe(true)
    expect(context.brdSpec).toContain("BRD 规范")
    expect(context.vars.requirementName).toBe("需求A")
    expect(context.outputPath).toContain("brd.md")
  })

  it("采集存在的代码目录并标记缺失路径", () => {
    const frontend = join(root, "web")
    mkdirSync(frontend)
    writeFileSync(join(frontend, "README.md"), "# Web\nhello")
    writeFileSync(join(frontend, "package.json"), "{\"name\":\"web\"}")

    const context = gatherBrdSourceContext(
      {
        sources: {
          frontendCodePath: "web",
          backendCodePath: "missing-api",
          websiteUrl: "https://example.com",
        },
      },
      root,
      { name: "需求B", description: "desc" },
    )
    expect(context.sources.some((s) => s.label === "前端代码" && !s.missing)).toBe(true)
    expect(context.sources.some((s) => s.label === "后端代码" && s.missing)).toBe(true)
    expect(context.vars.sourcesSummary).toContain("https://example.com")
    expect(context.warnings.some((w) => w.includes("后端"))).toBe(true)
  })

  it("每次采集历史 BRD 文本并排除当前输出文件", () => {
    const history = join(root, "docs", "history")
    mkdirSync(history, { recursive: true })
    writeFileSync(join(history, "approved.md"), "# 历史支付 BRD\n稳定结构")
    writeFileSync(join(history, "ignored.pdf"), "binary")
    writeFileSync(join(history, "current.md"), "# 不应作为历史重复读取")

    const context = gatherBrdSourceContext(
      {
        sources: { historicalBrdPaths: ["docs/history"] },
        brdOutputPath: "docs/history/current.md",
      },
      root,
      { name: "当前需求", description: "desc" },
    )
    expect(context.historicalBrds).toContain("历史支付 BRD")
    expect(context.historicalBrds).not.toContain("不应作为历史重复读取")
    expect(context.vars.historicalBrds).toBe(context.historicalBrds)
  })

  it("renderBrdPromptsForContext 按 mode 过滤", () => {
    const context = gatherBrdSourceContext(createEmptyBrdDesignConfig(), root, {
      name: "N",
      description: "D",
    })
    const generateOnly = renderBrdPromptsForContext(createEmptyBrdDesignConfig(), context, "generate")
    expect(generateOnly.map((p) => p.id)).toEqual(["generate"])
    expect(generateOnly[0]!.prompt).toContain("N")

    const withSummarize = renderBrdPromptsForContext(
      createEmptyBrdDesignConfig(),
      context,
      "generate",
      { includeSummarize: true },
    )
    expect(withSummarize.map((p) => p.id)).toEqual(["summarize-sources", "generate"])
  })

  it("encodeBrdPromptEnvelope 输出合法 JSON", () => {
    const encoded = encodeBrdPromptEnvelope("sys", "user")
    expect(JSON.parse(encoded)).toEqual({ system: "sys", prompt: "user" })
  })
})
