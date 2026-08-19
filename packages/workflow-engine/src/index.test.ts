import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Phase, PhaseLock } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import { Role } from "@octopus/core/role.js"
import { ArtifactType } from "@octopus/core/artifact.js"
import { TaskId } from "@octopus/core/branded-ids.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { InvalidPhaseTransitionError } from "@octopus/core/errors.js"
import { createStateStore } from "@octopus/context/index.js"
import { TeambitionVersionClient } from "@octopus/integration/index.js"
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

  describe("updateRequirementSchedule", () => {
    it("可写入成对的计划日期", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "req_schedule_write")
      const updated = engine.updateRequirementSchedule(state.requirementId, {
        plannedStart: "2026-03-01",
        plannedEnd: "2026-03-12",
      })
      expect(updated.plannedStart).toBe("2026-03-01")
      expect(updated.plannedEnd).toBe("2026-03-12")
      expect(engine.getState(state.requirementId).plannedStart).toBe("2026-03-01")
      expect(engine.getState(state.requirementId).plannedEnd).toBe("2026-03-12")
    })

    it("可清除计划日期", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "req_schedule_clear")
      engine.updateRequirementSchedule(state.requirementId, {
        plannedStart: "2026-03-01",
        plannedEnd: "2026-03-12",
      })
      const cleared = engine.updateRequirementSchedule(state.requirementId, {
        plannedStart: null,
        plannedEnd: null,
      })
      expect(cleared.plannedStart).toBeUndefined()
      expect(cleared.plannedEnd).toBeUndefined()
    })

    it("结束早于开始时失败", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "req_schedule_end_before_start")
      expect(() => engine.updateRequirementSchedule(state.requirementId, {
        plannedStart: "2026-03-12",
        plannedEnd: "2026-03-01",
      })).toThrow("计划结束日期不能早于开始日期")
    })

    it("只给一端时失败", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "req_schedule_one_sided")
      expect(() => engine.updateRequirementSchedule(state.requirementId, {
        plannedStart: "2026-03-01",
      })).toThrow("计划起止日期必须成对提供")
    })
  })

  describe("moveRequirementPhase", () => {
    it("同阶段 no-op", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "move_noop")
      const result = engine.moveRequirementPhase(state.requirementId, Phase.INTENTION)
      expect(result.currentPhase).toBe(Phase.INTENTION)
    })

    it("前进到下一阶段走 advancePhase", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "move_advance")
      completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
      const result = engine.moveRequirementPhase(state.requirementId, Phase.RESEARCH)
      expect(result.currentPhase).toBe(Phase.RESEARCH)
    })

    it("回退到前置阶段走 rollbackTo", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "move_rollback")
      completeAllPhaseTasks(engine, state.requirementId, Phase.INTENTION)
      engine.advancePhase(state.requirementId)
      const result = engine.moveRequirementPhase(state.requirementId, Phase.INTENTION)
      expect(result.currentPhase).toBe(Phase.INTENTION)
    })

    it("跨列前进抛 InvalidPhaseTransitionError", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "move_cross_jump")
      expect(() => engine.moveRequirementPhase(state.requirementId, Phase.DESIGN)).toThrow(InvalidPhaseTransitionError)
    })

    it("未知阶段抛错", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "move_unknown")
      expect(() => engine.moveRequirementPhase(state.requirementId, "UnknownPhase" as Phase)).toThrow("未知阶段")
    })
  })

  describe("milestones", () => {
    it("可新增并按日期列出", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_add")
      const later = engine.addMilestone(state.requirementId, { name: "上线", date: "2026-04-01" })
      const earlier = engine.addMilestone(state.requirementId, { name: "设计评审", date: "2026-03-12" })
      const listed = engine.listMilestones(state.requirementId)
      expect(listed.map((item) => item.id)).toEqual([earlier.id, later.id])
      expect(listed[0]?.status).toBe("planned")
    })

    it("拒绝空名称、非法日期、不存在的节点", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_validate")
      expect(() => engine.addMilestone(state.requirementId, { name: "  ", date: "2026-03-12" }))
        .toThrow("里程碑名称必须是 1–80 个字符")
      expect(() => engine.addMilestone(state.requirementId, { name: "评审", date: "03-12" }))
        .toThrow("里程碑日期必须是 YYYY-MM-DD")
      expect(() => engine.addMilestone(state.requirementId, {
        name: "评审",
        date: "2026-03-12",
        nodeId: "missing-node",
      })).toThrow("节点不存在: missing-node")
    })

    it("可改期、挂钩阶段，但不能清空日期", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_update")
      const created = engine.addMilestone(state.requirementId, { name: "评审", date: "2026-03-12" })
      const updated = engine.updateMilestone(state.requirementId, created.id, {
        date: "2026-03-20",
        phase: Phase.DESIGN,
      })
      expect(updated.date).toBe("2026-03-20")
      expect(updated.phase).toBe(Phase.DESIGN)
      expect(() => engine.updateMilestone(state.requirementId, created.id, { date: null }))
        .toThrow("里程碑日期必须是 YYYY-MM-DD")
    })

    it("reach / unreach 可往返，重复操作为 no-op", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_reach")
      const created = engine.addMilestone(state.requirementId, { name: "评审", date: "2026-03-12" })
      const reached = engine.reachMilestone(state.requirementId, created.id)
      expect(reached.status).toBe("reached")
      expect(reached.reachedAt).toBeTypeOf("string")
      expect(engine.reachMilestone(state.requirementId, created.id).reachedAt).toBe(reached.reachedAt)
      const planned = engine.unreachMilestone(state.requirementId, created.id)
      expect(planned.status).toBe("planned")
      expect(planned.reachedAt).toBeUndefined()
    })

    it("删除后不可再取", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_delete")
      const created = engine.addMilestone(state.requirementId, { name: "评审", date: "2026-03-12" })
      engine.deleteMilestone(state.requirementId, created.id)
      expect(engine.listMilestones(state.requirementId)).toEqual([])
      expect(() => engine.deleteMilestone(state.requirementId, created.id)).toThrow("里程碑不存在")
    })

    it("listProjectMilestones 跨需求按日期排序", () => {
      const engine = createEngine()
      const project = engine.createProject("里程碑项目")
      const first = engine.initRequirement(project.projectId, "需求A")
      const second = engine.initRequirement(project.projectId, "需求B")
      engine.addMilestone(second.requirementId, { name: "B晚", date: "2026-04-01" })
      engine.addMilestone(first.requirementId, { name: "A早", date: "2026-03-01" })
      const listed = engine.listProjectMilestones(project.projectId)
      expect(listed.map((item) => item.name)).toEqual(["A早", "B晚"])
      expect(listed[0]?.requirementName).toBe("需求A")
    })

    it("updateMilestone 挂钩非法 nodeId 抛错", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_bad_node")
      const created = engine.addMilestone(state.requirementId, { name: "评审", date: "2026-03-12" })
      expect(() => engine.updateMilestone(state.requirementId, created.id, { nodeId: "no-such-node" }))
        .toThrow("节点不存在: no-such-node")
    })

    it("updateMilestone nodeId: null / phase: null 清除对应字段", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_clear_fields")
      const created = engine.addMilestone(state.requirementId, {
        name: "评审",
        date: "2026-03-12",
        nodeId: state.steps[0]!.id,
        phase: Phase.DESIGN,
      })
      const cleared = engine.updateMilestone(state.requirementId, created.id, { nodeId: null, phase: null })
      expect(cleared.nodeId).toBeUndefined()
      expect(cleared.phase).toBeUndefined()
    })

    it("updateMilestone 对不存在 milestoneId 抛错", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_missing")
      expect(() => engine.updateMilestone(state.requirementId, "fake-id", { name: "新名" }))
        .toThrow("里程碑不存在: fake-id")
    })

    it("unreachMilestone 对已 planned 里程碑为 no-op", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_unreach_planned")
      const created = engine.addMilestone(state.requirementId, { name: "评审", date: "2026-03-12" })
      const result = engine.unreachMilestone(state.requirementId, created.id)
      expect(result.status).toBe("planned")
      expect(result.reachedAt).toBeUndefined()
      expect(result.id).toBe(created.id)
    })

    it("摘要透出下一条未达成里程碑", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "ms_summary")
      engine.addMilestone(state.requirementId, { name: "上线", date: "2026-04-01" })
      const early = engine.addMilestone(state.requirementId, { name: "评审", date: "2026-03-12" })
      engine.reachMilestone(state.requirementId, early.id)
      const summary = engine.listRequirementSummaries(state.projectId)
        .find((item) => item.requirementId === state.requirementId)
      expect(summary?.milestoneCount).toBe(2)
      expect(summary?.nextMilestone).toEqual({
        id: expect.any(String),
        name: "上线",
        date: "2026-04-01",
        overdue: expect.any(Boolean),
      })
    })
  })
})

