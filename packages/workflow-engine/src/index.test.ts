import { describe, it, expect } from "vitest"
import { Phase, PhaseLock } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { Role } from "@octopus/core/role.js"
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

describe("WorkflowEngine", () => {
  describe("initProject", () => {
    it("创建新项目并设置初始阶段", () => {
      const engine = createEngine()
      const state = engine.initProject("测试项目", "描述")
      expect(state.projectName).toBe("测试项目")
      expect(state.currentPhase).toBe(Phase.REQUIREMENTS_ANALYSIS)
      expect(state.phaseStatus[Phase.REQUIREMENTS_ANALYSIS]).toBe(PhaseLock.ACTIVE)
    })

    it("初始阶段生成12个任务", () => {
      const engine = createEngine()
      const state = engine.initProject("测试项目")
      expect(state.tasks.length).toBeGreaterThanOrEqual(12)
    })

    it("初始化海因里希记录", () => {
      const engine = createEngine()
      const state = engine.initProject("测试项目")
      expect(state.heinrich.majorDefects).toBe(0)
    })
  })

  describe("advancePhase", () => {
    it("完成所有任务后前进到下一阶段", () => {
      const engine = createEngine()
      const state = engine.initProject("advance_test")
      completeAllPhaseTasks(engine, state.projectId, Phase.REQUIREMENTS_ANALYSIS)
      const next = engine.advancePhase(state.projectId)
      expect(next.currentPhase).toBe(Phase.DESIGN)
      expect(next.phaseStatus[Phase.REQUIREMENTS_ANALYSIS]).toBe(PhaseLock.COMPLETED)
      expect(next.phaseStatus[Phase.DESIGN]).toBe(PhaseLock.ACTIVE)
    })
  })

  describe("rollbackTo", () => {
    it("完成所有任务后前进再回退到指定阶段", () => {
      const engine = createEngine()
      const state = engine.initProject("rollback_test")
      completeAllPhaseTasks(engine, state.projectId, Phase.REQUIREMENTS_ANALYSIS)
      engine.advancePhase(state.projectId) // → DESIGN
      const rolled = engine.rollbackTo(state.projectId, Phase.REQUIREMENTS_ANALYSIS)
      expect(rolled.currentPhase).toBe(Phase.REQUIREMENTS_ANALYSIS)
    })
  })

  describe("getTasks", () => {
    it("过滤指定阶段的任务", () => {
      const engine = createEngine()
      const state = engine.initProject("task_test")
      const tasks = engine.getTasks(state.projectId, { phase: Phase.REQUIREMENTS_ANALYSIS })
      for (const t of tasks) {
        expect(t.phase).toBe(Phase.REQUIREMENTS_ANALYSIS)
      }
    })

    it("按状态过滤", () => {
      const engine = createEngine()
      const state = engine.initProject("filter_test")
      const pending = engine.getTasks(state.projectId, { status: TaskStatus.PENDING })
      expect(pending.length).toBeGreaterThan(0)
    })

    it("按角色过滤", () => {
      const engine = createEngine()
      const state = engine.initProject("role_test")
      const pmTasks = engine.getTasks(state.projectId, { responsibleRole: Role.PM })
      for (const t of pmTasks) {
        expect(t.responsibleRole).toBe(Role.PM)
      }
    })
  })

  describe("completeTask", () => {
    it("完成任务", () => {
      const engine = createEngine()
      const state = engine.initProject("complete_test")
      const task = state.tasks[0]!
      const updated = engine.completeTask(state.projectId, task.id)
      const done = updated.tasks.find((t) => t.id === task.id)!
      expect(done.status).toBe(TaskStatus.COMPLETED)
      expect(done.completedAt).toBeTruthy()
    })
  })

  describe("getProjectStatus", () => {
    it("返回项目状态摘要", () => {
      const engine = createEngine()
      const state = engine.initProject("status_test")
      const status = engine.getProjectStatus(state.projectId)
      expect(status.currentPhase).toBe(Phase.REQUIREMENTS_ANALYSIS)
      expect(status.totalTasks).toBeGreaterThan(0)
    })
  })
})
