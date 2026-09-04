import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { PersistenceError } from "@octopus/core/errors.js"
import { config as loadDotenv } from "dotenv"

export interface DatabaseConfigOptions {
  databaseUrl?: string
  storeDir?: string
}

export interface CloudBasePgRestConfig {
  apiKey: string
  baseUrl: string
  envId: string
}

/** 加载本机后端进程的远端 PostgreSQL 连接串。已有进程环境变量始终优先。 */
export function resolveDatabaseUrl(options: DatabaseConfigOptions = {}): string {
  if (options.databaseUrl) return options.databaseUrl

  loadDatabaseEnv(options.storeDir)

  const databaseUrl = process.env["CLOUDBASE_DATABASE_URL"] ?? process.env["DATABASE_URL"]
  if (!databaseUrl) {
    throw new PersistenceError(
      "DATABASE_UNAVAILABLE",
      "缺少 CLOUDBASE_DATABASE_URL 或 DATABASE_URL；请在进程环境、仓库根 .env 或状态目录 .env 中配置 PostgreSQL 连接串",
    )
  }
  return databaseUrl
}

/** 加载 CloudBase 专用连接串，不回退到旧供应商的 DATABASE_URL。 */
export function resolveCloudBaseDatabaseUrl(
  options: Pick<DatabaseConfigOptions, "storeDir"> = {},
): string {
  loadDatabaseEnv(options.storeDir)
  const databaseUrl = process.env["CLOUDBASE_DATABASE_URL"]
  if (!databaseUrl) {
    throw new PersistenceError(
      "DATABASE_UNAVAILABLE",
      "缺少 CLOUDBASE_DATABASE_URL；为避免误写旧远端数据库，CloudBase 同步不会回退到 DATABASE_URL",
    )
  }
  return databaseUrl
}

/** 加载 CloudBase PG 模式的 PostgREST 后端配置。API Key 必须对应 service_role。 */
export function resolveCloudBasePgRestConfig(
  options: Pick<DatabaseConfigOptions, "storeDir"> = {},
): CloudBasePgRestConfig {
  loadDatabaseEnv(options.storeDir)
  const envId = process.env["CLOUDBASE_ENV_ID"]?.trim()
  const apiKey = process.env["CLOUDBASE_APIKEY"]?.trim()
  if (!envId || !apiKey) {
    throw new PersistenceError(
      "DATABASE_UNAVAILABLE",
      "缺少 CLOUDBASE_ENV_ID 或 CLOUDBASE_APIKEY；CloudBase PG REST 同步需要环境 ID 和后端 API Key",
    )
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(envId)) {
    throw new PersistenceError("DATABASE_UNAVAILABLE", "CLOUDBASE_ENV_ID 格式无效")
  }
  return {
    envId,
    apiKey,
    baseUrl: `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest`,
  }
}

function loadDatabaseEnv(storeDir?: string): void {
  if (process.env["NODE_ENV"] !== "production") {
    loadEnvFile(resolve(".env"))
  }
  if (storeDir) {
    const absoluteStoreDir = isAbsolute(storeDir) ? storeDir : resolve(storeDir)
    loadEnvFile(join(absoluteStoreDir, ".env"))
  }
}

/** 只返回安全的主机、端口和数据库名，绝不包含用户名、密码或查询参数。 */
export function describeDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl)
    const port = parsed.port || "5432"
    const database = parsed.pathname.replace(/^\//, "") || "postgres"
    return `${parsed.hostname}:${port}/${database}`
  } catch {
    return "无效数据库地址"
  }
}

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return
  loadDotenv({ path, override: false, quiet: true })
}
