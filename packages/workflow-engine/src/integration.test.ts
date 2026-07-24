/**
 * WorkflowEngine 集成测试 —— 覆盖常见 happy path。
 *
 * 注意：这些测试会实际读写 `.octo_engine_test/` 目录。
 */

import { describe, it, expect, afterAll } from "vitest"
import { Phase, PhaseLock } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { Role } from "@octopus/core/role.js"
import { ArtifactType } from "@octopus/core/artifact.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { createStateStore } from "@octopus/context/index.js"
import { WorkflowEngine } from "./index.js"

const TEST_STORE_DIR = ".octo_engine_test"

function createEngine(): WorkflowEngine {
  return new WorkflowEngine({
    store: createStateStore({ storeDir: TEST_STORE_DIR }),
  })
}

function completeAllPhaseTasks(engine: WorkflowEngine, projectId: string, phase: Phase): void {
  const tasks = engine.getTasks(projectId, { phase })
  for (const task of tasks) {
    if (task.status !== TaskStatus.COMPLETED) {
      engine.completeTask(projectId, task.id)
    }
  }
}

describe("WorkflowEngine 集成测试", () => {
  afterAll(() => {
    // 不清理目录，便于调试；如需清理可手动删除 `.octo_engine_test/`
  })

  it("完整推进到 DEPLOYMENT 阶段", () => {
    const engine = createEngine()
    const state = engine.initProject("集成测试项目")
    expect(state.currentPhase).toBe(Phase.REQUIREMENTS_ANALYSIS)

    // REQUIREMENTS → DESIGN
    completeAllPhaseTasks(engine, state.projectId, Phase.REQUIREMENTS_ANALYSIS)
    const design = engine.advancePhase(state.projectId)
    expect(design.currentPhase).toBe(Phase.DESIGN)

    // DESIGN → DEVELOPMENT
    completeAllPhaseTasks(engine, design.projectId, Phase.DESIGN)
    const dev = engine.advancePhase(design.projectId)
    expect(dev.currentPhase).toBe(Phase.DEVELOPMENT)

    // DEVELOPMENT → TESTING
    completeAllPhaseTasks(engine, dev.projectId, Phase.DEVELOPMENT)
    const testing = engine.advancePhase(dev.projectId)
    expect(testing.currentPhase).toBe(Phase.TESTING)

    // TESTING → DEPLOYMENT
    completeAllPhaseTasks(engine, testing.projectId, Phase.TESTING)
    const deployment = engine.advancePhase(testing.projectId)
    expect(deployment.currentPhase).toBe(Phase.DEPLOYMENT)
  })

  it("阶段回退并重新前进", () => {
    const engine = createEngine()
    const state = engine.initProject("回退测试")
    completeAllPhaseTasks(engine, state.projectId, Phase.REQUIREMENTS_ANALYSIS)
    const design = engine.advancePhase(state.projectId)

    const rolled = engine.rollbackTo(design.projectId, Phase.REQUIREMENTS_ANALYSIS)
    expect(rolled.currentPhase).toBe(Phase.REQUIREMENTS_ANALYSIS)

    // 重新前进
    completeAllPhaseTasks(engine, rolled.projectId, Phase.REQUIREMENTS_ANALYSIS)
    const next = engine.advancePhase(rolled.projectId)
    expect(next.currentPhase).toBe(Phase.DESIGN)
  })

  it("状态摘要统计正确", () => {
    const engine = createEngine()
    const state = engine.initProject("摘要测试")
    const status = engine.getProjectStatus(state.projectId)

    expect(status.projectName).toBe("摘要测试")
    expect(status.currentPhase).toBe(Phase.REQUIREMENTS_ANALYSIS)
    expect(status.totalTasks).toBeGreaterThan(0)
    expect(status.completedTasks).toBe(0)
  })

  it("清单添加、核验、删除闭环", () => {
    const engine = createEngine()
    const state = engine.initProject("清单测试")

    const added = engine.addChecklistItem(
      state.projectId,
      Phase.REQUIREMENTS_ANALYSIS,
      "文档",
      "PRD 已评审",
    )
    const item = added.checklists[Phase.REQUIREMENTS_ANALYSIS]!.items.at(-1)!
    expect(item.status).toBe("PENDING")

    const verified = engine.verifyChecklistItem(state.projectId, Phase.REQUIREMENTS_ANALYSIS, item.id, Role.PM)
    const found = verified.checklists[Phase.REQUIREMENTS_ANALYSIS]!.items.find((i) => i.id === item.id)!
    expect(found.status).toBe("VERIFIED")
    expect(found.verifiedBy).toBe(Role.PM)

    const removed = engine.removeChecklistItem(state.projectId, Phase.REQUIREMENTS_ANALYSIS, item.id)
    expect(removed.checklists[Phase.REQUIREMENTS_ANALYSIS]!.items.find((i) => i.id === item.id)).toBeUndefined()
  })

  it("制品创建与查询", () => {
    const engine = createEngine()
    const state = engine.initProject("制品测试")
    const created = engine.createArtifact(state.projectId, {
      type: ArtifactType.DOCUMENT,
      title: "产品需求文档",
      description: "v1",
      phase: Phase.REQUIREMENTS_ANALYSIS,
      createdBy: Role.PM,
      content: "# PRD",
    })

    const artifacts = engine.getArtifacts(state.projectId, Phase.REQUIREMENTS_ANALYSIS, "PRD")
    expect(artifacts.length).toBeGreaterThanOrEqual(1)
    expect(artifacts[0]!.title).toBe("产品需求文档")
  })

  it("海因里希三角数据评估", () => {
    const engine = createEngine()
    const state = engine.initProject("heinrich 测试")

    engine.logObservation(state.projectId, Phase.REQUIREMENTS_ANALYSIS, HeinrichLevel.MAJOR, "崩溃")
    engine.logObservation(state.projectId, Phase.REQUIREMENTS_ANALYSIS, HeinrichLevel.MINOR, "警告")
    engine.logObservation(state.projectId, Phase.REQUIREMENTS_ANALYSIS, HeinrichLevel.TRIVIAL, "建议")

    const record = engine.getHeinrichRecord(state.projectId)
    expect(record.majorDefects).toBe(1)
    expect(record.minorDefects).toBe(1)
    expect(record.trivialDefects).toBe(1)

    const assessment = engine.assessQuality(state.projectId)
    expect(assessment.verdict).toBe("UNDER_REPORTING")
  })
})
