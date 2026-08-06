/**
 * 需求分析模块 —— AI 根据 PRD 内容分解功能点、评估可行性、识别风险、建议优先级。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const requirementsAnalysisModule: AIAssistantModule = {
  type: AIAssistantType.REQUIREMENTS_ANALYSIS,
  name: "需求分析",
  execute: (input, client) =>
    client.ask({
      system: "你是一个需求分析专家。请根据 PRD 内容分解功能点、评估可行性、识别风险、建议优先级。仅输出分析结果。",
      prompt: `请分析以下 PRD 内容：\n\n${input}`,
    }),
}
