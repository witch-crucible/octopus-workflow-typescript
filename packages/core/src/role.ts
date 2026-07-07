/**
 * 角色定义 —— 项目流程中涉及的 8 种角色。
 *
 * 对应 PlantUML 中的参与者：PM, BA, SA, AI, DEV, QA, OP, HEI
 */

/** 项目角色枚举 */
export const Role = {
  /** 产品经理 —— 需求分析、BRD、排期、发布确认 */
  PM: "PM",
  /** 业务分析 —— PRD 设计、边界逆向、需求宣讲 */
  BA: "BA",
  /** 系统架构 —— 调研、PRD 拆解、估时、技术方案审核 */
  SA: "SA",
  /** AI 助手 —— 需求分析、估时提取、Code Review、文档同步 */
  AI: "AI",
  /** 开发 —— 技术方案编写、功能开发、自测、联调 */
  DEV: "DEV",
  /** 测试 —— 测试用例编写、功能测试、性能测试、UAT */
  QA: "QA",
  /** 运维 —— 环境配置、发布计划、监控 */
  OP: "OP",
  /** 海因里希 —— 质量风险审计、合规检查 */
  HEI: "HEI",
} as const

export type Role = (typeof Role)[keyof typeof Role]

/** 角色显示名称映射 */
export const ROLE_LABELS: Record<Role, string> = {
  [Role.PM]: "产品经理",
  [Role.BA]: "业务分析",
  [Role.SA]: "系统架构",
  [Role.AI]: "AI 助手",
  [Role.DEV]: "开发",
  [Role.QA]: "测试",
  [Role.OP]: "运维",
  [Role.HEI]: "海因里希审计",
}

/** 角色颜色（用于 CLI 输出） */
export const ROLE_COLORS: Record<Role, string> = {
  [Role.PM]: "blue",
  [Role.BA]: "cyan",
  [Role.SA]: "green",
  [Role.AI]: "magenta",
  [Role.DEV]: "yellow",
  [Role.QA]: "red",
  [Role.OP]: "white",
  [Role.HEI]: "purple",
}

/** 所有角色列表 */
export const ALL_ROLES: readonly Role[] = [
  Role.PM,
  Role.BA,
  Role.SA,
  Role.AI,
  Role.DEV,
  Role.QA,
  Role.OP,
  Role.HEI,
]

/** 判断角色是否有效 */
export function isValidRole(value: string): value is Role {
  return ALL_ROLES.includes(value as Role)
}
