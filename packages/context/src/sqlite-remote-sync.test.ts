import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const remote = vi.hoisted(() => ({
  queries: [] as string[],
  requests: [] as Array<{ input: string; init: RequestInit | undefined }>,
}))

vi.mock("postgres", () => ({
  default: vi.fn(() => ({
    begin: async (
      callback: (transaction: {
        unsafe: (query: string, parameters?: unknown[]) => Promise<unknown[]>
      }) => unknown,
    ) =>
      callback({
        unsafe: async (query: string, parameters = []) => {
          remote.queries.push(query)
          if (query.startsWith("SELECT value")) return [{ value: "0" }]
          return []
        },
      }),
    end: async () => undefined,
  })),
}))

import { createSqlitePersistenceStore } from "./sqlite-persistence.js"

const roots: string[] = []
const originalCloudBaseDatabaseUrl = process.env["CLOUDBASE_DATABASE_URL"]
const originalCloudBaseEnvId = process.env["CLOUDBASE_ENV_ID"]
const originalCloudBaseApiKey = process.env["CLOUDBASE_APIKEY"]
const originalDatabaseUrl = process.env["DATABASE_URL"]

afterEach(() => {
  remote.queries.length = 0
  remote.requests.length = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (originalCloudBaseDatabaseUrl === undefined) delete process.env["CLOUDBASE_DATABASE_URL"]
  else process.env["CLOUDBASE_DATABASE_URL"] = originalCloudBaseDatabaseUrl
  if (originalCloudBaseEnvId === undefined) delete process.env["CLOUDBASE_ENV_ID"]
  else process.env["CLOUDBASE_ENV_ID"] = originalCloudBaseEnvId
  if (originalCloudBaseApiKey === undefined) delete process.env["CLOUDBASE_APIKEY"]
  else process.env["CLOUDBASE_APIKEY"] = originalCloudBaseApiKey
  if (originalDatabaseUrl === undefined) delete process.env["DATABASE_URL"]
  else process.env["DATABASE_URL"] = originalDatabaseUrl
})

describe("CloudBase PostgreSQL 必要数据同步", () => {
  it("仅替换项目和需求，不访问运行、事件和集成健康表", async () => {
    process.env["CLOUDBASE_ENV_ID"] = "octopus-test-123"
    process.env["CLOUDBASE_APIKEY"] = "secret-service-role-key"
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      remote.requests.push({ input: String(input), init })
      return new Response(JSON.stringify({ snapshot_revision: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    const root = mkdtempSync(join(tmpdir(), "octopus-cloudbase-"))
    roots.push(root)
    const store = await createSqlitePersistenceStore({ storeDir: root })
    const project = await store.createProject("必要数据")
    const requirement = await store.createRequirement(project.projectId, "需求")
    await store.createRun({
      requirementId: requirement.requirementId,
      nodeId: "local-only",
      forced: false,
      stdoutPath: "",
      stderrPath: "",
    })

    const status = await store.syncWithRemote()
    const request = remote.requests[0]
    const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>

    expect(request?.input).toBe(
      "https://octopus-test-123.api.tcloudbasegateway.com/v1/rdb/rest/rpc/capy_replace_octopus_snapshot",
    )
    expect(request?.init?.headers).toMatchObject({
      Authorization: "Bearer secret-service-role-key",
      "Content-Type": "application/json",
    })
    expect(body["p_projects"]).toHaveLength(1)
    expect(body["p_requirements"]).toHaveLength(1)
    expect(body).not.toHaveProperty("p_workflow_runs")
    expect(body).not.toHaveProperty("p_workflow_events")
    expect(body).not.toHaveProperty("p_integration_health")
    expect(body["p_snapshot_scope"]).toBe("projects-and-requirements")
    expect(status.state).toBe("synced")
    expect(status.remoteRevision).toBe(1)
    expect(status.lastSyncedRemoteDataRevision).toBe(status.remoteDataRevision)
    await store.close()
  })

  it("REST RPC 失败时不推进已同步修订且不泄露 API Key", async () => {
    process.env["CLOUDBASE_ENV_ID"] = "octopus-test-123"
    process.env["CLOUDBASE_APIKEY"] = "secret-service-role-key"
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ message: "permission denied" }), { status: 403 }),
    )
    const root = mkdtempSync(join(tmpdir(), "octopus-cloudbase-failure-"))
    roots.push(root)
    const store = await createSqlitePersistenceStore({ storeDir: root })
    await store.createProject("待同步")

    await expect(store.syncWithRemote()).rejects.toThrow("CloudBase PG REST 同步失败")
    const status = await store.getSyncStatus()
    expect(status.state).toBe("error")
    expect(status.lastSyncedRemoteDataRevision).toBe(0)
    expect(status.lastError).not.toContain("secret-service-role-key")
    await store.close()
  })

  it("旧 syncWithSupabase 入口继续委托给通用远端同步", async () => {
    delete process.env["CLOUDBASE_DATABASE_URL"]
    process.env["DATABASE_URL"] = "postgresql://octopus:secret@legacy.example.test:6543/postgres"
    const root = mkdtempSync(join(tmpdir(), "octopus-compatible-sync-"))
    roots.push(root)
    const store = await createSqlitePersistenceStore({ storeDir: root })

    await expect(store.syncWithSupabase()).resolves.toMatchObject({ state: "synced" })
    expect(remote.queries.length).toBeGreaterThan(0)
    await store.close()
  })
})
