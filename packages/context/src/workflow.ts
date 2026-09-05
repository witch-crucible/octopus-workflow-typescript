/**
 * 项目工作流文件与节点工作目录管理。
 *
 * workflow.yaml 是项目级可版本化配置；运行时目录固定为 workflow/shared
 * 与 workflow/nodes/<nodeKey>，避免每个调用方重复推导路径。
 */

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { dump, load } from "js-yaml"
import { z } from "zod"
import type { WorkflowDefinition, WorkflowNodeSpec, NodeAction, WorkflowPluginRef } from "@octopus/core/execution.js"
import { getWorkflowSpec } from "@octopus/core/spec.js"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import { HeinrichLevel } from "@octopus/core/risk.js"
import { AIAssistantType, CODE_REVIEW_AGENTS } from "@octopus/core/agent.js"
import { applyWorkflowOverlays } from "@octopus/plugin/overlay.js"
import type { PluginRef, WorkflowOverlay } from "@octopus/plugin/index.js"

const WORKFLOW_FILE = "workflow.yaml"
const NODE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const ENGLISH_NODE_TEXT_PATTERN = /^[\x20-\x7E]+$/

/** 内置步骤 ID 到英文节点键的唯一映射。 */
const BUILT_IN_NODE_KEY_BY_ID: Readonly<Record<string, string>> = {
  "10.1": "requirements-analysis-and-brd-design",
  "10.2": "brd-walkthrough",
  "10.3": "requirements-research",
  "10.4": "prd-design-and-boundary-analysis",
  "10.5": "prd-walkthrough",
  "10.6": "ai-meeting-minutes",
  "10.7": "prd-review-and-feature-breakdown",
  "10.8": "prd-effort-estimation",
  "10.9": "ai-requirements-analysis",
  "10.10": "ai-effort-summary",
  "10.11": "effort-estimate-sync",
  "10.12": "developer-effort-confirmation",
  "10.doc": "generate-documentation",
  "20.1": "requirements-scheduling",
  "20.2": "kickoff-review",
  "20.2a": "ai-kickoff-summary",
  "20.3": "requirements-walkthrough",
  "20.4": "developer-prd-recap",
  "20.5": "teambition-task-breakdown",
  "20.6": "impact-scope-assessment",
  "20.7": "frontend-backend-alignment",
  "20.8": "technical-design-authoring",
  "30.1": "technical-design-consolidation",
  "30.2": "ai-setup-checklist-validation",
  "30.3": "technical-design-review-chain",
  "30.4": "ai-technical-design-review",
  "30.5": "test-case-design-and-review",
  "30.6": "data-and-api-design",
  "30.7": "feature-development",
  "30.8": "checklist-update-and-integration",
  "30.9": "environment-validation-and-documentation",
  "30.10": "self-test-and-code-quality",
  "30.11": "weekly-feature-demo",
  "40.1": "smoke-demo-validation",
  "40.2": "functional-and-performance-testing",
  "40.3": "uat-and-user-acceptance",
  "40.4": "release-plan-creation",
  "50.1": "environment-deployment",
  "50.2": "branch-merge",
  "50.3": "ai-checklist-recommendation",
  "50.4": "sonar-and-code-review",
  "50.5": "ai-code-review",
  "50.6": "postman-and-test-script-generation",
  "50.7": "sql-execution-and-risk-check",
  "50.7a": "go-live-check",
  "50.8": "magento-release-risk-assessment",
  "50.9": "regression-testing",
  "50.10": "ab-validation-and-branch-merge",
  "60.1": "ai-technical-debt-quantification",
  "60.2": "service-monitoring",
}

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual"), instructions: z.string().optional() }),
  z.object({
    type: z.literal("command"),
    executable: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("ai"),
    assistant: z.string().min(1),
    input: z.string().optional(),
    outputFile: z.string().min(1).optional(),
    ifExists: z.enum(["overwrite", "extend"]).optional(),
    reviewers: z.array(z.enum(CODE_REVIEW_AGENTS)).min(1).optional(),
    minimumSuccessfulReviewers: z.number().int().positive().optional(),
    reviewOutputDir: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("integration"),
    service: z.string().min(1),
    operation: z.string().min(1),
    input: z.record(z.unknown()).optional(),
  }),
  z.object({ type: z.literal("heinrich"), delta: z.number().int(), level: z.nativeEnum(HeinrichLevel).optional() }),
  z.object({
    type: z.literal("custom"),
    name: z.string().min(1),
    input: z.record(z.unknown()).optional(),
  }),
]).superRefine((action, ctx) => {
  if (action.type !== "ai") return
  if (action.reviewers && action.assistant !== AIAssistantType.CODE_REVIEW) {
    ctx.addIssue({ code: "custom", message: "reviewers 仅支持 CODE_REVIEW assistant", path: ["reviewers"] })
  }
  if (action.reviewers && new Set(action.reviewers).size !== action.reviewers.length) {
    ctx.addIssue({ code: "custom", message: "reviewers 不能重复", path: ["reviewers"] })
  }
  if (action.minimumSuccessfulReviewers !== undefined) {
    if (!action.reviewers) {
      ctx.addIssue({ code: "custom", message: "minimumSuccessfulReviewers 需要 reviewers", path: ["minimumSuccessfulReviewers"] })
    } else if (action.minimumSuccessfulReviewers > action.reviewers.length) {
      ctx.addIssue({ code: "custom", message: "minimumSuccessfulReviewers 不能超过 reviewers 数量", path: ["minimumSuccessfulReviewers"] })
    }
  }
})

