/**
 * 工作流 overlay 纯函数合并。不读磁盘、不校验依赖环；调用方在合并后走 validate。
 */

import type { WorkflowDefinition, WorkflowNodeSpec } from "@octopus/core/execution.js"
import type { WorkflowOverlay } from "./types.js"

/** 将单份 overlay 应用到工作流定义。 */
export function applyWorkflowOverlay(
  definition: WorkflowDefinition,
  overlay: WorkflowOverlay,
): WorkflowDefinition {
  let nodes: WorkflowNodeSpec[] = definition.nodes.map((node) => ({
    ...node,
    dependsOn: [...node.dependsOn],
    actions: [...node.actions],
  }))
  const mapping: Record<string, string> = { ...definition.nodeIdMapping }

  if (overlay.disable) {
    const disabled = new Set(overlay.disable)
    for (const key of disabled) {
      if (!nodes.some((node) => node.key === key)) {
        throw new Error(`overlay disable 引用不存在的节点: ${key}`)
      }
    }
    nodes = nodes
      .filter((node) => !disabled.has(node.key))
      .map((node) => ({
        ...node,
        dependsOn: node.dependsOn.filter((dependency) => !disabled.has(dependency)),
      }))
    for (const key of disabled) {
      delete mapping[key]
    }
  }

  if (overlay.add) {
    const existing = new Set(nodes.map((node) => node.key))
    for (const node of overlay.add) {
      if (existing.has(node.key)) throw new Error(`overlay add 节点 key 重复: ${node.key}`)
      existing.add(node.key)
      nodes.push({
        ...node,
        dependsOn: [...node.dependsOn],
        actions: [...node.actions],
      })
      mapping[node.key] = mapping[node.key] ?? `overlay:${node.key}`
    }
  }

  if (overlay.replace) {
    for (const patch of overlay.replace) {
      const index = nodes.findIndex((node) => node.key === patch.key)
      if (index === -1) throw new Error(`overlay replace 引用不存在的节点: ${patch.key}`)
      const current = nodes[index]
      if (!current) throw new Error(`overlay replace 引用不存在的节点: ${patch.key}`)
      nodes[index] = {
        ...current,
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.responsibleRoles !== undefined ? { responsibleRoles: patch.responsibleRoles } : {}),
        ...(patch.dependsOn !== undefined ? { dependsOn: [...patch.dependsOn] } : {}),
        ...(patch.actions !== undefined ? { actions: [...patch.actions] } : {}),
      }
    }
  }

  if (overlay.rewire) {
    for (const wire of overlay.rewire) {
      const index = nodes.findIndex((node) => node.key === wire.key)
      if (index === -1) throw new Error(`overlay rewire 引用不存在的节点: ${wire.key}`)
      const current = nodes[index]
      if (!current) throw new Error(`overlay rewire 引用不存在的节点: ${wire.key}`)
      nodes[index] = { ...current, dependsOn: [...wire.dependsOn] }
    }
  }

  return {
    ...definition,
    nodeIdMapping: mapping,
    nodes,
  }
}

/** 按顺序叠加多份 overlay；空列表返回原定义。 */
export function applyWorkflowOverlays(
  definition: WorkflowDefinition,
  overlays: readonly WorkflowOverlay[],
): WorkflowDefinition {
  let result = definition
  for (const overlay of overlays) {
    result = applyWorkflowOverlay(result, overlay)
  }
  return result
}
