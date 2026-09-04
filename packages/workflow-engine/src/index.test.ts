import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArtifactType } from "@octopus/core/artifact.js"
import { ChecklistItemStatus } from "@octopus/core/checklist.js"
import { MilestoneStatus } from "@octopus/core/milestone.js"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { TaskStatus } from "@octopus/core/task.js"
import type { PersistenceStore } from "@octopus/context/index.js"
import { createTestPersistenceStore } from "@octopus/context/testing.js"
import { WorkflowEngine } from "./index.js"

const engines: WorkflowEngine[] = []
const roots: string[] = []

async function createEngine(): Promise<WorkflowEngine> {
  const { store } = await createTestPersistenceStore()
  const engine = new WorkflowEngine({ store })
  await engine.initialize()
  engines.push(engine)
  return engine
}

async function seed(engine: WorkflowEngine, root?: string) {
  const project = await engine.createProject("测试项目", "项目描述")
  const state = await engine.initRequirement(project.projectId, "测试需求", "需求描述", root)
  return { project, state }
}

function engineStore(engine: WorkflowEngine): PersistenceStore {
  return (engine as unknown as { store: PersistenceStore }).store
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("WorkflowEngine 异步持久化", () => {
  it("创建项目和需求并生成摘要", async () => {
    const engine = await createEngine()
    const { project, state } = await seed(engine)
    expect(await engine.listProjects()).toEqual([project.projectId])
    expect((await engine.listProjectSummaries())[0]).toMatchObject({ requirementCount: 1 })
    expect((await engine.listRequirementSummaries())[0]).toMatchObject({
      requirementId: state.requirementId,
      requirementName: "测试需求",
    })
  })

  it("更新项目和需求元数据，删除保持级联", async () => {
    const engine = await createEngine()
    const { project, state } = await seed(engine)
    expect((await engine.updateProjectMeta(project.projectId, { name: "新项目名" })).name).toBe(
      "新项目名",
    )
    expect(
      (await engine.updateRequirement(state.requirementId, { name: "新需求名", owner: "Alice" }))
        .owner,
    ).toBe("Alice")
    await engine.deleteProject(project.projectId)
    expect(await engine.listRequirements()).toEqual([])
  })

  it("需求与节点排期可设置和清除", async () => {
    const engine = await createEngine()
    const { state } = await seed(engine)
    const nodeId = state.steps[0]!.id
    await engine.updateRequirementSchedule(state.requirementId, {
      plannedStart: "2026-08-01",
      plannedEnd: "2026-08-10",
    })
    await engine.updateNodeSchedule(state.requirementId, nodeId, {
      plannedStart: "2026-08-01",
      plannedEnd: "2026-08-03",
    })
    const scheduled = await engine.getState(state.requirementId)
    expect(scheduled.plannedEnd).toBe("2026-08-10")
    expect(scheduled.steps[0]?.plannedEnd).toBe("2026-08-03")
    await expect(
      engine.updateRequirementSchedule(state.requirementId, {
        plannedStart: "2026-08-10",
        plannedEnd: "2026-08-01",
      }),
    ).rejects.toThrow("不能早于")
  })

  it("任务状态与阶段进度共用 steps 真相源", async () => {
    const engine = await createEngine()
    const { state } = await seed(engine)
    const task = (await engine.getTasks(state.requirementId))[0]!
    await engine.setTaskStatus(state.requirementId, task.id, TaskStatus.IN_PROGRESS)
    await engine.completeTask(state.requirementId, task.id)
    const loaded = await engine.getState(state.requirementId)
    expect(engine.getPhaseProgress(loaded, task.phase).completed).toBeGreaterThan(0)
  })

  it("子任务归属需求且不影响工作流阶段进度", async () => {
    const engine = await createEngine()
    const { state } = await seed(engine)
    const subtask = await engine.addSubtask(state.requirementId, {
      title: "补充接口文档",
      description: "记录请求和响应示例",
      assignedTo: "Alice",
    })
    expect(subtask).toMatchObject({
      requirementId: state.requirementId,
      title: "补充接口文档",
      status: TaskStatus.PENDING,
    })
    expect((await engine.listSubtasks(state.requirementId))).toHaveLength(1)
    expect((await engine.getTasks(state.requirementId)).some((task) => task.id === subtask.id)).toBe(false)
    const completed = await engine.completeSubtask(state.requirementId, subtask.id)
    expect(completed.status).toBe(TaskStatus.COMPLETED)
    await engine.deleteSubtask(state.requirementId, subtask.id)
    expect(await engine.listSubtasks(state.requirementId)).toEqual([])
  })

  it("任务导入按 stageId 幂等合并", async () => {
    const engine = await createEngine()
    const first = await seed(engine)
    const secondProject = await engine.createProject("目标项目")
    const second = await engine.initRequirement(secondProject.projectId, "目标需求")
    const firstTask = (await engine.getTasks(first.state.requirementId))[0]!
    await engine.setTaskStatus(first.state.requirementId, firstTask.id, TaskStatus.COMPLETED)
    const document = await engine.exportTasks(first.state.requirementId)
    const result = await engine.importTasks(second.requirementId, document)
    expect(result.matched).toBe(document.tasks.length)
    expect((await engine.importTasks(second.requirementId, document)).updated).toBe(0)
  })

  it("Checklist 未核验时阻止阶段推进", async () => {
    const engine = await createEngine()
    const { state } = await seed(engine)
    const phase = state.currentPhase
    const itemState = await engine.addChecklistItem(state.requirementId, phase, "QA", "检查")
    const item = itemState.checklists[phase]!.items[0]!
    const store = engineStore(engine)
    await store.update(state.requirementId, (current) => {
      for (const step of current.steps.filter((candidate) => candidate.phase === phase)) {
        step.status = TaskStatus.COMPLETED
      }
      return current
    })
    expect((await engine.canAdvance(state.requirementId)).allowed).toBe(false)
    await engine.verifyChecklistItem(state.requirementId, phase, item.id, Role.QA)
    expect((await engine.getChecklist(state.requirementId, phase)).items[0]?.status).toBe(
      ChecklistItemStatus.VERIFIED,
    )
  })

  it("阶段前进和回退在事务中更新状态", async () => {
    const engine = await createEngine()
    const { state } = await seed(engine)
    const store = engineStore(engine)
    await store.update(state.requirementId, (current) => {
      for (const step of current.steps) step.status = TaskStatus.COMPLETED
      return current
    })
    const advanced = await engine.advancePhase(state.requirementId)
    expect(advanced.currentPhase).not.toBe(Phase.INTENTION)
    expect((await engine.rollbackTo(state.requirementId, Phase.INTENTION)).currentPhase).toBe(
      Phase.INTENTION,
    )
  })

  it("里程碑增删改达成及项目投影", async () => {
    const engine = await createEngine()
    const { project, state } = await seed(engine)
    const milestone = await engine.addMilestone(state.requirementId, {
      name: "Release",
      date: "2026-08-30",
    })
    expect((await engine.reachMilestone(state.requirementId, milestone.id)).status).toBe(
      MilestoneStatus.REACHED,
    )
    expect(await engine.listProjectMilestones(project.projectId)).toHaveLength(1)
    await engine.deleteMilestone(state.requirementId, milestone.id)
    expect(await engine.listMilestones(state.requirementId)).toEqual([])
  })

  it("负责人和我的工作投影保持一致", async () => {
    const engine = await createEngine()
    const { state } = await seed(engine)
    const nodeId = state.steps[0]!.id
    await engine.updateRequirement(state.requirementId, { owner: "Alice" })
    await engine.assignNode(state.requirementId, nodeId, "alice")
    const mine = await engine.listMyWork("Alice")
    expect(mine.requirements).toHaveLength(1)
    expect(mine.nodes).toHaveLength(1)
  })

  it("Heinrich 观测、评估与解决均持久化", async () => {
    const engine = await createEngine()
    const { state } = await seed(engine)
    const updated = await engine.logObservation(
      state.requirementId,
      state.currentPhase,
      HeinrichLevel.MAJOR,
      "严重问题",
    )
    const observation = updated.heinrich.observations[0]!
    expect((await engine.assessQuality(state.requirementId)).verdict).toBeDefined()
    expect(
      (await engine.resolveObservation(state.requirementId, observation.id)).heinrich
        .observations[0]?.resolvedAt,
    ).toBeDefined()
  })

  it("制品创建和过滤保留 JSON 内容", async () => {
    const engine = await createEngine()
    const { state } = await seed(engine)
    await engine.createArtifact(state.requirementId, {
      type: ArtifactType.BRD,
      title: "BRD",
      description: "desc",
      phase: state.currentPhase,
      createdBy: Role.PM,
      content: "正文",
    })
    expect(
      (await engine.getArtifacts(state.requirementId, state.currentPhase, ArtifactType.BRD))[0]
        ?.content,
    ).toBe("正文")
  })

  it("项目源码根可解析英文节点键并创建自定义节点", async () => {
    const root = mkdtempSync(join(tmpdir(), "octopus-engine-"))
    roots.push(root)
    const engine = await createEngine()
    const { state } = await seed(engine, root)
    const definition = await engine.getWorkflowDefinition(state.requirementId)
    const key = Object.keys(definition.nodeIdMapping)[0]!
    const id = await engine.resolveNodeId(state.requirementId, key)
    expect(await engine.resolveNodeKey(state.requirementId, id)).toBe(key)
  })
})
