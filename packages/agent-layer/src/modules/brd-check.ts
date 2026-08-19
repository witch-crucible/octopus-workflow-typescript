/**
 * BRD 检查模块 —— 对照规范与源摘要检查现有 BRD 完善性。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"
import { parseBrdPromptEnvelope } from "./brd-prompt-envelope.js"

const DEFAULT_SYSTEM =
  "你是 BRD 评审专家。请对照规范与上下文检查 BRD 完善性，输出缺口、风险与建议，不要无故重写全文。"

export const brdCheckModule: AIAssistantModule = {
  type: AIAssistantType.BRD_CHECK,
  name: "BRD 检查",
  execute: (input, client) => client.ask(parseBrdPromptEnvelope(input, DEFAULT_SYSTEM)),
}
