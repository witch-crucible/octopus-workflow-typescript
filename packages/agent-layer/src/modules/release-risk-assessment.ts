/**
 * 发布风险预评估模块 —— AI 评估变更影响面、回滚风险与变更冲突。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const releaseRiskAssessmentModule: AIAssistantModule = {
  type: AIAssistantType.RELEASE_RISK_ASSESSMENT,
  name: "发布风险评估",
  execute: (input, client) =>
    client.ask({
      system: "你是发布经理。请评估此次变更的影响面和回滚风险，分析变更冲突，生成回滚脚本建议。",
      prompt: `请评估以下变更的发布风险：\n\n${input}`,
    }),
}
