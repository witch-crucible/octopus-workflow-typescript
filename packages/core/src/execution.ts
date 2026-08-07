/**
 * 节点执行模型 —— 描述节点工作目录、动作序列和运行态。
 *
 * 工作流定义只描述意图；实际运行由 workflow-engine 的执行器负责。
 * 节点命令始终在其专属目录执行，公共目录通过环境变量提供只读契约。
 */

import type { AIAssistantType } from "./agent.js"
import type { HeinrichLevel } from "./risk.js"
import type { Phase } from "./phase.js"
import type { Role } from "./role.js"
import type { TaskStatus } from "./task.js"

/** 节点动作定义。动作按数组顺序执行，任一动作失败即停止后续动作。 */
export type NodeAction =
  | { readonly type: "manual"; readonly instructions?: string }
  | {
      readonly type: "command"
      readonly executable: string
      readonly args?: readonly string[]
      readonly env?: Readonly<Record<string, string>>
      readonly timeoutMs?: number
    }
  | {
      readonly type: "ai"
      readonly assistant: AIAssistantType
      readonly input?: string
      /** AI 结果相对于节点工作目录的输出文件。 */
      readonly outputFile?: string
      /** 输出文件已存在时覆盖或基于原内容扩展。 */
      readonly ifExists?: "overwrite" | "extend"
    }
  | {
      readonly type: "integration"
      readonly service: string
      readonly operation: string
      readonly input?: Readonly<Record<string, unknown>>
    }
  | { readonly type: "heinrich"; readonly delta: number; readonly level?: HeinrichLevel }

/** 工作流节点定义。 */
export interface WorkflowNodeSpec {
  /** 面向用户的英文节点键；内部 ID 由工作流映射维护。 */
  readonly key: string
  readonly phase: Phase
  readonly name: string
  readonly description: string
  readonly responsibleRoles: readonly Role[]
  readonly dependsOn: readonly string[]
  readonly actions: readonly NodeAction[]
}

/** 工作流文件的顶层定义。 */
export interface WorkflowDefinition {
  readonly version: 2
  readonly name: string
  /** 英文节点键到内部运行态 ID 的稳定映射。 */
  readonly nodeIdMapping: Readonly<Record<string, string>>
  readonly nodes: readonly WorkflowNodeSpec[]
}

/** 节点运行态。READY 根据依赖动态派生，不写入持久化状态。 */
export interface NodeRuntime {
  readonly id: string
  readonly phase: Phase
  readonly name: string
  readonly description: string
  readonly responsibleRole: Role
  readonly dependsOn: readonly string[]
  readonly actions: readonly NodeAction[]
  readonly status: TaskStatus
  readonly workspacePath: string
  readonly updatedAt: string
}

/** 一次节点执行的状态。 */
export type NodeRunStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "TIMED_OUT"
  | "INTERRUPTED"

/** 一次节点执行记录。 */
export interface NodeRun {
  readonly id: string
  readonly projectId: string
  readonly nodeId: string
  readonly status: NodeRunStatus
  readonly forced: boolean
  readonly pid?: number
  readonly currentAction?: number
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly heartbeatAt?: string
  readonly exitCode?: number
  readonly error?: string
  readonly stdoutPath: string
  readonly stderrPath: string
}

/** 工作流当前节点及监控摘要。 */
export interface WorkflowExecutionSnapshot {
  readonly projectId: string
  readonly currentNodeIds: readonly string[]
  readonly readyNodeIds: readonly string[]
  readonly waitingNodeIds: readonly string[]
  readonly activeRuns: readonly NodeRun[]
  readonly schedulerStatus: "IDLE" | "RUNNING" | "PAUSED" | "COMPLETED" | "BLOCKED"
  readonly updatedAt: string
}

/** 持久化的执行事件。 */
export interface WorkflowEvent {
  readonly sequence: number
  readonly projectId: string
  readonly runId?: string
  readonly nodeId?: string
  readonly type:
    | "RUN_QUEUED"
    | "RUN_STARTED"
    | "ACTION_STARTED"
    | "ACTION_FINISHED"
    | "HEARTBEAT"
    | "RUN_FINISHED"
    | "RUN_FAILED"
    | "RUN_CANCELED"
    | "INTEGRATION_HEALTH"
  readonly payload: Readonly<Record<string, unknown>>
  readonly createdAt: string
}

/** 集成健康检查结果。 */
export interface IntegrationHealth {
  readonly service: string
  readonly healthy: boolean
  readonly latencyMs: number
  readonly message: string
  readonly checkedAt: string
}