const pluginRefSchema = z.union([
  z.string().min(1),
  z.object({
    id: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    package: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    options: z.record(z.unknown()).optional(),
  }).strict(),
])

const nodeSchema = z.object({
  key: z.string().regex(NODE_KEY_PATTERN, "节点 key 必须是英文 kebab-case"),
  phase: z.nativeEnum(Phase),
  name: z.string().min(1).regex(ENGLISH_NODE_TEXT_PATTERN, "节点 name 必须使用英文"),
  description: z.string().default("").refine(
    (value) => value.length === 0 || ENGLISH_NODE_TEXT_PATTERN.test(value),
    "节点 description 必须使用英文",
  ),
  responsibleRoles: z.array(z.nativeEnum(Role)).min(1),
  dependsOn: z.array(z.string()).default([]),
  actions: z.array(actionSchema).default([]),
}).strict()

const definitionSchema = z.object({
  version: z.literal(2),
  name: z.string().min(1),
  nodeIdMapping: z.record(z.string().min(1)),
  nodes: z.array(nodeSchema).min(1),
  plugins: z.array(pluginRefSchema).optional(),
}).strict()

const overlaySchema = z.object({
  add: z.array(nodeSchema).optional(),
  replace: z.array(nodeSchema.partial().required({ key: true })).optional(),
  disable: z.array(z.string().min(1)).optional(),
  rewire: z.array(z.object({
    key: z.string().min(1),
    dependsOn: z.array(z.string()),
  }).strict()).optional(),
}).strict()

const OVERLAY_FILE = "workflow.overlay.yaml"

export interface WorkflowWorkspace {
  readonly projectRoot: string
  readonly workflowFile: string
  readonly sharedPath: string
  readonly nodesPath: string
  nodePath(nodeKey: string): string
}

/** 校验并返回可直接作为目录名的英文节点键。 */
export function nodeDirectoryName(nodeKey: string): string {
  if (!NODE_KEY_PATTERN.test(nodeKey)) throw new Error(`节点 key 必须是英文 kebab-case: ${nodeKey}`)
  return nodeKey
}

/** 获取项目工作目录布局。 */
export function getWorkflowWorkspace(projectRoot: string): WorkflowWorkspace {
  const root = resolve(projectRoot)
  const nodesPath = join(root, "workflow", "nodes")
  return {
    projectRoot: root,
    workflowFile: join(root, WORKFLOW_FILE),
    sharedPath: join(root, "workflow", "shared"),
    nodesPath,
    nodePath: (nodeKey: string) => join(nodesPath, nodeDirectoryName(nodeKey)),
  }
}

