/**
 * 技术方案审核模块 —— AI 评审架构合理性、安全漏洞预扫描、性能瓶颈预判。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const techDesignReviewModule: AIAssistantModule = {
  type: AIAssistantType.TECH_DESIGN_REVIEW,
  name: "技术方案审核",
  execute: (input, client) =>
    client.ask({
      system: "你是系统架构师。请评审技术方案：架构合理性（评分 1-10）、安全预扫描、性能瓶颈预判、改进建议。",
      prompt: `请评审以下技术方案：\n\n${input}`,
    }),
}
