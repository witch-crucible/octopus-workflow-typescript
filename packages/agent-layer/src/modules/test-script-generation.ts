/**
 * 自动化测试脚本生成模块 —— AI 根据接口资料生成 Postman Collection、
 * 断言和环境变量建议。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const testScriptGenerationModule: AIAssistantModule = {
  type: AIAssistantType.TEST_SCRIPT_GENERATION,
  name: "测试脚本生成",
  execute: (input, client) =>
    client.ask({
      system:
        "你是测试开发专家。请根据接口资料生成自动化测试方案：Postman Collection 结构、断言、环境变量建议。" +
        "输出可直接导入使用的 JSON 与说明。",
      prompt: `请根据以下接口资料生成测试脚本：\n\n${input}`,
    }),
}
