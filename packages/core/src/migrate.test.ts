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
    currentPhase: Phase.REQUIREMENTS_ANALYSIS,
    phaseStatus: { [Phase.REQUIREMENTS_ANALYSIS]: PhaseLock.ACTIVE },
    tasks: [
      {
        id: "task_1",
        stageId: "10.1",
        phase: Phase.REQUIREMENTS_ANALYSIS,
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
        phase: Phase.REQUIREMENTS_ANALYSIS,
        status: StageStatus.PENDING,
        dependsOn: [],
        responsibleRole: Role.PM,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      },
      "10.2": {
        stageId: "10.2",
        phase: Phase.REQUIREMENTS_ANALYSIS,
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

  it("已是 v2（含 steps）则原样返回", () => {
    const v2 = { schemaVersion: CURRENT_SCHEMA_VERSION, steps: [] }
    const migrated = migrateWorkflowState(v2)
    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(migrated.steps).toEqual([])
  })
})
