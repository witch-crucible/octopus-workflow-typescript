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
  appId?: string
  appSecret?: string
  orgId?: string
  /** 写操作默认 operator（x-operator-id） */
  operatorId?: string
  gatewayBase?: string
  refStrategy?: "prefix" | "shortid" | "tql"
  timeoutMs?: number
  versionManageBase?: string
  sessionCookie?: string
  userAccessToken?: string
  versionAuth?: "auto" | "app-jwt" | "session" | "user-token"
}

/** OmniPlan 集成配置 */
export interface OmniPlanConfig {
  rootDir: string
}

/** 本机身份配置 */
export interface IdentityConfig {
  name: string
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
  /** OmniPlan 配置 */
  omniplan?: OmniPlanConfig
  /** 本机身份 */
  identity?: IdentityConfig
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
      ocrPath: z.string().optional(),
      commandCodePath: z.string().optional(),
      codexPath: z.string().optional(),
      hermesPath: z.string().optional(),
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
      appId: z.string().optional(),
      appSecret: z.string().optional(),
      orgId: z.string().optional(),
      operatorId: z.string().optional(),
      gatewayBase: z.string().optional(),
      refStrategy: z.enum(["prefix", "shortid", "tql"]).optional(),
      timeoutMs: z.number().optional(),
      versionManageBase: z.string().optional(),
      sessionCookie: z.string().optional(),
      userAccessToken: z.string().optional(),
      versionAuth: z.enum(["auto", "app-jwt", "session", "user-token"]).optional(),
    })
    .optional(),
  omniplan: z
    .object({
      rootDir: z.string().optional(),
    })
    .optional(),
  identity: z
    .object({
      name: z.string().optional(),
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
    ocrPath: "ocr",
    commandCodePath: "commandcode",
    codexPath: "codex",
    hermesPath: "hermes",
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
  omniplan: { rootDir: "/Users/ben/Documents/OmniPlan" },
}

/** 从环境变量加载配置 */
function loadFromEnv(aiBase: AIClientConfig = DEFAULT_CONFIG.ai): Partial<OctopusConfig> {
  const config: Partial<OctopusConfig> = {}

  if (process.env["OCTOPUS_STORE_DIR"]) {
    config.storeDir = process.env["OCTOPUS_STORE_DIR"]
  }

  if (
    process.env["OCTOPUS_AI_MODEL"] ||
    process.env["OCTOPUS_AI_TIMEOUT"] ||
    process.env["OCTOPUS_AI_CLAUDE_PATH"] ||
    process.env["OCTOPUS_AI_OCR_PATH"] ||
    process.env["OCTOPUS_AI_COMMANDCODE_PATH"] ||
    process.env["OCTOPUS_AI_CODEX_PATH"] ||
    process.env["OCTOPUS_AI_HERMES_PATH"]
  ) {
    config.ai = { ...aiBase }
    if (process.env["OCTOPUS_AI_MODEL"]) config.ai.defaultModel = process.env["OCTOPUS_AI_MODEL"]
    if (process.env["OCTOPUS_AI_TIMEOUT"]) config.ai.defaultTimeout = Number(process.env["OCTOPUS_AI_TIMEOUT"])
    if (process.env["OCTOPUS_AI_CLAUDE_PATH"]) config.ai.claudePath = process.env["OCTOPUS_AI_CLAUDE_PATH"]
    if (process.env["OCTOPUS_AI_OCR_PATH"]) config.ai.ocrPath = process.env["OCTOPUS_AI_OCR_PATH"]
    if (process.env["OCTOPUS_AI_COMMANDCODE_PATH"]) {
      config.ai.commandCodePath = process.env["OCTOPUS_AI_COMMANDCODE_PATH"]
    }
    if (process.env["OCTOPUS_AI_CODEX_PATH"]) config.ai.codexPath = process.env["OCTOPUS_AI_CODEX_PATH"]
    if (process.env["OCTOPUS_AI_HERMES_PATH"]) config.ai.hermesPath = process.env["OCTOPUS_AI_HERMES_PATH"]
  }

  const teambition: TeambitionConfig = {}
  if (process.env["OCTOPUS_TB_APP_ID"]) teambition.appId = process.env["OCTOPUS_TB_APP_ID"]
  if (process.env["OCTOPUS_TB_APP_SECRET"]) teambition.appSecret = process.env["OCTOPUS_TB_APP_SECRET"]
  if (process.env["OCTOPUS_TB_ORG_ID"]) teambition.orgId = process.env["OCTOPUS_TB_ORG_ID"]
  if (process.env["OCTOPUS_TB_OPERATOR_ID"]) teambition.operatorId = process.env["OCTOPUS_TB_OPERATOR_ID"]
  if (process.env["OCTOPUS_TB_GATEWAY"]) teambition.gatewayBase = process.env["OCTOPUS_TB_GATEWAY"]
  const refStrategy = process.env["OCTOPUS_TB_REF_STRATEGY"]
  if (refStrategy === "prefix" || refStrategy === "shortid" || refStrategy === "tql") {
    teambition.refStrategy = refStrategy
  }
  if (process.env["OCTOPUS_TB_VERSION_BASE"]) teambition.versionManageBase = process.env["OCTOPUS_TB_VERSION_BASE"]
  if (process.env["OCTOPUS_TB_SESSION_COOKIE"]) teambition.sessionCookie = process.env["OCTOPUS_TB_SESSION_COOKIE"]
  if (process.env["OCTOPUS_TB_USER_TOKEN"]) teambition.userAccessToken = process.env["OCTOPUS_TB_USER_TOKEN"]
  const versionAuth = process.env["OCTOPUS_TB_VERSION_AUTH"]
  if (versionAuth === "auto" || versionAuth === "app-jwt" || versionAuth === "session" || versionAuth === "user-token") {
    teambition.versionAuth = versionAuth
  }
  if (Object.keys(teambition).length > 0) config.teambition = teambition

  if (process.env["OCTOPUS_OMNIPLAN_ROOT"]) {
    config.omniplan = { rootDir: process.env["OCTOPUS_OMNIPLAN_ROOT"] }
  }

  const me = process.env["OCTOPUS_ME"]
  if (me && me.trim() !== "") {
    config.identity = { name: me.trim() }
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
    if (config.omniplan) {
      result = {
        ...result,
        omniplan: result.omniplan
          ? { ...result.omniplan, ...config.omniplan }
          : { ...config.omniplan },
      }
    }
    if (config.identity) {
      result = {
        ...result,
        identity: result.identity
          ? { ...result.identity, ...config.identity }
          : { ...config.identity },
      }
    }
  }

  return result
}

/** 加载完整配置 */
export function loadConfig(storeDir?: string): OctopusConfig {
  const fileConfig = loadFromFile(storeDir ?? DEFAULT_CONFIG.storeDir)
  const explicitStoreConfig = storeDir === undefined ? {} : { storeDir }
  const baseConfig = mergeConfigs(fileConfig, explicitStoreConfig)
  const envConfig = loadFromEnv(baseConfig.ai)
  return mergeConfigs(baseConfig, envConfig)
}

/** 读取本机身份：OCTOPUS_ME 环境变量优先，其次配置文件 identity.name；无则 undefined。 */
export function getIdentity(storeDir?: string): string | undefined {
  const config = loadConfig(storeDir)
  const name = config.identity?.name?.trim()
  return name && name !== "" ? name : undefined
}

/** 只补丁 identity 键写入 config.json，禁止重写整个 config 丢掉其它字段；空 name 删除该键。 */
export function saveIdentity(storeDir: string, name: string | null): void {
  const configPath = join(storeDir, "config.json")
  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
  }
  if (name === null || name.trim() === "") {
    delete config["identity"]
  } else {
    config["identity"] = { ...(config["identity"] as Record<string, unknown> | undefined), name: name.trim() }
  }
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
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