describe("OmniPlan 导入导出", () => {
  it("exportProjectOmniPlan 应写 tmp 目录生成 .oplx", () => {
    const engine = createEngine()
    const project = engine.createProject("Test Project")
    const req = engine.initRequirement(project.projectId, "需求A")
    engine.updateNodeSchedule(req.requirementId, req.steps[0]!.id, { plannedStart: "2026-03-01", plannedEnd: "2026-03-05" })

    const result = engine.exportProjectOmniPlan(project.projectId, { rootDir: testStoreDir })

    expect(result.path).toContain(".oplx")
    expect(result.taskCount).toBeGreaterThan(0)
    expect(result.folder).toBeTruthy()

    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs")
    expect(existsSync(result.path)).toBe(true)
    const buf = readFileSync(result.path)
    expect(buf.length).toBeGreaterThan(100)
  })

  it("importProjectOmniPlan 只更新匹配任务、不匹配进 unmatched、缺日期跳过不清排期", () => {
    const engine = createEngine()
    const project = engine.createProject("Import Project")
    const req = engine.initRequirement(project.projectId, "需求X")
    const nodeA = req.steps[0]!
    engine.updateRequirementSchedule(req.requirementId, { plannedStart: "2026-04-01", plannedEnd: "2026-04-10" })
    engine.updateNodeSchedule(req.requirementId, nodeA.id, { plannedStart: "2026-04-01", plannedEnd: "2026-04-03" })

    // 先导出
    const exported = engine.exportProjectOmniPlan(project.projectId, { rootDir: testStoreDir })

    // 再导入同文件
    const imported = engine.importProjectOmniPlan(project.projectId, { path: exported.path })

    expect(imported.path).toBe(exported.path)
    expect(imported.updatedRequirements).toBeGreaterThanOrEqual(1)
    expect(imported.skipped.length).toBeGreaterThanOrEqual(0)

    // 验证原有排期未被清除
    const state = engine.getState(req.requirementId)
    const step = state.steps.find((s) => s.id === nodeA.id)
    expect(step?.plannedStart).toBeTruthy()
    expect(step?.plannedEnd).toBeTruthy()
  })

  it("setProjectOmniPlanMeta 应只允许三个指定键", () => {
    const engine = createEngine()
    const project = engine.createProject("Meta Project")

    const updated = engine.setProjectOmniPlanMeta(project.projectId, {
      omniplanFolder: "my-folder",
      omniplanFileName: "test.oplx",
    })
    expect(updated.metadata?.["omniplanFolder"]).toBe("my-folder")
    expect(updated.metadata?.["omniplanFileName"]).toBe("test.oplx")

    expect(() => engine.setProjectOmniPlanMeta(project.projectId, { omniplanFolder: "../../etc" as unknown as string }))
      .toThrow()
  })

  it("BRD 配置 get/set 深合并并持久化到 metadata", () => {
    const engine = createEngine()
    const project = engine.createProject("BRD Meta")
    expect(engine.getProjectBrdDesignConfig(project.projectId).sources).toEqual({})

    engine.setProjectBrdDesignConfig(project.projectId, {
      sources: { frontendCodePath: "web", websiteUrl: "https://a.test" },
      brdOutputPath: "docs/brd.md",
      prompts: { generate: { user: "自定义 {{requirementName}}" } },
    })
    const loaded = engine.getProjectBrdDesignConfig(project.projectId)
    expect(loaded.sources.frontendCodePath).toBe("web")
    expect(loaded.brdOutputPath).toBe("docs/brd.md")
    expect(loaded.prompts?.generate?.user).toContain("自定义")

    engine.setProjectBrdDesignConfig(project.projectId, {
      sources: { frontendCodePath: "" },
    })
    expect(engine.getProjectBrdDesignConfig(project.projectId).sources.frontendCodePath).toBeUndefined()
    expect(engine.getProjectBrdDesignConfig(project.projectId).sources.websiteUrl).toBe("https://a.test")
  })

  it("previewBrdPrompts / generateBrd dryRun / generateBrd 写文件", async () => {
    const { mkdirSync, writeFileSync, readFileSync, existsSync } = await import("node:fs")
    const projectRoot = join(testStoreDir, "brd-proj")
    mkdirSync(join(projectRoot, "web"), { recursive: true })
    writeFileSync(join(projectRoot, "web", "README.md"), "# frontend")

    const calls: string[] = []
    const fakeClient = {
      callAssistant: async (type: string, input: string) => {
        calls.push(type)
        const envelope = JSON.parse(input) as { system: string; prompt: string }
        expect(envelope.system).toBeTruthy()
        expect(envelope.prompt).toContain("功能X")
        return { result: "# BRD\n生成内容" }
      },
    }
    const engine = new WorkflowEngine({
      store: createStateStore({ storeDir: testStoreDir }),
      aiClient: fakeClient as never,
    })
    const project = engine.createProject("BRD Gen")
    engine.setProjectBrdDesignConfig(project.projectId, {
      sources: { frontendCodePath: "web" },
      brdOutputPath: "out/brd.md",
    })
    const req = engine.initRequirement(project.projectId, "功能X", "描述", projectRoot)

    const preview = engine.previewBrdPrompts(project.projectId, req.requirementId, { mode: "generate" })
    expect(preview.prompts).toHaveLength(1)
    expect(preview.prompts[0]!.id).toBe("generate")
    expect(preview.prompts[0]!.prompt).toContain("功能X")

    const dry = await engine.generateBrd(project.projectId, req.requirementId, { dryRun: true })
    expect(dry.dryRun).toBe(true)
    expect(calls).toHaveLength(0)

    const generated = await engine.generateBrd(project.projectId, req.requirementId)
    expect(generated.result).toContain("生成内容")
    expect(calls).toEqual(["BRD_GENERATE"])
    expect(existsSync(join(projectRoot, "out/brd.md"))).toBe(true)
    expect(readFileSync(join(projectRoot, "out/brd.md"), "utf8")).toContain("生成内容")
    expect(engine.getArtifacts(req.requirementId, undefined, "BRD").length).toBeGreaterThanOrEqual(1)

    const checked = await engine.checkBrd(project.projectId, req.requirementId)
    expect(checked.result).toBeDefined()
    expect(calls).toContain("BRD_CHECK")
    expect(existsSync(join(projectRoot, "out/brd-check-report.md"))).toBe(true)
    expect(readFileSync(join(projectRoot, "out/brd.md"), "utf8")).toContain("生成内容")
  })

  it("OmniPlan 里程碑往返：export → 改日期 → import → date 更新", () => {
    const engine = createEngine()
    const project = engine.createProject("Ms RoundTrip")
    const req = engine.initRequirement(project.projectId, "需求M")
    engine.addMilestone(req.requirementId, { name: "上线", date: "2026-04-01" })

    // Export
    const exported = engine.exportProjectOmniPlan(project.projectId, { rootDir: testStoreDir })

    // Modify the exported XML: change milestone locked-start-date
    const { readFileSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
    const { unpackOplx, packOplx } = require("@octopus/integration/omniplan.js") as typeof import("@octopus/integration/omniplan.js")
    const buf = readFileSync(exported.path)
    const { actualXml, tocXml, entries } = unpackOplx(buf)
    const modifiedXml = actualXml.replace("2026-04-01T02:00:00.000Z", "2026-05-15T02:00:00.000Z")
    const repacked = packOplx(modifiedXml, tocXml, entries)
    writeFileSync(exported.path, repacked)

    // Import
    const imported = engine.importProjectOmniPlan(project.projectId, { path: exported.path })
    expect(imported.updatedMilestones).toBe(1)

    const milestones = engine.listMilestones(req.requirementId)
    expect(milestones.length).toBe(1)
    expect(milestones[0]!.date).toBe("2026-05-15")
  })

  it("未知里程碑（无 note/idMap/同名）应 skipped 不自动新建", () => {
    const engine = createEngine()
    const project = engine.createProject("Ms Unknown")
    const req = engine.initRequirement(project.projectId, "需求U")
    // No milestone added

    // Manually build an XML with an unknown milestone
    const { buildOmniPlanActual, packOplx, buildTocXml } = require("@octopus/integration/omniplan.js") as typeof import("@octopus/integration/omniplan.js")
    const actualXml = buildOmniPlanActual({
      projectName: "Ms Unknown",
      scenarioId: "op-unk",
      requirements: [{
        id: req.requirementId,
        name: "需求U",
        nodes: [],
        milestones: [{ id: "ms_foo", name: "Ghost", date: "2026-06-01" }],
      }],
      idMap: {},
    })
    const tocXml = buildTocXml("op-unk")
    const packed = packOplx(actualXml, tocXml)

    const { mkdtempSync, writeFileSync, mkdirSync, existsSync } = require("node:fs") as typeof import("node:fs")
    const { tmpdir } = require("node:os") as typeof import("node:os")
    const { join } = require("node:path") as typeof import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "octopus-ms-unk-"))
    mkdirSync(`${dir}/Projects/ms-unknown`, { recursive: true })
    const filePath = `${dir}/Projects/ms-unknown/Unknown.oplx`
    writeFileSync(filePath, packed)

    const imported = engine.importProjectOmniPlan(project.projectId, { path: filePath })
    expect(imported.updatedMilestones).toBe(0)
    expect(imported.skipped).toContain(`milestone:${req.requirementId}:ms_foo`)
    // No milestone should be created
    expect(engine.listMilestones(req.requirementId).length).toBe(0)
  })

  it("缺 locked-start-date 的已匹配里程碑应 skipped 不清除原日期", () => {
    const engine = createEngine()
    const project = engine.createProject("Ms NoDate")
    const req = engine.initRequirement(project.projectId, "需求D")
    engine.addMilestone(req.requirementId, { name: "评审", date: "2026-07-01" })

    // Build XML with milestone note but no locked-start-date
    const { buildOmniPlanActual, packOplx, buildTocXml } = require("@octopus/integration/omniplan.js") as typeof import("@octopus/integration/omniplan.js")
    const { stableTaskId } = require("@octopus/integration/omniplan.js") as typeof import("@octopus/integration/omniplan.js")
    const msId = engine.listMilestones(req.requirementId)[0]!.id
    const actualXml = buildOmniPlanActual({
      projectName: "Ms NoDate",
      scenarioId: "op-nodate",
      requirements: [{
        id: req.requirementId,
        name: "需求D",
        nodes: [],
        // Pass empty milestones so the group is built, but we'll craft the XML manually
        milestones: [],
      }],
      idMap: {},
    })
    // Insert a milestone task with note but no locked-start-date
    const milestoneNote = `octopus:milestone:${req.requirementId}:${msId}`
    const milestoneXml = `  <task id="t-nodate">
    <title>评审</title>
    <note>${milestoneNote}</note>
    <type>milestone</type>
    <effort>0</effort>
    <recalculate>duration</recalculate>
    <static-cost>0</static-cost>
  </task>`
    const modifiedXml = actualXml.replace(
      "</scenario>",
      `${milestoneXml}\n</scenario>`,
    )
    const tocXml = buildTocXml("op-nodate")
    const packed = packOplx(modifiedXml, tocXml)

    const { mkdtempSync, writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs")
    const { tmpdir } = require("node:os") as typeof import("node:os")
    const { join } = require("node:path") as typeof import("node:path")
    const dir = mkdtempSync(join(tmpdir(), "octopus-ms-nodate-"))
    mkdirSync(`${dir}/Projects/ms-nodate`, { recursive: true })
    const filePath = `${dir}/Projects/ms-nodate/NoDate.oplx`
    writeFileSync(filePath, packed)

    const imported = engine.importProjectOmniPlan(project.projectId, { path: filePath })
    expect(imported.updatedMilestones).toBe(0)
    expect(imported.skipped).toContain(`milestone:${req.requirementId}:${msId}`)

    // Original date should be preserved
    const milestones = engine.listMilestones(req.requirementId)
    expect(milestones.length).toBe(1)
    expect(milestones[0]!.date).toBe("2026-07-01")
  })

  describe("updateRequirement owner", () => {
    it("设置 owner", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "owner 设")
      const updated = engine.updateRequirement(state.requirementId, { owner: "张三" })
      expect(updated.owner).toBe("张三")
      expect(engine.getState(state.requirementId).owner).toBe("张三")
    })

    it("owner: null 清除", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "owner 清除")
      engine.updateRequirement(state.requirementId, { owner: "张三" })
      const cleared = engine.updateRequirement(state.requirementId, { owner: null })
      expect(cleared.owner).toBeUndefined()
      expect(engine.getState(state.requirementId).owner).toBeUndefined()
    })

    it("owner: 空串清除", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "owner 空串")
      engine.updateRequirement(state.requirementId, { owner: "张三" })
      const cleared = engine.updateRequirement(state.requirementId, { owner: "" })
      expect(cleared.owner).toBeUndefined()
    })

    it("超长 owner 抛错", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "owner 超长")
      const longName = "A".repeat(81)
      expect(() => engine.updateRequirement(state.requirementId, { owner: longName })).toThrow("负责人必须是 1–80 个字符")
    })
  })

  describe("assignNode", () => {
    it("设置 assignedTo", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "节点分配")
      const nodeId = state.steps[0]!.id
      const updated = engine.assignNode(state.requirementId, nodeId, "Alice")
      const step = updated.steps.find((item) => item.id === nodeId)
      expect(step?.assignedTo).toBe("Alice")
    })

    it("清除 assignedTo (null)", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "节点清除")
      const nodeId = state.steps[0]!.id
      engine.assignNode(state.requirementId, nodeId, "Alice")
      const cleared = engine.assignNode(state.requirementId, nodeId, null)
      const step = cleared.steps.find((item) => item.id === nodeId)
      expect(step?.assignedTo).toBeUndefined()
    })

    it("清除 assignedTo (空串)", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "节点清除空串")
      const nodeId = state.steps[0]!.id
      engine.assignNode(state.requirementId, nodeId, "Alice")
      const cleared = engine.assignNode(state.requirementId, nodeId, "")
      const step = cleared.steps.find((item) => item.id === nodeId)
      expect(step?.assignedTo).toBeUndefined()
    })

    it("超长 assignedTo 抛错", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "节点超长")
      const nodeId = state.steps[0]!.id
      const longName = "A".repeat(81)
      expect(() => engine.assignNode(state.requirementId, nodeId, longName)).toThrow("负责人必须是 1–80 个字符")
    })

    it("节点不存在抛错", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "节点不存在")
      expect(() => engine.assignNode(state.requirementId, "missing-node", "Bob")).toThrow("节点不存在:")
    })
  })

  describe("listMyWork", () => {
    it("空身份返回空列表", () => {
      const engine = createEngine()
      initNamedRequirement(engine, "空身份")
      const result = engine.listMyWork("")
      expect(result.requirements).toEqual([])
      expect(result.nodes).toEqual([])
      expect(result.identity).toBe("")
    })

    it("trim+大小写不敏感匹配", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "trim 匹配")
      engine.assignNode(state.requirementId, state.steps[0]!.id, "Alice")
      const result = engine.listMyWork("alice")
      expect(result.nodes.length).toBe(1)
      expect(result.nodes[0]!.assignedTo).toBe("Alice")
    })

    it("trim 后带空格也能匹配", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "trim 空格")
      engine.updateRequirement(state.requirementId, { owner: "Bob" })
      const result = engine.listMyWork("  Bob  ")
      expect(result.requirements.length).toBe(1)
      expect(result.requirements[0]!.owner).toBe("Bob")
    })

    it("COMPLETED 节点排除", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "排除已完成")
      const nodeId = state.steps[0]!.id
      engine.assignNode(state.requirementId, nodeId, "Charlie")
      engine.completeTask(state.requirementId, engine.getTasks(state.requirementId)[0]!.id)
      const result = engine.listMyWork("Charlie")
      expect(result.nodes.length).toBe(0)
    })

    it("projectId 过滤", () => {
      const engine = createEngine()
      const p1 = engine.createProject("项目1")
      const p2 = engine.createProject("项目2")
      const s1 = engine.initRequirement(p1.projectId, "需求A")
      engine.initRequirement(p2.projectId, "需求B")
      engine.updateRequirement(s1.requirementId, { owner: "Dave" })
      const allResult = engine.listMyWork("Dave")
      expect(allResult.requirements.length).toBe(1)
      const filtered = engine.listMyWork("Dave", p2.projectId)
      expect(filtered.requirements.length).toBe(0)
    })
  })

  describe("getProjectOverview", () => {
    it("空项目返回全 0", () => {
      const engine = createEngine()
      const project = engine.createProject("空项目")
      const overview = engine.getProjectOverview(project.projectId)
      expect(overview.requirementCount).toBe(0)
      expect(overview.byPhase.every((item) => item.count === 0)).toBe(true)
      expect(overview.heinrich).toEqual({ major: 0, minor: 0, trivial: 0 })
      expect(overview.ownerlessCount).toBe(0)
    })

    it("阶段计数正确", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "阶段计数")
      const overview = engine.getProjectOverview(state.projectId)
      const intentionPhase = overview.byPhase.find((item) => item.phase === Phase.INTENTION)
      expect(intentionPhase?.count).toBe(1)
    })

    it("逾期计数 (milestone + plannedEnd)", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "逾期计数")
      engine.updateRequirementSchedule(state.requirementId, {
        plannedStart: "2025-01-01",
        plannedEnd: "2025-01-10",
      })
      engine.addMilestone(state.requirementId, { name: "里程碑", date: "2025-01-05" })
      const overview = engine.getProjectOverview(state.projectId)
      expect(overview.milestoneOverdue).toBeGreaterThanOrEqual(1)
    })

    it("Heinrich 合计", () => {
      const engine = createEngine()
      const state = initNamedRequirement(engine, "Heinrich 合计")
      engine.logObservation(state.requirementId, Phase.INTENTION, HeinrichLevel.MAJOR, "缺陷")
      engine.logObservation(state.requirementId, Phase.INTENTION, HeinrichLevel.MAJOR, "缺陷2")
      const overview = engine.getProjectOverview(state.projectId)
      expect(overview.heinrich.major).toBeGreaterThanOrEqual(2)
    })
  })
})

