import { describe, it, expect } from "vitest"
import {
  HeinrichLevel,
  HEINRICH_LEVEL_LABELS,
  HEINRICH_IDEAL_RATIO,
  QualityVerdict,
  createEmptyHeinrichRecord,
} from "./risk.js"

describe("HeinrichLevel", () => {
  it("枚举包含3个等级", () => {
    expect(Object.values(HeinrichLevel)).toHaveLength(3)
    expect(HeinrichLevel.MAJOR).toBe("MAJOR")
    expect(HeinrichLevel.MINOR).toBe("MINOR")
    expect(HeinrichLevel.TRIVIAL).toBe("TRIVIAL")
  })
})

describe("HEINRICH_LEVEL_LABELS", () => {
  it("所有等级都有中文标签", () => {
    for (const level of Object.values(HeinrichLevel)) {
      expect(HEINRICH_LEVEL_LABELS[level]).toBeTypeOf("string")
    }
  })
})

describe("HEINRICH_IDEAL_RATIO", () => {
  it("遵循海因里希法则 1:29:300", () => {
    expect(HEINRICH_IDEAL_RATIO.MAJOR).toBe(1)
    expect(HEINRICH_IDEAL_RATIO.MINOR).toBe(29)
    expect(HEINRICH_IDEAL_RATIO.TRIVIAL).toBe(300)
  })
})

describe("QualityVerdict", () => {
  it("枚举包含4种结果", () => {
    expect(Object.values(QualityVerdict)).toHaveLength(4)
    expect(QualityVerdict.HEALTHY).toBe("HEALTHY")
    expect(QualityVerdict.INSUFFICIENT_DATA).toBe("INSUFFICIENT_DATA")
  })
})

describe("createEmptyHeinrichRecord", () => {
  it("创建空白记录，所有计数为0", () => {
    const record = createEmptyHeinrichRecord()
    expect(record.majorDefects).toBe(0)
    expect(record.minorDefects).toBe(0)
    expect(record.trivialDefects).toBe(0)
    expect(record.observations).toEqual([])
  })
})
