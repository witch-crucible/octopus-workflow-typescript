/**
 * 项目工作流文件与节点工作目录管理。
 *
 * workflow.yaml 是项目级可版本化配置；运行时目录固定为 workflow/shared
 * 与 workflow/nodes/<nodeId>，避免每个调用方重复推导路径。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { dump, load } from "js-yaml"
import { z } from "zod"
import type { WorkflowDefinition, WorkflowNodeSpec, NodeAction } from "@octopus/core/execution.js"
import { getWorkflowSpec } from "@octopus/core/spec.js"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import { HeinrichLevel } from "@octopus/core/risk.js"

const WORKFLOW_FILE = "workflow.yaml"

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("manual"), instructions: z.string().optional() }),
  z.object({
    type: z.literal("command"),
    executable: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("ai"), assistant: z.string().min(1), input: z.string().optional() }),
  z.object({
    type: z.literal("integration"),
    service: z.string().min(1),
    operation: z.string().min(1),
    input: z.record(z.unknown()).optional(),
  }),
  z.object({ type: z.literal("heinrich"), delta: z.number().int(), level: z.nativeEnum(HeinrichLevel).optional() }),
])

const nodeSchema = z.object({
  id: z.string().min(1),
  phase: z.nativeEnum(Phase),
  name: z.string().min(1),
  description: z.string().default(""),
  responsibleRoles: z.array(z.nativeEnum(Role)).min(1),
  dependsOn: z.array(z.string()).default([]),
  actions: z.array(actionSchema).default([]),
})

const definitionSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  nodes: z.array(nodeSchema).min(1),
})

export interface WorkflowWorkspace {
  readonly projectRoot: string
  readonly workflowFile: string
  readonly sharedPath: string
  readonly nodesPath: string
  nodePath(nodeId: string): string
}

/** 将节点 id 转换为稳定且不会越界的目录名。 */
export function nodeDirectoryName(nodeId: string): string {
  const normalized = nodeId.trim().replaceAll(/[^a-zA-Z0-9._-]/g, "_")
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error(`节点 ID 无法生成目录名: ${nodeId}`)
  }
  return normalized
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
    nodePath: (nodeId: string) => join(nodesPath, nodeDirectoryName(nodeId)),
  }
}

/** 将现有内置规格转换为可执行工作流。 */
export function definitionFromBuiltInSpec(): WorkflowDefinition {
  const spec = getWorkflowSpec()
  return {
    version: 1,
    name: "Octopus Software Delivery",
    nodes: spec.phases.flatMap((phase) => phase.steps.map((step): WorkflowNodeSpec => ({
      id: step.id,
      phase: phase.phase,
      name: step.name,
      description: step.description,
      responsibleRoles: step.responsibleRoles,
      dependsOn: step.dependsOn,
      actions: step.capabilities?.map((capability): NodeAction => {
        if (capability.kind === "ai") return { type: "ai", assistant: capability.assistant }
        if (capability.kind === "integration") {
          return { type: "integration", service: capability.service, operation: capability.op }
        }
        return capability.level === undefined
          ? { type: "heinrich", delta: capability.delta }
          : { type: "heinrich", delta: capability.delta, level: capability.level }
      }) ?? [{ type: "manual" }],
    }))),
  }
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

  const result = definitionSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`workflow.yaml 校验失败: ${result.error.issues.map((issue) => issue.message).join("; ")}`)
  }
  const definition = result.data as unknown as WorkflowDefinition
  const ids = new Set<string>()
  for (const node of definition.nodes) {
    if (ids.has(node.id)) throw new Error(`工作流节点 ID 重复: ${node.id}`)
    ids.add(node.id)
  }
  for (const node of definition.nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`节点 ${node.id} 依赖不存在: ${dependency}`)
    }
  }
  assertAcyclic(definition.nodes)
  return definition
}

/** 创建缺失的公共目录和节点目录，并返回实际布局。 */
export function syncWorkflowWorkspace(projectRoot: string, definition = loadWorkflowDefinition(projectRoot)): WorkflowWorkspace {
  const workspace = getWorkflowWorkspace(projectRoot)
  mkdirSync(workspace.sharedPath, { recursive: true })
  for (const node of definition.nodes) mkdirSync(workspace.nodePath(node.id), { recursive: true })
  return workspace
}

/** 初始化工作流文件；已有文件绝不覆盖。 */
export function initializeWorkflowFile(projectRoot: string): WorkflowWorkspace {
  const workspace = getWorkflowWorkspace(projectRoot)
  if (!existsSync(workspace.workflowFile)) {
    writeFileSync(workspace.workflowFile, dump(definitionFromBuiltInSpec()), "utf8")
  }
  return syncWorkflowWorkspace(projectRoot)
}

function assertAcyclic(nodes: readonly WorkflowNodeSpec[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`工作流依赖存在环: ${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    const node = byId.get(id)
    if (!node) throw new Error(`依赖节点不存在: ${id}`)
    for (const dependency of node.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const node of nodes) visit(node.id)
}
