import { describe, it, expect } from "vitest"
import { TaskStatus, TASK_STATUS_LABELS } from "./task.js"

describe("TaskStatus", () => {
  it("枚举包含5种状态", () => {
    expect(Object.values(TaskStatus)).toHaveLength(5)
    expect(TaskStatus.PENDING).toBe("PENDING")
    expect(TaskStatus.IN_PROGRESS).toBe("IN_PROGRESS")
    expect(TaskStatus.COMPLETED).toBe("COMPLETED")
    expect(TaskStatus.BLOCKED).toBe("BLOCKED")
    expect(TaskStatus.SKIPPED).toBe("SKIPPED")
  })
})

describe("TASK_STATUS_LABELS", () => {
  it("所有状态都有中文标签", () => {
    for (const status of Object.values(TaskStatus)) {
      expect(TASK_STATUS_LABELS[status]).toBeTypeOf("string")
    }
  })
  it("标签内容正确", () => {
    expect(TASK_STATUS_LABELS[TaskStatus.PENDING]).toBe("待处理")
    expect(TASK_STATUS_LABELS[TaskStatus.COMPLETED]).toBe("已完成")
    expect(TASK_STATUS_LABELS[TaskStatus.BLOCKED]).toBe("阻塞")
  })
})
