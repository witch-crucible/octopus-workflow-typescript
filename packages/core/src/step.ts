/**
 * StepRuntime —— 统一的步骤运行态。
 *
 * 取代原先并行的 `Task` 与 `StageInfo` 两套状态：一个步骤 = 一条记录、
 * 一个状态字段。阶段推进门控与依赖检查读取同一数组，消除双写不一致。
 *
 * `Task` / `StageInfo` 保留为派生视图（见 workflow.ts 的 stepToTask/stepToStageInfo）。
 */

import type { TaskId, ArtifactId } from "./branded-ids.js"
import type { Role } from "./role.js"
import type { Phase } from "./phase.js"
import type { CapabilityRef } from "./spec.js"
import type { NodeAction } from "./execution.js"
import { TaskStatus } from "./task.js"

/** 步骤状态 —— 复用 TaskStatus 值域（PENDING/IN_PROGRESS/COMPLETED/BLOCKED/SKIPPED） */
export { TaskStatus as StepStatus }

/** 步骤运行态（唯一真相源） */
export interface StepRuntime {
  /** 内部运行态 ID；面向用户的英文 key 通过工作流映射解析。 */
  id: string
  /** 稳定任务 ID（派生 Task 视图使用） */
  taskId: TaskId
  /** 所属阶段 */
  phase: Phase
  /** 步骤名称 */
  name: string
  /** 步骤描述 */
  description: string
  /** 负责角色 */
  responsibleRole: Role
  /** 当前状态 */
  status: TaskStatus
  /** 前置步骤内部 ID 列表 */
  dependsOn: string[]
  /** 声明式能力（来自 spec，Phase 3 由 CapabilityRegistry 分发） */
  capabilities?: readonly CapabilityRef[]
  /** 可执行动作序列；旧 capability 会在生成运行态时转换为动作。 */
  actions?: readonly NodeAction[]
  /** 关联制品 ID 列表 */
  artifactIds: ArtifactId[]
  /** 实际负责人（可选） */
  assignedTo?: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 更新时间（ISO 8601） */
  updatedAt: string
  /** 完成时间（ISO 8601） */
  completedAt?: string
  /** 计划开始日期（YYYY-MM-DD，本地日历日） */
  plannedStart?: string
  /** 计划结束日期（YYYY-MM-DD，本地日历日） */
  plannedEnd?: string
  /** 备注 */
  notes?: string
  /** capability 分发审计记录（Phase 3 使用） */
  capabilityRuns?: Array<{ kind: string; ref: string; ok: boolean; at: string; summary?: string }>
}
