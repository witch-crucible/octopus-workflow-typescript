import { describe, it, expect } from "vitest"
import { Phase, PhaseLock, PHASE_ORDER, PHASE_LABELS, getPhaseIndex, getNextPhase, getPreviousPhase, isValidTransition } from "./phase.js"
import { getPhaseDef, getStages } from "./spec.js"

describe("Phase", () => {
  it("const 对象包含所有9个阶段", () => {
    expect(Object.values(Phase)).toHaveLength(9)
    expect(Phase.INTENTION).toBe("Intention")
    expect(Phase.RESEARCH).toBe("Research")
    expect(Phase.DESIGN).toBe("Design")
    expect(Phase.IMPLEMENTATION).toBe("Implementation")
    expect(Phase.TESTING).toBe("Testing")
    expect(Phase.UAT).toBe("UAT")
    expect(Phase.RELEASE).toBe("Release")
    expect(Phase.MAINTENANCE).toBe("Maintenance")
    expect(Phase.COMPLETED).toBe("Completed")
  })
})

describe("PhaseLock", () => {
  it("const 对象包含3种锁定状态", () => {
    expect(Object.values(PhaseLock)).toHaveLength(3)
    expect(PhaseLock.LOCKED).toBe("LOCKED")
    expect(PhaseLock.ACTIVE).toBe("ACTIVE")
    expect(PhaseLock.COMPLETED).toBe("COMPLETED")
  })
})

describe("PHASE_ORDER", () => {
  it("按项目生命周期顺序排列", () => {
    expect(PHASE_ORDER).toEqual([
      Phase.INTENTION,
      Phase.RESEARCH,
      Phase.DESIGN,
      Phase.IMPLEMENTATION,
      Phase.TESTING,
      Phase.UAT,
      Phase.RELEASE,
      Phase.MAINTENANCE,
      Phase.COMPLETED,
    ])
  })
})

describe("PHASE_LABELS", () => {
  it("所有阶段都有中文标签", () => {
    for (const phase of Object.values(Phase)) {
      expect(PHASE_LABELS[phase]).toBeTypeOf("string")
    }
  })
  it("标签内容正确", () => {
    expect(PHASE_LABELS[Phase.INTENTION]).toBe("意向")
    expect(PHASE_LABELS[Phase.RESEARCH]).toBe("调研")
    expect(PHASE_LABELS[Phase.DESIGN]).toBe("设计")
    expect(PHASE_LABELS[Phase.IMPLEMENTATION]).toBe("实现")
    expect(PHASE_LABELS[Phase.TESTING]).toBe("测试")
    expect(PHASE_LABELS[Phase.UAT]).toBe("UAT")
    expect(PHASE_LABELS[Phase.RELEASE]).toBe("发布")
    expect(PHASE_LABELS[Phase.MAINTENANCE]).toBe("维护")
    expect(PHASE_LABELS[Phase.COMPLETED]).toBe("完结")
  })
})

describe("getPhaseIndex", () => {
  it("返回正确的序号", () => {
    expect(getPhaseIndex(Phase.INTENTION)).toBe(0)
    expect(getPhaseIndex(Phase.DESIGN)).toBe(2)
    expect(getPhaseIndex(Phase.MAINTENANCE)).toBe(7)
    expect(getPhaseIndex(Phase.COMPLETED)).toBe(8)
  })
})

describe("getNextPhase", () => {
  it("返回正确的下一阶段", () => {
    expect(getNextPhase(Phase.INTENTION)).toBe(Phase.RESEARCH)
    expect(getNextPhase(Phase.RESEARCH)).toBe(Phase.DESIGN)
    expect(getNextPhase(Phase.DESIGN)).toBe(Phase.IMPLEMENTATION)
    expect(getNextPhase(Phase.TESTING)).toBe(Phase.UAT)
    expect(getNextPhase(Phase.RELEASE)).toBe(Phase.MAINTENANCE)
    expect(getNextPhase(Phase.MAINTENANCE)).toBe(Phase.COMPLETED)
  })
  it("最后阶段返回 null", () => {
    expect(getNextPhase(Phase.COMPLETED)).toBeNull()
  })
})

describe("getPreviousPhase", () => {
  it("返回正确的上一阶段", () => {
    expect(getPreviousPhase(Phase.RESEARCH)).toBe(Phase.INTENTION)
    expect(getPreviousPhase(Phase.DESIGN)).toBe(Phase.RESEARCH)
    expect(getPreviousPhase(Phase.IMPLEMENTATION)).toBe(Phase.DESIGN)
    expect(getPreviousPhase(Phase.UAT)).toBe(Phase.TESTING)
    expect(getPreviousPhase(Phase.RELEASE)).toBe(Phase.UAT)
  })
  it("第一阶段返回 null", () => {
    expect(getPreviousPhase(Phase.INTENTION)).toBeNull()
  })
})

describe("isValidTransition", () => {
  it("允许前进到下一阶段", () => {
    expect(isValidTransition(Phase.INTENTION, Phase.RESEARCH)).toBe(true)
    expect(isValidTransition(Phase.IMPLEMENTATION, Phase.TESTING)).toBe(true)
    expect(isValidTransition(Phase.MAINTENANCE, Phase.COMPLETED)).toBe(true)
  })
  it("允许回退到任意之前阶段", () => {
    expect(isValidTransition(Phase.IMPLEMENTATION, Phase.DESIGN)).toBe(true)
    expect(isValidTransition(Phase.TESTING, Phase.INTENTION)).toBe(true)
  })
  it("不允许跳跃前进", () => {
    expect(isValidTransition(Phase.INTENTION, Phase.DESIGN)).toBe(false)
    expect(isValidTransition(Phase.INTENTION, Phase.TESTING)).toBe(false)
    expect(isValidTransition(Phase.DESIGN, Phase.RELEASE)).toBe(false)
  })
})

describe("getPhaseDef", () => {
  it("返回完整的阶段定义", () => {
    const def = getPhaseDef(Phase.INTENTION)
    expect(def.phase).toBe(Phase.INTENTION)
    expect(def.label).toBe("意向")
    expect(def.stages.length).toBeGreaterThan(0)
    expect(def.entryCriteria).toBeDefined()
    expect(def.exitCriteria).toBeDefined()
  })
  it("每个阶段都有入口和出口条件", () => {
    for (const phase of Object.values(Phase)) {
      const def = getPhaseDef(phase)
      expect(def.entryCriteria.length).toBeGreaterThan(0)
      expect(def.exitCriteria.length).toBeGreaterThan(0)
    }
  })
  it("完结阶段无步骤", () => {
    expect(getPhaseDef(Phase.COMPLETED).stages).toHaveLength(0)
  })
})

describe("getStages", () => {
  it("返回阶段的步骤列表", () => {
    const stages = getStages(Phase.DESIGN)
    expect(stages.length).toBe(9) // 含 20.2a
    expect(stages[0]!.id).toBe("20.1")
    expect(stages[0]!.responsibleRoles.length).toBeGreaterThan(0)
  })
  it("每个步骤都有依赖信息", () => {
    const stages = getStages(Phase.RESEARCH)
    for (const stage of stages) {
      expect(stage.id).toBeTypeOf("string")
      expect(stage.dependsOn).toBeInstanceOf(Array)
    }
  })
})
