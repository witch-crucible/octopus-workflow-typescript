import { afterEach, describe, expect, it, vi } from "vitest"
import { Command } from "commander"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AIClient } from "@octopus/agent-layer/index.js"
import { createTestPersistenceStore } from "@octopus/context/testing.js"
import { WorkflowEngine } from "@octopus/workflow-engine/index.js"
import { buildBrdCommands } from "./brd.js"

const engines: WorkflowEngine[] = []
const roots: string[] = []

function mockAiClient(): AIClient {
  let call = 0
  return {
    callAssistant: async (assistant: string) => {
      if (assistant === "BRD_GENERATE") {
        call += 1
        return { result: `# BRD\n生成内容 v${call}` }
      }
      return { result: "# 检查报告\n完整" }
    },
  } as unknown as AIClient
}

async function createEngine(): Promise<WorkflowEngine> {
  const { store } = await createTestPersistenceStore()
  const engine = new WorkflowEngine({ store, aiClient: mockAiClient() })
  await engine.initialize()
  engines.push(engine)
  return engine
}

function program(): Command {
  return new Command().exitOverride()
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "octopus-cli-brd-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("brd 历史/diff/trace CLI", () => {
  it("brd history --json 列出快照历史", async () => {
    const engine = await createEngine()
    const root = tempRoot()
    const project = await engine.createProject("P")
    const requirement = await engine.initRequirement(project.projectId, "R", "描述", root)
    await engine.generateBrd(project.projectId, requirement.requirementId)

    const cli = program()
    buildBrdCommands(cli, engine)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await cli.parseAsync([
      "node",
      "octopus",
      "brd",
      "history",
      requirement.requirementId,
      "--json",
    ])
    const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as Array<{ source: string }>
    expect(payload).toHaveLength(1)
    expect(payload[0]?.source).toBe("generate")
  })

  it("brd diff --stat 输出增删统计", async () => {
    const engine = await createEngine()
    const root = tempRoot()
    const project = await engine.createProject("P")
    const requirement = await engine.initRequirement(project.projectId, "R", "描述", root)
    await engine.generateBrd(project.projectId, requirement.requirementId)
    writeFileSync(
      join(root, "workflow/nodes/requirements-analysis-and-brd-design/brd.md"),
      "# BRD\n生成内容 v1\n手工新增一行",
      "utf8",
    )
    await engine.snapshotBrd(project.projectId, requirement.requirementId)

    const cli = program()
    buildBrdCommands(cli, engine)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await cli.parseAsync([
      "node",
      "octopus",
      "brd",
      "diff",
      requirement.requirementId,
      "--stat",
    ])
    const output = log.mock.calls.map((call) => String(call[0])).join("\n")
    expect(output).toContain("+1")
  })

  it("brd trace --json 串联版本、事件与制品", async () => {
    const engine = await createEngine()
    const root = tempRoot()
    const project = await engine.createProject("P")
    const requirement = await engine.initRequirement(project.projectId, "R", "描述", root)
    await engine.generateBrd(project.projectId, requirement.requirementId)

    const cli = program()
    buildBrdCommands(cli, engine)
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await cli.parseAsync(["node", "octopus", "brd", "trace", requirement.requirementId, "--json"])
    const payload = JSON.parse(String(log.mock.calls[0]?.[0])) as Array<{
      entry: { source: string }
      artifact?: { type: string }
    }>
    expect(payload).toHaveLength(1)
    expect(payload[0]?.entry.source).toBe("generate")
    expect(payload[0]?.artifact?.type).toBe("BRD")
  })
})
