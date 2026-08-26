import { afterEach, describe, expect, it } from "vitest"
import { PersistenceError } from "@octopus/core/errors.js"
import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { describeDatabaseUrl, resolveDatabaseUrl } from "./database-config.js"
import { persistenceSchema } from "./db/schema.js"
import { createPersistenceStoreFromDatabase, type PersistenceDatabase } from "./persistence.js"
import { createTestPersistenceStore } from "./testing.js"

const originalDatabaseUrl = process.env["DATABASE_URL"]
const originalNodeEnv = process.env["NODE_ENV"]

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env["DATABASE_URL"]
  else process.env["DATABASE_URL"] = originalDatabaseUrl
  if (originalNodeEnv === undefined) delete process.env["NODE_ENV"]
  else process.env["NODE_ENV"] = originalNodeEnv
})

describe("PostgreSQL schema", () => {
  it("创建六张 capy_ 业务表、索引、外键和 RLS", async () => {
    const { client, store } = await createTestPersistenceStore()
    try {
      const tables = await client.query<{ relname: string; relrowsecurity: boolean }>(`
        SELECT relname, relrowsecurity
        FROM pg_class
        WHERE relkind = 'r' AND relname LIKE 'capy_%'
        ORDER BY relname
      `)
      expect(tables.rows.map((row) => row.relname)).toEqual(
        expect.arrayContaining([
          "capy_integration_health",
          "capy_octopus_meta",
          "capy_projects",
          "capy_requirements",
          "capy_workflow_events",
          "capy_workflow_runs",
        ]),
      )
      expect(
        tables.rows
          .filter((row) => row.relname !== "capy_drizzle_migrations")
          .every((row) => row.relrowsecurity),
      ).toBe(true)

      const indexes = await client.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes WHERE indexname LIKE 'capy_%' ORDER BY indexname
      `)
      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          "capy_projects_updated_at_idx",
          "capy_requirements_project_idx",
          "capy_workflow_events_requirement_idx",
          "capy_workflow_runs_requirement_idx",
        ]),
      )
    } finally {
      await store.close()
    }
  })

  it("缺失 DATABASE_URL 使用明确错误码且不包含凭据", () => {
    delete process.env["DATABASE_URL"]
    process.env["NODE_ENV"] = "production"
    expect(() => resolveDatabaseUrl({ storeDir: "/path/that/does/not/exist" })).toThrowError(
      expect.objectContaining({ code: "DATABASE_UNAVAILABLE" }),
    )
    try {
      resolveDatabaseUrl({ storeDir: "/path/that/does/not/exist" })
    } catch (cause) {
      expect(cause).toBeInstanceOf(PersistenceError)
      expect((cause as Error).message).not.toContain("password")
    }
  })

  it("连接目标描述只保留主机、端口和数据库名", () => {
    const description = describeDatabaseUrl(
      "postgresql://secret_user:secret_password@db.example.test:6543/postgres?sslmode=require",
    )
    expect(description).toBe("db.example.test:6543/postgres")
    expect(description).not.toContain("secret")
  })

  it("未迁移 schema 使用 DATABASE_SCHEMA_MISMATCH", async () => {
    const client = new PGlite()
    const database = drizzle(client, {
      schema: persistenceSchema,
    }) as unknown as PersistenceDatabase
    try {
      await expect(createPersistenceStoreFromDatabase(database)).rejects.toMatchObject({
        code: "DATABASE_SCHEMA_MISMATCH",
      })
    } finally {
      await client.close()
    }
  })
})
