/**
 * Config 包 —— 全局配置管理。
 *
 * 配置来源优先级（从高到低）：
 *  1. 环境变量（OCTOPUS_*）
 *  2. 调用方显式状态目录
 *  3. JSON 配置文件（.octo/config.json）
 *  4. 默认值
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AIClientConfig } from "@octopus/agent-layer/index.js"
import { ConfigError } from "@octopus/core/errors.js"
import type { PluginRef } from "@octopus/plugin/index.js"

/** 全局配置 */
export interface OctopusConfig {
  /** 状态存储目录 */
  storeDir: string
  /** AI 配置 */
  ai: AIClientConfig
  /** 工作流引擎配置 */
  workflow: {
    /** 是否启用严格权限校验 */
    strictPermissions: boolean
    /** AI 门控开关 */
    aiGatingEnabled: boolean
    /** 海因里希条数阈值 */
    heinrichThreshold: number
  }
  /** 本机插件引用；与 workflow.yaml plugins 按顺序拼接 */
  plugins: PluginRef[]
}

/** 默认配置 */
export const DEFAULT_CONFIG: OctopusConfig = {
  storeDir: ".octo",
  ai: {
    defaultModel: "haiku",
    defaultTimeout: 120_000,
    claudePath: "claude",
    persistent: false,
    retries: 2,
    retryDelay: 1000,
  },
  workflow: {
    strictPermissions: false,
    aiGatingEnabled: false,
    heinrichThreshold: 3,
  },
  plugins: [],
}

/** 从环境变量加载配置 */
function loadFromEnv(): Partial<OctopusConfig> {
  const config: Partial<OctopusConfig> = {}

  if (process.env["OCTOPUS_STORE_DIR"]) {
    config.storeDir = process.env["OCTOPUS_STORE_DIR"]
  }

  if (process.env["OCTOPUS_AI_MODEL"] || process.env["OCTOPUS_AI_TIMEOUT"] || process.env["OCTOPUS_AI_CLAUDE_PATH"]) {
    config.ai = { ...DEFAULT_CONFIG.ai }
    if (process.env["OCTOPUS_AI_MODEL"]) config.ai.defaultModel = process.env["OCTOPUS_AI_MODEL"]
    if (process.env["OCTOPUS_AI_TIMEOUT"]) config.ai.defaultTimeout = Number(process.env["OCTOPUS_AI_TIMEOUT"])
    if (process.env["OCTOPUS_AI_CLAUDE_PATH"]) config.ai.claudePath = process.env["OCTOPUS_AI_CLAUDE_PATH"]
  }

  return config
}

/** 从 JSON 文件加载配置 */
function loadFromFile(storeDir: string): Partial<OctopusConfig> {
  const configPath = join(storeDir, "config.json")
  if (!existsSync(configPath)) {
    return {}
  }

  let parsed: unknown
  try {
    const raw = readFileSync(configPath, "utf-8")
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new ConfigError(`无法解析配置文件 ${configPath}`, configPath, cause)
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(`配置文件 ${configPath} 顶层必须是对象`, configPath)
  }

  return parsed as Partial<OctopusConfig>
}

/** 合并配置 */
function mergeConfigs(...configs: Partial<OctopusConfig>[]): OctopusConfig {
  let result = { ...DEFAULT_CONFIG }

  for (const config of configs) {
    if (config.storeDir) {
      result = { ...result, storeDir: config.storeDir }
    }
    if (config.ai) {
      result = { ...result, ai: { ...result.ai, ...config.ai } }
    }
    if (config.workflow) {
      result = { ...result, workflow: { ...result.workflow, ...config.workflow } }
    }
    if (config.plugins) {
      result = { ...result, plugins: [...config.plugins] }
    }
  }

  return result
}

/** 加载完整配置 */
export function loadConfig(storeDir?: string): OctopusConfig {
  const fileConfig = loadFromFile(storeDir ?? DEFAULT_CONFIG.storeDir)
  const envConfig = loadFromEnv()
  const explicitStoreConfig = storeDir === undefined ? {} : { storeDir }
  return mergeConfigs(fileConfig, explicitStoreConfig, envConfig)
}

/** 保存配置到文件 */
export function saveConfig(config: OctopusConfig, storeDir?: string): void {
  const targetDir = storeDir ?? config.storeDir
  const configPath = join(targetDir, "config.json")

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true })
  }

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
  } catch (cause) {
    throw new ConfigError(`无法写入配置 ${configPath}`, configPath, cause)
  }
}

/** 将 OctopusConfig 转换为 AIClient 配置 */
export function toAIClientConfig(config: OctopusConfig): AIClientConfig {
  return { ...config.ai }
}
