/**
 * Agent Layer 包 —— AI 代理层。
 *
 * 封装了调用 `claude` CLI 作为 AI 后端的逻辑。
 * 模式与 alka-langgraph 一致：
 * - 默认模式：每次调用新子进程
 * - 支持常驻进程模式（复用进程减少冷启动）
 */

import { spawn } from "node:child_process"
import { AIAssistantType } from "@octopus/core/agent.js"
import type { AIRequest, AIResponse } from "@octopus/core/agent.js"
import { AICallError } from "@octopus/core/errors.js"
import { AgentCallId } from "@octopus/core/branded-ids.js"
import { executeAIAssistantModule } from "./modules/registry.js"

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

  /** 基础调用 —— 通过 stdin 执行 claude -p 子进程（异步 + 重试，避免大型 prompt 超出 argv 上限） */
  async ask(request: AIRequest): Promise<AIResponse> {
    const startTime = Date.now()
    const system = request.system ?? ""
    const model = request.model ?? this.config.defaultModel
    const timeout = request.timeout ?? this.config.defaultTimeout
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
      throw new AICallError("AI 调用超时必须是 0 至 2147483647ms 的整数")
    }
    if (!Number.isSafeInteger(this.config.retryDelay) || this.config.retryDelay < 0 || this.config.retryDelay > 2_147_483_647) {
      throw new AICallError("AI 重试间隔必须是 0 至 2147483647ms 的整数")
    }
    if (!Number.isSafeInteger(this.config.retries) || this.config.retries < 0) {
      throw new AICallError("AI 重试次数必须是非负整数")
    }
    if (this.config.retryDelay * Math.max(1, this.config.retries) > 2_147_483_647) {
      throw new AICallError("AI 重试退避时间超过 Node 定时器上限")
    }

    const args = [
      "-p",
      "--model",
      model,
      "--strict-mcp-config",
      "--output-format",
      "json",
      "--system-prompt",
      system,
    ]

    let lastError: unknown
    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const stdout = await this.executeClaude(args, request.prompt, timeout)

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

  private executeClaude(args: readonly string[], prompt: string, timeout: number): Promise<string> {
    const maxBuffer = 10 * 1024 * 1024
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.claudePath, args, { stdio: ["pipe", "pipe", "pipe"] })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutLength = 0
      let stderrLength = 0
      let settled = false
      let terminationError: Error | undefined
      let timer: NodeJS.Timeout | undefined
      const finish = (error?: Error, output?: string): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (error) reject(error)
        else resolve(output ?? "")
      }
      const append = (chunks: Buffer[], chunk: Buffer, currentLength: number): number => {
        const nextLength = currentLength + chunk.length
        if (nextLength > maxBuffer) {
          if (!terminationError) {
            terminationError = new Error(`claude 输出超过 ${maxBuffer} 字节`)
            child.kill("SIGKILL")
          }
          return currentLength
        }
        chunks.push(chunk)
        return nextLength
      }
      if (timeout > 0) {
        timer = setTimeout(() => {
          terminationError = new Error(`claude 调用超时（${timeout}ms）`)
          child.kill("SIGKILL")
        }, timeout)
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutLength = append(stdout, chunk, stdoutLength)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderrLength = append(stderr, chunk, stderrLength)
      })
      child.once("error", (error) => finish(error))
      child.once("spawn", () => {
        if (!terminationError) child.stdin.end(prompt)
      })
      child.once("close", (code, signal) => {
        if (terminationError) {
          finish(terminationError)
          return
        }
        const output = Buffer.concat(stdout).toString("utf-8")
        if (code === 0) {
          finish(undefined, output)
          return
        }
        const detail = Buffer.concat(stderr).toString("utf-8").trim()
        finish(new Error(`claude 退出失败（${signal ?? code ?? "unknown"}）${detail ? `: ${detail}` : ""}`))
      })
      child.stdin.once("error", (error) => finish(error))
    })
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

  // ── 专业助手方法（委托给模块注册表中的对应模块）──

  /** 需求分析 */
  async analyzeRequirements(prdContent: string): Promise<AIResponse> {
    return this.callAssistant(AIAssistantType.REQUIREMENTS_ANALYSIS, prdContent)
  }

  /** 估时提取 */
  async estimateEffort(requirements: string): Promise<AIResponse> {
    return this.callAssistant(AIAssistantType.EFFORT_ESTIMATION, requirements)
  }

  /** Code Review */
  async reviewCode(diff: string): Promise<AIResponse> {
    return this.callAssistant(AIAssistantType.CODE_REVIEW, diff)
  }

  /** SQL 风险检测 */
  async checkSQL(sqlContent: string): Promise<AIResponse> {
    return this.callAssistant(AIAssistantType.SQL_RISK_CHECK, sqlContent)
  }

  /** 会议纪要总结 */
  async summarizeMeeting(transcript: string): Promise<AIResponse> {
    return this.callAssistant(AIAssistantType.MEETING_MINUTES, transcript)
  }

  /** 技术方案审核 */
  async reviewTechDesign(designDoc: string): Promise<AIResponse> {
    return this.callAssistant(AIAssistantType.TECH_DESIGN_REVIEW, designDoc)
  }

  /** 发布风险评估 */
  async assessReleaseRisk(changeScope: string): Promise<AIResponse> {
    return this.callAssistant(AIAssistantType.RELEASE_RISK_ASSESSMENT, changeScope)
  }

  /** 技术债务量化 */
  async quantifyTechDebt(metrics: string): Promise<AIResponse> {
    return this.callAssistant(AIAssistantType.TECH_DEBT_QUANTIFICATION, metrics)
  }

  /** Checklist 增量推荐 */
  async recommendChecklistItems(changeScope: string): Promise<AIResponse> {
    return this.callAssistant(AIAssistantType.CHECKLIST_RECOMMENDATION, changeScope)
  }

  /** 根据功能类型从模块注册表查找并执行对应 AI 模块 */
  async callAssistant(type: string, input: string): Promise<AIResponse> {
    return executeAIAssistantModule(type, input, this)
  }
}

/** 创建默认 AIClient 实例 */
export function createAIClient(config?: Partial<AIClientConfig>): AIClient {
  return new AIClient(config)
}

// ── AI 辅助模块 API ──

export type { AIAssistantModule, AIAssistantClient } from "./modules/types.js"
export {
  AIAssistantModuleRegistry,
  aiAssistantModuleRegistry,
  getAIAssistantModule,
  executeAIAssistantModule,
} from "./modules/registry.js"
