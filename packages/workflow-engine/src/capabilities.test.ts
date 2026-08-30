import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStateStore } from "@octopus/context/index.js"
import type { AIClient } from "@octopus/agent-layer/index.js"
import { getAIAssistantModule } from "@octopus/agent-layer/index.js"
import type { AIAssistantType, AIResponse } from "@octopus/core/agent.js"
import type { IntegrationService } from "@octopus/integration/index.js"
import { Phase } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { DEFAULT_WORKFLOW_SPEC } from "@octopus/core/spec.js"
import { WorkflowEngine } from "./index.js"
import type { CapabilityHandler } from "./capabilities.js"

let testStoreDir: string

beforeEach(() => {
  testStoreDir = mkdtempSync(join(tmpdir(), "octopus-capability-"))
})

afterEach(() => {
  rmSync(testStoreDir, { recursive: true, force: true })
})

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

function enterResearch(engine: WorkflowEngine, requirementId: string): void {
  for (const task of engine.getTasks(requirementId, { phase: Phase.INTENTION })) {
    if (task.status !== TaskStatus.COMPLETED) engine.completeTask(requirementId, task.id)
  }
  engine.advancePhase(requirementId)
}

function advanceToPhase(engine: WorkflowEngine, requirementId: string, target: Phase): void {
  while (engine.getState(requirementId).currentPhase !== target) {
    const current = engine.getState(requirementId).currentPhase
    for (const task of engine.getTasks(requirementId, { phase: current })) {
      if (task.status !== TaskStatus.COMPLETED) {
        engine.completeTask(requirementId, task.id)
      }
    }
    engine.advancePhase(requirementId)
  }
}


function initNamedRequirement(
  engine: WorkflowEngine,
  name: string,
  description?: string,
  projectRoot?: string,
) {
  const project = engine.createProject(name, description)
  return engine.initRequirement(project.projectId, name, description, projectRoot)
}

