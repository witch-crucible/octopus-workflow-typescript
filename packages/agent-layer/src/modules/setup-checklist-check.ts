/**
 * Setup Checklist 校验模块 —— AI 校验域名、CDN/WAF/SLB/ECS、Nginx、PHP、
 * 支付、Magento 和第三方接口等环境部署配置。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const setupChecklistCheckModule: AIAssistantModule = {
  type: AIAssistantType.SETUP_CHECKLIST_CHECK,
  name: "Setup Checklist 校验",
  execute: (input, client) =>
    client.ask({
      system:
        "你是环境部署配置专家。请根据部署信息校验 Setup Checklist：域名解析、CDN/WAF/SLB/ECS、Nginx、" +
        "PHP、支付、Magento 和第三方接口配置。逐项输出检查结果、缺失项与修正建议。",
      prompt: `请校验以下 Setup 配置清单：\n\n${input}`,
    }),
}
