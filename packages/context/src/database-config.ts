import { existsSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { config as loadDotenv } from "dotenv"
import { PersistenceError } from "@octopus/core/errors.js"

export interface DatabaseConfigOptions {
  databaseUrl?: string
  storeDir?: string
}

/** 加载本机后端进程的数据库连接串。已有进程环境变量始终优先。 */
export function resolveDatabaseUrl(options: DatabaseConfigOptions = {}): string {
  if (options.databaseUrl) return options.databaseUrl

  if (process.env["NODE_ENV"] !== "production") {
    loadEnvFile(resolve(".env"))
  }
  if (options.storeDir) {
    const absoluteStoreDir = isAbsolute(options.storeDir) ? options.storeDir : resolve(options.storeDir)
    loadEnvFile(join(absoluteStoreDir, ".env"))
  }

  const databaseUrl = process.env["DATABASE_URL"]
  if (!databaseUrl) {
    throw new PersistenceError(
      "DATABASE_UNAVAILABLE",
      "缺少 DATABASE_URL；请在进程环境、仓库根 .env 或状态目录 .env 中配置 PostgreSQL 连接串",
    )
  }
  return databaseUrl
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