describe("runStepCapabilities", () => {
  it("AI 能力：调用助手并落为制品 + capabilityRuns", async () => {
    const { client, calls } = fakeAIClient("MOCK 会议纪要")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_ai")
    enterResearch(engine, state.requirementId)

    // 步骤 10.6 声明了 ai(MEETING_MINUTES)
    const after = await engine.runStepCapabilities(state.requirementId, "10.6")

    expect(calls).toHaveLength(1)
    const step = after.steps.find((s) => s.id === "10.6")!
    expect(step.capabilityRuns?.[0]?.kind).toBe("ai")
    expect(step.capabilityRuns?.[0]?.ok).toBe(true)
    expect(after.artifacts.some((a) => a.content === "MOCK 会议纪要")).toBe(true)
  })

  it("配置源码根目录时，从 workflow.yaml 恢复 AI capability 并实际调用", async () => {
    const { client, calls, inputs } = fakeAIClient("MOCK 项目工作流输出")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_project_root", undefined, join(testStoreDir, "source"))
    enterResearch(engine, state.requirementId)

    const after = await engine.runStepCapabilities(state.requirementId, "10.6")

    expect(calls).toHaveLength(1)
    expect(inputs).toEqual(["AI Meeting Minutes：AI generates meeting minutes from the recorded discussion"])
    expect(after.steps.find((step) => step.id === "10.6")?.capabilityRuns?.[0]?.ok).toBe(true)
  })

  it("无 capabilities 的步骤：无副作用", async () => {
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
    })
    const state = initNamedRequirement(engine, "cap_none")
    // 步骤 10.2 无 capabilities（10.1 已接入 BRD 生成/检查能力）
    const after = await engine.runStepCapabilities(state.requirementId, "10.2")
    const step = after.steps.find((s) => s.id === "10.2")!
    expect(step.capabilityRuns).toBeUndefined()
  })

  it("未配置 AIClient：AI 能力记为未执行", async () => {
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
    })
    const state = initNamedRequirement(engine, "cap_no_ai")
    enterResearch(engine, state.requirementId)
    const after = await engine.runStepCapabilities(state.requirementId, "10.6")
    const step = after.steps.find((s) => s.id === "10.6")!
    expect(step.capabilityRuns?.[0]?.ok).toBe(false)
  })

  it("CODE_REVIEW capability 使用三个 reviewer 并以两个成功通过", async () => {
    const calls: unknown[][] = []
    const client = {
      crossReviewCode: async (...args: unknown[]) => {
        calls.push(args)
        return {
          result: "# Cross review\n\n2/3 succeeded",
          successCount: 2,
          durationMs: 10,
          reviews: [
            { agent: "ocr", ok: true, output: "OCR finding", durationMs: 3 },
            { agent: "commandcode", ok: true, output: "Command Code finding", durationMs: 4 },
            { agent: "codex", ok: false, output: "", error: "codex failed", durationMs: 5 },
          ],
        }
      },
    } as unknown as AIClient
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_cross_review", undefined, testStoreDir)
    advanceToPhase(engine, state.requirementId, Phase.RELEASE)

    const after = await engine.runStepCapabilities(state.requirementId, "50.5", "审查当前变更")

    expect(calls).toEqual([[
      "审查当前变更",
      testStoreDir,
      ["ocr", "commandcode", "codex"],
      {
        excludedPaths: [
          "workflow/nodes/ai-code-review/cross-review.md",
          "workflow/nodes/ai-code-review/reviews/**",
        ],
      },
    ]])
    expect(after.steps.find((step) => step.id === "50.5")?.capabilityRuns?.[0]?.ok).toBe(true)
    expect(after.artifacts.some((artifact) => artifact.content === "OCR finding")).toBe(true)
    expect(after.artifacts.some((artifact) => artifact.content === "# Cross review\n\n2/3 succeeded")).toBe(true)
    const nodePath = join(testStoreDir, "workflow/nodes/ai-code-review")
    expect(readFileSync(join(nodePath, `reviews/${state.requirementId}/ocr.md`), "utf8")).toBe("OCR finding")
    expect(readFileSync(join(nodePath, "cross-review.md"), "utf8")).toContain("2/3 succeeded")
  })

  it("CODE_REVIEW capability 成功数不足时记录失败但保留报告", async () => {
    const client = {
      crossReviewCode: async () => ({
        result: "# Cross review\n\n1/3 succeeded",
        successCount: 1,
        durationMs: 10,
        reviews: [
          { agent: "ocr", ok: true, output: "Only finding", durationMs: 3 },
          { agent: "commandcode", ok: false, output: "", error: "failed", durationMs: 4 },
          { agent: "codex", ok: false, output: "", error: "failed", durationMs: 5 },
        ],
      }),
    } as unknown as AIClient
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_cross_review_quorum", undefined, testStoreDir)
    advanceToPhase(engine, state.requirementId, Phase.RELEASE)

    const after = await engine.runStepCapabilities(state.requirementId, "50.5")

    const run = after.steps.find((step) => step.id === "50.5")?.capabilityRuns?.[0]
    expect(run?.ok).toBe(false)
    expect(run?.summary).toContain("至少需要 2 个成功，实际 1 个")
    expect(after.steps.find((step) => step.id === "50.5")?.status).toBe(TaskStatus.BLOCKED)
    expect(after.artifacts.some((artifact) => artifact.content === "Only finding")).toBe(true)
    const nodePath = join(testStoreDir, "workflow/nodes/ai-code-review")
    expect(readFileSync(join(nodePath, `reviews/${state.requirementId}/ocr.md`), "utf8")).toBe("Only finding")
    expect(readFileSync(join(nodePath, "cross-review.md"), "utf8")).toContain("1/3 succeeded")
  })

  it("CODE_REVIEW capability 失败后成功重跑会解除自身 BLOCKED 状态", async () => {
    let attempt = 0
    const client = {
      crossReviewCode: async () => {
        attempt++
        const successCount = attempt === 1 ? 1 : 3
        return {
          result: `# Cross review\n\n${successCount}/3 succeeded`,
          successCount,
          durationMs: 10,
          reviews: [
            { agent: "ocr", ok: true, output: "OCR", durationMs: 1 },
            { agent: "commandcode", ok: successCount > 1, output: "Command Code", durationMs: 1 },
            { agent: "codex", ok: successCount > 1, output: "Codex", durationMs: 1 },
          ],
        }
      },
    } as unknown as AIClient
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_cross_review_retry", undefined, testStoreDir)
    advanceToPhase(engine, state.requirementId, Phase.RELEASE)

    const failed = await engine.runStepCapabilities(state.requirementId, "50.5")
    expect(failed.steps.find((step) => step.id === "50.5")?.status).toBe(TaskStatus.BLOCKED)

    const recovered = await engine.runStepCapabilities(state.requirementId, "50.5")
    const step = recovered.steps.find((candidate) => candidate.id === "50.5")
    expect(step?.status).toBe(TaskStatus.PENDING)
    expect(step?.notes).toBeUndefined()
    expect(step?.capabilityRuns?.map((run) => run.ok)).toEqual([false, true])
  })

  it("CODE_REVIEW capability 把取消信号传给 reviewer 且取消后不落盘", async () => {
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const client = {
      crossReviewCode: async (
        _input: string,
        _root: string,
        _reviewers: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        receivedSignal = options?.signal
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }))
        return {
          result: "canceled",
          successCount: 0,
          durationMs: 1,
          reviews: [
            { agent: "ocr", ok: false, output: "", error: "ocr 调用已取消", durationMs: 1 },
          ],
        }
      },
    } as unknown as AIClient
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_cross_review_abort", undefined, testStoreDir)
    advanceToPhase(engine, state.requirementId, Phase.RELEASE)

    const pending = engine.runStepCapabilities(
      state.requirementId,
      "50.5",
      undefined,
      controller.signal,
    )
    controller.abort()

    await expect(pending).rejects.toThrow("交叉代码评审已取消")
    expect(receivedSignal).toBe(controller.signal)
    expect(engine.getState(state.requirementId).steps.find((step) => step.id === "50.5")?.status)
      .toBe(TaskStatus.PENDING)
  })

  it("AI 等待期间的并发更新应保留并明确报告冲突", async () => {
    let resolveAI: ((response: AIResponse) => void) | undefined
    let notifyStarted: (() => void) | undefined
    const started = new Promise<void>((resolveStarted) => {
      notifyStarted = resolveStarted
    })
    const client = {
      callAssistant: async (): Promise<AIResponse> => {
        notifyStarted?.()
        return new Promise<AIResponse>((resolveResponse) => {
          resolveAI = resolveResponse
        })
      },
    } as unknown as AIClient
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const concurrentEngine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
    })
    const state = initNamedRequirement(engine, "cap_concurrent")
    enterResearch(engine, state.requirementId)
    const originalSnapshot = JSON.stringify(state)

    const capabilityRun = engine.runStepCapabilities(state.requirementId, "10.6")
    await started
    const task = concurrentEngine.getTasks(state.requirementId).find((candidate) => candidate.stageId === "10.1")
    if (!task) throw new Error("测试任务不存在")
    concurrentEngine.completeTask(state.requirementId, task.id)
    resolveAI?.({ result: "不应覆盖并发状态" })

    await expect(capabilityRun).rejects.toThrow("执行期间需求状态已变更")
    // 调用方持有的原始 state 对象未被 capability 副作用污染
    expect(JSON.stringify(state)).toBe(originalSnapshot)
    const latest = engine.getState(state.requirementId)
    expect(latest.steps.find((candidate) => candidate.id === "10.1")?.status).toBe(TaskStatus.COMPLETED)
    expect(latest.artifacts.some((artifact) => artifact.content === "不应覆盖并发状态")).toBe(false)
  })
})

