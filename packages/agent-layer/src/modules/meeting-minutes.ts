/**
 * 会议纪要总结模块 —— AI 从录音文字中提取决策、待办、问题、负责人。
 */

import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIAssistantModule } from "./types.js"

export const meetingMinutesModule: AIAssistantModule = {
  type: AIAssistantType.MEETING_MINUTES,
  name: "会议纪要总结",
  execute: (input, client) =>
    client.ask({
      system: "你是一个会议纪要助手。请从会议录音文字中提取：决策、待办事项、问题、负责人。",
      prompt: `请总结以下会议内容：\n\n${input}`,
    }),
}
