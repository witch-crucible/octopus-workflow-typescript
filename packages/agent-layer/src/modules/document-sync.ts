/**
 * 技术文档同步模块 —— AI 根据代码或变更内容生成 API、ER 图、架构图等
 * 需要更新的文档建议及产出。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const documentSyncModule: AIAssistantModule = {
  type: AIAssistantType.DOCUMENT_SYNC,
  name: "文档同步",
  execute: (input, client) =>
    client.ask({
      system:
        "你是技术文档维护专家。请根据代码或变更内容，识别需要更新的技术文档（API 文档、ER 图、架构图等），" +
        "输出更新建议及更新后的文档内容。",
      prompt: `请根据以下代码/变更内容分析需要同步的文档：\n\n${input}`,
    }),
}
