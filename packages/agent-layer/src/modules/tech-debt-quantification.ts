/**
 * 技术债务量化模块 —— AI 分析代码复杂度、重复率、依赖老化，生成还债优先级列表。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const techDebtQuantificationModule: AIAssistantModule = {
  type: AIAssistantType.TECH_DEBT_QUANTIFICATION,
  name: "技术债务量化",
  execute: (input, client) =>
    client.ask({
      system: "你是一个技术债务管理专家。请分析代码复杂度趋势、重复率、依赖老化情况，生成还债优先级列表。",
      prompt: `请分析以下技术指标：\n\n${input}`,
    }),
}