describe("setProjectDefaultColor", () => {
  it("设置合法色值写入 metadata.defaultColor", () => {
    const engine = createEngine()
    const project = engine.createProject("颜色项目")
    const updated = engine.setProjectDefaultColor(project.projectId, "#ff8800")
    expect(updated.metadata?.["defaultColor"]).toBe("#ff8800")
  })

  it("null / 空串清除（删除键）", () => {
    const engine = createEngine()
    const project = engine.createProject("颜色项目")
    engine.setProjectDefaultColor(project.projectId, "#ff8800")
    const cleared = engine.setProjectDefaultColor(project.projectId, null)
    expect(cleared.metadata?.["defaultColor"]).toBeUndefined()
    engine.setProjectDefaultColor(project.projectId, "#112233")
    const cleared2 = engine.setProjectDefaultColor(project.projectId, "")
    expect(cleared2.metadata?.["defaultColor"]).toBeUndefined()
  })

  it("非法色值抛错且 metadata 不变", () => {
    const engine = createEngine()
    const project = engine.createProject("颜色项目")
    expect(() => engine.setProjectDefaultColor(project.projectId, "red")).toThrow("默认颜色必须是 #rrggbb 格式")
    expect(() => engine.setProjectDefaultColor(project.projectId, "#fff")).toThrow()
    expect(() => engine.setProjectDefaultColor(project.projectId, "#12345g")).toThrow()
    expect(engine.getProject(project.projectId).metadata?.["defaultColor"]).toBeUndefined()
  })
})

