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
import { z } from "zod"
import type { AIClientConfig } from "@octopus/agent-layer/index.js"
import { ConfigError } from "@octopus/core/errors.js"
import type { PluginRef } from "@octopus/plugin/index.js"

/** Teambition 集成配置 */
export interface TeambitionConfig {
  appId: string
  appSecret: string
  orgId: string
  /** 写操作默认 operator（x-operator-id） */
  operatorId?: string
  gatewayBase?: string
  refStrategy?: "prefix" | "shortid" | "tql"
  timeoutMs?: number
}

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
  /** Teambition 凭据；缺省时不装配客户端 */
  teambition?: TeambitionConfig
}

/**
 * 配置文件宽松结构校验。只校验已知字段的类型，允许额外字段与缺省字段
 * （zod object 默认 strip 未知键，且所有键都是可选的）。
 */
const pluginRefSchema = z.union([
  z.string(),
  z
    .object({
      id: z.string().optional(),
      path: z.string().optional(),
      package: z.string().optional(),
      enabled: z.boolean().optional(),
      options: z.record(z.unknown()).optional(),
    })
    .refine(
      (value) =>
        value.id !== undefined ||
        value.path !== undefined ||
        value.package !== undefined ||
        value.enabled !== undefined ||
        value.options !== undefined,
      { message: "插件引用对象必须包含至少一个已知字段" },
    ),
])

const configFileSchema = z.object({
  storeDir: z.string().optional(),
  ai: z
    .object({
      defaultModel: z.string().optional(),
      defaultTimeout: z.number().optional(),
      claudePath: z.string().optional(),
      persistent: z.boolean().optional(),
      retries: z.number().optional(),
      retryDelay: z.number().optional(),
    })
    .optional(),
  workflow: z
    .object({
      strictPermissions: z.boolean().optional(),
      aiGatingEnabled: z.boolean().optional(),
      heinrichThreshold: z.number().optional(),
    })
    .optional(),
  plugins: z.array(pluginRefSchema).optional(),
  teambition: z
    .object({
      appId: z.string(),
      appSecret: z.string(),
      orgId: z.string(),
      operatorId: z.string().optional(),
      gatewayBase: z.string().optional(),
      refStrategy: z.enum(["prefix", "shortid", "tql"]).optional(),
      timeoutMs: z.number().optional(),
    })
    .optional(),
})

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

  const tbAppId = process.env["OCTOPUS_TB_APP_ID"]
  const tbAppSecret = process.env["OCTOPUS_TB_APP_SECRET"]
  const tbOrgId = process.env["OCTOPUS_TB_ORG_ID"]
  if (tbAppId || tbAppSecret || tbOrgId || process.env["OCTOPUS_TB_OPERATOR_ID"]) {
    const teambition: TeambitionConfig = {
      appId: tbAppId ?? "",
      appSecret: tbAppSecret ?? "",
      orgId: tbOrgId ?? "",
    }
    if (process.env["OCTOPUS_TB_OPERATOR_ID"]) teambition.operatorId = process.env["OCTOPUS_TB_OPERATOR_ID"]
    if (process.env["OCTOPUS_TB_GATEWAY"]) teambition.gatewayBase = process.env["OCTOPUS_TB_GATEWAY"]
    const refStrategy = process.env["OCTOPUS_TB_REF_STRATEGY"]
    if (refStrategy === "prefix" || refStrategy === "shortid" || refStrategy === "tql") {
      teambition.refStrategy = refStrategy
    }
    config.teambition = teambition
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

  const result = configFileSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ")
    throw new ConfigError(`配置文件 ${configPath} 字段校验失败：${issues}`, configPath)
  }

  return result.data as Partial<OctopusConfig>
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
    if (config.teambition) {
      result = {
        ...result,
        teambition: result.teambition
          ? { ...result.teambition, ...config.teambition }
          : { ...config.teambition },
      }
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
