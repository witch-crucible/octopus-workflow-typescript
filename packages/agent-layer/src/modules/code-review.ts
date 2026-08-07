/**
 * 智能 Code Review 模块 —— AI 审查代码 diff，输出风险等级和修复建议。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const codeReviewModule: AIAssistantModule = {
  type: AIAssistantType.CODE_REVIEW,
  name: "Code Review",
  execute: (input, client) =>
    client.ask({
      system: "你是一个代码审查专家。请审查代码 diff，找出潜在缺陷、安全问题和性能问题。输出风险等级和修复建议。",
      prompt: `请审查以下代码变更：\n\n${input}`,
    }),
}