/** 将现有内置规格转换为可执行工作流。 */
export function definitionFromBuiltInSpec(): WorkflowDefinition {
  const spec = getWorkflowSpec()
  const steps = spec.phases.flatMap((phase) => phase.steps.map((step) => ({ phase, step })))
  const keyForId = (id: string): string => {
    const key = BUILT_IN_NODE_KEY_BY_ID[id]
    if (!key) throw new Error(`内置节点缺少英文 key 映射: ${id}`)
    return key
  }
  return {
    version: 2,
    name: "Octopus Software Delivery",
    nodeIdMapping: Object.fromEntries(steps.map(({ step }) => [keyForId(step.id), step.id])),
    nodes: steps.map(({ phase, step }): WorkflowNodeSpec => ({
      key: keyForId(step.id),
      phase: phase.phase,
      name: step.name,
      description: step.description,
      responsibleRoles: step.responsibleRoles,
      dependsOn: step.dependsOn.map(keyForId),
      actions: step.capabilities?.map((capability): NodeAction => {
        if (capability.kind === "ai") {
          return {
            type: "ai",
            assistant: capability.assistant,
            ...(capability.input !== undefined ? { input: capability.input } : {}),
            ...(capability.outputFile !== undefined ? { outputFile: capability.outputFile } : {}),
            ...(capability.ifExists !== undefined ? { ifExists: capability.ifExists } : {}),
            ...(capability.reviewers !== undefined ? { reviewers: capability.reviewers } : {}),
            ...(capability.minimumSuccessfulReviewers !== undefined
              ? { minimumSuccessfulReviewers: capability.minimumSuccessfulReviewers }
              : {}),
            ...(capability.reviewOutputDir !== undefined
              ? { reviewOutputDir: capability.reviewOutputDir }
              : {}),
          }
        }
        if (capability.kind === "integration") {
          return { type: "integration", service: capability.service, operation: capability.op }
        }
        if (capability.kind === "custom") {
          return capability.input === undefined
            ? { type: "custom", name: capability.name }
            : { type: "custom", name: capability.name, input: capability.input }
        }
        return capability.level === undefined
          ? { type: "heinrich", delta: capability.delta }
          : { type: "heinrich", delta: capability.delta, level: capability.level }
      }) ?? [{ type: "manual" }],
    })),
  }
}

