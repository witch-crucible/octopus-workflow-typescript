/** Workflow graph node shaping (DOM-free). */

export type RoleBearingNode = {
  responsibleRoles?: readonly string[] | null
  responsibleRole?: string | null
} | null | undefined

export type RuntimeGraphNode = {
  id: string
  phase?: string
  name?: string
  description?: string
  responsibleRole?: string
  responsibleRoles?: readonly string[]
  dependsOn?: readonly string[]
  actions?: readonly unknown[]
  status?: string
  [key: string]: unknown
}

export type WorkflowNodeSpecLike = {
  key: string
  phase: string
  name: string
  description: string
  responsibleRoles?: readonly string[]
  responsibleRole?: string
  dependsOn: readonly string[]
  actions?: readonly unknown[]
}

export type WorkflowDefinitionLike = {
  nodes?: readonly WorkflowNodeSpecLike[]
  nodeIdMapping?: Readonly<Record<string, string>>
} | null | undefined

export type WorkflowStateLike = {
  steps?: readonly RuntimeGraphNode[]
} | null | undefined

export type GraphDisplayNode = RuntimeGraphNode & {
  key?: string
  responsibleRoles: string[]
  activated: boolean
}

export type WorkflowFocusSnapshot = {
  currentNodeIds?: readonly string[]
  readyNodeIds?: readonly string[]
}

/** 返回当前执行上下文及其一跳前置/后续节点。 */
export function getWorkflowFocusNodeIds(
  nodes: readonly GraphDisplayNode[],
  snapshot: WorkflowFocusSnapshot,
): ReadonlySet<string> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const currentIds = (snapshot.currentNodeIds || []).filter((nodeId) => nodeById.has(nodeId))
  const anchorIds = new Set(
    currentIds.length
      ? currentIds
      : (snapshot.readyNodeIds || []).filter((nodeId) => nodeById.has(nodeId)),
  )
  const focused = new Set(anchorIds)

  for (const node of nodes) {
    if (anchorIds.has(node.id)) {
      for (const dependencyId of node.dependsOn || []) focused.add(dependencyId)
      continue
    }
    if ((node.dependsOn || []).some((dependencyId) => anchorIds.has(dependencyId))) {
      focused.add(node.id)
    }
  }

  return new Set([...focused].filter((nodeId) => nodeById.has(nodeId)))
}

export function nodeRoles(node: RoleBearingNode): string[] {
  const roles =
    Array.isArray(node?.responsibleRoles) && node.responsibleRoles.length
      ? node.responsibleRoles
      : [node?.responsibleRole || "DEV"]
  return [...new Set(roles.filter(Boolean))]
}

export function buildWorkflowGraphNodes(
  state: WorkflowStateLike,
  definition: WorkflowDefinitionLike,
): GraphDisplayNode[] {
  const runtimeNodes = state?.steps || []
  if (!Array.isArray(definition?.nodes) || !definition.nodeIdMapping) {
    return runtimeNodes.map((node) => ({
      ...node,
      responsibleRoles: nodeRoles(node),
      activated: true,
    }))
  }

  const mapping = definition.nodeIdMapping
  const runtimeById = new Map(runtimeNodes.map((node) => [node.id, node]))
  const nodes: GraphDisplayNode[] = definition.nodes.flatMap((spec) => {
    const id = mapping[spec.key]
    if (!id) return []
    const runtime = runtimeById.get(id)
    const responsibleRoles = nodeRoles(spec)
    return [
      {
        ...runtime,
        id,
        key: spec.key,
        phase: spec.phase,
        name: spec.name,
        description: spec.description,
        responsibleRole: responsibleRoles[0] || runtime?.responsibleRole || "DEV",
        responsibleRoles,
        dependsOn: spec.dependsOn
          .map((key: string) => mapping[key])
          .filter((value: string | undefined): value is string => Boolean(value)),
        actions: runtime?.actions || spec.actions || [],
        status: runtime?.status || "LOCKED",
        activated: Boolean(runtime),
      } satisfies GraphDisplayNode,
    ]
  })

  const knownIds = new Set(nodes.map((node) => node.id))
  for (const runtime of runtimeNodes) {
    if (knownIds.has(runtime.id)) continue
    nodes.push({
      ...runtime,
      responsibleRoles: nodeRoles(runtime),
      activated: true,
    } as GraphDisplayNode)
  }
  return nodes
}
