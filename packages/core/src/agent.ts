/**
 * AI Agent 接口 —— 定义与 AI 助手交互的类型。
 *
 * 与 alka-langgraph 的模式一致：通过 CLI 子进程调用 `claude -p`，
 * 支持一次性调用和常驻会话模式。
 */

import type { AgentCallId } from "./branded-ids.js"
import type { WorkflowState } from "./workflow.js"
import { Phase } from "./phase.js"

/** AI 请求参数 */
export interface AIRequest {
  /** 提示词 */
  prompt: string
  /** 系统提示词（可选） */
  system?: string
  /** 模型名称（默认 haiku） */
  model?: string
  /** 超时时间（毫秒，默认 120000） */
  timeout?: number
}

/** AI 响应 */
export interface AIResponse {
  /** 响应文本 */
  result: string
  /** 会话 ID（常驻模式时可用） */
  sessionId?: string
  /** 调用耗时（毫秒） */
  durationMs?: number
}

/** AI 调用记录 */
export interface AgentCallRecord {
  /** 调用 ID */
  id: AgentCallId
  /** 请求参数 */
  request: AIRequest
  /** 响应 */
  response?: AIResponse
  /** 调用时间 */
  timestamp: string
  /** 是否成功 */
  success: boolean
  /** 错误信息 */
  error?: string
}

/** AI 助手标识。内置 12 类见 `AIAssistantType`；插件可注册额外字符串 id。 */
export type AssistantId = string

/** AI 辅助功能类型枚举 —— 映射 PlantUML 中的 AI 介入点 */
export enum AIAssistantType {
  /** 会议纪要 */
  MEETING_MINUTES = "MEETING_MINUTES",
  /** 需求分析 */
  REQUIREMENTS_ANALYSIS = "REQUIREMENTS_ANALYSIS",
  /** 估时提取 */
  EFFORT_ESTIMATION = "EFFORT_ESTIMATION",
  /** 技术方案审核 */
  TECH_DESIGN_REVIEW = "TECH_DESIGN_REVIEW",
  /** Code Review */
  CODE_REVIEW = "CODE_REVIEW",
  /** SQL 风险检测 */
  SQL_RISK_CHECK = "SQL_RISK_CHECK",
  /** 测试脚本生成 */
  TEST_SCRIPT_GENERATION = "TEST_SCRIPT_GENERATION",
  /** 文档同步 */
  DOCUMENT_SYNC = "DOCUMENT_SYNC",
  /** 发布风险评估 */
  RELEASE_RISK_ASSESSMENT = "RELEASE_RISK_ASSESSMENT",
  /** 技术债务量化 */
  TECH_DEBT_QUANTIFICATION = "TECH_DEBT_QUANTIFICATION",
  /** Setup Checklist 校验 */
  SETUP_CHECKLIST_CHECK = "SETUP_CHECKLIST_CHECK",
  /** Checklist 增量推荐 */
  CHECKLIST_RECOMMENDATION = "CHECKLIST_RECOMMENDATION",
}

/** AI 辅助功能标签映射 */
export const AI_ASSISTANT_LABELS: Record<AIAssistantType, string> = {
  [AIAssistantType.MEETING_MINUTES]: "会议纪要总结",
  [AIAssistantType.REQUIREMENTS_ANALYSIS]: "需求分析",
  [AIAssistantType.EFFORT_ESTIMATION]: "估时提取",
  [AIAssistantType.TECH_DESIGN_REVIEW]: "技术方案审核",
  [AIAssistantType.CODE_REVIEW]: "Code Review",
  [AIAssistantType.SQL_RISK_CHECK]: "SQL 风险检测",
  [AIAssistantType.TEST_SCRIPT_GENERATION]: "测试脚本生成",
  [AIAssistantType.DOCUMENT_SYNC]: "文档同步",
  [AIAssistantType.RELEASE_RISK_ASSESSMENT]: "发布风险评估",
  [AIAssistantType.TECH_DEBT_QUANTIFICATION]: "技术债务量化",
  [AIAssistantType.SETUP_CHECKLIST_CHECK]: "Setup Checklist 校验",
  [AIAssistantType.CHECKLIST_RECOMMENDATION]: "Checklist 增量推荐",
}

/** AI 门控事件类型 */
export type AIEventType = "onPhaseAdvance" | "onPhaseRollback"

/** AI 门控事件载荷 */
export interface AIEventPayload {
  type: AIEventType
  from: Phase
  to: Phase
  state: WorkflowState
}

/** AI 门控处理器返回值 */
export interface AIGateResult {
  allowed: boolean
  reason?: string
}

/** AI 门控处理器类型 */
export type AIEventHandler = (payload: AIEventPayload) => Promise<AIGateResult> | AIGateResult
