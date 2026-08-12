import { describe, it, expect } from "vitest"
import { Phase, PhaseLock } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { Role } from "@octopus/core/role.js"
import { ArtifactType } from "@octopus/core/artifact.js"
import { TaskId } from "@octopus/core/branded-ids.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { createStateStore } from "@octopus/context/index.js"
import { WorkflowEngine } from "./index.js"

const TEST_STORE_DIR = ".octo_engine_test"

function createEngine(): WorkflowEngine {
  return new WorkflowEngine({
    store: createStateStore({ storeDir: TEST_STORE_DIR }),
  })
}

function createGatedEngine(): WorkflowEngine {
  return new WorkflowEngine({
    store: createStateStore({ storeDir: TEST_STORE_DIR }),
    aiGatingEnabled: true,
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
      expect(state.steps.length).toBeGreaterThanOrEqual(12)
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

    it("注册异步 AI 门控时明确拒绝同步阶段转换", () => {
      const engine = createGatedEngine()
      const state = engine.initProject("async_gate_test")
      completeAllPhaseTasks(engine, state.projectId, Phase.REQUIREMENTS_ANALYSIS)
      engine.registerAIHandler(async () => ({ allowed: false, reason: "异步拒绝" }))

      expect(() => engine.advancePhase(state.projectId)).toThrow("异步 AI 门控处理器")
      expect(engine.getState(state.projectId).currentPhase).toBe(Phase.REQUIREMENTS_ANALYSIS)
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

  describe("任务导入导出", () => {
    it("导出版本化文档和全部任务字段", () => {
      const engine = createEngine()
      const state = engine.initProject("export_tasks_test")
      const document = engine.exportTasks(state.projectId)

      expect(document.format).toBe("octopus.tasks")
      expect(document.version).toBe(1)
      expect(document.sourceProject).toEqual({
        projectId: state.projectId,
        projectName: state.projectName,
      })
      expect(document.tasks).toHaveLength(state.steps.length)
      expect(document.tasks[0]).toMatchObject({
        taskId: state.steps[0]!.taskId,
        stageId: state.steps[0]!.id,
        assignedTo: null,
        completedAt: null,
        notes: null,
      })
    })

    it("按 stageId 跨项目合并执行信息且保留目标规格字段", () => {
      const engine = createEngine()
      const source = engine.initProject("import_source_test")
      const target = engine.initProject("import_target_test")
      const document = engine.exportTasks(source.projectId)
      const importedTask = document.tasks[0]!
      const originalTarget = engine.getTasks(target.projectId).find((task) => task.stageId === importedTask.stageId)!
      const completedAt = new Date().toISOString()

      importedTask.taskId = TaskId("external_task_id")
      importedTask.title = "不应覆盖的标题"
      importedTask.description = "不应覆盖的描述"
      importedTask.status = TaskStatus.COMPLETED
      importedTask.assignedTo = "测试负责人"
      importedTask.notes = "导入备注"
      importedTask.completedAt = completedAt
      document.tasks = [importedTask]

      const result = engine.importTasks(target.projectId, document)
      const imported = engine.getTasks(target.projectId).find((task) => task.stageId === importedTask.stageId)!

      expect(result).toEqual({ projectId: target.projectId, matched: 1, updated: 1, unchanged: 0 })
      expect(imported.id).toBe(originalTarget.id)
      expect(imported.title).toBe(originalTarget.title)
      expect(imported.description).toBe(originalTarget.description)
      expect(imported.status).toBe(TaskStatus.COMPLETED)
      expect(imported.assignedTo).toBe("测试负责人")
      expect(imported.notes).toBe("导入备注")
      expect(imported.completedAt).toBe(completedAt)
    })

    it("重复导入保持幂等并支持用 null 清除可选字段", () => {
      const engine = createEngine()
      const state = engine.initProject("import_idempotent_test")
      const document = engine.exportTasks(state.projectId)
      const task = document.tasks[0]!
      document.tasks = [task]
      task.status = TaskStatus.COMPLETED
      task.assignedTo = "负责人"
      task.notes = "备注"
      task.completedAt = new Date().toISOString()

      expect(engine.importTasks(state.projectId, document).updated).toBe(1)
      expect(engine.importTasks(state.projectId, document)).toMatchObject({ updated: 0, unchanged: 1 })

      task.status = TaskStatus.PENDING
      task.assignedTo = null
      task.notes = null
      task.completedAt = null
      expect(engine.importTasks(state.projectId, document).updated).toBe(1)

      const cleared = engine.getTasks(state.projectId).find((item) => item.stageId === task.stageId)!
      expect(cleared.status).toBe(TaskStatus.PENDING)
      expect(cleared.assignedTo).toBeUndefined()
      expect(cleared.notes).toBeUndefined()
      expect(cleared.completedAt).toBeUndefined()
    })

    it("未知任务导致整批拒绝且目标状态不变", () => {
      const engine = createEngine()
      const state = engine.initProject("import_atomic_test")
      const document = engine.exportTasks(state.projectId)
      document.tasks[0]!.status = TaskStatus.COMPLETED
      document.tasks[1]!.stageId = "unknown_stage"
      const before = engine.getState(state.projectId)

      expect(() => engine.importTasks(state.projectId, document)).toThrow("目标项目不存在任务 stageId: unknown_stage")
      expect(engine.getState(state.projectId)).toEqual(before)
    })

    it("拒绝重复任务、未知版本和阶段不匹配", () => {
      const engine = createEngine()
      const state = engine.initProject("import_validation_test")
      const duplicate = engine.exportTasks(state.projectId)
      duplicate.tasks = [duplicate.tasks[0]!, { ...duplicate.tasks[0]! }]
      expect(() => engine.importTasks(state.projectId, duplicate)).toThrow("包含重复的 stageId")

      const unsupported = engine.exportTasks(state.projectId) as unknown as Record<string, unknown>
      unsupported["version"] = 2
      expect(() => engine.importTasks(state.projectId, unsupported)).toThrow("不支持的任务导入文件版本")

      const mismatch = engine.exportTasks(state.projectId)
      mismatch.tasks = [mismatch.tasks[0]!]
      mismatch.tasks[0]!.phase = Phase.DESIGN
      expect(() => engine.importTasks(state.projectId, mismatch)).toThrow("阶段不匹配")
    })
  })

  describe("completeTask", () => {
    it("完成任务", () => {
      const engine = createEngine()
      const state = engine.initProject("complete_test")
      const task = engine.getTasks(state.projectId)[0]!
      engine.completeTask(state.projectId, task.id)
      const done = engine.getTasks(state.projectId).find((t) => t.id === task.id)!
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

  describe("canAdvance", () => {
    it("任务和清单都完成时允许前进", () => {
      const engine = createEngine()
      const state = engine.initProject("can_advance_pass")
      completeAllPhaseTasks(engine, state.projectId, Phase.REQUIREMENTS_ANALYSIS)
      const checklist = engine.getChecklist(state.projectId, Phase.REQUIREMENTS_ANALYSIS)
      for (const item of checklist.items) {
        engine.verifyChecklistItem(state.projectId, Phase.REQUIREMENTS_ANALYSIS, item.id, Role.PM)
      }
      const gate = engine.canAdvance(state.projectId)
      expect(gate.allowed).toBe(true)
      expect(gate.reasons).toHaveLength(0)
    })

    it("有未完成任务时阻止前进", () => {
      const engine = createEngine()
      const state = engine.initProject("can_advance_blocked_tasks")
      const gate = engine.canAdvance(state.projectId)
      expect(gate.allowed).toBe(false)
      expect(gate.reasons.some((r) => r.includes("任务未完成"))).toBe(true)
    })

    it("最终阶段不允许前进", () => {
      const engine = createEngine()
      const state = engine.initProject("can_advance_final")
      // 手动推进到最终阶段
      let current = state
      for (let i = 0; i < 5; i++) {
        completeAllPhaseTasks(engine, current.projectId, current.currentPhase)
        const checklist = engine.getChecklist(current.projectId, current.currentPhase)
        for (const item of checklist.items) {
          engine.verifyChecklistItem(current.projectId, current.currentPhase, item.id, Role.PM)
        }
        current = engine.advancePhase(current.projectId)
      }
      const gate = engine.canAdvance(current.projectId)
      expect(gate.allowed).toBe(false)
      expect(gate.reasons.some((r) => r.includes("最终阶段"))).toBe(true)
    })
  })

  describe("advancePhase failure", () => {
    it("任务未完成时抛出 PhaseLockedError", () => {
      const engine = createEngine()
      const state = engine.initProject("advance_fail_tasks")
      expect(() => engine.advancePhase(state.projectId)).toThrow()
    })
  })

  describe("rollbackTo failure", () => {
    it("回退到后续阶段时抛出错误", () => {
      const engine = createEngine()
      const state = engine.initProject("rollback_fail")
      expect(() => engine.rollbackTo(state.projectId, Phase.DESIGN)).toThrow()
    })
  })

  describe("checklist", () => {
    it("添加并核验清单项", () => {
      const engine = createEngine()
      const state = engine.initProject("checklist_test")
      const added = engine.addChecklistItem(
        state.projectId,
        Phase.REQUIREMENTS_ANALYSIS,
        "文档",
        "PRD 已评审",
      )
      const item = added.checklists[Phase.REQUIREMENTS_ANALYSIS]!.items.at(-1)!
      const verified = engine.verifyChecklistItem(state.projectId, Phase.REQUIREMENTS_ANALYSIS, item.id, Role.BA)
      const found = verified.checklists[Phase.REQUIREMENTS_ANALYSIS]!.items.find((i) => i.id === item.id)!
      expect(found.status).toBe("VERIFIED")
      expect(found.verifiedBy).toBe(Role.BA)
    })

    it("删除清单项", () => {
      const engine = createEngine()
      const state = engine.initProject("checklist_delete_test")
      const added = engine.addChecklistItem(
        state.projectId,
        Phase.REQUIREMENTS_ANALYSIS,
        "文档",
        "临时项",
      )
      const item = added.checklists[Phase.REQUIREMENTS_ANALYSIS]!.items.at(-1)!
      const removed = engine.removeChecklistItem(state.projectId, Phase.REQUIREMENTS_ANALYSIS, item.id)
      expect(removed.checklists[Phase.REQUIREMENTS_ANALYSIS]!.items.find((i) => i.id === item.id)).toBeUndefined()
    })
  })

  describe("heinrich", () => {
    it("记录观测并评估质量", () => {
      const engine = createEngine()
      const state = engine.initProject("heinrich_test")
      const logged = engine.logObservation(state.projectId, Phase.REQUIREMENTS_ANALYSIS, HeinrichLevel.MAJOR, "崩溃")
      expect(logged.heinrich.majorDefects).toBe(1)
      const assessment = engine.assessQuality(state.projectId)
      expect(assessment.verdict).toBe("INSUFFICIENT_DATA")
    })
  })

  describe("artifacts", () => {
    it("创建并查询制品", () => {
      const engine = createEngine()
      const state = engine.initProject("artifact_test")
      const created = engine.createArtifact(state.projectId, {
        type: ArtifactType.PRD,
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
  })

  describe("setTaskStatus", () => {
    it("设置任务状态并记录完成时间", () => {
      const engine = createEngine()
      const state = engine.initProject("set_status_test")
      const task = engine.getTasks(state.projectId)[0]!
      engine.setTaskStatus(state.projectId, task.id, TaskStatus.IN_PROGRESS)
      const found = engine.getTasks(state.projectId).find((t) => t.id === task.id)!
      expect(found.status).toBe(TaskStatus.IN_PROGRESS)
      expect(found.completedAt).toBeUndefined()
      engine.setTaskStatus(state.projectId, task.id, TaskStatus.COMPLETED)
      const done = engine.getTasks(state.projectId).find((t) => t.id === task.id)!
      expect(done.status).toBe(TaskStatus.COMPLETED)
      expect(done.completedAt).toBeTruthy()
    })
  })

  describe("getPhaseProgress", () => {
    it("计算阶段任务进度", () => {
      const engine = createEngine()
      const state = engine.initProject("progress_test")
      const progress = engine.getPhaseProgress(state, Phase.REQUIREMENTS_ANALYSIS)
      expect(progress.total).toBeGreaterThan(0)
      expect(progress.percent).toBeGreaterThanOrEqual(0)
    })
  })

  describe("边界场景", () => {
    it("查询不存在的项目状态应抛出错误", () => {
      const engine = createEngine()
      expect(() => engine.getState("non_existent_project")).toThrow()
    })

    it("更新不存在的任务应抛出错误", () => {
      const engine = createEngine()
      const state = engine.initProject("unknown_task_test")
      expect(() => engine.completeTask(state.projectId, "non_existent_task")).toThrow()
      expect(() => engine.setTaskStatus(state.projectId, "non_existent_task", TaskStatus.IN_PROGRESS)).toThrow()
    })
  })

  describe("清单边界场景", () => {
    it("核验不存在的清单项应抛出错误", () => {
      const engine = createEngine()
      const state = engine.initProject("checklist_boundary_test")
      expect(() => engine.verifyChecklistItem(state.projectId, Phase.REQUIREMENTS_ANALYSIS, "non_existent_item", Role.PM)).toThrow()
    })

    it("从不存在的阶段删除清单项应抛出错误", () => {
      const engine = createEngine()
      const state = engine.initProject("checklist_delete_boundary_test")
      expect(() => engine.removeChecklistItem(state.projectId, Phase.DEPLOYMENT, "some_item")).toThrow()
    })
  })

  describe("海因里希边界场景", () => {
    it("解决不存在的观测应抛出错误", () => {
      const engine = createEngine()
      const state = engine.initProject("heinrich_boundary_test")
      expect(() => engine.resolveObservation(state.projectId, "non_existent_obs")).toThrow()
    })
  })

  describe("阶段门禁正向场景", () => {
    it("所有任务完成且清单核验后允许前进", () => {
      const engine = createEngine()
      const state = engine.initProject("gate_positive_test")
      completeAllPhaseTasks(engine, state.projectId, Phase.REQUIREMENTS_ANALYSIS)
      const checklist = engine.getChecklist(state.projectId, Phase.REQUIREMENTS_ANALYSIS)
      for (const item of checklist.items) {
        engine.verifyChecklistItem(state.projectId, Phase.REQUIREMENTS_ANALYSIS, item.id, Role.PM)
      }
      const gate = engine.canAdvance(state.projectId)
      expect(gate.allowed).toBe(true)
      expect(gate.reasons).toHaveLength(0)
    })
  })

  describe("阶段门禁负向场景", () => {
    it("有未完成任务时阻止前进并返回具体原因", () => {
      const engine = createEngine()
      const state = engine.initProject("gate_negative_tasks")
      const gate = engine.canAdvance(state.projectId)
      expect(gate.allowed).toBe(false)
      expect(gate.reasons.length).toBeGreaterThan(0)
      expect(gate.reasons.some((r) => r.includes("任务未完成"))).toBe(true)
    })

    it("有未核验清单项时阻止前进并返回具体原因", () => {
      const engine = createEngine()
      const state = engine.initProject("gate_negative_checklist")
      completeAllPhaseTasks(engine, state.projectId, Phase.REQUIREMENTS_ANALYSIS)
      engine.addChecklistItem(state.projectId, Phase.REQUIREMENTS_ANALYSIS, "文档", "待核验项")
      const gate = engine.canAdvance(state.projectId)
      expect(gate.allowed).toBe(false)
      expect(gate.reasons.some((r) => r.includes("清单未核验"))).toBe(true)
    })
  })
})
