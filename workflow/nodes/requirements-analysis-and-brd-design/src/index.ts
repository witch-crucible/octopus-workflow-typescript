/**
 * Requirements Analysis and BRD Design 节点业务编排。
 *
 * WorkflowEngine 负责提供项目状态、AI 客户端和 Artifact 持久化；本模块拥有
 * BRD 上下文、提示词选择、生成/检查分支以及节点产出文件约定。
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { AIAssistantType, type AIResponse } from "@octopus/core/agent.js"
import { ArtifactType, type CreateArtifactParams } from "@octopus/core/artifact.js"
import type { ProjectBrdDesignConfig } from "@octopus/core/brd-design.js"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import {
  encodeBrdPromptEnvelope,
  gatherBrdSourceContext,
  renderBrdPromptsForContext,
  resolveBrdCheckReportPath,
  toProjectRelative,
  type BrdRenderedPrompt,
} from "./context.js"

export * from "./context.js"

export interface BrdNodeInput {
  config: ProjectBrdDesignConfig
  projectRoot: string
  requirementId: string
  requirementName: string
  requirementDescription: string
}

export interface BrdNodeRuntime {
  callAssistant?: (assistant: AIAssistantType, input: string) => Promise<AIResponse>
  createArtifact: (requirementId: string, params: CreateArtifactParams) => void
}

export interface BrdGenerateResult {
  outputPath: string
  result?: string
  promptsUsed: BrdRenderedPrompt[]
  warnings: string[]
  dryRun: boolean
}

export interface BrdCheckResult {
  reportPath: string
  result?: string
  promptsUsed: BrdRenderedPrompt[]
  warnings: string[]
  dryRun: boolean
}

export interface BrdPreviewOptions {
  mode?: "generate" | "check" | "all"
  includeSummarize?: boolean
}

function gather(input: BrdNodeInput) {
  return gatherBrdSourceContext(input.config, input.projectRoot, {
    name: input.requirementName,
    description: input.requirementDescription,
  })
}

export function previewBrdNodePrompts(
  input: BrdNodeInput,
  options?: BrdPreviewOptions,
): { prompts: BrdRenderedPrompt[]; warnings: string[]; outputPath: string } {
  const context = gather(input)
  const prompts = renderBrdPromptsForContext(
    input.config,
    context,
    options?.mode ?? "all",
    options?.includeSummarize === true ? { includeSummarize: true } : undefined,
  )
  return { prompts, warnings: context.warnings, outputPath: context.outputPath }
}

export async function runBrdGenerate(
  input: BrdNodeInput,
  runtime: BrdNodeRuntime,
  options?: { dryRun?: boolean },
): Promise<BrdGenerateResult> {
  const context = gather(input)
  const promptsUsed = renderBrdPromptsForContext(input.config, context, "generate")
  const generatePrompt = promptsUsed.find((item) => item.id === "generate")
  if (!generatePrompt) throw new Error("未找到 generate 提示词")

  if (options?.dryRun) {
    return {
      outputPath: context.outputPath,
      promptsUsed,
      warnings: context.warnings,
      dryRun: true,
    }
  }
  if (!runtime.callAssistant) throw new Error("未配置 AI 客户端，无法生成 BRD")

  const envelope = encodeBrdPromptEnvelope(generatePrompt.system, generatePrompt.prompt)
  const response = await runtime.callAssistant(AIAssistantType.BRD_GENERATE, envelope)
  mkdirSync(dirname(context.absoluteOutputPath), { recursive: true })
  writeFileSync(context.absoluteOutputPath, response.result, "utf8")
  runtime.createArtifact(input.requirementId, {
    type: ArtifactType.BRD,
    title: `${input.requirementName} BRD`,
    description: "AI 生成的商业需求文档",
    phase: Phase.INTENTION,
    createdBy: Role.AI,
    content: response.result.slice(0, 4_000),
    filePath: toProjectRelative(input.projectRoot, context.absoluteOutputPath),
  })
  return {
    outputPath: context.outputPath,
    result: response.result,
    promptsUsed,
    warnings: context.warnings,
    dryRun: false,
  }
}

export async function runBrdCheck(
  input: BrdNodeInput,
  runtime: BrdNodeRuntime,
  options?: { dryRun?: boolean },
): Promise<BrdCheckResult> {
  const context = gather(input)
  if (!context.existingBrd.trim()) {
    throw new Error(
      `未找到已有 BRD（${context.outputPath}）。请先运行 brd generate，或将 BRD 放入该路径后再检查。`,
    )
  }
  const promptsUsed = renderBrdPromptsForContext(input.config, context, "check")
  const checkPrompt = promptsUsed.find((item) => item.id === "check")
  if (!checkPrompt) throw new Error("未找到 check 提示词")

  const reportAbsolute = resolveBrdCheckReportPath(context.absoluteOutputPath)
  const reportPath = toProjectRelative(input.projectRoot, reportAbsolute)
  if (options?.dryRun) {
    return {
      reportPath,
      promptsUsed,
      warnings: context.warnings,
      dryRun: true,
    }
  }
  if (!runtime.callAssistant) throw new Error("未配置 AI 客户端，无法检查 BRD")

  const envelope = encodeBrdPromptEnvelope(checkPrompt.system, checkPrompt.prompt)
  const response = await runtime.callAssistant(AIAssistantType.BRD_CHECK, envelope)
  mkdirSync(dirname(reportAbsolute), { recursive: true })
  writeFileSync(reportAbsolute, response.result, "utf8")
  return {
    reportPath,
    result: response.result,
    promptsUsed,
    warnings: context.warnings,
    dryRun: false,
  }
}
