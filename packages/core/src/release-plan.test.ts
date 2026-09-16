import { describe, expect, it } from "vitest"
import {
  detectDeviation,
  deriveReleasePlanStage,
  instantiateReleasePlan,
  isItemGrayed,
  ReleaseItemStatus,
  ReleasePlanStage,
  RehearsalResult,
  scheduleReleasePlan,
  summarizeReleasePlan,
  type ReleaseChecklistTemplate,
  type ReleasePlan,
  type ReleaseTemplateItem,
} from "./release-plan.js"

function templateItem(
  patch: Partial<ReleaseTemplateItem> & Pick<ReleaseTemplateItem, "group" | "task">,
): ReleaseTemplateItem {
  return { ...patch }
}

function baseTemplate(items: ReleaseTemplateItem[]): ReleaseChecklistTemplate {
  return { name: "test-template.xlsx", importedAt: "2026-01-01T00:00:00.000Z", items, setup: [] }
}

describe("instantiateReleasePlan", () => {
  it("从模板生成行、门控 flag（未答）、预演 TODO", () => {
    const template = baseTemplate([
      templateItem({
        group: "发布前置条件",
        task: "有 PageBuild 配置项",
        remark: "有 PageBuild 配置项",
        content: "No",
      }),
      templateItem({ group: "发版影响评估", task: "有数据库改动", content: "No" }),
      templateItem({ group: "代码封版", task: "创建 Tag" }),
    ])
    const plan = instantiateReleasePlan(template, "ver_1", [
      { requirementId: "req_1", requirementName: "需求一" },
    ])
    expect(plan.versionId).toBe("ver_1")
    expect(plan.flags).toHaveLength(2)
    expect(plan.flags[0]).toMatchObject({ key: "gate_1", group: "precondition", value: null })
    expect(plan.flags[1]).toMatchObject({ key: "gate_2", group: "impact", value: null })
    expect(plan.items).toHaveLength(3)
    expect(plan.items[0]?.gateKey).toBe("gate_1")
    expect(plan.items[0]?.status).toBe(ReleaseItemStatus.TODO)
    expect(plan.items[2]?.gateKey).toBeUndefined()
    expect(plan.rehearsals).toEqual([
      { requirementId: "req_1", requirementName: "需求一", result: RehearsalResult.TODO },
    ])
  })
})

describe("isItemGrayed", () => {
  it("门控 flag 为 false 时该行置灰", () => {
    const plan: ReleasePlan = {
      versionId: "v",
      templateName: "t",
      createdAt: "now",
      updatedAt: "now",
      flags: [{ key: "gate_1", group: "precondition", label: "l", value: false }],
      items: [],
      rehearsals: [],
    }
    expect(
      isItemGrayed(plan, {
        id: "i1",
        group: "g",
        task: "t",
        status: ReleaseItemStatus.TODO,
        gateKey: "gate_1",
      }),
    ).toBe(true)
    expect(
      isItemGrayed(plan, { id: "i2", group: "g", task: "t", status: ReleaseItemStatus.TODO }),
    ).toBe(false)
  })

  it("flag 为 null 或 true 时不置灰", () => {
    const plan: ReleasePlan = {
      versionId: "v",
      templateName: "t",
      createdAt: "now",
      updatedAt: "now",
      flags: [{ key: "gate_1", group: "precondition", label: "l", value: true }],
      items: [],
      rehearsals: [],
    }
    expect(
      isItemGrayed(plan, {
        id: "i1",
        group: "g",
        task: "t",
        status: ReleaseItemStatus.TODO,
        gateKey: "gate_1",
      }),
    ).toBe(false)
  })
})

describe("detectDeviation", () => {
  it("content 与 plannedContent 不同视为偏差", () => {
    expect(detectDeviation({ content: "已发布", plannedContent: "待发布" })).toBe(true)
  })

  it("两者皆为空白视为一致", () => {
    expect(detectDeviation({ content: "  " })).toBe(false)
  })

  it("门控行永远不算偏差", () => {
    expect(detectDeviation({ content: "Yes", plannedContent: "No", gateKey: "gate_1" })).toBe(false)
  })
})

describe("scheduleReleasePlan", () => {
  it("按行序累加 durationMin，跳过灰行", () => {
    const plan: ReleasePlan = {
      versionId: "v",
      templateName: "t",
      createdAt: "now",
      updatedAt: "now",
      flags: [{ key: "gate_1", group: "precondition", label: "l", value: false }],
      items: [
        {
          id: "i1",
          group: "g",
          task: "a",
          status: ReleaseItemStatus.TODO,
          gateKey: "gate_1",
          durationMin: 999,
        },
        { id: "i2", group: "g", task: "b", status: ReleaseItemStatus.TODO, durationMin: 30 },
        { id: "i3", group: "g", task: "c", status: ReleaseItemStatus.TODO, durationMin: 15 },
      ],
      rehearsals: [],
    }
    const scheduled = scheduleReleasePlan(plan, "2026-01-01T00:00:00.000Z")
    expect(scheduled.items[0]?.plannedStart).toBeUndefined()
    expect(scheduled.items[1]?.plannedStart).toBe("2026-01-01T00:00:00.000Z")
    expect(scheduled.items[1]?.plannedEnd).toBe("2026-01-01T00:30:00.000Z")
    expect(scheduled.items[2]?.plannedStart).toBe("2026-01-01T00:30:00.000Z")
    expect(scheduled.items[2]?.plannedEnd).toBe("2026-01-01T00:45:00.000Z")
    // 不修改入参
    expect(plan.items[1]?.plannedStart).toBeUndefined()
  })
})

