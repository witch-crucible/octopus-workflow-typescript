import { describe, expect, it } from "vitest"
import {
  ACCENT,
  actionLabel,
  BRD_PROMPT_IDS,
  escapeHtml,
  nodeDescZh,
  nodeNameZh,
  phaseLabel,
  ROLE_ORDER,
  roleLabel,
  runStatusLabel,
  schedulerLabel,
  statusLabel,
  truncate,
} from "./labels.js"

describe("labels", () => {
  it("maps known keys and falls back for unknown", () => {
    expect(phaseLabel("Design")).toBe("设计")
    expect(phaseLabel("Nope")).toBe("Nope")
    expect(phaseLabel("")).toBe("未知阶段")
    expect(statusLabel("COMPLETED")).toBe("已完成")
    expect(roleLabel("PM")).toBe("产品经理")
    expect(schedulerLabel("RUNNING")).toBe("运行中")
    expect(runStatusLabel("SUCCEEDED")).toBe("成功")
  })

  it("resolves node zh name/desc and action labels", () => {
    expect(nodeNameZh({ name: "BRD Walkthrough" })).toBe("BRD 宣讲")
    expect(nodeDescZh({ name: "BRD Walkthrough" })).toContain("BRD")
    expect(nodeDescZh({ name: "Unknown", description: "fallback" })).toBe("fallback")
    expect(actionLabel({ type: "manual" })).toBe("手动操作")
    expect(actionLabel({ type: "ai", assistant: "brd" })).toBe("AI：brd")
    expect(actionLabel({ type: "heinrich", delta: 2, level: "major" })).toBe("海因里希：Δ2 / major")
  })

  it("escapes html and truncates text", () => {
    expect(escapeHtml(`<"&'>`)).toBe("&lt;&quot;&amp;&#39;&gt;")
    expect(truncate("abcdef", 4)).toBe("abc…")
    expect(truncate("ab", 4)).toBe("ab")
  })

  it("exposes accent and role/prompt constants", () => {
    expect(ACCENT).toBe("#4f86c6")
    expect(ROLE_ORDER).toContain("DEV")
    expect(BRD_PROMPT_IDS).toEqual(["generate", "check", "summarize-sources"])
  })
})