describe("Teambition 版本计划编排", () => {
  function makeEngine() {
    const store = createStateStore({ storeDir: testStoreDir })
    const client = new TeambitionVersionClient({ appId: "a", appSecret: "s", orgId: "o" })
    const engine = new WorkflowEngine({
      store,
      integrations: { "teambition-version": client },
    })
    return { engine, store, client }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("无版本客户端时抛未配置", async () => {
    const engine = createEngine()
    const project = engine.createProject("P")
    await expect(engine.bindProjectTeambitionRepo(project.projectId, { repoId: "repo1" }))
      .rejects.toThrow("未配置 Teambition 版本管理")
  })

  it("绑仓库不改 project.teambition", async () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    store.updateProject(project.projectId, (cur) => {
      cur.teambition = { projectId: "tb-proj", name: "TB" }
      return cur
    })
    await engine.bindProjectTeambitionRepo(project.projectId, { repoId: "repo1" })
    const loaded = store.loadProject(project.projectId)
    expect(loaded.teambition).toEqual({ projectId: "tb-proj", name: "TB" })
    expect(loaded.teambitionVersion?.repoId).toBe("repo1")
  })

  it("unbindProjectTeambition 不删 teambitionVersion", () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    store.updateProject(project.projectId, (cur) => {
      cur.teambition = { projectId: "tb" }
      cur.teambitionVersion = { repoId: "repo1" }
      return cur
    })
    engine.unbindProjectTeambition(project.projectId)
    const loaded = store.loadProject(project.projectId)
    expect(loaded.teambition).toBeUndefined()
    expect(loaded.teambitionVersion?.repoId).toBe("repo1")
  })

  it("unbindRequirementTask 不删 state.teambitionVersion", () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    const req = store.createRequirement(project.projectId, "R")
    store.update(req.requirementId, (cur) => {
      cur.teambition = { taskId: "t1" }
      cur.teambitionVersion = { versionId: "v1", repoId: "repo1" }
      return cur
    })
    engine.unbindRequirementTask(req.requirementId)
    const state = store.load(req.requirementId)
    expect(state.teambition).toBeUndefined()
    expect(state.teambitionVersion?.versionId).toBe("v1")
  })

  it("UNCONFIRMED 绑仓库成功后 listProjectVersions 抛中文、不返回 []", async () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    await engine.bindProjectTeambitionRepo(project.projectId, { repoId: "repo1" })
    const loaded = store.loadProject(project.projectId)
    expect(loaded.teambitionVersion?.listSyncStatus).toBe("unconfirmed")
    await expect(engine.listProjectVersions(project.projectId)).rejects.toThrow("尚未确认")
  })

  it("TTL 内且 listSyncStatus=ok 时 listProjectVersions 不打客户端", async () => {
    const { engine, store, client } = makeEngine()
    const project = store.createProject("P")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = {
        repoId: "repo1",
        listSyncStatus: "ok",
        versionsCachedAt: new Date().toISOString(),
        versionsCache: [{ versionId: "v1", name: "版本1" }],
      }
      return cur
    })
    const spy = vi.spyOn(client, "listVersions")
    const versions = await engine.listProjectVersions(project.projectId)
    expect(versions).toEqual([{ versionId: "v1", name: "版本1", repoId: "repo1" }])
    expect(spy).not.toHaveBeenCalled()
  })

  it("refresh:true 时 listProjectVersions 打客户端并回写缓存", async () => {
    const { engine, store, client } = makeEngine()
    const project = store.createProject("P")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = {
        repoId: "repo1",
        listSyncStatus: "ok",
        versionsCachedAt: new Date().toISOString(),
        versionsCache: [{ versionId: "v1", name: "旧" }],
      }
      return cur
    })
    vi.spyOn(client, "listVersions").mockResolvedValue({
      success: true,
      message: "ok",
      data: [{ versionId: "v2", name: "新" }],
    })
    const versions = await engine.listProjectVersions(project.projectId, { refresh: true })
    expect(versions[0]!.versionId).toBe("v2")
    expect(store.loadProject(project.projectId).teambitionVersion?.listSyncStatus).toBe("ok")
  })

  it("从未 sync 时 bindRequirementVersion 裸 id 成功、零网络", async () => {
    const { engine, store, client } = makeEngine()
    const project = store.createProject("P")
    const req = store.createRequirement(project.projectId, "R")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = { repoId: "repo1" }
      return cur
    })
    const spy = vi.spyOn(client, "listVersions")
    const state = await engine.bindRequirementVersion(req.requirementId, "ver_x")
    expect(state.teambitionVersion?.versionId).toBe("ver_x")
    expect(state.teambitionVersion?.versionName).toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it("listVersions 401 导致 error 后 bindRequirementVersion 裸 id 成功且 0 额外 fetch", async () => {
    const { engine, store, client } = makeEngine()
    const project = store.createProject("P")
    const req = store.createRequirement(project.projectId, "R")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = { repoId: "repo1" }
      return cur
    })
    const spy = vi.spyOn(client, "listVersions").mockResolvedValue({
      success: false,
      message: "Teambition 版本管理鉴权失败",
      error: "401",
    })
    await expect(engine.syncProjectVersions(project.projectId)).rejects.toThrow("鉴权失败")
    expect(spy).toHaveBeenCalledTimes(1)
    const state = await engine.bindRequirementVersion(req.requirementId, "ver_x")
    expect(state.teambitionVersion?.versionId).toBe("ver_x")
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("成功空列表后裸未知 id 抛版本不存在", async () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    const req = store.createRequirement(project.projectId, "R")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = {
        repoId: "repo1",
        listSyncStatus: "ok",
        versionsCachedAt: new Date().toISOString(),
        versionsCache: [],
      }
      return cur
    })
    await expect(engine.bindRequirementVersion(req.requirementId, "unknown_id"))
      .rejects.toThrow("版本不存在: unknown_id")
  })

  it("同一需求重复绑定覆盖旧版本", async () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    const req = store.createRequirement(project.projectId, "R")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = { repoId: "repo1" }
      return cur
    })
    await engine.bindRequirementVersion(req.requirementId, "v1")
    const state2 = await engine.bindRequirementVersion(req.requirementId, "v2")
    expect(state2.teambitionVersion?.versionId).toBe("v2")
    expect(store.load(req.requirementId).teambitionVersion?.versionId).toBe("v2")
  })

  it("updateVersionNote 允许空串", async () => {
    const { engine, store, client } = makeEngine()
    const project = store.createProject("P")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = { repoId: "repo1" }
      return cur
    })
    vi.spyOn(client, "updateVersionNote").mockResolvedValue({
      success: true,
      message: "ok",
      data: { repoId: "repo1", versionId: "v1", note: "" },
    })
    const result = await engine.updateVersionNote(project.projectId, "v1", "")
    expect(result).toEqual({ versionId: "v1", note: "" })
  })

  it("listVersionRequirements 按 requirementName 排序并可按版本过滤", () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    const alpha = store.createRequirement(project.projectId, "Alpha")
    const zulu = store.createRequirement(project.projectId, "Zulu")
    const mike = store.createRequirement(project.projectId, "Mike")
    store.update(alpha.requirementId, (cur) => { cur.teambitionVersion = { versionId: "v1", repoId: "repo1", versionName: "版本1" }; return cur })
    store.update(zulu.requirementId, (cur) => { cur.teambitionVersion = { versionId: "v1", repoId: "repo1", versionName: "版本1" }; return cur })
    store.update(mike.requirementId, (cur) => { cur.teambitionVersion = { versionId: "v2", repoId: "repo1", versionName: "版本2" }; return cur })
    const all = engine.listVersionRequirements(project.projectId)
    expect(all.map((m) => m.requirementName)).toEqual(["Alpha", "Mike", "Zulu"])
    const filtered = engine.listVersionRequirements(project.projectId, "v1")
    expect(filtered.map((m) => m.requirementName)).toEqual(["Alpha", "Zulu"])
  })

  it("setProjectDefaultVersion 在 cache 空时不拦非空字符串", () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = {
        repoId: "repo1",
        listSyncStatus: "ok",
        versionsCachedAt: new Date().toISOString(),
        versionsCache: [],
      }
      return cur
    })
    const updated = engine.setProjectDefaultVersion(project.projectId, "v1")
    expect(updated.teambitionVersion?.defaultVersionId).toBe("v1")
  })

  it("listProjectSummaries 含 teambitionRepoId", () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = { repoId: "repo1" }
      return cur
    })
    const summary = engine.listProjectSummaries().find((s) => s.projectId === project.projectId)
    expect(summary?.teambitionRepoId).toBe("repo1")
  })

  it("listRequirementSummaries：ok 且 cache 命中时无 stale 键", () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    const req = store.createRequirement(project.projectId, "R")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = {
        repoId: "repo1",
        listSyncStatus: "ok",
        versionsCache: [{ versionId: "v1", name: "版本1" }],
      }
      return cur
    })
    store.update(req.requirementId, (cur) => {
      cur.teambitionVersion = { versionId: "v1", repoId: "repo1", versionName: "版本1" }
      return cur
    })
    const summary = engine.listRequirementSummaries(project.projectId).find((s) => s.requirementId === req.requirementId)!
    expect(summary.teambitionVersionId).toBe("v1")
    expect(summary.teambitionVersionName).toBe("版本1")
    expect(summary.teambitionVersionStale).toBeUndefined()
  })

  it("listRequirementSummaries：解绑仓库后 stale true；未绑版本三键都不出现", () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    const req = store.createRequirement(project.projectId, "R")
    const req2 = store.createRequirement(project.projectId, "R2")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = {
        repoId: "repo1",
        listSyncStatus: "ok",
        versionsCache: [{ versionId: "v1", name: "版本1" }],
      }
      return cur
    })
    store.update(req.requirementId, (cur) => {
      cur.teambitionVersion = { versionId: "v1", repoId: "repo1", versionName: "版本1" }
      return cur
    })
    engine.unbindProjectTeambitionRepo(project.projectId)
    const summaries = engine.listRequirementSummaries(project.projectId)
    const bound = summaries.find((s) => s.requirementId === req.requirementId)!
    expect(bound.teambitionVersionStale).toBe(true)
    const unbound = summaries.find((s) => s.requirementId === req2.requirementId)!
    expect(unbound.teambitionVersionId).toBeUndefined()
    expect(unbound.teambitionVersionName).toBeUndefined()
    expect(unbound.teambitionVersionStale).toBeUndefined()
  })

  it("listRequirementSummaries：unconfirmed 状态有 id 无 stale", () => {
    const { engine, store } = makeEngine()
    const project = store.createProject("P")
    const req = store.createRequirement(project.projectId, "R")
    store.updateProject(project.projectId, (cur) => {
      cur.teambitionVersion = { repoId: "repo1", listSyncStatus: "unconfirmed" }
      return cur
    })
    store.update(req.requirementId, (cur) => {
      cur.teambitionVersion = { versionId: "v1", repoId: "repo1" }
      return cur
    })
    const summary = engine.listRequirementSummaries(project.projectId).find((s) => s.requirementId === req.requirementId)!
    expect(summary.teambitionVersionId).toBe("v1")
    expect(summary.teambitionVersionStale).toBeUndefined()
  })
})
