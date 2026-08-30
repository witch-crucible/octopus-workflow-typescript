import { afterEach, describe, expect, it, vi } from "vitest"
import { Command } from "commander"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TaskStatus } from "@octopus/core/task.js"
import { createTestPersistenceStore } from "@octopus/context/testing.js"
import { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { buildInitCommand } from "./commands/init.js"
import { buildProjectCommands } from "./commands/project.js"
import { buildRequirementCommands } from "./commands/requirement.js"
import { buildTaskCommands } from "./commands/task.js"
import { buildStatusCommand } from "./commands/status.js"

const engines: WorkflowEngine[] = []
const roots: string[] = []

async function createEngine(): Promise<WorkflowEngine> {
  const { store } = await createTestPersistenceStore()
  const engine = new WorkflowEngine({ store })
  await engine.initialize()
  engines.push(engine)
  return engine
}

function program(): Command {
  return new Command().exitOverride()
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("CLI 异步存储契约", () => {
  it("project create --json 返回既有响应结构", async () => {
    const engine = await createEngine()
    const cli = program()
    buildProjectCommands(cli, engine)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await cli.parseAsync(["node", "octopus", "project", "create", "P", "--json"])
    const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as {
      name: string
      projectId: string
    }
    expect(payload.name).toBe("P")
    expect(await engine.listProjects()).toContain(payload.projectId)
  })

  it("init 在指定项目下创建需求", async () => {
    const engine = await createEngine()
    const project = await engine.createProject("P")
    const root = mkdtempSync(join(tmpdir(), "octopus-cli-"))
    roots.push(root)
    const cli = program()
    buildInitCommand(cli, engine)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    await cli.parseAsync([
      "node",
      "octopus",
      "init",
      "R",
      "--project",
      project.projectId,
      "--root",
      root,
    ])
    expect(await engine.listRequirements(project.projectId)).toHaveLength(1)
  })

  it("requirement list --json 输出摘要", async () => {
    const engine = await createEngine()
    const project = await engine.createProject("P")
    const requirement = await engine.initRequirement(project.projectId, "R")
    const cli = program()
    buildRequirementCommands(cli, engine)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await cli.parseAsync(["node", "octopus", "requirement", "list", "--json"])
    const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as Array<{ requirementId: string }>
    expect(payload[0]?.requirementId).toBe(requirement.requirementId)
  })

  it("task complete 等待写入后再输出", async () => {
    const engine = await createEngine()
    const project = await engine.createProject("P")
    const requirement = await engine.initRequirement(project.projectId, "R")
    const task = (await engine.getTasks(requirement.requirementId))[0]!
    const cli = program()
    buildTaskCommands(cli, engine)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    await cli.parseAsync([
      "node",
      "octopus",
      "task",
      "complete",
      task.id,
      requirement.requirementId,
    ])
    expect(
      (await engine.getTasks(requirement.requirementId)).find((item) => item.id === task.id)
        ?.status,
    ).toBe(TaskStatus.COMPLETED)
  })

  it("status --json 保持摘要字段", async () => {
    const engine = await createEngine()
    const project = await engine.createProject("P")
    const requirement = await engine.initRequirement(project.projectId, "R")
    const cli = program()
    buildStatusCommand(cli, engine)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await cli.parseAsync(["node", "octopus", "status", requirement.requirementId, "--json"])
    const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as { requirementId: string }
    expect(payload.requirementId).toBe(requirement.requirementId)
  })
})
