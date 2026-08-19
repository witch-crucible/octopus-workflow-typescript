/**
 * AI 辅助模块契约 —— 每个 AI 能力的最小可独立实现单元。
 *
 * 模块只依赖显式传入的输入文本与客户端，不直接依赖工作流状态或持久化层，
 * 因此可以单独导入、单独执行、单独测试。
 */

import type { AIRequest, AIResponse } from "@octopus/core/agent.js"

/** AI 模块可调用的客户端最小接口（AIClient 结构兼容） */
export interface AIAssistantClient {
  ask(request: AIRequest): Promise<AIResponse>
}

/** AI 辅助模块 */
export interface AIAssistantModule {
  /** 唯一类型标识。内置类型使用 AIAssistantType；插件可注册额外字符串 id。 */
  readonly type: string
  /** 模块名称 */
  readonly name: string
  /** 执行：调用方显式传入输入文本与客户端 */
  execute(input: string, client: AIAssistantClient): Promise<AIResponse>
}
