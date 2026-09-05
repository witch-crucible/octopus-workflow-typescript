import { describe, it, expect } from "vitest"
import type { WorkflowEvent } from "./execution.js"

describe("WorkflowEvent 新类型", () => {
  it("REQUIREMENT_CHANGED 类型可用", () => {
    const event: WorkflowEvent = {
      sequence: 1,
      requirementId: "req_123",
      type: "REQUIREMENT_CHANGED",
      payload: { name: { old: "旧名", new: "新名" } },
      createdAt: "2025-01-01T00:00:00Z",
    }
    expect(event.type).toBe("REQUIREMENT_CHANGED")
  })

  it("BRD_UPDATED 类型可用", () => {
    const event: WorkflowEvent = {
      sequence: 2,
      requirementId: "req_123",
      type: "BRD_UPDATED",
      payload: { filePath: "brd.md" },
      createdAt: "2025-01-01T00:00:00Z",
    }
    expect(event.type).toBe("BRD_UPDATED")
  })

  it("ARTIFACT_CREATED 类型可用", () => {
    const event: WorkflowEvent = {
      sequence: 3,
      requirementId: "req_123",
      type: "ARTIFACT_CREATED",
      payload: { artifactId: "art_abc", type: "BRD" },
      createdAt: "2025-01-01T00:00:00Z",
    }
    expect(event.type).toBe("ARTIFACT_CREATED")
  })

  it("现有类型仍可用", () => {
    const types: WorkflowEvent["type"][] = [
      "RUN_QUEUED",
      "RUN_STARTED",
      "ACTION_STARTED",
      "ACTION_FINISHED",
      "HEARTBEAT",
      "RUN_FINISHED",
      "RUN_FAILED",
      "RUN_CANCELED",
      "INTEGRATION_HEALTH",
    ]
    expect(types).toHaveLength(9)
  })
})
