import { describe, expect, it, vi } from "vitest"
import { AIAssistantType } from "@octopus/core/agent.js"
import { Phase } from "@octopus/core/phase.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { createEmptyState } from "@octopus/core/workflow.js"
import { ProjectId, RequirementId } from "@octopus/core/branded-ids.js"
import { createStepsForPhase } from "@octopus/task-library/index.js"
import { CapabilityRegistry } from "./capabilities.js"

function context() {
  const state = createEmptyState(ProjectId("proj_test"), RequirementId("req_test"), "R", "")
  state.steps = createStepsForPhase(state.projectId, Phase.INTENTION)
  return { state, step: state.steps[0]! }
}

describe("CapabilityRegistry", () => {
  it("未配置 AI 时返回可诊断失败", async () => {
    const ctx = context()
    const result = await new CapabilityRegistry().dispatch({ kind: "ai", assistant: AIAssistantType.BRD_GENERATE }, { ...ctx, integrations: {} })
    expect(result).toMatchObject({ ok: false, summary: "未配置 AIClient" })
  })
  it("AI 结果写入制品", async () => {
    const ctx = context()
    const callAssistant = vi.fn(async () => ({ result: "AI 输出", rawOutput: "AI 输出" }))
    const result = await new CapabilityRegistry().dispatch({ kind: "ai", assistant: AIAssistantType.BRD_GENERATE }, { ...ctx, integrations: {}, aiClient: { callAssistant } as never })
    expect(result.ok).toBe(true)
    expect(ctx.state.artifacts[0]?.content).toBe("AI 输出")
  })
  it("Heinrich 能力使用步骤阶段", async () => {
    const ctx = context()
    await new CapabilityRegistry().dispatch({ kind: "heinrich", delta: 2, level: HeinrichLevel.MINOR }, { ...ctx, integrations: {} })
    expect(ctx.state.heinrich.triggerCounts[ctx.step.phase]).toBe(2)
    expect(ctx.state.heinrich.observations[0]?.phase).toBe(ctx.step.phase)
  })
  it("集成缺失和成功调用均返回明确结果", async () => {
    const ctx = context()
    const registry = new CapabilityRegistry()
    expect((await registry.dispatch({ kind: "integration", service: "sonar", op: "scan" }, { ...ctx, integrations: {} })).summary).toContain("未注册")
    const scan = vi.fn(async () => ({ ok: true }))
    expect((await registry.dispatch({ kind: "integration", service: "sonar", op: "scan" }, { ...ctx, integrations: { sonar: { scan } as never } })).ok).toBe(true)
    expect(scan).toHaveBeenCalledOnce()
  })
})