describe("runStepCapabilities 显式输入", () => {
  it("显式输入到达 AI 模块并生成 Artifact", async () => {
    const { client, inputs } = fakeAIClient("MOCK 显式输入")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_input")
    enterResearch(engine, state.requirementId)
    const after = await engine.runStepCapabilities(state.requirementId, "10.6", "显式输入原文")

    expect(inputs).toEqual(["显式输入原文"])
    expect(after.artifacts.some((a) => a.content === "MOCK 显式输入")).toBe(true)
  })

  it("未传运行参数时使用 capability 声明输入", async () => {
    const { client, inputs } = fakeAIClient("MOCK 声明输入")
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store, aiClient: client })
    const state = initNamedRequirement(engine, "cap_declared_input")
    enterResearch(engine, state.requirementId)
    store.update(state.requirementId, (current) => {
      const step = current.steps.find((candidate) => candidate.id === "10.6")
      if (!step || !step.capabilities?.[0] || step.capabilities[0].kind !== "ai") {
        throw new Error("测试 AI capability 不存在")
      }
      step.capabilities = [{ ...step.capabilities[0], input: "workflow 声明输入" }]
      return current
    })

    await engine.runStepCapabilities(state.requirementId, "10.6")

    expect(inputs).toEqual(["workflow 声明输入"])
  })

  it("运行参数优先于 capability 声明输入", async () => {
    const { client, inputs } = fakeAIClient("MOCK 覆盖输入")
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store, aiClient: client })
    const state = initNamedRequirement(engine, "cap_runtime_input")
    enterResearch(engine, state.requirementId)
    store.update(state.requirementId, (current) => {
      const step = current.steps.find((candidate) => candidate.id === "10.6")
      if (!step || !step.capabilities?.[0] || step.capabilities[0].kind !== "ai") {
        throw new Error("测试 AI capability 不存在")
      }
      step.capabilities = [{ ...step.capabilities[0], input: "workflow 声明输入" }]
      return current
    })

    await engine.runStepCapabilities(state.requirementId, "10.6", "运行参数输入")

    expect(inputs).toEqual(["运行参数输入"])
  })

  it("不传输入时使用英文步骤名称与描述", async () => {
    const { client, inputs } = fakeAIClient("ok")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_fallback")
    enterResearch(engine, state.requirementId)
    await engine.runStepCapabilities(state.requirementId, "10.6")

    expect(inputs).toEqual(["AI Meeting Minutes：AI generates meeting minutes from the recorded discussion"])
  })

  it("Integration 能力不消费显式输入，Heinrich 行为不变", async () => {
    const { client, inputs } = fakeAIClient("ok")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_multi")
    advanceToPhase(engine, state.requirementId, Phase.RELEASE)
    const before = engine.getState(state.requirementId).heinrich.triggerCounts[Phase.RELEASE] ?? 0

    const after = await engine.runStepCapabilities(state.requirementId, "50.7", "EXPLICIT SQL")
    const step = after.steps.find((s) => s.id === "50.7")!

    expect(inputs).toEqual(["EXPLICIT SQL"])
    expect(step.capabilityRuns).toHaveLength(2)
    expect(step.capabilityRuns?.[0]?.kind).toBe("ai")
    expect(step.capabilityRuns?.[1]?.kind).toBe("heinrich")
    expect(after.heinrich.triggerCounts[Phase.RELEASE]).toBe(before + 1)
  })

  it("无 AI 能力的 Integration 步骤：显式输入被忽略，行为不变", async () => {
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
    })
    const state = initNamedRequirement(engine, "cap_int")
    advanceToPhase(engine, state.requirementId, Phase.RELEASE)

    const after = await engine.runStepCapabilities(state.requirementId, "50.2", "EXPLICIT")
    const step = after.steps.find((s) => s.id === "50.2")!

    expect(step.capabilityRuns).toHaveLength(2)
    expect(step.capabilityRuns?.[0]?.kind).toBe("integration")
    expect(step.capabilityRuns?.[0]?.ok).toBe(false)
    expect(step.capabilityRuns?.[1]?.kind).toBe("heinrich")
  })
})

