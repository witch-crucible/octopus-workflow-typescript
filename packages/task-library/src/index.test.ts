import { describe, it, expect } from "vitest"
import { Phase } from "@octopus/core/phase.js"
import { TaskStatus } from "@octopus/core/task.js"
import {
  createTasksForPhase,
  createAllTasks,
  getTasksByRole,
  getPendingTasks,
} from "./index.js"

describe("createTasksForPhase", () => {
  it("REQUIREMENTS_ANALYSIS 阶段生成12个任务", () => {
    const tasks = createTasksForPhase("proj_test", Phase.REQUIREMENTS_ANALYSIS)
    expect(tasks.length).toBe(12)
    expect(tasks[0]!.phase).toBe(Phase.REQUIREMENTS_ANALYSIS)
    expect(tasks[0]!.status).toBe(TaskStatus.PENDING)
  })

  it("DESIGN 阶段生成9个任务（含 20.2a）", () => {
    const tasks = createTasksForPhase("proj_test", Phase.DESIGN)
    expect(tasks.length).toBe(9)
  })

  it("每个任务都有必填字段", () => {
    const tasks = createTasksForPhase("proj_test", Phase.DEVELOPMENT)
    for (const task of tasks) {
      expect(task.id).toBeTruthy()
      expect(task.stageId).toBeTruthy()
      expect(task.title).toBeTruthy()
      expect(task.responsibleRole).toBeTruthy()
    }
  })
})

describe("createAllTasks", () => {
  it("为所有6个阶段生成任务", () => {
    const all = createAllTasks("proj_test")
    expect(Object.keys(all)).toHaveLength(6)
  })
})

describe("getTasksByRole", () => {
  it("按角色过滤任务", () => {
    const tasks = createTasksForPhase("proj_test", Phase.REQUIREMENTS_ANALYSIS)
    const pmTasks = getTasksByRole(tasks, "PM")
    for (const t of pmTasks) {
      expect(t.responsibleRole).toBe("PM")
    }
  })
})

describe("getPendingTasks", () => {
  it("返回待处理的任务", () => {
    const tasks = createTasksForPhase("proj_test", Phase.DESIGN)
    const pending = getPendingTasks(tasks)
    expect(pending.length).toBe(tasks.length) // all are PENDING initially
  })
})
