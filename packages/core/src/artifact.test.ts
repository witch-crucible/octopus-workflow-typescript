import { describe, it, expect } from "vitest"
import { ArtifactType, ARTIFACT_TYPE_LABELS } from "./artifact.js"

describe("ArtifactType", () => {
  it("枚举包含12种类型", () => {
    expect(Object.values(ArtifactType)).toHaveLength(12)
    expect(ArtifactType.BRD).toBe("BRD")
    expect(ArtifactType.PRD).toBe("PRD")
    expect(ArtifactType.TECH_DESIGN).toBe("TECH_DESIGN")
    expect(ArtifactType.TEST_CASE).toBe("TEST_CASE")
    expect(ArtifactType.MEETING_MINUTES).toBe("MEETING_MINUTES")
    expect(ArtifactType.OTHER).toBe("OTHER")
  })
})

describe("ARTIFACT_TYPE_LABELS", () => {
  it("所有类型都有中文标签", () => {
    for (const type of Object.values(ArtifactType)) {
      expect(ARTIFACT_TYPE_LABELS[type]).toBeTypeOf("string")
    }
  })
  it("标签内容正确", () => {
    expect(ARTIFACT_TYPE_LABELS[ArtifactType.BRD]).toBe("商业需求文档")
    expect(ARTIFACT_TYPE_LABELS[ArtifactType.PRD]).toBe("产品需求文档")
    expect(ARTIFACT_TYPE_LABELS[ArtifactType.TECH_DESIGN]).toBe("技术设计文档")
  })
})
