import { describe, it, expect } from "vitest"
import { ArtifactType, ARTIFACT_TYPE_LABELS } from "./artifact.js"
import type { Artifact } from "./artifact.js"

describe("ArtifactType", () => {
  it("枚举包含13种类型", () => {
    expect(Object.values(ArtifactType)).toHaveLength(13)
    expect(ArtifactType.BRD).toBe("BRD")
    expect(ArtifactType.PRD).toBe("PRD")
    expect(ArtifactType.TECH_DESIGN).toBe("TECH_DESIGN")
    expect(ArtifactType.TEST_CASE).toBe("TEST_CASE")
    expect(ArtifactType.MEETING_MINUTES).toBe("MEETING_MINUTES")
    expect(ArtifactType.OTHER).toBe("OTHER")
  })

  it("包含 BRD_CHECK_REPORT 类型", () => {
    expect(ArtifactType.BRD_CHECK_REPORT).toBe("BRD_CHECK_REPORT")
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
  it("BRD_CHECK_REPORT 标签正确", () => {
    expect(ARTIFACT_TYPE_LABELS[ArtifactType.BRD_CHECK_REPORT]).toBe("BRD 检查报告")
  })
})

describe("Artifact 新字段可选兼容", () => {
  it("parentArtifactId 和 source 字段存在且可选", () => {
    // 编译期类型检查：确保 Artifact 接口包含新字段
    const artifact: Artifact = {
      id: "art_test" as never,
      type: ArtifactType.BRD_CHECK_REPORT,
      title: "test",
      description: "test",
      phase: "INTENTION" as never,
      version: "1.0.0",
      createdBy: "AI" as never,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      parentArtifactId: "art_parent",
      source: {
        runId: "run_123",
        eventSequence: 42,
        fileHash: "abc123",
        commitSha: "def456",
        sessionId: "ses_xyz",
      },
    }
    expect(artifact.parentArtifactId).toBe("art_parent")
    expect(artifact.source?.runId).toBe("run_123")
    expect(artifact.source?.eventSequence).toBe(42)
    expect(artifact.source?.fileHash).toBe("abc123")
    expect(artifact.source?.commitSha).toBe("def456")
    expect(artifact.source?.sessionId).toBe("ses_xyz")
  })

  it("不提供新字段时仍合法", () => {
    const artifact: Artifact = {
      id: "art_test2" as never,
      type: ArtifactType.BRD,
      title: "test",
      description: "test",
      phase: "INTENTION" as never,
      version: "1.0.0",
      createdBy: "AI" as never,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    }
    expect(artifact.parentArtifactId).toBeUndefined()
    expect(artifact.source).toBeUndefined()
  })
})
