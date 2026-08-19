/**
 * BRD 生成模块 —— 根据规范、需求与项目源摘要生成商业需求文档。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"
import { parseBrdPromptEnvelope } from "./brd-prompt-envelope.js"

const DEFAULT_SYSTEM =
  "你是资深产品经理（PM）。请根据输入撰写完整的商业需求文档（BRD），输出 Markdown。"

export const brdGenerateModule: AIAssistantModule = {
  type: AIAssistantType.BRD_GENERATE,
  name: "BRD 生成",
  execute: (input, client) => client.ask(parseBrdPromptEnvelope(input, DEFAULT_SYSTEM)),
}
