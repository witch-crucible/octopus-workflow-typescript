import { defineConfig } from "drizzle-kit"
import "dotenv/config"

const databaseUrl =
  process.env["CLOUDBASE_MIGRATION_URL"] ??
  process.env["CLOUDBASE_DATABASE_URL"] ??
  process.env["DATABASE_MIGRATION_URL"] ??
  process.env["DATABASE_URL"]

if (!databaseUrl) {
  throw new Error(
    "缺少 CLOUDBASE_MIGRATION_URL、CLOUDBASE_DATABASE_URL、DATABASE_MIGRATION_URL 或 DATABASE_URL，无法运行数据库迁移",
  )
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/context/src/db/schema.ts",
  out: "./drizzle",
  migrations: {
    table: "capy_drizzle_migrations",
    schema: "public",
  },
  dbCredentials: { url: databaseUrl },
})