describe("Integration 能力透传输入", () => {
  /** 记录调用参数的假集成服务 */
  function makeRecordingService(received: unknown[][]) {
    return {
      name: "fakeService",
      healthCheck: async () => ({ success: true, message: "ok" }),
      runOp: async (...args: unknown[]) => {
        received.push(args)
        return { success: true, message: "done" }
      },
    } as unknown as IntegrationService
  }

  it("integration capability 有 input 时 op 收到该 input", async () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const received: unknown[][] = []
    const engine = new WorkflowEngine({
      store,
      integrations: { fakeService: makeRecordingService(received) },
    })
    const state = initNamedRequirement(engine, "cap_int_input")
    const stepId = state.steps[0]!.id
    store.update(state.requirementId, (current) => {
      const step = current.steps.find((item) => item.id === stepId)
      if (step) step.capabilities = [{ kind: "integration", service: "fakeService", op: "runOp" }]
      return current
    })

    await engine.runStepCapabilities(state.requirementId, stepId, "EXPLICIT INPUT")

    expect(received).toEqual([["EXPLICIT INPUT"]])
  })

  it("integration capability 无 input 时不传参（保持零参兼容）", async () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const received: unknown[][] = []
    const engine = new WorkflowEngine({
      store,
      integrations: { fakeService: makeRecordingService(received) },
    })
    const state = initNamedRequirement(engine, "cap_int_zeroarg")
    const stepId = state.steps[0]!.id
    store.update(state.requirementId, (current) => {
      const step = current.steps.find((item) => item.id === stepId)
      if (step) step.capabilities = [{ kind: "integration", service: "fakeService", op: "runOp" }]
      return current
    })

    await engine.runStepCapabilities(state.requirementId, stepId)

    expect(received).toEqual([[]])
  })
})