function makePlan(overrides: Partial<ReleasePlan> = {}): ReleasePlan {
  return {
    versionId: "v",
    templateName: "t",
    createdAt: "now",
    updatedAt: "now",
    flags: [],
    items: [],
    rehearsals: [],
    ...overrides,
  }
}

describe("deriveReleasePlanStage", () => {
  it("有未答门控 → PREPARE", () => {
    const plan = makePlan({
      flags: [{ key: "gate_1", group: "precondition", label: "l", value: null }],
    })
    expect(deriveReleasePlanStage(plan)).toBe(ReleasePlanStage.PREPARE)
  })

  it("门控已答但 PREPARE 分组未完成 → PREPARE", () => {
    const plan = makePlan({
      flags: [{ key: "gate_1", group: "precondition", label: "l", value: true }],
      items: [
        {
          id: "i1",
          group: "发布前置条件",
          task: "a",
          status: ReleaseItemStatus.TODO,
          gateKey: "gate_1",
        },
      ],
    })
    // 门控行本身置为 true（非灰）但状态仍 TODO → 未完成
    expect(deriveReleasePlanStage(plan)).toBe(ReleasePlanStage.PREPARE)
  })

  it("PREPARE 完成但预演未 PASS → REHEARSAL", () => {
    const plan = makePlan({
      flags: [{ key: "gate_1", group: "precondition", label: "l", value: true }],
      items: [
        {
          id: "i1",
          group: "发布前置条件",
          task: "a",
          status: ReleaseItemStatus.DONE,
          gateKey: "gate_1",
        },
      ],
      rehearsals: [{ requirementId: "r1", requirementName: "n1", result: RehearsalResult.TODO }],
    })
    expect(deriveReleasePlanStage(plan)).toBe(ReleasePlanStage.REHEARSAL)
  })

  it("预演全部 PASS 但发布分组未完成 → RELEASING", () => {
    const plan = makePlan({
      rehearsals: [{ requirementId: "r1", requirementName: "n1", result: RehearsalResult.PASS }],
      items: [
        { id: "i1", group: "Magento 后端发布", task: "发布", status: ReleaseItemStatus.TODO },
      ],
    })
    expect(deriveReleasePlanStage(plan)).toBe(ReleasePlanStage.RELEASING)
  })

  it("发布分组完成但上线收尾未完成 → MONITORING", () => {
    const plan = makePlan({
      rehearsals: [],
      items: [
        { id: "i1", group: "Magento 后端发布", task: "发布", status: ReleaseItemStatus.DONE },
        { id: "i2", group: "上线收尾", task: "更新状态", status: ReleaseItemStatus.TODO },
      ],
    })
    expect(deriveReleasePlanStage(plan)).toBe(ReleasePlanStage.MONITORING)
  })

  it("上线收尾完成但维护分组未完成 → MONITORING", () => {
    const plan = makePlan({
      items: [
        { id: "i1", group: "上线收尾", task: "更新状态", status: ReleaseItemStatus.DONE },
        { id: "i2", group: "维护", task: "监控 7d 表现", status: ReleaseItemStatus.TODO },
      ],
    })
    expect(deriveReleasePlanStage(plan)).toBe(ReleasePlanStage.MONITORING)
  })

  it("全部完成 → DONE", () => {
    const plan = makePlan({
      flags: [{ key: "gate_1", group: "precondition", label: "l", value: true }],
      items: [
        {
          id: "i0",
          group: "发布前置条件",
          task: "a",
          status: ReleaseItemStatus.DONE,
          gateKey: "gate_1",
        },
        { id: "i1", group: "上线收尾", task: "更新状态", status: ReleaseItemStatus.DONE },
        { id: "i2", group: "维护", task: "监控 7d 表现", status: ReleaseItemStatus.CLOSE },
      ],
      rehearsals: [{ requirementId: "r1", requirementName: "n1", result: RehearsalResult.PASS }],
    })
    expect(deriveReleasePlanStage(plan)).toBe(ReleasePlanStage.DONE)
  })
})

describe("summarizeReleasePlan", () => {
  it("统计阻塞项：未答门控、非 PASS 预演、偏差、未完成 Setup", () => {
    const plan = makePlan({
      flags: [{ key: "gate_1", group: "precondition", label: "有 db_schema", value: null }],
      rehearsals: [
        { requirementId: "r1", requirementName: "需求一", result: RehearsalResult.FAIL },
      ],
      items: [
        {
          id: "i1",
          group: "发布前置条件",
          task: "a",
          status: ReleaseItemStatus.TODO,
          gateKey: "gate_1",
        },
        {
          id: "i2",
          group: "Magento 后端发布",
          task: "发布",
          status: ReleaseItemStatus.DONE,
          deviation: true,
        },
      ],
    })
    const summary = summarizeReleasePlan(plan, [
      { id: "su_1", type: "CDN", task: "静态资源增加 cdn", status: "未完成" },
    ])
    expect(summary.stage).toBe(ReleasePlanStage.PREPARE)
    expect(summary.deviations).toBe(1)
    expect(summary.blockers.map((b) => b.kind).sort()).toEqual([
      "deviation",
      "gate",
      "rehearsal",
      "setup",
    ])
  })

  it("灰行计入 grayed 且视为完成，不出现在阻塞项", () => {
    const plan = makePlan({
      flags: [{ key: "gate_1", group: "precondition", label: "l", value: false }],
      items: [
        {
          id: "i1",
          group: "发布前置条件",
          task: "a",
          status: ReleaseItemStatus.TODO,
          gateKey: "gate_1",
        },
      ],
    })
    const summary = summarizeReleasePlan(plan)
    expect(summary.grayed).toBe(1)
    expect(summary.byStage[ReleasePlanStage.PREPARE]).toEqual({ total: 1, done: 1 })
    expect(summary.blockers.some((b) => b.kind === "gate")).toBe(false)
  })
})
