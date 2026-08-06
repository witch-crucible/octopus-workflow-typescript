/**
 * PRD 工时提取模块 —— AI 从估时明细中汇总开发工时。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const effortEstimationModule: AIAssistantModule = {
  type: AIAssistantType.EFFORT_ESTIMATION,
  name: "估时提取",
  execute: (input, client) =>
    client.ask({
      system: "你是一个项目估算专家。请根据功能点列表估算开发工时，每子项不超过 2 小时。输出包含每项估时和汇总。",
      prompt: `请估算以下功能点：\n\n${input}`,
    }),
}
