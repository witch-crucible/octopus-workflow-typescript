import { describe, expect, it } from "vitest"
import {
  BRD_DESIGN_METADATA_KEY,
  BRD_PROMPT_IDS,
  DEFAULT_BRD_OUTPUT_PATH,
  buildDefaultBrdPrompts,
  createEmptyBrdDesignConfig,
  hasBrdSourcesConfigured,
  mergeBrdDesignConfig,
  normalizeBrdDesignConfig,
  parseBrdDesignConfigFromMetadata,
  renderBrdPrompt,
  resolveBrdOutputPath,
  resolveBrdPrompts,
  serializeBrdDesignConfig,
} from "./brd-design.js"

describe("brd-design", () => {
  it("默认提示词包含全部 id，且 system/user 非空", () => {
    const prompts = buildDefaultBrdPrompts()
    expect(Object.keys(prompts).sort()).toEqual([...BRD_PROMPT_IDS].sort())
    for (const id of BRD_PROMPT_IDS) {
      expect(prompts[id].system.length).toBeGreaterThan(0)
      expect(prompts[id].user.length).toBeGreaterThan(0)
    }
  })

  it("空 metadata 解析为空配置", () => {
    expect(parseBrdDesignConfigFromMetadata(undefined)).toEqual(createEmptyBrdDesignConfig())
    expect(parseBrdDesignConfigFromMetadata({})).toEqual(createEmptyBrdDesignConfig())
  })

  it("往返序列化保留源与产出路径", () => {
    const config = normalizeBrdDesignConfig({
      sources: {
        miniprogramCodePath: "apps/mini",
        websiteUrl: "https://example.com",
        historicalBrdPaths: ["docs/history", "docs/example.md"],
      },
      brdOutputPath: "docs/brd.md",
    })
    const serialized = serializeBrdDesignConfig(config)
    expect(serialized).toBeTruthy()
    const parsed = parseBrdDesignConfigFromMetadata({
      [BRD_DESIGN_METADATA_KEY]: serialized!,
    })
    expect(parsed.sources.miniprogramCodePath).toBe("apps/mini")
    expect(parsed.sources.websiteUrl).toBe("https://example.com")
    expect(parsed.sources.historicalBrdPaths).toEqual(["docs/history", "docs/example.md"])
    expect(parsed.brdOutputPath).toBe("docs/brd.md")
  })

  it("非法 JSON 与非法结构抛错", () => {
    expect(() => parseBrdDesignConfigFromMetadata({ [BRD_DESIGN_METADATA_KEY]: "{" })).toThrow(/合法 JSON/)
    expect(() => normalizeBrdDesignConfig("x")).toThrow(/对象/)
    expect(() => normalizeBrdDesignConfig({ prompts: { generate: { system: "" } } })).toThrow(/system 与 user/)
    expect(() => normalizeBrdDesignConfig({ prompts: { unknown: { system: "a", user: "b" } } })).toThrow(/未知提示词/)
    expect(() => normalizeBrdDesignConfig({ sources: { historicalBrdPaths: "docs" } })).toThrow(/字符串数组/)
  })

  it("merge 支持深合并与空串清除", () => {
    const base = normalizeBrdDesignConfig({
      sources: { frontendCodePath: "web", backendCodePath: "api" },
      brdSpecPath: "spec.md",
    })
    const merged = mergeBrdDesignConfig(base, {
      sources: { frontendCodePath: "", miniprogramCodePath: "mini" },
      brdSpecPath: "",
      brdOutputPath: "out/brd.md",
      prompts: {
        generate: { user: "自定义 {{requirementName}}" },
      },
    })
    expect(merged.sources.frontendCodePath).toBeUndefined()
    expect(merged.sources.backendCodePath).toBe("api")
    expect(merged.sources.miniprogramCodePath).toBe("mini")
    expect(merged.brdSpecPath).toBeUndefined()
    expect(merged.brdOutputPath).toBe("out/brd.md")
    expect(merged.prompts?.generate?.user).toBe("自定义 {{requirementName}}")
    expect(merged.prompts?.generate?.system).toContain("资深产品经理")

    const withHistory = mergeBrdDesignConfig(merged, {
      sources: { historicalBrdPaths: [" docs/a.md ", "docs/a.md", "docs/b"] },
    })
    expect(withHistory.sources.historicalBrdPaths).toEqual(["docs/a.md", "docs/b"])
    const clearedHistory = mergeBrdDesignConfig(withHistory, {
      sources: { historicalBrdPaths: [] },
    })
    expect(clearedHistory.sources.historicalBrdPaths).toBeUndefined()
  })

  it("merge prompts[id]=null 删除覆盖", () => {
    const base = mergeBrdDesignConfig(createEmptyBrdDesignConfig(), {
      prompts: { check: { system: "s", user: "u" } },
    })
    expect(base.prompts?.check?.system).toBe("s")
    const cleared = mergeBrdDesignConfig(base, { prompts: { check: null } })
    expect(cleared.prompts?.check).toBeUndefined()
  })

  it("resolveBrdPrompts 使用默认 ⊕ 覆盖", () => {
    const resolved = resolveBrdPrompts({
      sources: {},
      prompts: { generate: { system: "SYS", user: "USER {{requirementName}}" } },
    })
    expect(resolved.generate.system).toBe("SYS")
    expect(resolved.check.system).toContain("BRD 评审")
    expect(buildDefaultBrdPrompts().generate.user).toContain("{{historicalBrds}}")
  })

  it("renderBrdPrompt 替换占位符，缺失为空串", () => {
    const rendered = renderBrdPrompt(
      { system: "sys {{requirementName}}", user: "desc={{requirementDescription}};url={{websiteUrl}}" },
      { requirementName: "功能A", websiteUrl: "https://x.test" },
    )
    expect(rendered.system).toBe("sys 功能A")
    expect(rendered.prompt).toBe("desc=;url=https://x.test")
  })

  it("resolveBrdOutputPath 与 hasBrdSourcesConfigured", () => {
    expect(resolveBrdOutputPath({ sources: {} })).toBe(DEFAULT_BRD_OUTPUT_PATH)
    expect(resolveBrdOutputPath({ sources: {}, brdOutputPath: "a.md" })).toBe("a.md")
    expect(hasBrdSourcesConfigured({ sources: {} })).toBe(false)
    expect(hasBrdSourcesConfigured({ sources: { websiteUrl: "https://a.com" } })).toBe(true)
  })

  it("空配置序列化为 undefined", () => {
    expect(serializeBrdDesignConfig(createEmptyBrdDesignConfig())).toBeUndefined()
  })
})
