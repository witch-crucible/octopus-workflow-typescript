/**
 * CapabilityRegistry —— 步骤能力的注册与分发。
 *
 * spec 步骤上声明的 `capabilities`（ai / integration / heinrich）在此被统一分发。
 * 新增/移动时序图中的能力节点 = 改 spec 数据；引擎与本注册表无需改动。
 */

import type { CapabilityRef } from "@octopus/core/spec.js"
import { AIAssistantType } from "@octopus/core/agent.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { ChecklistItemStatus, createEmptyChecklist } from "@octopus/core/checklist.js"
import { ChecklistItemId, ObservationId, ArtifactId } from "@octopus/core/branded-ids.js"
import { ArtifactType } from "@octopus/core/artifact.js"
import { Role } from "@octopus/core/role.js"
import { relative } from "node:path"
import type { CapabilityContext, CapabilityHandler, CapabilityResult } from "@octopus/plugin/types.js"
import {
  getWorkflowWorkspace,
  loadWorkflowDefinition,
  resolveWorkflowNodeKey,
} from "@octopus/context/workflow.js"
import { writeCrossReviewReports } from "@octopus/executor/ai-output.js"

export type { CapabilityContext, CapabilityHandler, CapabilityResult }

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
const truncate = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s)

function appendAIArtifact(ctx: CapabilityContext, title: string, description: string, content: string): void {
  ctx.state.artifacts.push({
    id: ArtifactId(`art_${uid()}`),
    type: ArtifactType.OTHER,
    title,
    description,
    phase: ctx.step.phase,
    version: "0.1.0",
    createdBy: Role.AI,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    content,
  })
}

/** AI 能力：调用 agent-layer 助手；CHECKLIST_RECOMMENDATION 落为清单项，其余落为制品 */
const aiHandler: CapabilityHandler = async (ref, ctx) => {
  if (ref.kind !== "ai") return { kind: ref.kind, ref: "", ok: false }
  const label = ref.assistant
  if (!ctx.aiClient) {
    return { kind: "ai", ref: label, ok: false, summary: "未配置 AIClient" }
  }
  const input = ctx.input ?? ref.input ?? `${ctx.step.name}：${ctx.step.description}`
  let text: string
  let crossReviewSummary: string | undefined
  let crossReviewOk = true
  if (ref.reviewers !== undefined) {
    if (ref.assistant !== AIAssistantType.CODE_REVIEW) {
      return { kind: "ai", ref: label, ok: false, summary: "交叉 reviewer 仅支持 CODE_REVIEW" }
    }
    if (!ctx.state.projectRoot) {
      return { kind: "ai", ref: label, ok: false, summary: "交叉代码评审需要配置源码根目录" }
    }
    const definition = loadWorkflowDefinition(ctx.state.projectRoot)
    const nodeKey = resolveWorkflowNodeKey(definition, ctx.step.id)
    const nodePath = getWorkflowWorkspace(ctx.state.projectRoot).nodePath(nodeKey)
    const relativeNodePath = relative(ctx.state.projectRoot, nodePath).replaceAll("\\", "/")
    const reviewOutputDir = ref.reviewOutputDir ?? "reviews"
    const res = await ctx.aiClient.crossReviewCode(input, ctx.state.projectRoot, ref.reviewers, {
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      excludedPaths: [
        ...(ref.outputFile ? [`${relativeNodePath}/${ref.outputFile}`] : []),
        `${relativeNodePath}/${reviewOutputDir}/**`,
      ],
    })
    if (ctx.signal?.aborted) throw new Error("交叉代码评审已取消")
    text = res.result
    writeCrossReviewReports(nodePath, res, {
      ...(ref.outputFile !== undefined ? { outputFile: ref.outputFile } : {}),
      ...(ref.reviewOutputDir !== undefined ? { reviewOutputDir: ref.reviewOutputDir } : {}),
      scope: ctx.state.requirementId,
    })
    for (const review of res.reviews) {
      appendAIArtifact(
        ctx,
        `AI ${label} · ${review.agent} · ${ctx.step.id}`,
        `${review.agent} 的独立代码评审${review.ok ? "" : "（失败）"}`,
        review.ok
          ? review.output
          : [review.error ?? "未知错误", review.output].filter((part) => part !== "").join("\n\n"),
      )
    }
    const minimum = ref.minimumSuccessfulReviewers ?? ref.reviewers.length
    crossReviewOk = res.successCount >= minimum
    crossReviewSummary = crossReviewOk
      ? `${res.successCount}/${ref.reviewers.length} 个 reviewer 成功`
      : `至少需要 ${minimum} 个成功，实际 ${res.successCount} 个`
  } else {
    const res = await ctx.aiClient.callAssistant(ref.assistant, input)
    text = res.result ?? ""
  }

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

  appendAIArtifact(ctx, `AI ${label} · ${ctx.step.id}`, `步骤 ${ctx.step.id} 的 AI 辅助产出`, text)
  return {
    kind: "ai",
    ref: label,
    ok: crossReviewOk,
    summary: crossReviewSummary ?? truncate(text),
  }
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
    const input = (ref as { input?: Readonly<Record<string, unknown>> }).input ?? ctx.input
    const out =
      input === undefined
        ? await (fn as (...args: unknown[]) => unknown).call(service)
        : await (fn as (...args: unknown[]) => unknown).call(service, input)
    return { kind: "integration", ref: label, ok: true, summary: truncate(JSON.stringify(out ?? {})) }
  } catch (err) {
    return { kind: "integration", ref: label, ok: false, summary: (err as Error).message }
  }
}

function createCustomHandler(customHandlers: ReadonlyMap<string, CapabilityHandler>): CapabilityHandler {
  return async (ref, ctx) => {
    if (ref.kind !== "custom") return { kind: ref.kind, ref: "", ok: false }
    const handler = customHandlers.get(ref.name)
    if (!handler) {
      return { kind: "custom", ref: ref.name, ok: false, summary: `未注册自定义能力: ${ref.name}` }
    }
    return handler(ref, ctx)
  }
}

/** capability 注册表 */
export class CapabilityRegistry {
  private readonly handlers = new Map<string, CapabilityHandler>()

  constructor(customHandlers: ReadonlyMap<string, CapabilityHandler> = new Map()) {
    this.handlers.set("ai", aiHandler)
    this.handlers.set("heinrich", heinrichHandler)
    this.handlers.set("integration", integrationHandler)
    this.handlers.set("custom", createCustomHandler(customHandlers))
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
