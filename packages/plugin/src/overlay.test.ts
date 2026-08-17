import { describe, expect, it } from "vitest"
import { Phase } from "@octopus/core/phase.js"
import { Role } from "@octopus/core/role.js"
import type { WorkflowDefinition, WorkflowNodeSpec } from "@octopus/core/execution.js"
import { applyWorkflowOverlay, applyWorkflowOverlays } from "./overlay.js"

function node(key: string, dependsOn: string[] = []): WorkflowNodeSpec {
  return {
    key,
    phase: Phase.TESTING,
    name: key.replaceAll("-", " "),
    description: "node",
    responsibleRoles: [Role.QA],
    dependsOn,
    actions: [{ type: "manual" }],
  }
}

function definition(nodes: WorkflowNodeSpec[]): WorkflowDefinition {
  return {
    version: 2,
    name: "Test",
    nodeIdMapping: Object.fromEntries(nodes.map((item) => [item.key, `id:${item.key}`])),
    nodes,
  }
}

describe("applyWorkflowOverlay", () => {
  it("空 overlay 保持节点与 mapping 不变", () => {
    const base = definition([node("a"), node("b", ["a"])])
    expect(applyWorkflowOverlay(base, {})).toEqual(base)
    expect(applyWorkflowOverlays(base, [])).toBe(base)
  })

  it("add 追加节点并生成稳定 overlay id", () => {
    const result = applyWorkflowOverlay(definition([node("a")]), {
      add: [node("extra", ["a"])],
    })
    expect(result.nodes.map((item) => item.key)).toEqual(["a", "extra"])
    expect(result.nodeIdMapping["extra"]).toBe("overlay:extra")
    expect(result.nodeIdMapping["a"]).toBe("id:a")
  })

  it("replace 整段替换数组字段", () => {
    const result = applyWorkflowOverlay(definition([node("a"), node("b", ["a"])]), {
      replace: [{ key: "b", name: "B Updated", dependsOn: [], actions: [{ type: "heinrich", delta: 1 }] }],
    })
    const updated = result.nodes.find((item) => item.key === "b")
    expect(updated?.name).toBe("B Updated")
    expect(updated?.dependsOn).toEqual([])
    expect(updated?.actions).toEqual([{ type: "heinrich", delta: 1 }])
  })

  it("disable 删除节点并剥离后继依赖", () => {
    const result = applyWorkflowOverlay(definition([node("a"), node("b", ["a"]), node("c", ["b"])]), {
      disable: ["b"],
    })
    expect(result.nodes.map((item) => item.key)).toEqual(["a", "c"])
    expect(result.nodes.find((item) => item.key === "c")?.dependsOn).toEqual([])
    expect(result.nodeIdMapping["b"]).toBeUndefined()
  })

  it("rewire 只改 dependsOn", () => {
    const result = applyWorkflowOverlay(definition([node("a"), node("b"), node("c", ["a"])]), {
      rewire: [{ key: "c", dependsOn: ["b"] }],
    })
    expect(result.nodes.find((item) => item.key === "c")?.dependsOn).toEqual(["b"])
  })

  it("引用不存在的节点时失败", () => {
    const base = definition([node("a")])
    expect(() => applyWorkflowOverlay(base, { disable: ["missing"] })).toThrow(/disable/)
    expect(() => applyWorkflowOverlay(base, { replace: [{ key: "missing", name: "X" }] })).toThrow(/replace/)
    expect(() => applyWorkflowOverlay(base, { rewire: [{ key: "missing", dependsOn: [] }] })).toThrow(/rewire/)
    expect(() => applyWorkflowOverlay(base, { add: [node("a")] })).toThrow(/重复/)
  })
})
