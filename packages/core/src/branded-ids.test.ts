import { describe, it, expect } from "vitest"
import { TaskId, PhaseId, ProjectId, RequirementId, MilestoneId, ArtifactId, ObservationId, ChecklistItemId, AgentCallId, createId } from "./branded-ids.js"

describe("createId", () => {
  it("创建带品牌类型的 ID", () => {
    const MyId = createId<"MyId">("my")
    const id = MyId("abc123")
    expect(id).toBe("abc123")
  })
})

describe("工厂函数", () => {
  it("TaskId 返回传入的字符串", () => {
    expect(TaskId("task_001")).toBe("task_001")
  })
  it("PhaseId 返回传入的字符串", () => {
    expect(PhaseId("design")).toBe("design")
  })
  it("ProjectId 返回传入的字符串", () => {
    expect(ProjectId("proj_001")).toBe("proj_001")
  })
  it("RequirementId 返回传入的字符串", () => {
    expect(RequirementId("req_001")).toBe("req_001")
  })
  it("MilestoneId 返回传入的字符串", () => {
    expect(MilestoneId("ms_001")).toBe("ms_001")
  })
  it("ArtifactId 返回传入的字符串", () => {
    expect(ArtifactId("art_001")).toBe("art_001")
  })
  it("ObservationId 返回传入的字符串", () => {
    expect(ObservationId("obs_001")).toBe("obs_001")
  })
  it("ChecklistItemId 返回传入的字符串", () => {
    expect(ChecklistItemId("check_001")).toBe("check_001")
  })
  it("AgentCallId 返回传入的字符串", () => {
    expect(AgentCallId("call_001")).toBe("call_001")
  })
})