describe("Checklist 推荐落库", () => {
  it("合法 JSON 新增清单项", async () => {
    const { client } = fakeAIClient(
      '[{"category":"性能","description":"验证缓存命中率"},{"description":"检查日志输出"}]',
    )
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_cl_valid")
    advanceToPhase(engine, state.requirementId, Phase.RELEASE)

    const after = await engine.runStepCapabilities(state.requirementId, "50.3")
    const cl = after.checklists[Phase.RELEASE]!

    expect(cl.items).toHaveLength(2)
    expect(cl.items[0]?.category).toBe("性能")
    expect(cl.items[0]?.description).toBe("验证缓存命中率")
    expect(cl.items[1]?.category).toBe("AI Recommended")
    expect(cl.items[1]?.description).toBe("检查日志输出")
  })

  it("非法 JSON 不破坏状态，并保留能力执行记录", async () => {
    const { client } = fakeAIClient("这不是 JSON")
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: client,
    })
    const state = initNamedRequirement(engine, "cap_cl_invalid")
    advanceToPhase(engine, state.requirementId, Phase.RELEASE)

    const after = await engine.runStepCapabilities(state.requirementId, "50.3")
    const step = after.steps.find((s) => s.id === "50.3")!

    expect(after.checklists[Phase.RELEASE]!.items).toHaveLength(0)
    expect(step.capabilityRuns?.[0]?.kind).toBe("ai")
    expect(step.capabilityRuns?.[0]?.ok).toBe(true)
  })
})

describe("自定义能力", () => {
  it("按 name 分发插件注册的 custom handler", async () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const customHandlers = new Map<string, CapabilityHandler>()
    customHandlers.set("sample.ping", async (ref) => ({
      kind: "custom",
      ref: ref.kind === "custom" ? ref.name : "",
      ok: true,
      summary: "pong",
    }))
    const engine = new WorkflowEngine({
      store,
      pluginHost: {
        plugins: [{ id: "sample", version: "1.0.0" }],
        overlays: [],
        integrations: {},
        customHandlers,
        kindHandlers: new Map(),
      },
    })
    const state = initNamedRequirement(engine, "cap_custom")
    const stepId = state.steps[0]!.id
    store.update(state.requirementId, (current) => {
      const step = current.steps.find((item) => item.id === stepId)
      if (step) step.capabilities = [{ kind: "custom", name: "sample.ping" }]
      return current
    })

    const after = await engine.runStepCapabilities(state.requirementId, stepId)
    const step = after.steps.find((item) => item.id === stepId)!
    expect(step.capabilityRuns?.[0]).toMatchObject({ kind: "custom", ref: "sample.ping", ok: true, summary: "pong" })
  })

  it("未注册的 custom 记为失败且不抛错", async () => {
    const store = createStateStore({ storeDir: testStoreDir })
    const engine = new WorkflowEngine({ store })
    const state = initNamedRequirement(engine, "cap_custom_missing")
    const stepId = state.steps[0]!.id
    store.update(state.requirementId, (current) => {
      const step = current.steps.find((item) => item.id === stepId)
      if (step) step.capabilities = [{ kind: "custom", name: "missing.op" }]
      return current
    })
    const after = await engine.runStepCapabilities(state.requirementId, stepId)
    expect(after.steps.find((item) => item.id === stepId)?.capabilityRuns?.[0]).toMatchObject({
      kind: "custom",
      ok: false,
    })
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
