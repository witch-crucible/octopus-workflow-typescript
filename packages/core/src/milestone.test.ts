import { describe, expect, it } from "vitest"
import { MilestoneId } from "./branded-ids.js"
import {
  assertMilestonePhase,
  isMilestoneDate,
  isMilestoneOverdue,
  MilestoneStatus,
  nextOpenMilestone,
  normalizeMilestoneDate,
  normalizeMilestoneName,
  normalizeMilestoneNote,
  type RequirementMilestone,
  sortMilestones,
  todayYmd,
} from "./milestone.js"
import { Phase } from "./phase.js"

function milestone(
  patch: Partial<RequirementMilestone> & Pick<RequirementMilestone, "id" | "name" | "date">,
): RequirementMilestone {
  return {
    status: MilestoneStatus.PLANNED,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  }
}

describe("todayYmd", () => {
  it("按本地日历日格式化", () => {
    expect(todayYmd(new Date(2026, 2, 5, 23, 30))).toBe("2026-03-05")
  })
})

describe("isMilestoneDate", () => {
  it("接受合法日历日", () => {
    expect(isMilestoneDate("2026-03-12")).toBe(true)
  })

  it("拒绝非法日", () => {
    expect(isMilestoneDate("2026-02-30")).toBe(false)
    expect(isMilestoneDate("2026/03/12")).toBe(false)
    expect(isMilestoneDate("")).toBe(false)
  })
})

describe("isMilestoneOverdue", () => {
  it("计划中且早于 today 为逾期", () => {
    expect(
      isMilestoneOverdue(
        milestone({ id: MilestoneId("a"), name: "x", date: "2026-03-01" }),
        "2026-03-12",
      ),
    ).toBe(true)
  })

  it("当天或已达成不算逾期", () => {
    expect(
      isMilestoneOverdue(
        milestone({ id: MilestoneId("a"), name: "x", date: "2026-03-12" }),
        "2026-03-12",
      ),
    ).toBe(false)
    expect(
      isMilestoneOverdue(
        milestone({
          id: MilestoneId("a"),
          name: "x",
          date: "2026-03-01",
          status: MilestoneStatus.REACHED,
        }),
        "2026-03-12",
      ),
    ).toBe(false)
  })
})

describe("nextOpenMilestone", () => {
  it("空列表或全达成时返回 undefined", () => {
    expect(nextOpenMilestone([])).toBeUndefined()
    expect(
      nextOpenMilestone([
        milestone({
          id: MilestoneId("a"),
          name: "x",
          date: "2026-03-01",
          status: MilestoneStatus.REACHED,
        }),
      ]),
    ).toBeUndefined()
  })

  it("返回日期最早的未达成项", () => {
    const next = nextOpenMilestone([
      milestone({
        id: MilestoneId("b"),
        name: "上线",
        date: "2026-04-01",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      milestone({
        id: MilestoneId("a"),
        name: "评审",
        date: "2026-03-12",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
      milestone({
        id: MilestoneId("c"),
        name: "旧",
        date: "2026-01-01",
        status: MilestoneStatus.REACHED,
      }),
    ])
    expect(next?.id).toBe("a")
  })
})

describe("sortMilestones", () => {
  it("先按日期再按创建时间", () => {
    const sorted = sortMilestones([
      milestone({
        id: MilestoneId("b"),
        name: "b",
        date: "2026-03-12",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
      milestone({
        id: MilestoneId("a"),
        name: "a",
        date: "2026-03-12",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      milestone({
        id: MilestoneId("c"),
        name: "c",
        date: "2026-03-01",
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    ])
    expect(sorted.map((item) => item.id)).toEqual(["c", "a", "b"])
  })
})

describe("normalize helpers", () => {
  it("名称去空白并限制长度", () => {
    expect(normalizeMilestoneName("  设计评审  ")).toBe("设计评审")
    expect(() => normalizeMilestoneName("   ")).toThrow("里程碑名称必须是 1–80 个字符")
    expect(() => normalizeMilestoneName("x".repeat(81))).toThrow("里程碑名称必须是 1–80 个字符")
  })

  it("日期必须合法", () => {
    expect(normalizeMilestoneDate("2026-03-12")).toBe("2026-03-12")
    expect(() => normalizeMilestoneDate("03-12")).toThrow("里程碑日期必须是 YYYY-MM-DD")
  })

  it("备注限制 500 字", () => {
    expect(normalizeMilestoneNote("ok")).toBe("ok")
    expect(() => normalizeMilestoneNote("n".repeat(501))).toThrow("备注不能超过 500 个字符")
  })

  it("阶段必须存在", () => {
    expect(assertMilestonePhase(Phase.DESIGN)).toBe(Phase.DESIGN)
    expect(() => assertMilestonePhase("Unknown")).toThrow("未知阶段")
  })
})
