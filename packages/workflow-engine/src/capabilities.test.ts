import { describe, it, expect } from "vitest"
import { createStateStore } from "@octopus/context/index.js"
import type { AIClient } from "@octopus/agent-layer/index.js"
import type { AIAssistantType, AIResponse } from "@octopus/core/agent.js"
import { WorkflowEngine } from "./index.js"

const TEST_STORE_DIR = ".octo_cap_test"

/** 记录调用的假 AIClient */
function fakeAIClient(result: string): { client: AIClient; calls: AIAssistantType[] } {
  const calls: AIAssistantType[] = []
  const client = {
    callAssistant: async (type: AIAssistantType, _input: string): Promise<AIResponse> => {
      calls.push(type)
      return { result }
    },
  } as unknown as AIClient
  return { client, calls }
}

describe("runStepCapabilities", () => {
  it("AI 能力：调用助手并落为制品 + capabilityRuns", async () => {
    const { client, calls } = fakeAIClient("MOCK 会议纪要")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: TEST_STORE_DIR }),
      aiClient: client,
    })
    const state = engine.initProject("cap_ai")

    // 步骤 10.6 声明了 ai(MEETING_MINUTES)
    const after = await engine.runStepCapabilities(state.projectId, "10.6")

    expect(calls).toHaveLength(1)
    const step = after.steps.find((s) => s.id === "10.6")!
    expect(step.capabilityRuns?.[0]?.kind).toBe("ai")
    expect(step.capabilityRuns?.[0]?.ok).toBe(true)
    expect(after.artifacts.some((a) => a.content === "MOCK 会议纪要")).toBe(true)
  })

  it("无 capabilities 的步骤：无副作用", async () => {
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: TEST_STORE_DIR }),
    })
    const state = engine.initProject("cap_none")
    // 步骤 10.1 无 capabilities
    const after = await engine.runStepCapabilities(state.projectId, "10.1")
    const step = after.steps.find((s) => s.id === "10.1")!
    expect(step.capabilityRuns).toBeUndefined()
  })

  it("未配置 AIClient：AI 能力记为未执行", async () => {
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: TEST_STORE_DIR }),
    })
    const state = engine.initProject("cap_no_ai")
    const after = await engine.runStepCapabilities(state.projectId, "10.6")
    const step = after.steps.find((s) => s.id === "10.6")!
    expect(step.capabilityRuns?.[0]?.ok).toBe(false)
  })
})
