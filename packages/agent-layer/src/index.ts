/**
 * Agent Layer 包 —— AI 代理层。
 *
 * 封装了调用 `claude` CLI 作为 AI 后端的逻辑。
 * 模式与 alka-langgraph 一致：
 * - 默认模式：每次调用新子进程
 * - 支持常驻进程模式（复用进程减少冷启动）
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { AIRequest, AIResponse, AIAssistantType } from "@octopus/core/agent.js"
import { AICallError } from "@octopus/core/errors.js"
import { AgentCallId } from "@octopus/core/branded-ids.js"

const execFileAsync = promisify(execFile)

/** AI 客户端配置 */
export interface AIClientConfig {
  /** 默认模型 */
  defaultModel: string
  /** 默认超时（毫秒） */
  defaultTimeout: number
  /** claude CLI 路径 */
  claudePath: string
  /** 是否启用常驻模式 */
  persistent: boolean
  /** 重试次数 */
  retries: number
  /** 重试间隔（毫秒） */
  retryDelay: number
}

/** 默认配置 */
const DEFAULT_CONFIG: AIClientConfig = {
  defaultModel: "haiku",
  defaultTimeout: 120_000,
  claudePath: "claude",
  persistent: false,
  retries: 2,
  retryDelay: 1000,
}

/** AI 客户端 */
export class AIClient {
  private readonly config: AIClientConfig
  private callCount = 0

  constructor(config?: Partial<AIClientConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /** 基础调用 —— 直接执行 claude -p 子进程（异步 + 重试） */
  async ask(request: AIRequest): Promise<AIResponse> {
    const startTime = Date.now()
    const system = request.system ?? ""
    const model = request.model ?? this.config.defaultModel
    const timeout = request.timeout ?? this.config.defaultTimeout

    const args = [
      "-p",
      "--model",
      model,
      "--strict-mcp-config",
      "--output-format",
      "json",
      "--system-prompt",
      system,
      request.prompt,
    ]

    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const { stdout } = await execFileAsync(this.config.claudePath, args, {
          encoding: "utf-8",
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        })

        const parsed = JSON.parse(stdout) as { result?: string }
        const durationMs = Date.now() - startTime

        return {
          result: parsed.result ?? stdout,
          durationMs,
        }
      } catch (cause) {
        lastError = cause
        if (attempt < this.config.retries) {
          await this.sleep(this.config.retryDelay * (attempt + 1))
        }
      }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError)
    throw new AICallError(`AI 调用失败: ${message}`, lastError)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** 生成 AI 调用记录 */
  createCallRecord(request: AIRequest, response?: AIResponse, error?: string) {
    const now = new Date().toISOString()
    const callId = AgentCallId(`ai_${Date.now()}_${++this.callCount}`)
    return {
      id: callId,
      request,
      response,
      timestamp: now,
      success: !error,
      error,
    }
  }

  // ── 专业助手方法 ──

  /** 需求分析 */
  async analyzeRequirements(prdContent: string): Promise<AIResponse> {
    const system = "你是一个需求分析专家。请根据 PRD 内容分解功能点、评估可行性、识别风险、建议优先级。仅输出分析结果。"
    const prompt = `请分析以下 PRD 内容：\n\n${prdContent}`
    return this.ask({ prompt, system })
  }

  /** 估时提取 */
  async estimateEffort(requirements: string): Promise<AIResponse> {
    const system = "你是一个项目估算专家。请根据功能点列表估算开发工时，每子项不超过 2 小时。输出包含每项估时和汇总。"
    const prompt = `请估算以下功能点：\n\n${requirements}`
    return this.ask({ prompt, system })
  }

  /** Code Review */
  async reviewCode(diff: string): Promise<AIResponse> {
    const system = "你是一个代码审查专家。请审查代码 diff，找出潜在缺陷、安全问题和性能问题。输出风险等级和修复建议。"
    const prompt = `请审查以下代码变更：\n\n${diff}`
    return this.ask({ prompt, system })
  }

  /** SQL 风险检测 */
  async checkSQL(sqlContent: string): Promise<AIResponse> {
    const system = "你是一个数据库专家。请审查以下 SQL，检测缺索引、锁表风险、大表全表扫描、不可回滚操作等问题。"
    const prompt = `请审查以下 SQL：\n\n${sqlContent}`
    return this.ask({ prompt, system })
  }

  /** 会议纪要总结 */
  async summarizeMeeting(transcript: string): Promise<AIResponse> {
    const system = "你是一个会议纪要助手。请从会议录音文字中提取：决策、待办事项、问题、负责人。"
    const prompt = `请总结以下会议内容：\n\n${transcript}`
    return this.ask({ prompt, system })
  }

  /** 技术方案审核 */
  async reviewTechDesign(designDoc: string): Promise<AIResponse> {
    const system = "你是系统架构师。请评审技术方案：架构合理性（评分 1-10）、安全预扫描、性能瓶颈预判、改进建议。"
    const prompt = `请评审以下技术方案：\n\n${designDoc}`
    return this.ask({ prompt, system })
  }

  /** 发布风险评估 */
  async assessReleaseRisk(changeScope: string): Promise<AIResponse> {
    const system = "你是发布经理。请评估此次变更的影响面和回滚风险，分析变更冲突，生成回滚脚本建议。"
    const prompt = `请评估以下变更的发布风险：\n\n${changeScope}`
    return this.ask({ prompt, system })
  }

  /** 技术债务量化 */
  async quantifyTechDebt(metrics: string): Promise<AIResponse> {
    const system = "你是一个技术债务管理专家。请分析代码复杂度趋势、重复率、依赖老化情况，生成还债优先级列表。"
    const prompt = `请分析以下技术指标：\n\n${metrics}`
    return this.ask({ prompt, system })
  }

  /** Checklist 增量推荐 */
  async recommendChecklistItems(changeScope: string): Promise<AIResponse> {
    const system = "你是质量保证专家。请根据变更范围推荐需要新增的 checklist 项，输出 JSON 数组，每项包含 category、description。"
    const prompt = `请为以下变更范围推荐 checklist 项：\n\n${changeScope}`
    return this.ask({ prompt, system })
  }

  /** 根据功能类型选择对应的 AI 辅助调用 */
  async callAssistant(type: AIAssistantType, input: string): Promise<AIResponse> {
    const assistantMethods: Record<string, (input: string) => Promise<AIResponse>> = {
      MEETING_MINUTES: this.summarizeMeeting.bind(this),
      REQUIREMENTS_ANALYSIS: this.analyzeRequirements.bind(this),
      EFFORT_ESTIMATION: this.estimateEffort.bind(this),
      TECH_DESIGN_REVIEW: this.reviewTechDesign.bind(this),
      CODE_REVIEW: this.reviewCode.bind(this),
      SQL_RISK_CHECK: this.checkSQL.bind(this),
      RELEASE_RISK_ASSESSMENT: this.assessReleaseRisk.bind(this),
      TECH_DEBT_QUANTIFICATION: this.quantifyTechDebt.bind(this),
    }

    const method = assistantMethods[type]
    if (!method) {
      return this.ask({ prompt: input, system: "请回答以下问题。" })
    }

    return method(input)
  }
}

/** 创建默认 AIClient 实例 */
export function createAIClient(config?: Partial<AIClientConfig>): AIClient {
  return new AIClient(config)
}
