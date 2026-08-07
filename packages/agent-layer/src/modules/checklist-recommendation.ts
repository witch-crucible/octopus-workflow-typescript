/**
 * Checklist 增量推荐模块 —— AI 根据变更范围推荐新增 checklist 项。
 * 输出 JSON 数组（category / description），供工作流解析后写入清单。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const checklistRecommendationModule: AIAssistantModule = {
  type: AIAssistantType.CHECKLIST_RECOMMENDATION,
  name: "Checklist 增量推荐",
  execute: (input, client) =>
    client.ask({
      system: "你是质量保证专家。请根据变更范围推荐需要新增的 checklist 项，输出 JSON 数组，每项包含 category、description。",
      prompt: `请为以下变更范围推荐 checklist 项：\n\n${input}`,
    }),
}
