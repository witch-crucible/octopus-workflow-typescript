import { describe, expect, it } from "vitest"
import {
  buildHubCardsModel,
  buildKanbanModel,
  buildRequirementCardsModel,
  formatMilestoneDate,
  formatUpdatedAt,
  milestoneBadgeData,
} from "./view-models.js"

describe("format helpers", () => {
  it("formats updatedAt and milestone dates", () => {
    expect(formatUpdatedAt("")).toBe("")
    expect(formatUpdatedAt("not-a-date")).toBe("not-a-date")
    expect(formatUpdatedAt("2024-01-02T03:04:05.000Z")).not.toBe("")
    expect(formatMilestoneDate("2024-08-15")).toBe("08-15")
    expect(formatMilestoneDate("soon")).toBe("soon")
  })

  it("builds milestone badge data", () => {
    expect(milestoneBadgeData({ milestoneCount: 0 })).toBeNull()
    expect(
      milestoneBadgeData({
        milestoneCount: 2,
        nextMilestone: { name: "Alpha", date: "2024-08-15", overdue: true },
      }),
    ).toEqual({
      kind: "next",
      overdue: true,
      date: "08-15",
      name: "Alpha",
    })
    expect(milestoneBadgeData({ milestoneCount: 1 })).toEqual({ kind: "done" })
  })
})

describe("buildHubCardsModel", () => {
  const items = [
    {
      projectId: "p1",
      name: "Alpha",
      description: "first",
      requirementCount: 2,
      teambitionProjectId: "tb1",
      updatedAt: "2024-01-01T00:00:00.000Z",
    },
    {
      projectId: "p2",
      name: "Beta",
      description: "second",
      requirementCount: 0,
    },
  ]

  it("returns empty / nomatch / cards", () => {
    expect(buildHubCardsModel([], {}).kind).toBe("empty")
    const nomatch = buildHubCardsModel(items, { filter: "zzz" })
    expect(nomatch.kind).toBe("nomatch")
    if (nomatch.kind === "nomatch") expect(nomatch.filter).toBe("zzz")

    const cards = buildHubCardsModel(items, { filter: "alpha", lastCreatedId: "p1" })
    expect(cards.kind).toBe("cards")
    if (cards.kind === "cards") {
      expect(cards.items).toHaveLength(1)
      expect(cards.filtered).toEqual(cards.items)
      expect(cards.items[0]?.highlight).toBe(true)
      expect(cards.items[0]?.teambitionBound).toBe(true)
      expect(cards.items[0]?.displayName).toBe("Alpha")
    }
  })
})

describe("buildRequirementCardsModel", () => {
  it("includes milestone badge data on cards", () => {
    const model = buildRequirementCardsModel(
      [
        {
          requirementId: "r1",
          requirementName: "Req",
          description: "d",
          currentPhase: "Design",
          completedTasks: 1,
          totalTasks: 3,
          milestoneCount: 1,
          nextMilestone: { name: "M1", date: "2024-09-01", overdue: false },
        },
      ],
      { expandedScheduleId: "r1" },
    )
    expect(model.kind).toBe("cards")
    if (model.kind === "cards") {
      expect(model.items[0]?.phaseLabelText).toBe("设计")
      expect(model.items[0]?.milestoneBadge).toEqual({
        kind: "next",
        overdue: false,
        date: "09-01",
        name: "M1",
      })
      expect(model.items[0]?.scheduleExpanded).toBe(true)
    }
  })
})

describe("buildKanbanModel", () => {
  const items = [
    {
      requirementId: "r1",
      requirementName: "One",
      description: "d1",
      currentPhase: "Intention",
      completedTasks: 0,
      totalTasks: 2,
      plannedStart: "2024-01-10",
      plannedEnd: "2024-01-20",
    },
    {
      requirementId: "r2",
      requirementName: "Two",
      description: "d2",
      owner: "李四",
      currentPhase: "Design",
      completedTasks: 1,
      totalTasks: 2,
    },
  ]

  it("returns empty / nomatch / columns with PHASE_ORDER", () => {
    expect(buildKanbanModel([], {}).kind).toBe("empty")
    const nomatch = buildKanbanModel(items, { filter: "missing" })
    expect(nomatch.kind).toBe("nomatch")

    const model = buildKanbanModel(items, { lastCreatedId: "r2" })
    expect(model.kind).toBe("columns")
    if (model.kind === "columns") {
      expect(model.columns).toHaveLength(9)
      const intention = model.columns.find((column) => column.phase === "Intention")
      const design = model.columns.find((column) => column.phase === "Design")
      expect(intention?.label).toBe("意向")
      expect(intention?.cards).toHaveLength(1)
      expect(intention?.cards[0]?.scheduleText).toBe("01-10 → 01-20")
      expect(design?.cards[0]?.highlight).toBe(true)
      expect(model.filtered).toHaveLength(2)
    }
  })

  it("filters by owner as well as requirement text", () => {
    const model = buildKanbanModel(items, { filter: "李四" })

    expect(model.kind).toBe("columns")
    if (model.kind === "columns") {
      expect(model.filtered.map((card) => card.requirementId)).toEqual(["r2"])
      expect(model.columns.find((column) => column.phase === "Design")?.cards).toHaveLength(1)
      expect(model.columns.find((column) => column.phase === "Intention")?.cards).toHaveLength(0)
    }
  })
})
