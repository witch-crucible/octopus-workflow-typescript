/**
 * Branded ID 类型 —— 利用 TypeScript branded type 在编译层防止
 * 不同类型 ID 的混用（如把 ArtifactId 传给 TaskId 参数）。
 *
 * 使用 createId 工厂创建带前缀的 ID 生成器：
 *   const TaskId = createId<TaskId>("task")
 *   TaskId("abc123")  // => 类型为 TaskId
 */

declare const Brand: unique symbol

/** 基础 Branded String 类型 */
export type BrandedId<T extends string> = string & { readonly [Brand]: T }

// ── 核心 ID 类型 ────────────────────────────────────────────

export type AgentId = BrandedId<"AgentId">
export type TaskId = BrandedId<"TaskId">
export type PhaseId = BrandedId<"PhaseId">
export type WorkflowId = BrandedId<"WorkflowId">
export type ArtifactId = BrandedId<"ArtifactId">
export type RiskEventId = BrandedId<"RiskEventId">

// ── 遗留 ID 类型（被其他模块引用） ──────────────────────────

export type ProjectId = BrandedId<"ProjectId">
export type RequirementId = BrandedId<"RequirementId">
export type ChecklistItemId = BrandedId<"ChecklistItemId">
export type ObservationId = BrandedId<"ObservationId">
export type AgentCallId = BrandedId<"AgentCallId">

// ── 工厂函数 ────────────────────────────────────────────────

/**
 * 创建带前缀的 ID 生成器。
 * _prefix 参数仅用于文档/调试，不参与运行时逻辑。
 *
 * @example
 *   const TaskId = createId<TaskId>("task")
 *   const id = TaskId("abc123")  // id 类型为 TaskId
 */
export function createId<T extends string>(_prefix: string): (id: string) => BrandedId<T> {
  return (id: string): BrandedId<T> => id as BrandedId<T>
}

// ── 便捷工厂函数 ────────────────────────────────────────────

export function AgentId(id: string): AgentId {
  return id as AgentId
}

export function TaskId(id: string): TaskId {
  return id as TaskId
}

export function PhaseId(id: string): PhaseId {
  return id as PhaseId
}

export function WorkflowId(id: string): WorkflowId {
  return id as WorkflowId
}

export function ArtifactId(id: string): ArtifactId {
  return id as ArtifactId
}

export function RiskEventId(id: string): RiskEventId {
  return id as RiskEventId
}

export function ProjectId(id: string): ProjectId {
  return id as ProjectId
}

export function RequirementId(id: string): RequirementId {
  return id as RequirementId
}

export function ChecklistItemId(id: string): ChecklistItemId {
  return id as ChecklistItemId
}

export function ObservationId(id: string): ObservationId {
  return id as ObservationId
}

export function AgentCallId(id: string): AgentCallId {
  return id as AgentCallId
}
