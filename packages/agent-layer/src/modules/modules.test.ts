/**
 * AI 辅助模块与注册表单元测试。
 *
 * 使用记录请求的假客户端，不调用真实 Claude CLI、不访问网络。
 */

import { describe, it, expect } from "vitest"
import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIRequest, AIResponse } from "@octopus/core/agent.js"
import { AICallError } from "@octopus/core/errors.js"
import {
  AIAssistantModuleRegistry,
  aiAssistantModuleRegistry,
  executeAIAssistantModule,
  getAIAssistantModule,
} from "./registry.js"
import { meetingMinutesModule } from "./meeting-minutes.js"
import type { AIAssistantClient } from "./types.js"

const ALL_TYPES = Object.values(AIAssistantType)

/** 记录 ask 请求的假客户端（不调用 Claude CLI） */
function recordingClient(): { client: AIAssistantClient; requests: AIRequest[] } {
  const requests: AIRequest[] = []
  const client: AIAssistantClient = {
    ask: async (request: AIRequest): Promise<AIResponse> => {
      requests.push(request)
      return { result: "ok" }
    },
  }
  return { client, requests }
}

describe("AIAssistantModuleRegistry", () => {
  it("12 个枚举值与注册项一一对应，无遗漏、无重复", () => {
    expect(ALL_TYPES).toHaveLength(12)
    const registered = aiAssistantModuleRegistry.list()
    expect(registered).toHaveLength(12)
    expect(new Set(registered.map((m) => m.type))).toEqual(new Set(ALL_TYPES))
    for (const type of ALL_TYPES) {
      expect(aiAssistantModuleRegistry.get(type).type).toBe(type)
    }
  })

  it("重复注册视为开发错误", () => {
    const registry = new AIAssistantModuleRegistry()
    registry.register(meetingMinutesModule)
    expect(() => registry.register(meetingMinutesModule)).toThrow(/重复注册/)
  })

  it("未注册类型视为开发错误，不再走通用提示词", () => {
    expect(() => getAIAssistantModule("UNKNOWN_TYPE" as AIAssistantType)).toThrow(/AI 模块未注册/)
  })

  it("execute 独立执行并返回 AIResponse", async () => {
    const { client, requests } = recordingClient()
    const res = await executeAIAssistantModule(AIAssistantType.CODE_REVIEW, "diff 原文", client)
    expect(res.result).toBe("ok")
    expect(requests).toHaveLength(1)
  })
})

describe("各 AI 模块", () => {
  it.each(ALL_TYPES)("模块 %s：生成对应领域提示词，显式输入原样传入", async (type) => {
    const { client, requests } = recordingClient()
    await getAIAssistantModule(type).execute("显式输入原文", client)

    expect(requests).toHaveLength(1)
    expect(requests[0]!.system).toBeTruthy()
    expect(requests[0]!.prompt).toContain("显式输入原文")
  })

  it("全部模块使用领域专属 system prompt（非通用兜底，且互不相同）", async () => {
    const systems = new Set<string>()
    for (const type of ALL_TYPES) {
      const { client, requests } = recordingClient()
      await executeAIAssistantModule(type, "x", client)
      const system = requests[0]!.system ?? ""
      expect(system).not.toBe("请回答以下问题。")
      systems.add(system)
    }
    expect(systems.size).toBe(12)
  })

  it("底层调用异常按 AICallError 类型传播", async () => {
    const failingClient: AIAssistantClient = {
      ask: async (): Promise<AIResponse> => {
        throw new AICallError("模拟失败")
      },
    }
    for (const type of ALL_TYPES) {
      await expect(executeAIAssistantModule(type, "x", failingClient)).rejects.toBeInstanceOf(AICallError)
    }
  })
})
