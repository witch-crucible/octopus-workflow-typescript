import { describe, expect, it } from "vitest"

import { buildRequirementsModel, milestoneDiamondPoints, OctopusGantt } from "./gantt"

describe("OctopusGantt API", () => {
  it("exposes mount, unmount, and render", () => {
    expect(typeof OctopusGantt.mount).toBe("function")
    expect(typeof OctopusGantt.unmount).toBe("function")
    expect(typeof OctopusGantt.render).toBe("function")
    expect(typeof OctopusGantt.isDragging).toBe("function")
    expect(typeof OctopusGantt.getUiState).toBe("function")
    expect(typeof OctopusGantt.setUiState).toBe("function")
    expect(typeof OctopusGantt.scrollToToday).toBe("function")
  })
})

describe("buildRequirementsModel", () => {
  it('produces kind:"requirement" rows for scheduled requirements', () => {
    const model = buildRequirementsModel({
      mode: "requirements",
      requirements: [
        {
          id: "req-1",
          name: "Alpha",
          phase: "DEV",
          plannedStart: "2026-01-01",
          plannedEnd: "2026-01-10",
          statusLabel: "开发中",
          progress: 0.4,
          steps: [
            {
              id: "node-1",
              name: "Implement",
              plannedStart: "2026-01-02",
              plannedEnd: "2026-01-05",
              status: "IN_PROGRESS",
              responsibleRole: "DEV",
            },
          ],
        },
        {
          id: "req-2",
          name: "Beta",
          phase: "QA",
          steps: [],
        },
      ],
      selectedId: "req-1",
    })

    const requirementRows = model.rows.filter((row) => row.kind === "requirement")
    expect(requirementRows).toHaveLength(2)
    expect(requirementRows[0]).toMatchObject({
      kind: "requirement",
      id: "req-1",
      label: "Alpha",
      selected: true,
      plannedStart: "2026-01-01",
      plannedEnd: "2026-01-10",
    })
    expect(model.scheduled.some((row) => row.kind === "requirement" && row.id === "req-1")).toBe(
      true,
    )
    expect(model.unscheduled.some((row) => row.kind === "requirement" && row.id === "req-2")).toBe(
      true,
    )
    expect(model.rows.some((row) => row.kind === "node" && row.id === "node-1")).toBe(true)
  })

  it("collapses requirement children when collapsed set contains req key", () => {
    const model = buildRequirementsModel(
      {
        requirements: [
          {
            id: "req-1",
            name: "Alpha",
            plannedStart: "2026-01-01",
            plannedEnd: "2026-01-10",
            steps: [
              { id: "node-1", name: "A", plannedStart: "2026-01-01", plannedEnd: "2026-01-02" },
            ],
          },
        ],
      },
      { collapsed: new Set(["req:req-1"]) },
    )
    expect(model.rows.filter((row) => row.kind === "requirement")).toHaveLength(1)
    expect(model.rows.some((row) => row.kind === "node")).toBe(false)
  })
})

describe("milestoneDiamondPoints", () => {
  it("returns SVG polygon points for a diamond", () => {
    expect(milestoneDiamondPoints(10, 20, 7)).toBe("10,13 17,20 10,27 3,20")
  })
})
