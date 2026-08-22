import { describe, expect, it } from "vitest"
import { buildWorkflowGraphNodes, nodeRoles } from "./graph-model.js"

describe("nodeRoles", () => {
  it("prefers responsibleRoles and falls back to responsibleRole/DEV", () => {
    expect(nodeRoles({ responsibleRoles: ["PM", "BA", "PM"] })).toEqual(["PM", "BA"])
    expect(nodeRoles({ responsibleRole: "QA" })).toEqual(["QA"])
    expect(nodeRoles({})).toEqual(["DEV"])
    expect(nodeRoles(null)).toEqual(["DEV"])
  })
})

describe("buildWorkflowGraphNodes", () => {
  it("maps runtime-only nodes when definition is missing", () => {
    const nodes = buildWorkflowGraphNodes(
      {
        steps: [
          {
            id: "10.1",
            name: "A",
            responsibleRole: "PM",
            status: "PENDING",
          },
        ],
      },
      null,
    )
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.responsibleRoles).toEqual(["PM"])
    expect(nodes[0]?.activated).toBe(true)
  })

  it("merges definition roles and dependsOn mapping", () => {
    const nodes = buildWorkflowGraphNodes(
      {
        steps: [
          {
            id: "n1",
            name: "Runtime Name",
            responsibleRole: "DEV",
            status: "IN_PROGRESS",
            actions: [{ type: "manual" }],
          },
        ],
      },
      {
        nodeIdMapping: { a: "n1", b: "n2" },
        nodes: [
          {
            key: "a",
            phase: "Intention",
            name: "Spec Name",
            description: "from spec",
            responsibleRoles: ["PM", "BA"],
            dependsOn: [],
            actions: [{ type: "ai" }],
          },
          {
            key: "b",
            phase: "Research",
            name: "Locked Node",
            description: "waiting",
            responsibleRoles: ["SA"],
            dependsOn: ["a"],
          },
        ],
      },
    )

    expect(nodes).toHaveLength(2)
    const first = nodes.find((node) => node.id === "n1")
    const second = nodes.find((node) => node.id === "n2")
    expect(first?.name).toBe("Spec Name")
    expect(first?.responsibleRoles).toEqual(["PM", "BA"])
    expect(first?.responsibleRole).toBe("PM")
    expect(first?.activated).toBe(true)
    expect(first?.status).toBe("IN_PROGRESS")
    expect(second?.activated).toBe(false)
    expect(second?.status).toBe("LOCKED")
    expect(second?.dependsOn).toEqual(["n1"])
    expect(second?.responsibleRoles).toEqual(["SA"])
  })

  it("appends orphan runtime nodes not present in definition", () => {
    const nodes = buildWorkflowGraphNodes(
      {
        steps: [
          { id: "known", name: "K", responsibleRole: "PM" },
          { id: "orphan", name: "O", responsibleRole: "QA" },
        ],
      },
      {
        nodeIdMapping: { k: "known" },
        nodes: [
          {
            key: "k",
            phase: "Design",
            name: "Known",
            description: "d",
            responsibleRoles: ["PM"],
            dependsOn: [],
          },
        ],
      },
    )
    expect(nodes.map((node) => node.id).sort()).toEqual(["known", "orphan"])
    expect(nodes.find((node) => node.id === "orphan")?.activated).toBe(true)
  })
})
