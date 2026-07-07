import { describe, it, expect } from "vitest"
import { ChecklistItemStatus, CHECKLIST_ITEM_STATUS_LABELS, createEmptyChecklist } from "./checklist.js"
import { Phase } from "./phase.js"

describe("ChecklistItemStatus", () => {
  it("枚举包含3种状态", () => {
    expect(Object.values(ChecklistItemStatus)).toHaveLength(3)
    expect(ChecklistItemStatus.PENDING).toBe("PENDING")
    expect(ChecklistItemStatus.VERIFIED).toBe("VERIFIED")
    expect(ChecklistItemStatus.NA).toBe("NA")
  })
})

describe("CHECKLIST_ITEM_STATUS_LABELS", () => {
  it("所有状态都有中文标签", () => {
    for (const status of Object.values(ChecklistItemStatus)) {
      expect(CHECKLIST_ITEM_STATUS_LABELS[status]).toBeTypeOf("string")
    }
  })
})

describe("createEmptyChecklist", () => {
  it("创建指定阶段的空清单", () => {
    const checklist = createEmptyChecklist(Phase.DEVELOPMENT)
    expect(checklist.phase).toBe(Phase.DEVELOPMENT)
    expect(checklist.items).toEqual([])
  })
})
