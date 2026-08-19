/**
 * WorkflowEngine 集成测试 —— 覆盖常见 happy path。
 *
 * 每个用例使用独立临时状态目录。
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Phase } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { Role } from "@octopus/core/role.js"
import { ArtifactType } from "@octopus/core/artifact.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { createStateStore } from "@octopus/context/index.js"
import { WorkflowEngine } from "./index.js"

let testStoreDir: string

beforeEach(() => {
  testStoreDir = mkdtempSync(join(tmpdir(), "octopus-engine-int-"))
})

afterEach(() => {
  rmSync(testStoreDir, { recursive: true, force: true })
})

function createEngine(): WorkflowEngine {
  return new WorkflowEngine({
    store: createStateStore({ storeDir: testStoreDir }),
  })
}

function completeAllPhaseTasks(engine: WorkflowEngine, requirementId: string, phase: Phase): void {
  const tasks = engine.getTasks(requirementId, { phase })
  for (const task of tasks) {
    if (task.status !== TaskStatus.COMPLETED) {
      engine.completeTask(requirementId, task.id)
    }
  }
}


function initNamedRequirement(
  engine: WorkflowEngine,
  name: string,
  description?: string,
  projectRoot?: string,
) {
  const project = engine.createProject(name, description)
  return engine.initRequirement(project.projectId, name, description, projectRoot)
}

describe("WorkflowEngine 集成测试", () => {
  it("完整推进到 RELEASE 阶段", () => {
    const engine = createEngine()
    const state = initNamedRequirement(engine, "集成测试项目")
    expect(state.currentPhase).toBe(Phase.INTENTION)

    // INTENTION → RESEARCH
    completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
    const research = engine.advancePhase(state.requirementId)
    expect(research.currentPhase).toBe(Phase.RESEARCH)

    // RESEARCH → DESIGN
    completeAllPhaseTasks(engine, research.requirementId, Phase.RESEARCH)
    const design = engine.advancePhase(research.requirementId)
    expect(design.currentPhase).toBe(Phase.DESIGN)

    // DESIGN → IMPLEMENTATION
    completeAllPhaseTasks(engine, design.requirementId, Phase.DESIGN)
    const impl = engine.advancePhase(design.requirementId)
    expect(impl.currentPhase).toBe(Phase.IMPLEMENTATION)

    // IMPLEMENTATION → TESTING
    completeAllPhaseTasks(engine, impl.requirementId, Phase.IMPLEMENTATION)
    const testing = engine.advancePhase(impl.requirementId)
    expect(testing.currentPhase).toBe(Phase.TESTING)

    // TESTING → UAT
    completeAllPhaseTasks(engine, testing.requirementId, Phase.TESTING)
    const uat = engine.advancePhase(testing.requirementId)
    expect(uat.currentPhase).toBe(Phase.UAT)

    // UAT → RELEASE
    completeAllPhaseTasks(engine, uat.requirementId, Phase.UAT)
    const release = engine.advancePhase(uat.requirementId)
    expect(release.currentPhase).toBe(Phase.RELEASE)
  })

  it("阶段回退并重新前进", () => {
    const engine = createEngine()
    const state = initNamedRequirement(engine, "回退测试")
    completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
    const research = engine.advancePhase(state.requirementId)

    const rolled = engine.rollbackTo(research.requirementId, Phase.INTENTION)
    expect(rolled.currentPhase).toBe(Phase.INTENTION)

    // 重新前进
    completeAllPhaseTasks(engine, rolled.requirementId, Phase.INTENTION)
    const next = engine.advancePhase(rolled.requirementId)
    expect(next.currentPhase).toBe(Phase.RESEARCH)
  })

  it("状态摘要统计正确", () => {
    const engine = createEngine()
    const state = initNamedRequirement(engine, "摘要测试")
    const status = engine.getRequirementStatus(state.requirementId)

    expect(status.requirementName).toBe("摘要测试")
    expect(status.currentPhase).toBe(Phase.INTENTION)
    expect(status.totalTasks).toBeGreaterThan(0)
    expect(status.completedTasks).toBe(0)
  })

  it("清单添加、核验、删除闭环", () => {
    const engine = createEngine()
    const state = initNamedRequirement(engine, "清单测试")

    const added = engine.addChecklistItem(
      state.requirementId,
      Phase.INTENTION,
      "文档",
      "PRD 已评审",
    )
    const item = added.checklists[Phase.INTENTION]!.items.at(-1)!
    expect(item.status).toBe("PENDING")

    const verified = engine.verifyChecklistItem(state.requirementId, Phase.INTENTION, item.id, Role.PM)
    const found = verified.checklists[Phase.INTENTION]!.items.find((i) => i.id === item.id)!
    expect(found.status).toBe("VERIFIED")
    expect(found.verifiedBy).toBe(Role.PM)

    const removed = engine.removeChecklistItem(state.requirementId, Phase.INTENTION, item.id)
    expect(removed.checklists[Phase.INTENTION]!.items.find((i) => i.id === item.id)).toBeUndefined()
  })

  it("制品创建与查询", () => {
    const engine = createEngine()
    const state = initNamedRequirement(engine, "制品测试")
    engine.createArtifact(state.requirementId, {
      type: ArtifactType.PRD,
      title: "产品需求文档",
      description: "v1",
      phase: Phase.INTENTION,
      createdBy: Role.PM,
      content: "# PRD",
    })

    const artifacts = engine.getArtifacts(state.requirementId, Phase.INTENTION, "PRD")
    expect(artifacts.length).toBeGreaterThanOrEqual(1)
    expect(artifacts[0]!.title).toBe("产品需求文档")
  })

  it("海因里希三角数据评估", () => {
    const engine = createEngine()
    const state = initNamedRequirement(engine, "heinrich 测试")

    engine.logObservation(state.requirementId, Phase.INTENTION, HeinrichLevel.MAJOR, "崩溃")
    engine.logObservation(state.requirementId, Phase.INTENTION, HeinrichLevel.MINOR, "警告")
    engine.logObservation(state.requirementId, Phase.INTENTION, HeinrichLevel.TRIVIAL, "建议")

    const record = engine.getHeinrichRecord(state.requirementId)
    expect(record.majorDefects).toBe(1)
    expect(record.minorDefects).toBe(1)
    expect(record.trivialDefects).toBe(1)

    const assessment = engine.assessQuality(state.requirementId)
    expect(assessment.verdict).toBe("UNDER_REPORTING")
  })
})
