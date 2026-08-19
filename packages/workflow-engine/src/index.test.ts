import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Phase, PhaseLock } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { Role } from "@octopus/core/role.js"
import { ArtifactType } from "@octopus/core/artifact.js"
import { TaskId } from "@octopus/core/branded-ids.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { createStateStore } from "@octopus/context/index.js"
import { WorkflowEngine } from "./index.js"

let testStoreDir: string

beforeEach(() => {
  testStoreDir = mkdtempSync(join(tmpdir(), "octopus-engine-"))
})

afterEach(() => {
  rmSync(testStoreDir, { recursive: true, force: true })
})

function createEngine(): WorkflowEngine {
  return new WorkflowEngine({
    store: createStateStore({ storeDir: testStoreDir }),
  })
}

function createGatedEngine(): WorkflowEngine {
  return new WorkflowEngine({
    store: createStateStore({ storeDir: testStoreDir }),
    aiGatingEnabled: true,
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

describe("WorkflowEngine", () => {
  describe("initRequirement", () => {
    it("创建新项目并设置初始阶段", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "测试项目", "描述")
      expect(state.requirementName).toBe("测试项目")
      expect(state.currentPhase).toBe(Phase.INTENTION)
      expect(state.phaseStatus[Phase.INTENTION]).toBe(PhaseLock.ACTIVE)
    })

    it("初始阶段生成意向步骤", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "测试项目")
      expect(state.steps.length).toBe(2)
      expect(state.steps.every((step) => step.phase === Phase.INTENTION)).toBe(true)
    })

    it("初始化海因里希记录", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "测试项目")
      expect(state.heinrich.majorDefects).toBe(0)
    })
  })

  describe("advancePhase", () => {
    it("完成所有任务后前进到下一阶段", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "advance_test")
      completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
      const next = engine.advancePhase(state.requirementId)
      expect(next.currentPhase).toBe(Phase.RESEARCH)
      expect(next.phaseStatus[Phase.INTENTION]).toBe(PhaseLock.COMPLETED)
      expect(next.phaseStatus[Phase.RESEARCH]).toBe(PhaseLock.ACTIVE)
    })

    it("注册异步 AI 门控时明确拒绝同步阶段转换", () => {
      const engine = createGatedEngine()
      const state = initNamedRequirement(engine, "async_gate_test")
      completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
      engine.registerAIHandler(async () => ({ allowed: false, reason: "异步拒绝" }))

      expect(() => engine.advancePhase(state.requirementId)).toThrow("异步 AI 门控处理器")
      expect(engine.getState(state.requirementId).currentPhase).toBe(Phase.INTENTION)
    })
  })

  describe("rollbackTo", () => {
    it("完成所有任务后前进再回退到指定阶段", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "rollback_test")
      completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
      engine.advancePhase(state.requirementId) // → RESEARCH
      const rolled = engine.rollbackTo(state.requirementId, Phase.INTENTION)
      expect(rolled.currentPhase).toBe(Phase.INTENTION)
    })
  })

  describe("getTasks", () => {
    it("过滤指定阶段的任务", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "task_test")
      const tasks = engine.getTasks(state.requirementId, { phase: Phase.INTENTION })
      for (const t of tasks) {
        expect(t.phase).toBe(Phase.INTENTION)
      }
    })

    it("按状态过滤", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "filter_test")
      const pending = engine.getTasks(state.requirementId, { status: TaskStatus.PENDING })
      expect(pending.length).toBeGreaterThan(0)
    })

    it("按角色过滤", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "role_test")
      const pmTasks = engine.getTasks(state.requirementId, { responsibleRole: Role.PM })
      for (const t of pmTasks) {
        expect(t.responsibleRole).toBe(Role.PM)
      }
    })
  })

  describe("任务导入导出", () => {
    it("导出版本化文档和全部任务字段", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "export_tasks_test")
      const document = engine.exportTasks(state.requirementId)

      expect(document.format).toBe("octopus.tasks")
      expect(document.version).toBe(1)
      expect(document.sourceRequirement).toEqual({
        projectId: state.projectId,
        requirementId: state.requirementId,
        requirementName: state.requirementName,
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
      const source = initNamedRequirement(engine, "import_source_test")
      const target = initNamedRequirement(engine, "import_target_test")
      const document = engine.exportTasks(source.requirementId)
      const importedTask = document.tasks[0]!
      const originalTarget = engine.getTasks(target.requirementId).find((task) => task.stageId === importedTask.stageId)!
      const completedAt = new Date().toISOString()

      importedTask.taskId = TaskId("external_task_id")
      importedTask.title = "不应覆盖的标题"
      importedTask.description = "不应覆盖的描述"
      importedTask.status = TaskStatus.COMPLETED
      importedTask.assignedTo = "测试负责人"
      importedTask.notes = "导入备注"
      importedTask.completedAt = completedAt
      document.tasks = [importedTask]

      const result = engine.importTasks(target.requirementId, document)
      const imported = engine.getTasks(target.requirementId).find((task) => task.stageId === importedTask.stageId)!

      expect(result).toEqual({ projectId: target.projectId, requirementId: target.requirementId, matched: 1, updated: 1, unchanged: 0 })
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
      const state = initNamedRequirement(engine, "import_idempotent_test")
      const document = engine.exportTasks(state.requirementId)
      const task = document.tasks[0]!
      document.tasks = [task]
      task.status = TaskStatus.COMPLETED
      task.assignedTo = "负责人"
      task.notes = "备注"
      task.completedAt = new Date().toISOString()

      expect(engine.importTasks(state.requirementId, document).updated).toBe(1)
      expect(engine.importTasks(state.requirementId, document)).toMatchObject({ updated: 0, unchanged: 1 })

      task.status = TaskStatus.PENDING
      task.assignedTo = null
      task.notes = null
      task.completedAt = null
      expect(engine.importTasks(state.requirementId, document).updated).toBe(1)

      const cleared = engine.getTasks(state.requirementId).find((item) => item.stageId === task.stageId)!
      expect(cleared.status).toBe(TaskStatus.PENDING)
      expect(cleared.assignedTo).toBeUndefined()
      expect(cleared.notes).toBeUndefined()
      expect(cleared.completedAt).toBeUndefined()
    })

    it("未知任务导致整批拒绝且目标状态不变", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "import_atomic_test")
      const document = engine.exportTasks(state.requirementId)
      document.tasks[0]!.status = TaskStatus.COMPLETED
      document.tasks[1]!.stageId = "unknown_stage"
      const before = engine.getState(state.requirementId)

      expect(() => engine.importTasks(state.requirementId, document)).toThrow("目标需求不存在任务 stageId: unknown_stage")
      expect(engine.getState(state.requirementId)).toEqual(before)
    })

    it("拒绝重复任务、未知版本和阶段不匹配", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "import_validation_test")
      const duplicate = engine.exportTasks(state.requirementId)
      duplicate.tasks = [duplicate.tasks[0]!, { ...duplicate.tasks[0]! }]
      expect(() => engine.importTasks(state.requirementId, duplicate)).toThrow("包含重复的 stageId")

      const unsupported = engine.exportTasks(state.requirementId) as unknown as Record<string, unknown>
      unsupported["version"] = 2
      expect(() => engine.importTasks(state.requirementId, unsupported)).toThrow("不支持的任务导入文件版本")

      const mismatch = engine.exportTasks(state.requirementId)
      mismatch.tasks = [mismatch.tasks[0]!]
      mismatch.tasks[0]!.phase = Phase.DESIGN
      expect(() => engine.importTasks(state.requirementId, mismatch)).toThrow("阶段不匹配")
    })
  })

  describe("completeTask", () => {
    it("完成任务", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "complete_test")
      const task = engine.getTasks(state.requirementId)[0]!
      engine.completeTask(state.requirementId, task.id)
      const done = engine.getTasks(state.requirementId).find((t) => t.id === task.id)!
      expect(done.status).toBe(TaskStatus.COMPLETED)
      expect(done.completedAt).toBeTruthy()
    })
  })

  describe("getRequirementStatus", () => {
    it("返回项目状态摘要", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "status_test")
      const status = engine.getRequirementStatus(state.requirementId)
      expect(status.currentPhase).toBe(Phase.INTENTION)
      expect(status.totalTasks).toBeGreaterThan(0)
    })
  })

  describe("project and requirement lifecycle", () => {
    it("同一状态库可创建多个需求并列出摘要", () => {
      const engine = createEngine()
      const first = initNamedRequirement(engine, "生命周期甲", "描述甲")
      const second = initNamedRequirement(engine, "生命周期乙", "描述乙")
      const summaries = engine.listRequirementSummaries()
      expect(summaries.map((item) => item.requirementId)).toEqual(
        expect.arrayContaining([first.requirementId, second.requirementId]),
      )
      const firstSummary = summaries.find((item) => item.requirementId === first.requirementId)
      expect(firstSummary).toMatchObject({
        projectId: first.projectId,
        requirementName: "生命周期甲",
        description: "描述甲",
        currentPhase: Phase.INTENTION,
      })
      expect(firstSummary?.totalTasks).toBeGreaterThan(0)

      const projectSummaries = engine.listProjectSummaries()
      expect(projectSummaries.map((item) => item.projectId)).toEqual(
        expect.arrayContaining([first.projectId, second.projectId]),
      )
      expect(projectSummaries.find((item) => item.projectId === first.projectId)).toMatchObject({
        name: "生命周期甲",
        requirementCount: 1,
      })
    })

    it("updateRequirement 可改名称与描述", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "待改名", "旧描述")
      const updated = engine.updateRequirement(state.requirementId, { name: "新名称", description: "新描述" })
      expect(updated.requirementName).toBe("新名称")
      expect(updated.description).toBe("新描述")
      expect(engine.getState(state.requirementId).requirementName).toBe("新名称")
    })

    it("deleteRequirement 后不再出现在列表中", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "待删除需求")
      engine.deleteRequirement(state.requirementId)
      expect(engine.listRequirements()).not.toContain(state.requirementId)
      expect(engine.listRequirementSummaries().some((item) => item.requirementId === state.requirementId)).toBe(false)
    })
  })

  describe("updateNodeSchedule", () => {
    it("可写入成对的计划日期", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "排期写入")
      const nodeId = state.steps[0]!.id
      const updated = engine.updateNodeSchedule(state.requirementId, nodeId, {
        plannedStart: "2026-03-01",
        plannedEnd: "2026-03-05",
      })
      const step = updated.steps.find((item) => item.id === nodeId)
      expect(step?.plannedStart).toBe("2026-03-01")
      expect(step?.plannedEnd).toBe("2026-03-05")
      expect(engine.getState(state.requirementId).steps.find((item) => item.id === nodeId)?.plannedStart).toBe("2026-03-01")
    })

    it("可清除计划日期", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "排期清除")
      const nodeId = state.steps[0]!.id
      engine.updateNodeSchedule(state.requirementId, nodeId, {
        plannedStart: "2026-03-01",
        plannedEnd: "2026-03-05",
      })
      const cleared = engine.updateNodeSchedule(state.requirementId, nodeId, {
        plannedStart: null,
        plannedEnd: null,
      })
      const step = cleared.steps.find((item) => item.id === nodeId)
      expect(step?.plannedStart).toBeUndefined()
      expect(step?.plannedEnd).toBeUndefined()
    })

    it("结束早于开始或只给一端时失败", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "排期校验")
      const nodeId = state.steps[0]!.id
      expect(() => engine.updateNodeSchedule(state.requirementId, nodeId, {
        plannedStart: "2026-03-05",
        plannedEnd: "2026-03-01",
      })).toThrow("计划结束日期不能早于开始日期")
      expect(() => engine.updateNodeSchedule(state.requirementId, nodeId, {
        plannedStart: "2026-03-01",
      })).toThrow("计划起止日期必须成对提供")
    })

    it("未知节点失败；旧状态缺字段仍可加载", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "排期未知节点")
      expect(() => engine.updateNodeSchedule(state.requirementId, "missing-node", {
        plannedStart: "2026-03-01",
        plannedEnd: "2026-03-02",
      })).toThrow("节点不存在")
      const step = engine.getState(state.requirementId).steps[0]
      expect(step?.plannedStart).toBeUndefined()
      expect(step?.plannedEnd).toBeUndefined()
    })
  })

  describe("canAdvance", () => {
    it("任务和清单都完成时允许前进", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "can_advance_pass")
      completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
      const checklist = engine.getChecklist(state.requirementId, Phase.INTENTION)
      for (const item of checklist.items) {
        engine.verifyChecklistItem(state.requirementId, Phase.INTENTION, item.id, Role.PM)
      }
      const gate = engine.canAdvance(state.requirementId)
      expect(gate.allowed).toBe(true)
      expect(gate.reasons).toHaveLength(0)
    })

    it("有未完成任务时阻止前进", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "can_advance_blocked_tasks")
      const gate = engine.canAdvance(state.requirementId)
      expect(gate.allowed).toBe(false)
      expect(gate.reasons.some((r) => r.includes("任务未完成"))).toBe(true)
    })

    it("最终阶段不允许前进", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "can_advance_final")
      // 手动推进到完结阶段
      let current = state
      while (current.currentPhase !== Phase.COMPLETED) {
        completeAllPhaseTasks(engine, current.requirementId, current.currentPhase)
        const checklist = engine.getChecklist(current.requirementId, current.currentPhase)
        for (const item of checklist.items) {
          engine.verifyChecklistItem(current.requirementId, current.currentPhase, item.id, Role.PM)
        }
        current = engine.advancePhase(current.requirementId)
      }
      const gate = engine.canAdvance(current.requirementId)
      expect(gate.allowed).toBe(false)
      expect(gate.reasons.some((r) => r.includes("最终阶段"))).toBe(true)
    })
  })

  describe("advancePhase failure", () => {
    it("任务未完成时抛出 PhaseLockedError", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "advance_fail_tasks")
      expect(() => engine.advancePhase(state.requirementId)).toThrow()
    })
  })

  describe("rollbackTo failure", () => {
    it("回退到后续阶段时抛出错误", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "rollback_fail")
      expect(() => engine.rollbackTo(state.requirementId, Phase.DESIGN)).toThrow()
    })
  })

  describe("checklist", () => {
    it("添加并核验清单项", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "checklist_test")
      const added = engine.addChecklistItem(
        state.requirementId,
        Phase.INTENTION,
        "文档",
        "PRD 已评审",
      )
      const item = added.checklists[Phase.INTENTION]!.items.at(-1)!
      const verified = engine.verifyChecklistItem(state.requirementId, Phase.INTENTION, item.id, Role.BA)
      const found = verified.checklists[Phase.INTENTION]!.items.find((i) => i.id === item.id)!
      expect(found.status).toBe("VERIFIED")
      expect(found.verifiedBy).toBe(Role.BA)
    })

    it("删除清单项", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "checklist_delete_test")
      const added = engine.addChecklistItem(
        state.requirementId,
        Phase.INTENTION,
        "文档",
        "临时项",
      )
      const item = added.checklists[Phase.INTENTION]!.items.at(-1)!
      const removed = engine.removeChecklistItem(state.requirementId, Phase.INTENTION, item.id)
      expect(removed.checklists[Phase.INTENTION]!.items.find((i) => i.id === item.id)).toBeUndefined()
    })
  })

  describe("heinrich", () => {
    it("记录观测并评估质量", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "heinrich_test")
      const logged = engine.logObservation(state.requirementId, Phase.INTENTION, HeinrichLevel.MAJOR, "崩溃")
      expect(logged.heinrich.majorDefects).toBe(1)
      const assessment = engine.assessQuality(state.requirementId)
      expect(assessment.verdict).toBe("INSUFFICIENT_DATA")
    })
  })

  describe("artifacts", () => {
    it("创建并查询制品", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "artifact_test")
      const created = engine.createArtifact(state.requirementId, {
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
  })

  describe("setTaskStatus", () => {
    it("设置任务状态并记录完成时间", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "set_status_test")
      const task = engine.getTasks(state.requirementId)[0]!
      engine.setTaskStatus(state.requirementId, task.id, TaskStatus.IN_PROGRESS)
      const found = engine.getTasks(state.requirementId).find((t) => t.id === task.id)!
      expect(found.status).toBe(TaskStatus.IN_PROGRESS)
      expect(found.completedAt).toBeUndefined()
      engine.setTaskStatus(state.requirementId, task.id, TaskStatus.COMPLETED)
      const done = engine.getTasks(state.requirementId).find((t) => t.id === task.id)!
      expect(done.status).toBe(TaskStatus.COMPLETED)
      expect(done.completedAt).toBeTruthy()
    })
  })

  describe("getPhaseProgress", () => {
    it("计算阶段任务进度", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "progress_test")
      const progress = engine.getPhaseProgress(state, Phase.INTENTION)
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
      const state = initNamedRequirement(engine, "unknown_task_test")
      expect(() => engine.completeTask(state.requirementId, "non_existent_task")).toThrow()
      expect(() => engine.setTaskStatus(state.requirementId, "non_existent_task", TaskStatus.IN_PROGRESS)).toThrow()
    })
  })

  describe("清单边界场景", () => {
    it("核验不存在的清单项应抛出错误", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "checklist_boundary_test")
      expect(() => engine.verifyChecklistItem(state.requirementId, Phase.INTENTION, "non_existent_item", Role.PM)).toThrow()
    })

    it("从不存在的阶段删除清单项应抛出错误", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "checklist_delete_boundary_test")
      expect(() => engine.removeChecklistItem(state.requirementId, Phase.RELEASE, "some_item")).toThrow()
    })
  })

  describe("海因里希边界场景", () => {
    it("解决不存在的观测应抛出错误", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "heinrich_boundary_test")
      expect(() => engine.resolveObservation(state.requirementId, "non_existent_obs")).toThrow()
    })
  })

  describe("阶段门禁正向场景", () => {
    it("所有任务完成且清单核验后允许前进", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "gate_positive_test")
      completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
      const checklist = engine.getChecklist(state.requirementId, Phase.INTENTION)
      for (const item of checklist.items) {
        engine.verifyChecklistItem(state.requirementId, Phase.INTENTION, item.id, Role.PM)
      }
      const gate = engine.canAdvance(state.requirementId)
      expect(gate.allowed).toBe(true)
      expect(gate.reasons).toHaveLength(0)
    })
  })

  describe("阶段门禁负向场景", () => {
    it("有未完成任务时阻止前进并返回具体原因", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "gate_negative_tasks")
      const gate = engine.canAdvance(state.requirementId)
      expect(gate.allowed).toBe(false)
      expect(gate.reasons.length).toBeGreaterThan(0)
      expect(gate.reasons.some((r) => r.includes("任务未完成"))).toBe(true)
    })

    it("有未核验清单项时阻止前进并返回具体原因", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "gate_negative_checklist")
      completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
      engine.addChecklistItem(state.requirementId, Phase.INTENTION, "文档", "待核验项")
      const gate = engine.canAdvance(state.requirementId)
      expect(gate.allowed).toBe(false)
      expect(gate.reasons.some((r) => r.includes("清单未核验"))).toBe(true)
    })
  })
})
