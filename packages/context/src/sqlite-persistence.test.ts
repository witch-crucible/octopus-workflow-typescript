import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createSqlitePersistenceStore } from "./sqlite-persistence.js"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("本地 octopus.sqlite 主库", () => {
  it("固定文件名并在没有 DATABASE_URL 时完成项目、需求和运行状态写入", async () => {
    delete process.env["DATABASE_URL"]
    const root = mkdtempSync(join(tmpdir(), "octopus-local-"))
    roots.push(root)
    const store = await createSqlitePersistenceStore({ storeDir: root })
    const project = await store.createProject("本地项目")
    const requirement = await store.createRequirement(project.projectId, "本地需求")
    const run = await store.createRun({
      requirementId: requirement.requirementId,
      nodeId: "plan",
      forced: false,
      stdoutPath: join(root, "stdout.log"),
      stderrPath: join(root, "stderr.log"),
    })
    const event = await store.appendEvent({
      requirementId: requirement.requirementId,
      runId: run.id,
      nodeId: "plan",
      type: "RUN_QUEUED",
      payload: { ok: true },
      createdAt: new Date().toISOString(),
    })

    expect(existsSync(join(root, "octopus.sqlite"))).toBe(true)
    expect(existsSync(join(root, "state.sqlite"))).toBe(false)
    expect(event.sequence).toBe(1)
    expect(await store.listProjects()).toEqual([project.projectId])
    expect(await store.listRequirements(project.projectId)).toEqual([requirement.requirementId])
    const status = await store.getSyncStatus()
    expect(status.state).toBe("pending")
    expect(status.localRevision).toBeGreaterThanOrEqual(4)
    expect(status.remoteDataRevision).toBe(2)
    expect(status.lastSyncedRemoteDataRevision).toBe(0)
    await store.close()
  })

  it("运行、事件和健康状态仅增加本地修订，不增加远端必要数据修订", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-local-only-"))
    roots.push(root)
    const store = await createSqlitePersistenceStore({ storeDir: root })
    const project = await store.createProject("项目")
    const requirement = await store.createRequirement(project.projectId, "需求")
    const before = await store.getSyncStatus()
    const run = await store.createRun({
      requirementId: requirement.requirementId,
      nodeId: "plan",
      forced: false,
      stdoutPath: "",
      stderrPath: "",
    })
    await store.appendEvent({
      requirementId: requirement.requirementId,
      runId: run.id,
      type: "RUN_QUEUED",
      payload: {},
      createdAt: new Date().toISOString(),
    })
    await store.saveIntegrationHealth({
      service: "local",
      healthy: true,
      latencyMs: 1,
      message: "ok",
      checkedAt: new Date().toISOString(),
    })
    const after = await store.getSyncStatus()

    expect(after.localRevision).toBe(before.localRevision + 3)
    expect(after.remoteDataRevision).toBe(before.remoteDataRevision)
    await store.close()
  })

  it("删除项目级联删除需求、运行和事件", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-cascade-"))
    roots.push(root)
    const store = await createSqlitePersistenceStore({ storeDir: root })
    const project = await store.createProject("项目")
    const requirement = await store.createRequirement(project.projectId, "需求")
    const run = await store.createRun({
      requirementId: requirement.requirementId,
      nodeId: "x",
      forced: false,
      stdoutPath: "",
      stderrPath: "",
    })
    await store.appendEvent({
      requirementId: requirement.requirementId,
      runId: run.id,
      type: "RUN_QUEUED",
      payload: {},
      createdAt: new Date().toISOString(),
    })
    await store.deleteProject(project.projectId)
    expect(await store.listProjects()).toEqual([])
    expect(await store.listRequirements()).toEqual([])
    expect(await store.getRun(run.id)).toBeUndefined()
    expect(await store.eventsAfter(requirement.requirementId, 0)).toEqual([])
    await store.close()
  })
})
