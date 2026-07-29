/**
 * Task Library 包 —— 从 spec 步骤生成运行态 StepRuntime。
 *
 * 将 spec 中的 StepSpec 转换为可执行的 StepRuntime 实例。
 */

import type { StepSpec } from "@octopus/core/spec.js"
import { getSteps } from "@octopus/core/spec.js"
import type { StepRuntime } from "@octopus/core/step.js"
import { TaskStatus } from "@octopus/core/task.js"
import { TaskId } from "@octopus/core/branded-ids.js"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"

/** 从步骤定义创建运行态步骤 */
export function createStepFromSpec(phase: Phase, step: StepSpec): StepRuntime {
  const now = new Date().toISOString()
  const random = Math.random().toString(36).slice(2, 8)
  return {
    id: step.id,
    taskId: TaskId(`${step.id}_${Date.now()}_${random}`),
    phase,
    name: step.name,
    description: step.description,
    responsibleRole: step.responsibleRoles[0] ?? Role.AI,
    status: TaskStatus.PENDING,
    dependsOn: [...step.dependsOn],
    ...(step.capabilities ? { capabilities: step.capabilities } : {}),
    artifactIds: [],
    createdAt: now,
    updatedAt: now,
  }
}

/** 为一个阶段生成所有步骤 */
export function createStepsForPhase(_projectId: string, phase: Phase): StepRuntime[] {
  return getSteps(phase).map((step) => createStepFromSpec(phase, step))
}

/** 为所有阶段生成所有步骤 */
export function createAllSteps(projectId: string): Record<Phase, StepRuntime[]> {
  const result = {} as Record<Phase, StepRuntime[]>
  for (const phase of Object.values(Phase)) {
    result[phase] = createStepsForPhase(projectId, phase)
  }
  return result
}

/** 获取特定角色的步骤 */
export function getStepsByRole(steps: StepRuntime[], roleName: string): StepRuntime[] {
  return steps.filter((s) => s.responsibleRole === roleName)
}

/** 获取未完成的步骤 */
export function getPendingSteps(steps: StepRuntime[]): StepRuntime[] {
  return steps.filter(
    (s) => s.status === TaskStatus.PENDING || s.status === TaskStatus.IN_PROGRESS,
  )
}
