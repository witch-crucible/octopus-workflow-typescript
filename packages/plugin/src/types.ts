/**
 * 插件契约 —— 项目外挂定制的类型定义。
 *
 * 插件通过 activate(ctx) 叠加节点、注册 AI / 集成 / 自定义能力。
 * 零插件时主流程不经过本包的加载器。
 */

import type { AIAssistantModule, AIClient } from "@octopus/agent-layer/index.js"
import type { CapabilityRef } from "@octopus/core/spec.js"
import type { StepRuntime } from "@octopus/core/step.js"
import type { WorkflowState } from "@octopus/core/workflow.js"
import type { WorkflowNodeSpec, WorkflowPluginRef } from "@octopus/core/execution.js"
import type { IntegrationService } from "@octopus/integration/index.js"

export type PluginRef = WorkflowPluginRef

/** capability 分发上下文 */
export interface CapabilityContext {
  state: WorkflowState
  step: StepRuntime
  aiClient?: AIClient | undefined
  integrations: Record<string, IntegrationService>
  input?: string
  /** 调用方取消长时间运行的 capability（如多 AI 交叉评审）。 */
  signal?: AbortSignal
}

/** capability 分发结果 */
export interface CapabilityResult {
  kind: string
  ref: string
  ok: boolean
  summary?: string
}

/** capability 处理器 */
export type CapabilityHandler = (ref: CapabilityRef, ctx: CapabilityContext) => Promise<CapabilityResult>

/** 工作流叠加：按 disable → add → replace → rewire 顺序应用 */
export interface WorkflowOverlay {
  add?: readonly WorkflowNodeSpec[]
  replace?: ReadonlyArray<{ readonly key: string } & Partial<Omit<WorkflowNodeSpec, "key">>>
  disable?: readonly string[]
  rewire?: ReadonlyArray<{ readonly key: string; readonly dependsOn: readonly string[] }>
}

export interface PluginContext {
  readonly projectRoot: string
  readonly options: Readonly<Record<string, unknown>>
  contributeOverlay(overlay: WorkflowOverlay): void
  registerAIModule(module: AIAssistantModule): void
  registerIntegration(service: IntegrationService): void
  registerCapability(kind: string, handler: CapabilityHandler): void
}

export interface OctopusPlugin {
  readonly id: string
  readonly version: string
  activate(ctx: PluginContext): void | Promise<void>
}

export interface LoadedPlugin {
  readonly id: string
  readonly version: string
}

export interface PluginHost {
  readonly plugins: readonly LoadedPlugin[]
  readonly overlays: readonly WorkflowOverlay[]
  readonly integrations: Readonly<Record<string, IntegrationService>>
  readonly customHandlers: ReadonlyMap<string, CapabilityHandler>
  readonly kindHandlers: ReadonlyMap<string, CapabilityHandler>
}
