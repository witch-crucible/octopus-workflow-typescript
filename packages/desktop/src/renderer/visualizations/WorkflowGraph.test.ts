import { describe, expect, it } from "vitest"

import type { GraphDisplayNode } from "../lib/graph-model"
import { getWorkflowFocusNodeIds } from "../lib/graph-model"

function node(id: string, dependsOn: string[] = []): GraphDisplayNode {
  return {
    id,
    dependsOn,
    responsibleRoles: ["DEV"],
    activated: true,
    status: "PENDING",
  }
}

describe("getWorkflowFocusNodeIds", () => {
  it("keeps current nodes and their immediate predecessors and successors focused", () => {
    const nodes = [
      node("before"),
      node("current", ["before"]),
      node("after", ["current"]),
      node("far", ["after"]),
    ]

    expect([...getWorkflowFocusNodeIds(nodes, { currentNodeIds: ["current"] })]).toEqual([
      "current",
      "before",
      "after",
    ])
  })

  it("uses ready nodes when there is no current node and drops stale IDs", () => {
    const nodes = [node("ready"), node("next", ["ready"]), node("other")]

    expect([
      ...getWorkflowFocusNodeIds(nodes, { currentNodeIds: ["missing"], readyNodeIds: ["ready"] }),
    ]).toEqual(["ready", "next"])
  })
})
