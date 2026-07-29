/**
 * 阶段与阶段步骤（Stage）的身份与顺序定义。
 *
 * 说明：具体的步骤数据表（各阶段包含哪些步骤、依赖、能力）已迁移到
 * `spec.ts` 的 `DEFAULT_WORKFLOW_SPEC`，本文件只保留与"具体序列"无关的
 * 阶段身份、顺序与转换规则，避免时序图变更时波及此处。
 */

import { Role } from "./role.js"
import { PhaseId } from "./branded-ids.js"

/** 阶段枚举 —— 对应完整 SDLC 流程 */
export const Phase = {
  REQUIREMENTS_ANALYSIS: "RequirementsAnalysis",
  DESIGN: "Design",
  DEVELOPMENT: "Development",
  TESTING: "Testing",
  DEPLOYMENT: "Deployment",
  MAINTENANCE: "Maintenance",
} as const

export type Phase = (typeof Phase)[keyof typeof Phase]

/** 阶段锁定状态 */
export const PhaseLock = {
  /** 锁定 —— 前置阶段未完成 */
  LOCKED: "LOCKED",
  /** 激活 —— 当前可操作 */
  ACTIVE: "ACTIVE",
  /** 已完成 */
  COMPLETED: "COMPLETED",
} as const

export type PhaseLock = (typeof PhaseLock)[keyof typeof PhaseLock]

/** 所有阶段的有序列表 */
export const PHASE_ORDER: readonly Phase[] = [
  Phase.REQUIREMENTS_ANALYSIS,
  Phase.DESIGN,
  Phase.DEVELOPMENT,
  Phase.TESTING,
  Phase.DEPLOYMENT,
  Phase.MAINTENANCE,
]

/** 阶段显示名称映射 */
export const PHASE_LABELS: Record<Phase, string> = {
  [Phase.REQUIREMENTS_ANALYSIS]: "需求分析",
  [Phase.DESIGN]: "设计",
  [Phase.DEVELOPMENT]: "开发",
  [Phase.TESTING]: "测试",
  [Phase.DEPLOYMENT]: "部署",
  [Phase.MAINTENANCE]: "维护",
}

/** 阶段步骤定义（声明式步骤的基础形状；`StepSpec` 在其上扩展 capabilities） */
export interface StageDef {
  /** 唯一标识 (如 "10.1") */
  readonly id: string
  /** 步骤名称 */
  readonly name: string
  /** 步骤描述 */
  readonly description: string
  /** 负责角色 */
  readonly responsibleRoles: readonly Role[]
  /** 前置步骤 ID 列表 */
  readonly dependsOn: readonly string[]
}

/** 阶段定义 */
export interface PhaseDef {
  /** 阶段枚举 */
  readonly phase: Phase
  /** 阶段显示名称 */
  readonly label: string
  /** 阶段 ID */
  readonly phaseId: PhaseId
  /** 阶段包含的步骤 */
  readonly stages: readonly StageDef[]
  /** 进入条件 */
  readonly entryCriteria: readonly string[]
  /** 退出条件 */
  readonly exitCriteria: readonly string[]
}

/** 获取阶段在流程中的序号（从 0 开始） */
export function getPhaseIndex(phase: Phase): number {
  const index = PHASE_ORDER.indexOf(phase)
  if (index === -1) {
    throw new Error(`未知阶段: ${phase}`)
  }
  return index
}

/** 获取下一个阶段 */
export function getNextPhase(current: Phase): Phase | null {
  const index = getPhaseIndex(current)
  const next = PHASE_ORDER[index + 1]
  return next ?? null
}

/** 获取上一个阶段 */
export function getPreviousPhase(current: Phase): Phase | null {
  const index = getPhaseIndex(current)
  if (index === 0) return null
  return PHASE_ORDER[index - 1] ?? null
}

/** 判断阶段转换是否合法（只能前进，不能跳跃） */
export function isValidTransition(from: Phase, to: Phase): boolean {
  const fromIdx = getPhaseIndex(from)
  const toIdx = getPhaseIndex(to)
  // 允许前进到下一阶段，或回退到任意之前阶段
  return toIdx === fromIdx + 1 || toIdx <= fromIdx
}
