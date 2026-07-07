/**
 * Task Library 包 —— 各阶段预定义的任务模板。
 *
 * 将 phase.ts 中的 StageDef 转换为可执行的 Task 实例，
 * 并提供每个阶段的任务工厂函数。
 */

import type { Task } from "@octopus/core/task.js"
import { TaskStatus } from "@octopus/core/task.js"
import { TaskId } from "@octopus/core/branded-ids.js"
import type { StageDef } from "@octopus/core/phase.js"
import { Phase, getStages } from "@octopus/core/phase.js"

/** 任务创建参数 */
export interface TaskTemplateParams {
  projectId: string
  stage: StageDef
  phase: Phase
}

/** 从阶段步骤定义创建任务 */
export function createTaskFromStage(params: TaskTemplateParams): Task {
  const { stage, phase } = params
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)

  return {
    id: TaskId(`${stage.id}_${timestamp}_${random}`),
    stageId: stage.id,
    phase,
    title: stage.name,
    description: stage.description,
    responsibleRole: stage.responsibleRoles[0] ?? stage.responsibleRoles[0]!,
    status: TaskStatus.PENDING,
    artifactIds: [],
    createdAt: new Date().toISOString(),
  }
}

/** 为一个阶段生成所有任务 */
export function createTasksForPhase(projectId: string, phase: Phase): Task[] {
  const stages = getStages(phase)
  return stages.map((stage) => createTaskFromStage({ projectId, stage, phase }))
}

/** 为所有阶段生成所有任务 */
export function createAllTasks(projectId: string): Record<Phase, Task[]> {
  const phases = Object.values(Phase)
  const result = {} as Record<Phase, Task[]>

  for (const phase of phases) {
    result[phase] = createTasksForPhase(projectId, phase)
  }

  return result
}

/** 获取指定阶段中特定角色的任务 */
export function getTasksByRole(tasks: Task[], roleName: string): Task[] {
  return tasks.filter((t) => t.responsibleRole === roleName)
}

/** 获取指定阶段中未完成的任务 */
export function getPendingTasks(tasks: Task[]): Task[] {
  return tasks.filter(
    (t) => t.status === TaskStatus.PENDING || t.status === TaskStatus.IN_PROGRESS,
  )
}
