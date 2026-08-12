/**
 * CapabilityRegistry —— 步骤能力的注册与分发。
 *
 * spec 步骤上声明的 `capabilities`（ai / integration / heinrich）在此被统一分发。
 * 新增/移动时序图中的能力节点 = 改 spec 数据；引擎与本注册表无需改动。
 */

import type { CapabilityRef } from "@octopus/core/spec.js"
import type { WorkflowState } from "@octopus/core/workflow.js"
import type { StepRuntime } from "@octopus/core/step.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { ChecklistItemStatus, createEmptyChecklist } from "@octopus/core/checklist.js"
import { ChecklistItemId, ObservationId, ArtifactId } from "@octopus/core/branded-ids.js"
import { ArtifactType } from "@octopus/core/artifact.js"
import { Role } from "@octopus/core/role.js"
import type { AIClient } from "@octopus/agent-layer/index.js"
import type { IntegrationService } from "@octopus/integration/index.js"

/** capability 分发上下文 */
export interface CapabilityContext {
  state: WorkflowState
  step: StepRuntime
  aiClient?: AIClient | undefined
  integrations: Record<string, IntegrationService>
  /** 显式输入：仅 AI 能力消费；未提供时回退为“步骤名称：步骤描述” */
  input?: string
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

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const truncate = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** AI 能力：调用 agent-layer 助手；CHECKLIST_RECOMMENDATION 落为清单项，其余落为制品 */
const aiHandler: CapabilityHandler = async (ref, ctx) => {
  if (ref.kind !== "ai") return { kind: ref.kind, ref: "", ok: false }
  const label = ref.assistant
  if (!ctx.aiClient) {
    return { kind: "ai", ref: label, ok: false, summary: "未配置 AIClient" }
  }
  const input = ctx.input ?? ref.input ?? `${ctx.step.name}：${ctx.step.description}`
  const res = await ctx.aiClient.callAssistant(ref.assistant, input)
  const text = res.result ?? ""

  if (ref.assistant === AIAssistantType.CHECKLIST_RECOMMENDATION) {
    const phase = ctx.step.phase
    if (!ctx.state.checklists[phase]) ctx.state.checklists[phase] = createEmptyChecklist(phase)
    const target = ctx.state.checklists[phase]
    let added = 0
    try {
      const parsed = JSON.parse(text || "[]") as Array<{ category?: string; description?: string }>
      if (target && Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item.description) continue
          target.items.push({
            id: ChecklistItemId(`cl_${uid()}`),
            category: item.category ?? "AI Recommended",
            description: item.description,
            status: ChecklistItemStatus.PENDING,
            inherited: false,
          })
          added++
        }
      }
    } catch {
      // 非 JSON 输出：忽略，仅记录一次调用
    }
    return { kind: "ai", ref: label, ok: true, summary: `新增 ${added} 项 checklist` }
  }

  ctx.state.artifacts.push({
    id: ArtifactId(`art_${uid()}`),
    type: ArtifactType.OTHER,
    title: `AI ${label} · ${ctx.step.id}`,
    description: `步骤 ${ctx.step.id} 的 AI 辅助产出`,
    phase: ctx.step.phase,
    version: "0.1.0",
    createdBy: Role.AI,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    content: text,
  })
  return { kind: "ai", ref: label, ok: true, summary: truncate(text) }
}

/** Heinrich 能力：按 delta 增加条数并记录观测 */
const heinrichHandler: CapabilityHandler = async (ref, ctx) => {
  if (ref.kind !== "heinrich") return { kind: ref.kind, ref: "", ok: false }
  const phase = ctx.step.phase
  ctx.state.heinrich.triggerCounts[phase] = (ctx.state.heinrich.triggerCounts[phase] ?? 0) + ref.delta
  ctx.state.heinrich.observations.push({
    id: ObservationId(`obs_${uid()}`),
    phase,
    level: ref.level ?? HeinrichLevel.TRIVIAL,
    description: `Heinrich 标记 +${ref.delta}（步骤 ${ctx.step.id}）`,
    notedAt: new Date().toISOString(),
  })
  return { kind: "heinrich", ref: `+${ref.delta}`, ok: true, summary: `条数 +${ref.delta}` }
}

/** 集成能力：从注入的服务表解析并调用 op（best-effort；未注册则记为未执行） */
const integrationHandler: CapabilityHandler = async (ref, ctx) => {
  if (ref.kind !== "integration") return { kind: ref.kind, ref: "", ok: false }
  const label = `${ref.service}.${ref.op}`
  const service = ctx.integrations[ref.service]
  if (!service) {
    return { kind: "integration", ref: label, ok: false, summary: `未注册集成: ${ref.service}` }
  }
  const fn = (service as unknown as Record<string, unknown>)[ref.op]
  if (typeof fn !== "function") {
    return { kind: "integration", ref: label, ok: false, summary: `集成无操作: ${ref.op}` }
  }
  try {
    const out = await (fn as (...args: unknown[]) => unknown).call(service)
    return { kind: "integration", ref: label, ok: true, summary: truncate(JSON.stringify(out ?? {})) }
  } catch (err) {
    return { kind: "integration", ref: label, ok: false, summary: (err as Error).message }
  }
}

/** capability 注册表 */
export class CapabilityRegistry {
  private readonly handlers = new Map<string, CapabilityHandler>()

  constructor() {
    this.handlers.set("ai", aiHandler)
    this.handlers.set("heinrich", heinrichHandler)
    this.handlers.set("integration", integrationHandler)
  }

  /** 注册/覆盖某类能力的处理器 */
  register(kind: string, handler: CapabilityHandler): void {
    this.handlers.set(kind, handler)
  }

  /** 分发单条能力 */
  async dispatch(ref: CapabilityRef, ctx: CapabilityContext): Promise<CapabilityResult> {
    const handler = this.handlers.get(ref.kind)
    if (!handler) return { kind: ref.kind, ref: "", ok: false, summary: `未知能力: ${ref.kind}` }
    return handler(ref, ctx)
  }
}
