/**
 * 阶段与阶段步骤（Stage）定义。
 *
 * 从 project-process-AI.puml 提取的 6 个阶段、40+ 个步骤。
 * 每个 Stage 映射 PlantUML 中的一个交互步骤。
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

/** 阶段步骤定义 */
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

/**
 * 阶段定义映射 —— 从 PlantUML 提取。
 *
 * 每条目的 stages 数组映射该阶段内的交互步骤。
 */
export const PHASE_DEFS: Record<Phase, PhaseDef> = {
  [Phase.REQUIREMENTS_ANALYSIS]: {
    phase: Phase.REQUIREMENTS_ANALYSIS,
    label: "需求分析",
    phaseId: PhaseId("req"),
    entryCriteria: ["项目已创建"],
    exitCriteria: ["PRD 已完成", "估时已完成", "DEV 二次确认工时"],
    stages: [
      { id: "10.1", name: "需求分析和 BRD 设计", description: "PM 进行需求分析，完成 BRD 设计", responsibleRoles: [Role.PM], dependsOn: [] },
      { id: "10.2", name: "BRD 讲解", description: "PM 向 BA 讲解 BRD", responsibleRoles: [Role.PM, Role.BA], dependsOn: ["10.1"] },
      { id: "10.3", name: "需求调研", description: "SA 进行技术调研，评估可行性和预计时间/成本", responsibleRoles: [Role.SA], dependsOn: ["10.2"] },
      { id: "10.4", name: "PRD 设计与边界逆向设计", description: "BA 进行 PRD 设计和边界逆向设计", responsibleRoles: [Role.BA], dependsOn: ["10.3"] },
      { id: "10.5", name: "PRD 讲解", description: "BA 向 PM/DEV/SA 讲解 PRD", responsibleRoles: [Role.BA, Role.PM, Role.DEV, Role.SA], dependsOn: ["10.4"] },
      { id: "10.6", name: "AI 会议纪要", description: "AI 通过通义听悟/chatGPT录音生成会议纪要", responsibleRoles: [Role.AI], dependsOn: ["10.5"] },
      { id: "10.7", name: "PRD 阅读和功能点拆分", description: "SA 阅读 PRD 并拆分功能点", responsibleRoles: [Role.SA], dependsOn: ["10.5"] },
      { id: "10.8", name: "PRD 估时", description: "SA 对功能点进行估时（每子项 ≤2h）", responsibleRoles: [Role.SA], dependsOn: ["10.7"] },
      { id: "10.9", name: "AI 需求分析", description: "AI 根据项目代码/wiki/思维导图进行需求拆解分析", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["10.7"] },
      { id: "10.10", name: "AI PRD 估时提取", description: "AI 从 Excel 估时明细中汇总工时", responsibleRoles: [Role.AI], dependsOn: ["10.8"] },
      { id: "10.11", name: "PRD 估时同步", description: "SA 向 PM 和 DEV 同步估时结果", responsibleRoles: [Role.SA, Role.PM, Role.DEV], dependsOn: ["10.10"] },
      { id: "10.12", name: "DEV 二次确认工时", description: "DEV 确认工时评估", responsibleRoles: [Role.DEV], dependsOn: ["10.11"] },
    ],
  },

  [Phase.DESIGN]: {
    phase: Phase.DESIGN,
    label: "设计",
    phaseId: PhaseId("design"),
    entryCriteria: ["需求分析阶段已完成", "PRD 已定稿"],
    exitCriteria: ["技术方案已审核", "测试用例已评审"],
    stages: [
      { id: "20.1", name: "需求排期", description: "PM 进行需求排期", responsibleRoles: [Role.PM], dependsOn: [] },
      { id: "20.2", name: "Kick Off 评审", description: "需求评审会议，含录音和 AI 总结", responsibleRoles: [Role.PM, Role.BA, Role.SA, Role.DEV, Role.QA], dependsOn: ["20.1"] },
      { id: "20.2a", name: "AI 会议录音总结", description: "AI 总结会议录音", responsibleRoles: [Role.AI], dependsOn: ["20.2"] },
      { id: "20.3", name: "BA 需求讲解", description: "BA 向 PM/SA/DEV/QA 讲解需求", responsibleRoles: [Role.BA, Role.PM, Role.SA, Role.DEV, Role.QA], dependsOn: ["20.2"] },
      { id: "20.4", name: "DEV PRD 复述", description: "DEV 复述 PRD 理解，反馈问题给 SA/BA", responsibleRoles: [Role.DEV, Role.SA, Role.BA], dependsOn: ["20.3"] },
      { id: "20.5", name: "PM TB 任务拆分", description: "PM 拆分 TB 任务（每任务 ≤4h）", responsibleRoles: [Role.PM], dependsOn: ["20.4"] },
      { id: "20.6", name: "DEV 需求影响范围评估", description: "DEV 评估需求影响范围，反馈给 SA/QA", responsibleRoles: [Role.DEV, Role.SA, Role.QA], dependsOn: ["20.5"] },
      { id: "20.7", name: "前后端沟通会议", description: "DEV 前后端沟通实现方案，产出会议纪要", responsibleRoles: [Role.DEV], dependsOn: ["20.6"] },
      { id: "20.8", name: "技术方案编写", description: "DEV 编写前端和后端技术方案（API/ER/流程图/PDL）", responsibleRoles: [Role.DEV], dependsOn: ["20.7"] },
    ],
  },

  [Phase.DEVELOPMENT]: {
    phase: Phase.DEVELOPMENT,
    label: "开发",
    phaseId: PhaseId("dev"),
    entryCriteria: ["设计阶段已完成", "技术方案已审核通过"],
    exitCriteria: ["功能开发完成", "自测完成", "Code Review 通过"],
    stages: [
      { id: "30.1", name: "技术方案合并和估时核验", description: "DEV 合并技术方案并核验估时", responsibleRoles: [Role.DEV], dependsOn: [] },
      { id: "30.2", name: "AI Setup Checklist 校验", description: "AI 自动校验域名/Nginx/PHP/支付等配置", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["30.1"] },
      { id: "30.3", name: "技术方案审核链", description: "DEV→SA→BA→PM 多级技术方案审核", responsibleRoles: [Role.DEV, Role.SA, Role.BA, Role.PM], dependsOn: ["30.1"] },
      { id: "30.4", name: "AI 技术方案审核", description: "AI 进行架构合理性评分、安全漏洞预扫描、性能瓶颈预判", responsibleRoles: [Role.AI], dependsOn: ["30.3"] },
      { id: "30.5", name: "测试用例编写与评审", description: "QA 编写测试用例并组织评审", responsibleRoles: [Role.QA, Role.DEV, Role.SA, Role.PM], dependsOn: ["30.4"] },
      { id: "30.6", name: "数据结构与接口设计", description: "DEV 进行数据结构设计、接口设计、界面设计", responsibleRoles: [Role.DEV, Role.SA], dependsOn: ["30.5"] },
      { id: "30.7", name: "功能开发（AB Test）", description: "DEV 实现功能开发，构建对应主任务分支", responsibleRoles: [Role.DEV], dependsOn: ["30.6"] },
      { id: "30.8", name: "记录 Checklist 和联调", description: "DEV 更新 Checklist 并完成联调", responsibleRoles: [Role.DEV], dependsOn: ["30.7"] },
      { id: "30.9", name: "环境确认与 AI 文档同步", description: "SA 确认环境就绪，AI 同步更新技术文档", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["30.8"] },
      { id: "30.10", name: "自测和代码质量检查", description: "DEV 自测（产出自我测试表）→ Sonar → 漏洞扫描 → CodeCheck", responsibleRoles: [Role.DEV], dependsOn: ["30.9"] },
      { id: "30.11", name: "每周功能演示", description: "SA 进行每周功能演示和代码质量检查", responsibleRoles: [Role.SA, Role.DEV], dependsOn: ["30.10"] },
    ],
  },

  [Phase.TESTING]: {
    phase: Phase.TESTING,
    label: "测试",
    phaseId: PhaseId("test"),
    entryCriteria: ["开发阶段已完成", "冒烟演示已完成"],
    exitCriteria: ["UAT 已通过", "性能测试已完成", "发布计划已创建"],
    stages: [
      { id: "40.1", name: "核验冒烟演示", description: "DEV 向 QA 核验冒烟演示", responsibleRoles: [Role.DEV, Role.QA], dependsOn: [] },
      { id: "40.2", name: "功能测试与性能测试", description: "QA 进行功能测试和性能测试", responsibleRoles: [Role.QA], dependsOn: ["40.1"] },
      { id: "40.3", name: "UAT 用例与用户验收", description: "QA 准备 UAT 用例，OP 进行 UAT", responsibleRoles: [Role.QA, Role.OP], dependsOn: ["40.2"] },
      { id: "40.4", name: "创建发布计划", description: "OP 创建发布计划（至少提前 3 天）", responsibleRoles: [Role.OP], dependsOn: ["40.3"] },
    ],
  },

  [Phase.DEPLOYMENT]: {
    phase: Phase.DEPLOYMENT,
    label: "部署",
    phaseId: PhaseId("deploy"),
    entryCriteria: ["测试阶段已完成", "发布计划已创建"],
    exitCriteria: ["部署已完成", "回归测试通过", "Prod 分支已合并回 Dev"],
    stages: [
      { id: "50.1", name: "Setup 部署", description: "SA 进行环境部署（域名/CDN/WAF/SLB/ECS 等全套配置）", responsibleRoles: [Role.SA], dependsOn: [] },
      { id: "50.2", name: "分支合并", description: "SA 合并分支", responsibleRoles: [Role.SA, Role.DEV], dependsOn: ["50.1"] },
      { id: "50.3", name: "AI Checklist 增量推荐和多方评审", description: "AI 推荐增量 Checklist，SA/BA/DEV/PM/QA 多方评审", responsibleRoles: [Role.SA, Role.BA, Role.DEV, Role.PM, Role.QA, Role.AI], dependsOn: ["50.2"] },
      { id: "50.4", name: "Sonar 检查和 Code Review", description: "SA 运行 Sonar，DEV 进行 Code Review", responsibleRoles: [Role.SA, Role.DEV], dependsOn: ["50.3"] },
      { id: "50.5", name: "AI 智能 Code Review", description: "AI 生成 UML 时序图/CFG，进行变更风险评分", responsibleRoles: [Role.AI], dependsOn: ["50.4"] },
      { id: "50.6", name: "Postman 运行与 AI 测试脚本", description: "SA 运行 Postman，AI 生成自动化测试脚本", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["50.5"] },
      { id: "50.7", name: "SQL 执行与 AI 风险检测", description: "SA/DEV 执行 SQL，AI 进行 SQL 风险检测（缺索引/锁表/不可回滚）", responsibleRoles: [Role.SA, Role.DEV, Role.AI], dependsOn: ["50.6"] },
      { id: "50.8", name: "Magento 发布与 AI 风险评估", description: "SA 执行发布，AI 进行发布风险预评估", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["50.7"] },
      { id: "50.9", name: "回归测试", description: "QA 进行回归测试", responsibleRoles: [Role.QA], dependsOn: ["50.8"] },
      { id: "50.10", name: "AB 有效性验证和分支合并", description: "PM 验证 AB Test 有效性，合并 Prod 分支到 Dev", responsibleRoles: [Role.PM], dependsOn: ["50.9"] },
    ],
  },

  [Phase.MAINTENANCE]: {
    phase: Phase.MAINTENANCE,
    label: "维护",
    phaseId: PhaseId("maint"),
    entryCriteria: ["部署阶段已完成"],
    exitCriteria: ["监控完成"],
    stages: [
      { id: "60.1", name: "AI 技术债务量化", description: "AI 量化技术债务（代码复杂度/重复率/依赖老化评分，生成还债优先级列表）", responsibleRoles: [Role.AI], dependsOn: [] },
      { id: "60.2", name: "监控服务", description: "DEV 监控服务（1d/1w/1y）", responsibleRoles: [Role.DEV], dependsOn: ["60.1"] },
    ],
  },
}

/** 获取阶段定义 */
export function getPhaseDef(phase: Phase): PhaseDef {
  return PHASE_DEFS[phase]
}

/** 根据阶段获取所有步骤 */
export function getStages(phase: Phase): readonly StageDef[] {
  return PHASE_DEFS[phase].stages
}
