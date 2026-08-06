/**
 * SQL 风险检测模块 —— AI 检测缺索引、锁表风险、大表全表扫描、不可回滚操作等。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const sqlRiskCheckModule: AIAssistantModule = {
  type: AIAssistantType.SQL_RISK_CHECK,
  name: "SQL 风险检测",
  execute: (input, client) =>
    client.ask({
      system: "你是一个数据库专家。请审查以下 SQL，检测缺索引、锁表风险、大表全表扫描、不可回滚操作等问题。",
      prompt: `请审查以下 SQL：\n\n${input}`,
    }),
}
