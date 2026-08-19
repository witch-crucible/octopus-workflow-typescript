import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createEmptyBrdDesignConfig } from "@octopus/core/brd-design.js"
import {
  encodeBrdPromptEnvelope,
  gatherBrdSourceContext,
  renderBrdPromptsForContext,
} from "./brd-context.js"

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
