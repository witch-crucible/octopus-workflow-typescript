import { afterEach, describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AIClient } from "@octopus/agent-layer/index.js"
import { ArtifactType } from "@octopus/core/artifact.js"
import { createTestPersistenceStore } from "@octopus/context/testing.js"
import { WorkflowEngine } from "./index.js"

const engines: WorkflowEngine[] = []
const roots: string[] = []

function mockAiClient(results: { generate?: string; check?: string } = {}): AIClient {
  let generateCall = 0
  return {
    callAssistant: async (assistant: string) => {
      if (assistant === "BRD_GENERATE") {
        generateCall += 1
        return { result: results.generate ?? `# BRD\n生成内容 v${generateCall}` }
      }
      return { result: results.check ?? "# 检查报告\n完整" }
    },
  } as unknown as AIClient
}

async function createEngine(aiClient?: AIClient): Promise<WorkflowEngine> {
  const { store } = await createTestPersistenceStore()
  const engine = new WorkflowEngine(aiClient ? { store, aiClient } : { store })
  await engine.initialize()
  engines.push(engine)
  return engine
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "octopus-brd-trace-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("WorkflowEngine BRD 变动追踪", () => {
  it("generateBrd 写入快照并发出带 sha 的 BRD_UPDATED 事件", async () => {
    const root = tempRoot()
    const engine = await createEngine(mockAiClient())
    const project = await engine.createProject("项目", "描述")
    const state = await engine.initRequirement(project.projectId, "需求", "描述", root)

    const result = await engine.generateBrd(project.projectId, state.requirementId)
    expect(result.snapshot?.changed).toBe(true)
    expect(result.snapshot?.previousSha).toBeNull()

    const events = await engine.execution.eventsAfter(state.requirementId, 0)
    const updated = events.find((event) => event.type === "BRD_UPDATED")
    expect(updated?.payload["sha"]).toBe(result.snapshot?.sha)
    expect(updated?.payload["previousSha"]).toBeNull()
  })

  it("AI 输出与上一版相同的内容不重复发出 BRD_UPDATED 事件", async () => {
    const root = tempRoot()
    const engine = await createEngine(mockAiClient({ generate: "# BRD\n固定内容" }))
    const project = await engine.createProject("项目", "描述")
    const state = await engine.initRequirement(project.projectId, "需求", "描述", root)

    await engine.generateBrd(project.projectId, state.requirementId)
    const second = await engine.generateBrd(project.projectId, state.requirementId)
    const afterSecond = await engine.execution.eventsAfter(state.requirementId, 0)

    expect(second.snapshot?.changed).toBe(false)
    expect(afterSecond.filter((event) => event.type === "BRD_UPDATED")).toHaveLength(1)
  })

  it("generate → 手工修改 → snapshotBrd → check → getBrdTrace 串联完整链路", async () => {
    const root = tempRoot()
    const engine = await createEngine(mockAiClient())
    const project = await engine.createProject("项目", "描述")
    const state = await engine.initRequirement(project.projectId, "需求", "描述", root)

    const generated = await engine.generateBrd(project.projectId, state.requirementId)
    const brdPath = join(root, "workflow/nodes/requirements-analysis-and-brd-design/brd.md")
    mkdirSync(join(root, "workflow/nodes/requirements-analysis-and-brd-design"), { recursive: true })
    writeFileSync(brdPath, "# BRD\n手工追加的一行", "utf8")

    const snapshot = await engine.snapshotBrd(project.projectId, state.requirementId)
    expect(snapshot.changed).toBe(true)
    expect(snapshot.entry?.source).toBe("manual")

    const checked = await engine.checkBrd(project.projectId, state.requirementId)
    expect(checked.checkedSha).toBe(snapshot.entry?.sha)

    const history = await engine.listBrdHistory(project.projectId, state.requirementId)
    expect(history.map((entry) => entry.source)).toEqual(["generate", "manual"])

    const diff = await engine.diffBrd(project.projectId, state.requirementId)
    expect(diff.diff.added).toBeGreaterThan(0)

    const trace = await engine.getBrdTrace(project.projectId, state.requirementId)
    expect(trace).toHaveLength(2)
    expect(trace[0]?.entry.sha).toBe(generated.snapshot?.sha)
    expect(trace[0]?.artifact?.type).toBe(ArtifactType.BRD)
    expect(trace[1]?.entry.sha).toBe(snapshot.entry?.sha)
    expect(trace[1]?.artifact?.type).toBe(ArtifactType.BRD)
    expect(trace[1]?.checks.map((artifact) => artifact.type)).toEqual([ArtifactType.BRD_CHECK_REPORT])
    expect(trace[1]?.checks[0]?.source?.fileHash).toBe(snapshot.entry?.sha)
  })
})
