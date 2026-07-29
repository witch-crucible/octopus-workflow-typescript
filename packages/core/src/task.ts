/**
 * 任务模型 —— 项目流程中的最小执行单元。
 *
 * 每个任务对应一个阶段步骤（Stage）的实际执行实例。
 */

import type { TaskId, ArtifactId } from "./branded-ids.js"
import { Role } from "./role.js"
import { Phase } from "./phase.js"

/** 任务状态枚举 */
export enum TaskStatus {
  /** 待处理 */
  PENDING = "PENDING",
  /** 进行中 */
  IN_PROGRESS = "IN_PROGRESS",
  /** 已完成 */
  COMPLETED = "COMPLETED",
  /** 阻塞 */
  BLOCKED = "BLOCKED",
  /** 跳过（不适用） */
  SKIPPED = "SKIPPED",
}

/** 任务状态标签映射 */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  [TaskStatus.PENDING]: "待处理",
  [TaskStatus.IN_PROGRESS]: "进行中",
  [TaskStatus.COMPLETED]: "已完成",
  [TaskStatus.BLOCKED]: "阻塞",
  [TaskStatus.SKIPPED]: "已跳过",
}

/** 阶段步骤状态枚举 */
export enum StageStatus {
  PENDING = "PENDING",
  IN_PROGRESS = "IN_PROGRESS",
  COMPLETED = "COMPLETED",
  BLOCKED = "BLOCKED",
  SKIPPED = "SKIPPED",
}

/** 阶段步骤状态标签映射 */
export const STAGE_STATUS_LABELS: Record<StageStatus, string> = {
  [StageStatus.PENDING]: "待处理",
  [StageStatus.IN_PROGRESS]: "进行中",
  [StageStatus.COMPLETED]: "已完成",
  [StageStatus.BLOCKED]: "阻塞",
  [StageStatus.SKIPPED]: "已跳过",
}

/** 任务接口 */
export interface Task {
  /** 任务唯一 ID */
  id: TaskId
  /** 所属阶段步骤 ID */
  stageId: string
  /** 所属阶段 */
  phase: Phase
  /** 任务标题 */
  title: string
  /** 任务描述 */
  description: string
  /** 负责角色 */
  responsibleRole: Role
  /** 当前状态 */
  status: TaskStatus
  /** 关联的制品 ID 列表 */
  artifactIds: ArtifactId[]
  /** 实际负责人（可选） */
  assignedTo?: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 完成时间（ISO 8601） */
  completedAt?: string
  /** 备注 */
  notes?: string
}

/** 创建新任务的参数 */
export interface CreateTaskParams {
  stageId: string
  phase: Phase
  title: string
  description: string
  responsibleRole: Role
  assignedTo?: string
  notes?: string
}

/** 任务过滤条件 */
export interface TaskFilter {
  phase?: Phase
  status?: TaskStatus
  responsibleRole?: Role
  stageId?: string
}

/** 任务进度摘要 */
export interface TaskProgress {
  total: number
  completed: number
  inProgress: number
  blocked: number
  pending: number
  skipped: number
  /** 完成百分比 0-100 */
  percent: number
}

/** 阶段步骤运行时信息 */
export interface StageInfo {
  /** 步骤定义 ID */
  stageId: string
  /** 所属阶段 */
  phase: Phase
  /** 当前状态 */
  status: StageStatus
  /** 依赖的步骤 ID 列表 */
  dependsOn: string[]
  /** 负责角色 */
  responsibleRole: Role
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
  /** 完成时间 */
  completedAt?: string
  /** 是否跳过 */
  skipped?: boolean
}

/** 阶段进度摘要 */
export interface StageProgress {
  total: number
  completed: number
  inProgress: number
  blocked: number
  pending: number
  skipped: number
  /** 完成百分比 0-100 */
  percent: number
}

