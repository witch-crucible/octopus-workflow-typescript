import { describe, it, expect } from "vitest"
import { Phase, PhaseLock, PHASE_ORDER, PHASE_LABELS, getPhaseIndex, getNextPhase, getPreviousPhase, isValidTransition, getPhaseDef, getStages } from "./phase.js"

describe("Phase", () => {
  it("const 对象包含所有6个阶段", () => {
    expect(Object.values(Phase)).toHaveLength(6)
    expect(Phase.REQUIREMENTS_ANALYSIS).toBe("RequirementsAnalysis")
    expect(Phase.DESIGN).toBe("Design")
    expect(Phase.DEVELOPMENT).toBe("Development")
    expect(Phase.TESTING).toBe("Testing")
    expect(Phase.DEPLOYMENT).toBe("Deployment")
    expect(Phase.MAINTENANCE).toBe("Maintenance")
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
  it("按 SDLC 顺序排列", () => {
    expect(PHASE_ORDER).toEqual([
      Phase.REQUIREMENTS_ANALYSIS,
      Phase.DESIGN,
      Phase.DEVELOPMENT,
      Phase.TESTING,
      Phase.DEPLOYMENT,
      Phase.MAINTENANCE,
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
    expect(PHASE_LABELS[Phase.REQUIREMENTS_ANALYSIS]).toBe("需求分析")
    expect(PHASE_LABELS[Phase.DESIGN]).toBe("设计")
    expect(PHASE_LABELS[Phase.DEVELOPMENT]).toBe("开发")
    expect(PHASE_LABELS[Phase.TESTING]).toBe("测试")
    expect(PHASE_LABELS[Phase.DEPLOYMENT]).toBe("部署")
    expect(PHASE_LABELS[Phase.MAINTENANCE]).toBe("维护")
  })
})

describe("getPhaseIndex", () => {
  it("返回正确的序号", () => {
    expect(getPhaseIndex(Phase.REQUIREMENTS_ANALYSIS)).toBe(0)
    expect(getPhaseIndex(Phase.DESIGN)).toBe(1)
    expect(getPhaseIndex(Phase.MAINTENANCE)).toBe(5)
  })
})

describe("getNextPhase", () => {
  it("返回正确的下一阶段", () => {
    expect(getNextPhase(Phase.REQUIREMENTS_ANALYSIS)).toBe(Phase.DESIGN)
    expect(getNextPhase(Phase.DESIGN)).toBe(Phase.DEVELOPMENT)
    expect(getNextPhase(Phase.DEPLOYMENT)).toBe(Phase.MAINTENANCE)
  })
  it("最后阶段返回 null", () => {
    expect(getNextPhase(Phase.MAINTENANCE)).toBeNull()
  })
})

describe("getPreviousPhase", () => {
  it("返回正确的上一阶段", () => {
    expect(getPreviousPhase(Phase.DESIGN)).toBe(Phase.REQUIREMENTS_ANALYSIS)
    expect(getPreviousPhase(Phase.DEVELOPMENT)).toBe(Phase.DESIGN)
    expect(getPreviousPhase(Phase.DEPLOYMENT)).toBe(Phase.TESTING)
  })
  it("第一阶段返回 null", () => {
    expect(getPreviousPhase(Phase.REQUIREMENTS_ANALYSIS)).toBeNull()
  })
})

describe("isValidTransition", () => {
  it("允许前进到下一阶段", () => {
    expect(isValidTransition(Phase.REQUIREMENTS_ANALYSIS, Phase.DESIGN)).toBe(true)
    expect(isValidTransition(Phase.DEVELOPMENT, Phase.TESTING)).toBe(true)
  })
  it("允许回退到任意之前阶段", () => {
    expect(isValidTransition(Phase.DEVELOPMENT, Phase.DESIGN)).toBe(true)
    expect(isValidTransition(Phase.TESTING, Phase.REQUIREMENTS_ANALYSIS)).toBe(true)
  })
  it("不允许跳跃前进", () => {
    expect(isValidTransition(Phase.REQUIREMENTS_ANALYSIS, Phase.DEVELOPMENT)).toBe(false)
    expect(isValidTransition(Phase.REQUIREMENTS_ANALYSIS, Phase.TESTING)).toBe(false)
    expect(isValidTransition(Phase.DESIGN, Phase.DEPLOYMENT)).toBe(false)
  })
})

describe("getPhaseDef", () => {
  it("返回完整的阶段定义", () => {
    const def = getPhaseDef(Phase.REQUIREMENTS_ANALYSIS)
    expect(def.phase).toBe(Phase.REQUIREMENTS_ANALYSIS)
    expect(def.label).toBe("需求分析")
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
})

describe("getStages", () => {
  it("返回阶段的步骤列表", () => {
    const stages = getStages(Phase.DESIGN)
    expect(stages.length).toBe(9) // 含 20.2a
    expect(stages[0]!.id).toBe("20.1")
    expect(stages[0]!.responsibleRoles.length).toBeGreaterThan(0)
  })
  it("每个步骤都有依赖信息", () => {
    const stages = getStages(Phase.REQUIREMENTS_ANALYSIS)
    for (const stage of stages) {
      expect(stage.id).toBeTypeOf("string")
      expect(stage.dependsOn).toBeInstanceOf(Array)
    }
  })
})
