/**
 * 风险模型 —— 海因里希三角（Heinrich's Triangle）质量指标追踪。
 *
 * 海因里希法则：每 1 起重特大事故背后，有 29 起轻伤/轻微事故
 * 和 300 起未遂/不安全行为。通过追踪这个比例评估项目质量健康度。
 *
 * PlantUML 中标注的风险计数点：
 * - 开发阶段：+1, +1 = 2
 * - 测试阶段：+1 = 1
 * - 部署阶段：+1, +1, +1, +1 = 4
 */

import type { ObservationId } from "./branded-ids.js"
import { Phase } from "./phase.js"

/** 风险等级 */
export enum HeinrichLevel {
  /** 重大缺陷/事故 */
  MAJOR = "MAJOR",
  /** 轻微缺陷/轻伤 */
  MINOR = "MINOR",
  /** 未遂/不安全行为/轻微问题 */
  TRIVIAL = "TRIVIAL",
}

/** 风险等级标签映射 */
export const HEINRICH_LEVEL_LABELS: Record<HeinrichLevel, string> = {
  [HeinrichLevel.MAJOR]: "重大",
  [HeinrichLevel.MINOR]: "轻微",
  [HeinrichLevel.TRIVIAL]: "未遂/轻微问题",
}

/** 海因里希三角的理想比例 1:29:300 */
export const HEINRICH_IDEAL_RATIO = {
  MAJOR: 1,
  MINOR: 29,
  TRIVIAL: 300,
} as const satisfies Record<HeinrichLevel, number>

/**
 * 风险观测记录 —— 记录一次风检查到的缺陷/问题。
 */
export interface HeinrichObservation {
  /** 观测唯一 ID */
  id: ObservationId
  /** 所属阶段 */
  phase: Phase
  /** 风险等级 */
  level: HeinrichLevel
  /** 描述 */
  description: string
  /** 记录时间 */
  notedAt: string
  /** 解决时间（可选） */
  resolvedAt?: string
}

/** 海因里希三角记录 */
export interface HeinrichRecord {
  /** 重大缺陷数 */
  majorDefects: number
  /** 轻微缺陷数 */
  minorDefects: number
  /** 未遂/轻微问题数 */
  trivialDefects: number
  /** 观测记录列表 */
  observations: HeinrichObservation[]
}

/** 质量评估结果 */
export enum QualityVerdict {
  /** 健康 —— 比例接近 1:29:300 */
  HEALTHY = "HEALTHY",
  /** 漏报 —— 轻微/未遂记录不足，可能存在隐性问题 */
  UNDER_REPORTING = "UNDER_REPORTING",
  /** 过报 —— 轻微/未遂记录过多，可能过于保守 */
  OVER_REPORTING = "OVER_REPORTING",
  /** 数据不足 —— 样本量太小无法评估 */
  INSUFFICIENT_DATA = "INSUFFICIENT_DATA",
}

/** 质量评估结果接口 */
export interface QualityAssessment {
  expectedMinor: number
  expectedTrivial: number
  actualMinor: number
  actualTrivial: number
  minorRatio: number
  trivialRatio: number
  verdict: QualityVerdict
}

/** 创建一个空白海因里希记录 */
export function createEmptyHeinrichRecord(): HeinrichRecord {
  return {
    majorDefects: 0,
    minorDefects: 0,
    trivialDefects: 0,
    observations: [],
  }
}
