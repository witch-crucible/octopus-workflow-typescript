import { describe, it, expect } from "vitest"
import { migrateWorkflowState, CURRENT_SCHEMA_VERSION } from "./workflow.js"
import { Phase, PhaseLock } from "./phase.js"
import { TaskStatus, StageStatus } from "./task.js"
import { Role } from "./role.js"

/** 构造一个最小的旧版（v1: tasks[]+stages{}）状态对象 */
function legacyState(): unknown {
  return {
    projectId: "proj_legacy",
    projectName: "旧项目",
    description: "",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    currentPhase: Phase.INTENTION,
    phaseStatus: { [Phase.INTENTION]: PhaseLock.ACTIVE },
    tasks: [
      {
        id: "task_1",
        stageId: "10.1",
        phase: Phase.INTENTION,
        title: "需求分析",
        description: "d",
        responsibleRole: Role.PM,
        status: TaskStatus.COMPLETED,
        artifactIds: [],
        createdAt: "2025-01-01T00:00:00.000Z",
        completedAt: "2025-01-02T00:00:00.000Z",
      },
    ],
    stages: {
      "10.1": {
        stageId: "10.1",
        phase: Phase.INTENTION,
        status: StageStatus.PENDING,
        dependsOn: [],
        responsibleRole: Role.PM,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      "10.2": {
        stageId: "10.2",
        phase: Phase.INTENTION,
        status: StageStatus.PENDING,
        dependsOn: ["10.1"],
        responsibleRole: Role.BA,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
    },
    checklists: {},
    heinrich: { majorDefects: 0, minorDefects: 0, trivialDefects: 0, observations: [], triggerCounts: {} },
    artifacts: [],
    metadata: {},
    aiGatingEnabled: false,
    aiGateResults: [],
  }
}

describe("migrateWorkflowState", () => {
  it("v1 状态归并 tasks+stages 为 steps", () => {
    const migrated = migrateWorkflowState(legacyState())
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    // 一条来自 task 的 step + 一条仅有 stage 的 step
    expect(migrated.steps).toHaveLength(2)

    const s1 = migrated.steps.find((s) => s.id === "10.1")!
    expect(s1.taskId).toBe("task_1")
    expect(s1.status).toBe(TaskStatus.COMPLETED) // task 状态优先
    expect(s1.completedAt).toBe("2025-01-02T00:00:00.000Z")

    const s2 = migrated.steps.find((s) => s.id === "10.2")!
    expect(s2.dependsOn).toEqual(["10.1"])
  })

  it("移除旧字段 tasks/stages", () => {
    const migrated = migrateWorkflowState(legacyState()) as unknown as Record<string, unknown>
    expect(migrated["tasks"]).toBeUndefined()
    expect(migrated["stages"]).toBeUndefined()
  })

  it("已是当前版本（含 steps）则保留 steps", () => {
    const v2 = { schemaVersion: CURRENT_SCHEMA_VERSION, steps: [] }
    const migrated = migrateWorkflowState(v2)
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.steps).toEqual([])
  })

  it("v4 旧项目字段下沉为需求，并接受所属 projectId", () => {
    const migrated = migrateWorkflowState(legacyState(), { projectId: "proj_parent" as import("./branded-ids.js").ProjectId })
    expect(migrated.requirementId).toBe("proj_legacy")
    expect(migrated.requirementName).toBe("旧项目")
    expect(migrated.projectId).toBe("proj_parent")
    expect((migrated as unknown as Record<string, unknown>)["projectName"]).toBeUndefined()
  })

  it("v5→v6 迁移后 schemaVersion=6 且排期字段为 undefined", () => {
    const v5State = {
      schemaVersion: 5,
      projectId: "proj_v5",
      requirementId: "req_v5",
      requirementName: "v5 需求",
      description: "",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      currentPhase: Phase.INTENTION,
      phaseStatus: { [Phase.INTENTION]: PhaseLock.ACTIVE },
      steps: [],
      checklists: {},
      heinrich: { majorDefects: 0, minorDefects: 0, trivialDefects: 0, observations: [], triggerCounts: {} },
      artifacts: [],
      metadata: {},
      aiGatingEnabled: false,
      aiGateResults: [],
    }
    const migrated = migrateWorkflowState(v5State)
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.plannedStart).toBeUndefined()
    expect(migrated.plannedEnd).toBeUndefined()
    expect(migrated.milestones).toEqual([])
  })

  it("v6→v7 迁移后补 milestones=[] 且不丢已有排期", () => {
    const v6State = {
      schemaVersion: 6,
      projectId: "proj_v6",
      requirementId: "req_v6",
      requirementName: "v6 需求",
      description: "",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      currentPhase: Phase.INTENTION,
      phaseStatus: { [Phase.INTENTION]: PhaseLock.ACTIVE },
      steps: [],
      checklists: {},
      heinrich: { majorDefects: 0, minorDefects: 0, trivialDefects: 0, observations: [], triggerCounts: {} },
      artifacts: [],
      metadata: {},
      plannedStart: "2026-03-01",
      plannedEnd: "2026-03-12",
      aiGatingEnabled: false,
      aiGateResults: [],
    }
    const migrated = migrateWorkflowState(v6State)
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.plannedStart).toBe("2026-03-01")
    expect(migrated.plannedEnd).toBe("2026-03-12")
    expect(migrated.milestones).toEqual([])
  })

  it("已有 milestones 在迁移后保留", () => {
    const existing = [{
      id: "ms_keep",
      name: "上线",
      date: "2026-04-01",
      status: "planned",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }]
    const migrated = migrateWorkflowState({
      schemaVersion: 6,
      projectId: "proj_ms",
      requirementId: "req_ms",
      requirementName: "有里程碑",
      description: "",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      currentPhase: Phase.INTENTION,
      phaseStatus: { [Phase.INTENTION]: PhaseLock.ACTIVE },
      steps: [],
      checklists: {},
      heinrich: { majorDefects: 0, minorDefects: 0, trivialDefects: 0, observations: [], triggerCounts: {} },
      artifacts: [],
      metadata: {},
      milestones: existing,
      aiGatingEnabled: false,
      aiGateResults: [],
    })
    expect(migrated.milestones).toEqual(existing)
  })

  it("v7→v8 迁移后 schemaVersion=8 且 owner 为 undefined", () => {
    const v7State = {
      schemaVersion: 7,
      projectId: "proj_v7",
      requirementId: "req_v7",
      requirementName: "v7 需求",
      description: "",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
      currentPhase: Phase.INTENTION,
      phaseStatus: { [Phase.INTENTION]: PhaseLock.ACTIVE },
      steps: [],
      checklists: {},
      heinrich: { majorDefects: 0, minorDefects: 0, trivialDefects: 0, observations: [], triggerCounts: {} },
      artifacts: [],
      metadata: {},
      plannedStart: "2026-04-01",
      plannedEnd: "2026-04-15",
      milestones: [{
        id: "ms_v7",
        name: "里程碑",
        date: "2026-04-10",
        status: "planned",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
      aiGatingEnabled: false,
      aiGateResults: [],
    }
    const migrated = migrateWorkflowState(v7State)
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.plannedStart).toBe("2026-04-01")
    expect(migrated.plannedEnd).toBe("2026-04-15")
    expect(migrated.milestones).toHaveLength(1)
    expect(migrated.owner).toBeUndefined()
  })
})
