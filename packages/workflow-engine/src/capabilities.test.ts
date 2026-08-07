import { describe, it, expect } from "vitest"
import { createStateStore } from "@octopus/context/index.js"
import type { AIClient } from "@octopus/agent-layer/index.js"
import { getAIAssistantModule } from "@octopus/agent-layer/index.js"
import type { AIAssistantType, AIResponse } from "@octopus/core/agent.js"
import { Phase } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { DEFAULT_WORKFLOW_SPEC } from "@octopus/core/spec.js"
import { WorkflowEngine } from "./index.js"

const TEST_STORE_DIR = ".octo_cap_test"

/** 记录调用的假 AIClient */
function fakeAIClient(result: string): { client: AIClient; calls: AIAssistantType[]; inputs: string[] } {
  const calls: AIAssistantType[] = []
  const inputs: string[] = []
  const client = {
    callAssistant: async (type: AIAssistantType, input: string): Promise<AIResponse> => {
      calls.push(type)
      inputs.push(input)
      return { result }
    },
  } as unknown as AIClient
  return { client, calls, inputs }
}

/** 完成某阶段全部任务并前进，直到到达目标阶段 */
function advanceToPhase(engine: WorkflowEngine, projectId: string, target: Phase): void {
  while (engine.getState(projectId).currentPhase !== target) {
    const current = engine.getState(projectId).currentPhase
    for (const task of engine.getTasks(projectId, { phase: current })) {
      if (task.status !== TaskStatus.COMPLETED) {
        engine.completeTask(projectId, task.id)
      }
    }
    engine.advancePhase(projectId)
  }
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

describe("runStepCapabilities 显式输入", () => {
  it("显式输入到达 AI 模块并生成 Artifact", async () => {
    const { client, inputs } = fakeAIClient("MOCK 显式输入")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: TEST_STORE_DIR }),
      aiClient: client,
    })
    const state = engine.initProject("cap_input")
    const after = await engine.runStepCapabilities(state.projectId, "10.6", "显式输入原文")

    expect(inputs).toEqual(["显式输入原文"])
    expect(after.artifacts.some((a) => a.content === "MOCK 显式输入")).toBe(true)
  })

  it("不传输入时使用英文步骤名称与描述", async () => {
    const { client, inputs } = fakeAIClient("ok")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: TEST_STORE_DIR }),
      aiClient: client,
    })
    const state = engine.initProject("cap_fallback")
    await engine.runStepCapabilities(state.projectId, "10.6")

    expect(inputs).toEqual(["AI Meeting Minutes：AI generates meeting minutes from the recorded discussion"])
  })

  it("Integration 能力不消费显式输入，Heinrich 行为不变", async () => {
    const { client, inputs } = fakeAIClient("ok")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: TEST_STORE_DIR }),
      aiClient: client,
    })
    const state = engine.initProject("cap_multi")
    advanceToPhase(engine, state.projectId, Phase.DEPLOYMENT)
    const before = engine.getState(state.projectId).heinrich.triggerCounts[Phase.DEPLOYMENT] ?? 0

    const after = await engine.runStepCapabilities(state.projectId, "50.7", "EXPLICIT SQL")
    const step = after.steps.find((s) => s.id === "50.7")!

    expect(inputs).toEqual(["EXPLICIT SQL"])
    expect(step.capabilityRuns).toHaveLength(2)
    expect(step.capabilityRuns?.[0]?.kind).toBe("ai")
    expect(step.capabilityRuns?.[1]?.kind).toBe("heinrich")
    expect(after.heinrich.triggerCounts[Phase.DEPLOYMENT]).toBe(before + 1)
  })

  it("无 AI 能力的 Integration 步骤：显式输入被忽略，行为不变", async () => {
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: TEST_STORE_DIR }),
    })
    const state = engine.initProject("cap_int")
    advanceToPhase(engine, state.projectId, Phase.DEPLOYMENT)

    const after = await engine.runStepCapabilities(state.projectId, "50.2", "EXPLICIT")
    const step = after.steps.find((s) => s.id === "50.2")!

    expect(step.capabilityRuns).toHaveLength(2)
    expect(step.capabilityRuns?.[0]?.kind).toBe("integration")
    expect(step.capabilityRuns?.[0]?.ok).toBe(false)
    expect(step.capabilityRuns?.[1]?.kind).toBe("heinrich")
  })
})

describe("Checklist 推荐落库", () => {
  it("合法 JSON 新增清单项", async () => {
    const { client } = fakeAIClient(
      '[{"category":"性能","description":"验证缓存命中率"},{"description":"检查日志输出"}]',
    )
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: TEST_STORE_DIR }),
      aiClient: client,
    })
    const state = engine.initProject("cap_cl_valid")
    advanceToPhase(engine, state.projectId, Phase.DEPLOYMENT)

    const after = await engine.runStepCapabilities(state.projectId, "50.3")
    const cl = after.checklists[Phase.DEPLOYMENT]!

    expect(cl.items).toHaveLength(2)
    expect(cl.items[0]?.category).toBe("性能")
    expect(cl.items[0]?.description).toBe("验证缓存命中率")
    expect(cl.items[1]?.category).toBe("AI Recommended")
    expect(cl.items[1]?.description).toBe("检查日志输出")
  })

  it("非法 JSON 不破坏状态，并保留能力执行记录", async () => {
    const { client } = fakeAIClient("这不是 JSON")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: TEST_STORE_DIR }),
      aiClient: client,
    })
    const state = engine.initProject("cap_cl_invalid")
    advanceToPhase(engine, state.projectId, Phase.DEPLOYMENT)

    const after = await engine.runStepCapabilities(state.projectId, "50.3")
    const step = after.steps.find((s) => s.id === "50.3")!

    expect(after.checklists[Phase.DEPLOYMENT]!.items).toHaveLength(0)
    expect(step.capabilityRuns?.[0]?.kind).toBe("ai")
    expect(step.capabilityRuns?.[0]?.ok).toBe(true)
  })
})

describe("spec 与注册表一致", () => {
  it("六阶段 spec 中所有 AI capability 均解析到已注册模块", () => {
    for (const phase of DEFAULT_WORKFLOW_SPEC.phases) {
      for (const step of phase.steps) {
        for (const cap of step.capabilities ?? []) {
          if (cap.kind === "ai") {
            expect(getAIAssistantModule(cap.assistant).type).toBe(cap.assistant)
          }
        }
      }
    }
  })
})