/** 读取 workflow.yaml 中的 plugins 字段；文件不存在时返回空列表。 */
export function loadWorkflowPluginRefs(projectRoot: string): PluginRef[] {
  const workspace = getWorkflowWorkspace(projectRoot)
  if (!existsSync(workspace.workflowFile)) return []
  let parsed: unknown
  try {
    parsed = load(readFileSync(workspace.workflowFile, "utf8"))
  } catch (cause) {
    throw new Error(`无法解析 ${workspace.workflowFile}: ${(cause as Error).message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const plugins = (parsed as { plugins?: unknown }).plugins
  if (plugins === undefined) return []
  const result = z.array(pluginRefSchema).safeParse(plugins)
  if (!result.success) {
    throw new Error(`workflow.yaml plugins 校验失败: ${result.error.issues.map((issue) => issue.message).join("; ")}`)
  }
  return result.data as PluginRef[]
}

/** 读取项目根目录的 workflow.overlay.yaml；不存在则返回 undefined。 */
export function loadWorkflowOverlayFile(projectRoot: string): WorkflowOverlay | undefined {
  const overlayPath = join(resolve(projectRoot), OVERLAY_FILE)
  if (!existsSync(overlayPath)) return undefined
  let parsed: unknown
  try {
    parsed = load(readFileSync(overlayPath, "utf8"))
  } catch (cause) {
    throw new Error(`无法解析 ${overlayPath}: ${(cause as Error).message}`)
  }
  const result = overlaySchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`workflow.overlay.yaml 校验失败: ${result.error.issues.map((issue) => issue.message).join("; ")}`)
  }
  return result.data as WorkflowOverlay
}

/** 读取基础定义并按插件 overlay + 项目 overlay 文件叠加。无 overlay 时返回原定义。 */
export function loadResolvedWorkflowDefinition(
  projectRoot: string,
  pluginOverlays: readonly WorkflowOverlay[] = [],
): WorkflowDefinition {
  const base = loadWorkflowDefinition(projectRoot)
  const fileOverlay = loadWorkflowOverlayFile(projectRoot)
  const overlays = [...pluginOverlays, ...(fileOverlay ? [fileOverlay] : [])]
  if (overlays.length === 0) return base
  return validateWorkflowDefinition(applyWorkflowOverlays(base, overlays))
}

/** 读取并严格校验 workflow.yaml，同时检测重复节点和依赖环。 */
export function loadWorkflowDefinition(projectRoot: string): WorkflowDefinition {
  const workspace = getWorkflowWorkspace(projectRoot)
  if (!existsSync(workspace.workflowFile)) return definitionFromBuiltInSpec()

  let parsed: unknown
  try {
    parsed = load(readFileSync(workspace.workflowFile, "utf8"))
  } catch (cause) {
    throw new Error(`无法解析 ${workspace.workflowFile}: ${(cause as Error).message}`)
  }

  return validateWorkflowDefinition(parsed)
}

/** 严格校验工作流定义，同时检测重复节点、缺失依赖和依赖环。 */
export function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  const result = definitionSchema.safeParse(value)
  if (!result.success) {
    throw new Error(`workflow.yaml 校验失败: ${result.error.issues.map((issue) => issue.message).join("; ")}`)
  }
  const parsed = result.data
  const definition: WorkflowDefinition = {
    version: parsed.version,
    name: parsed.name,
    nodeIdMapping: parsed.nodeIdMapping,
    nodes: parsed.nodes as unknown as WorkflowNodeSpec[],
    ...(parsed.plugins !== undefined && parsed.plugins.length > 0
      ? { plugins: parsed.plugins as WorkflowPluginRef[] }
      : {}),
  }
  const keys = new Set<string>()
  for (const node of definition.nodes) {
    if (keys.has(node.key)) throw new Error(`工作流节点 key 重复: ${node.key}`)
    keys.add(node.key)
  }
  const mappingKeys = Object.keys(definition.nodeIdMapping)
  const mappedIds = Object.values(definition.nodeIdMapping)
  if (new Set(mappedIds).size !== mappedIds.length) throw new Error("nodeIdMapping 包含重复内部 ID")
  for (const key of keys) {
    if (!definition.nodeIdMapping[key]) throw new Error(`节点 ${key} 缺少内部 ID 映射`)
  }
  for (const key of mappingKeys) {
    if (!keys.has(key)) throw new Error(`nodeIdMapping 包含未知节点: ${key}`)
  }
  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn) {
      if (!keys.has(dependency)) throw new Error(`节点 ${node.key} 依赖不存在: ${dependency}`)
    }
  }
  assertAcyclic(definition.nodes)
  return definition
}

/** 原子写入经过校验的工作流定义。 */
export function saveWorkflowDefinition(
  projectRoot: string,
  definition: WorkflowDefinition,
): WorkflowDefinition {
  const validated = validateWorkflowDefinition(definition)
  const workspace = getWorkflowWorkspace(projectRoot)
  const temporaryFile = `${workspace.workflowFile}.${process.pid}.tmp`
  writeFileSync(temporaryFile, dump(validated), "utf8")
  renameSync(temporaryFile, workspace.workflowFile)
  return validated
}

/** 将节点追加到项目工作流，并同步对应工作目录。 */
export function appendWorkflowNode(
  projectRoot: string,
  node: WorkflowNodeSpec,
): { readonly definition: WorkflowDefinition; readonly nodeId: string; readonly workspace: WorkflowWorkspace } {
  const definition = loadWorkflowDefinition(projectRoot)
  const nodeId = `node-${randomUUID()}`
  const next: WorkflowDefinition = {
    ...definition,
    nodeIdMapping: { ...definition.nodeIdMapping, [node.key]: nodeId },
    nodes: [...definition.nodes, node],
  }
  saveWorkflowDefinition(projectRoot, next)
  return { definition: next, nodeId, workspace: syncWorkflowWorkspace(projectRoot, next) }
}

/** 使用英文节点键解析内部运行态 ID。 */
export function resolveWorkflowNodeId(definition: WorkflowDefinition, nodeKey: string): string {
  const nodeId = definition.nodeIdMapping[nodeKey]
  if (!nodeId) throw new Error(`节点不存在: ${nodeKey}`)
  return nodeId
}

/** 使用内部运行态 ID 反查英文节点键。 */
export function resolveWorkflowNodeKey(definition: WorkflowDefinition, nodeId: string): string {
  const entry = Object.entries(definition.nodeIdMapping).find(([, mappedId]) => mappedId === nodeId)
  if (!entry) throw new Error(`内部节点 ID 未映射: ${nodeId}`)
  return entry[0]
}

/** 创建缺失的公共目录和节点目录，并返回实际布局。 */
export function syncWorkflowWorkspace(projectRoot: string, definition = loadWorkflowDefinition(projectRoot)): WorkflowWorkspace {
  const workspace = getWorkflowWorkspace(projectRoot)
  mkdirSync(workspace.sharedPath, { recursive: true })
  for (const node of definition.nodes) mkdirSync(workspace.nodePath(node.key), { recursive: true })
  return workspace
}

/** 初始化工作流文件；已有文件绝不覆盖。 */
export function initializeWorkflowFile(projectRoot: string): WorkflowWorkspace {
  const workspace = getWorkflowWorkspace(projectRoot)
  mkdirSync(workspace.projectRoot, { recursive: true })
  if (!existsSync(workspace.workflowFile)) {
    writeFileSync(workspace.workflowFile, dump(definitionFromBuiltInSpec()), "utf8")
  }
  return syncWorkflowWorkspace(projectRoot)
}

function assertAcyclic(nodes: readonly WorkflowNodeSpec[]): void {
  const byKey = new Map(nodes.map((node) => [node.key, node]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`工作流依赖存在环: ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    const node = byKey.get(id)
    if (!node) throw new Error(`依赖节点不存在: ${id}`)
    for (const dependency of node.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const node of nodes) visit(node.key)
}
