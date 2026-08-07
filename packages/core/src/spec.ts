/**
 * WorkflowSpec —— 工作流的唯一声明式真相源。
 *
 * `project-process-AI.puml` 中的阶段 / 步骤 / AI 辅助点 / Heinrich 标记 / 外部集成
 * 全部编码为下方 `DEFAULT_WORKFLOW_SPEC` 的数据。引擎与各能力（AI / 集成 / Heinrich）
 * 都从本 spec 派生行为——"改时序图"因此退化为"改这里的数据"，无需改引擎。
 *
 * 步骤上的 `capabilities` 声明该步骤要触发的能力（见 CapabilityRef）；
 * 由 workflow-engine 的 CapabilityRegistry 统一分发。
 *
 * 注：本文件是 phase.ts 之上的"步骤层"。phase.ts 只管阶段身份与顺序，
 * 不依赖本文件，从而避免运行时循环依赖。
 */

import { Phase } from "./phase.js"
import type { StageDef, PhaseDef } from "./phase.js"
import { Role } from "./role.js"
import { PhaseId } from "./branded-ids.js"
import { AIAssistantType } from "./agent.js"
import type { HeinrichLevel } from "./risk.js"

/**
 * 能力引用 —— 声明式地把一个步骤连接到具体能力。
 * 新增/移动时序图中的 AI/集成/Heinrich 节点，只需增删这里的一条引用。
 */
export type CapabilityRef =
  /** AI 辅助：调用 agent-layer 的对应助手 */
  | {
      readonly kind: "ai"
      readonly assistant: AIAssistantType
      readonly input?: string
      readonly outputFile?: string
      readonly ifExists?: "overwrite" | "extend"
    }
  /** 外部集成：调用注册的 IntegrationService（如 sonar/postman） */
  | { readonly kind: "integration"; readonly service: string; readonly op: string }
  /** Heinrich 标记：完成步骤时增加对应条数 */
  | { readonly kind: "heinrich"; readonly delta: number; readonly level?: HeinrichLevel }

/** 步骤定义 —— 在 StageDef 基础上增加声明式 capabilities */
export interface StepSpec extends StageDef {
  readonly capabilities?: readonly CapabilityRef[]
}

/** 阶段规格 —— 阶段元信息 + 有序步骤 */
export interface PhaseSpec {
  readonly phase: Phase
  readonly label: string
  readonly phaseId: PhaseId
  readonly entryCriteria: readonly string[]
  readonly exitCriteria: readonly string[]
  readonly steps: readonly StepSpec[]
}

/** 工作流规格 —— 有序阶段的集合 */
export interface WorkflowSpec {
  readonly phases: readonly PhaseSpec[]
}

/** 便捷构造 AI capability */
const ai = (
  assistant: AIAssistantType,
  options: Omit<Extract<CapabilityRef, { kind: "ai" }>, "kind" | "assistant"> = {},
): CapabilityRef => ({ kind: "ai", assistant, ...options })
/** 便捷构造集成 capability */
const svc = (service: string, op: string): CapabilityRef => ({ kind: "integration", service, op })
/** 便捷构造 Heinrich capability */
const hei = (delta = 1): CapabilityRef => ({ kind: "heinrich", delta })

/**
 * 默认工作流规格 —— 由 project-process-AI.puml 提取。
 * 步骤 id 与 puml 交互序号一一对应，便于图变更时定位。
 */
export const DEFAULT_WORKFLOW_SPEC: WorkflowSpec = {
  phases: [
    {
      phase: Phase.REQUIREMENTS_ANALYSIS,
      label: "需求分析",
      phaseId: PhaseId("req"),
      entryCriteria: ["项目已创建"],
      exitCriteria: ["PRD 已完成", "估时已完成", "DEV 二次确认工时"],
      steps: [
        { id: "10.1", name: "需求分析和 BRD 设计", description: "PM 进行需求分析，完成 BRD 设计", responsibleRoles: [Role.PM], dependsOn: [] },
        { id: "10.2", name: "BRD 讲解", description: "PM 向 BA 讲解 BRD", responsibleRoles: [Role.PM, Role.BA], dependsOn: ["10.1"] },
        { id: "10.3", name: "需求调研", description: "SA 进行技术调研，评估可行性和预计时间/成本", responsibleRoles: [Role.SA], dependsOn: ["10.2"] },
        { id: "10.4", name: "PRD 设计与边界逆向设计", description: "BA 进行 PRD 设计和边界逆向设计", responsibleRoles: [Role.BA], dependsOn: ["10.3"] },
        { id: "10.5", name: "PRD 讲解", description: "BA 向 PM/DEV/SA 讲解 PRD", responsibleRoles: [Role.BA, Role.PM, Role.DEV, Role.SA], dependsOn: ["10.4"] },
        { id: "10.6", name: "AI 会议纪要", description: "AI 通过通义听悟/chatGPT录音生成会议纪要", responsibleRoles: [Role.AI], dependsOn: ["10.5"], capabilities: [ai(AIAssistantType.MEETING_MINUTES)] },
        { id: "10.7", name: "PRD 阅读和功能点拆分", description: "SA 阅读 PRD 并拆分功能点", responsibleRoles: [Role.SA], dependsOn: ["10.5"] },
        { id: "10.8", name: "PRD 估时", description: "SA 对功能点进行估时（每子项 ≤2h）", responsibleRoles: [Role.SA], dependsOn: ["10.7"] },
        { id: "10.9", name: "AI 需求分析", description: "AI 根据项目代码/wiki/思维导图进行需求拆解分析", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["10.7"], capabilities: [ai(AIAssistantType.REQUIREMENTS_ANALYSIS)] },
        { id: "10.10", name: "AI PRD 估时提取", description: "AI 从 Excel 估时明细中汇总工时", responsibleRoles: [Role.AI], dependsOn: ["10.8"], capabilities: [ai(AIAssistantType.EFFORT_ESTIMATION)] },
        { id: "10.11", name: "PRD 估时同步", description: "SA 向 PM 和 DEV 同步估时结果", responsibleRoles: [Role.SA, Role.PM, Role.DEV], dependsOn: ["10.10"] },
        { id: "10.12", name: "DEV 二次确认工时", description: "DEV 确认工时评估", responsibleRoles: [Role.DEV], dependsOn: ["10.11"] },
      ],
    },
    {
      phase: Phase.DESIGN,
      label: "设计",
      phaseId: PhaseId("design"),
      entryCriteria: ["需求分析阶段已完成", "PRD 已定稿"],
      exitCriteria: ["技术方案已审核", "测试用例已评审"],
      steps: [
        { id: "20.1", name: "需求排期", description: "PM 进行需求排期", responsibleRoles: [Role.PM], dependsOn: [] },
        { id: "20.2", name: "Kick Off 评审", description: "需求评审会议，含录音和 AI 总结", responsibleRoles: [Role.PM, Role.BA, Role.SA, Role.DEV, Role.QA], dependsOn: ["20.1"] },
        { id: "20.2a", name: "AI 会议录音总结", description: "AI 总结会议录音", responsibleRoles: [Role.AI], dependsOn: ["20.2"], capabilities: [ai(AIAssistantType.MEETING_MINUTES)] },
        { id: "20.3", name: "BA 需求讲解", description: "BA 向 PM/SA/DEV/QA 讲解需求", responsibleRoles: [Role.BA, Role.PM, Role.SA, Role.DEV, Role.QA], dependsOn: ["20.2"] },
        { id: "20.4", name: "DEV PRD 复述", description: "DEV 复述 PRD 理解，反馈问题给 SA/BA", responsibleRoles: [Role.DEV, Role.SA, Role.BA], dependsOn: ["20.3"] },
        { id: "20.5", name: "PM TB 任务拆分", description: "PM 拆分 TB 任务（每任务 ≤4h）", responsibleRoles: [Role.PM], dependsOn: ["20.4"], capabilities: [svc("teambition", "splitTasks")] },
        { id: "20.6", name: "DEV 需求影响范围评估", description: "DEV 评估需求影响范围，反馈给 SA/QA", responsibleRoles: [Role.DEV, Role.SA, Role.QA], dependsOn: ["20.5"] },
        { id: "20.7", name: "前后端沟通会议", description: "DEV 前后端沟通实现方案，产出会议纪要", responsibleRoles: [Role.DEV], dependsOn: ["20.6"] },
        { id: "20.8", name: "技术方案编写", description: "DEV 编写前端和后端技术方案（API/ER/流程图/PDL）", responsibleRoles: [Role.DEV], dependsOn: ["20.7"] },
      ],
    },
    {
      phase: Phase.DEVELOPMENT,
      label: "开发",
      phaseId: PhaseId("dev"),
      entryCriteria: ["设计阶段已完成", "技术方案已审核通过"],
      exitCriteria: ["功能开发完成", "自测完成", "Code Review 通过"],
      steps: [
        { id: "30.1", name: "技术方案合并和估时核验", description: "DEV 合并技术方案并核验估时", responsibleRoles: [Role.DEV], dependsOn: [] },
        { id: "30.2", name: "AI Setup Checklist 校验", description: "AI 自动校验域名/Nginx/PHP/支付等配置", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["30.1"], capabilities: [ai(AIAssistantType.SETUP_CHECKLIST_CHECK)] },
        { id: "30.3", name: "技术方案审核链", description: "DEV→SA→BA→PM 多级技术方案审核", responsibleRoles: [Role.DEV, Role.SA, Role.BA, Role.PM], dependsOn: ["30.1"] },
        { id: "30.4", name: "AI 技术方案审核", description: "AI 进行架构合理性评分、安全漏洞预扫描、性能瓶颈预判", responsibleRoles: [Role.AI], dependsOn: ["30.3"], capabilities: [ai(AIAssistantType.TECH_DESIGN_REVIEW)] },
        { id: "30.5", name: "测试用例编写与评审", description: "QA 编写测试用例并组织评审", responsibleRoles: [Role.QA, Role.DEV, Role.SA, Role.PM], dependsOn: ["30.4"] },
        { id: "30.6", name: "数据结构与接口设计", description: "DEV 进行数据结构设计、接口设计、界面设计", responsibleRoles: [Role.DEV, Role.SA], dependsOn: ["30.5"] },
        { id: "30.7", name: "功能开发（AB Test）", description: "DEV 实现功能开发，构建对应主任务分支", responsibleRoles: [Role.DEV], dependsOn: ["30.6"], capabilities: [hei(1)] },
        { id: "30.8", name: "记录 Checklist 和联调", description: "DEV 更新 Checklist 并完成联调", responsibleRoles: [Role.DEV], dependsOn: ["30.7"] },
        {
          id: "30.9",
          name: "环境确认与 AI 文档生成",
          description: "SA 确认环境就绪，AI 生成技术文档；文档存在时在原内容基础上扩展",
          responsibleRoles: [Role.SA, Role.AI],
          dependsOn: ["30.8"],
          capabilities: [ai(AIAssistantType.DOCUMENT_SYNC, {
            input: "根据当前项目代码和变更生成完整技术文档；如果已有文档，请保留有效内容并扩展变更部分。只输出完整 Markdown 文档。",
            outputFile: "documentation.md",
            ifExists: "extend",
          })],
        },
        { id: "30.10", name: "自测和代码质量检查", description: "DEV 自测（产出自我测试表）→ Sonar → 漏洞扫描 → CodeCheck", responsibleRoles: [Role.DEV], dependsOn: ["30.9"], capabilities: [svc("sonar", "runScan"), hei(1)] },
        { id: "30.11", name: "每周功能演示", description: "SA 进行每周功能演示和代码质量检查", responsibleRoles: [Role.SA, Role.DEV], dependsOn: ["30.10"] },
      ],
    },
    {
      phase: Phase.TESTING,
      label: "测试",
      phaseId: PhaseId("test"),
      entryCriteria: ["开发阶段已完成", "冒烟演示已完成"],
      exitCriteria: ["UAT 已通过", "性能测试已完成", "发布计划已创建"],
      steps: [
        { id: "40.1", name: "核验冒烟演示", description: "DEV 向 QA 核验冒烟演示", responsibleRoles: [Role.DEV, Role.QA], dependsOn: [], capabilities: [hei(1)] },
        { id: "40.2", name: "功能测试与性能测试", description: "QA 进行功能测试和性能测试", responsibleRoles: [Role.QA], dependsOn: ["40.1"] },
        { id: "40.3", name: "UAT 用例与用户验收", description: "QA 准备 UAT 用例，OP 进行 UAT", responsibleRoles: [Role.QA, Role.OP], dependsOn: ["40.2"] },
        { id: "40.4", name: "创建发布计划", description: "OP 创建发布计划（至少提前 3 天）", responsibleRoles: [Role.OP], dependsOn: ["40.3"] },
      ],
    },
    {
      phase: Phase.DEPLOYMENT,
      label: "部署",
      phaseId: PhaseId("deploy"),
      entryCriteria: ["测试阶段已完成", "发布计划已创建"],
      exitCriteria: ["部署已完成", "回归测试通过", "Prod 分支已合并回 Dev"],
      steps: [
        { id: "50.1", name: "Setup 部署", description: "SA 进行环境部署（域名/CDN/WAF/SLB/ECS 等全套配置）", responsibleRoles: [Role.SA], dependsOn: [] },
        { id: "50.2", name: "分支合并", description: "SA 合并分支", responsibleRoles: [Role.SA, Role.DEV], dependsOn: ["50.1"], capabilities: [svc("git", "mergeBranches"), hei(1)] },
        { id: "50.3", name: "AI Checklist 增量推荐和多方评审", description: "AI 推荐增量 Checklist，SA/BA/DEV/PM/QA 多方评审", responsibleRoles: [Role.SA, Role.BA, Role.DEV, Role.PM, Role.QA, Role.AI], dependsOn: ["50.2"], capabilities: [ai(AIAssistantType.CHECKLIST_RECOMMENDATION)] },
        { id: "50.4", name: "Sonar 检查和 Code Review", description: "SA 运行 Sonar，DEV 进行 Code Review", responsibleRoles: [Role.SA, Role.DEV], dependsOn: ["50.3"], capabilities: [svc("sonar", "runScan"), hei(1)] },
        { id: "50.5", name: "AI 智能 Code Review", description: "AI 生成 UML 时序图/CFG，进行变更风险评分", responsibleRoles: [Role.AI], dependsOn: ["50.4"], capabilities: [ai(AIAssistantType.CODE_REVIEW)] },
        { id: "50.6", name: "Postman 运行与 AI 测试脚本", description: "SA 运行 Postman，AI 生成自动化测试脚本", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["50.5"], capabilities: [svc("postman", "runCollection"), ai(AIAssistantType.TEST_SCRIPT_GENERATION), hei(1)] },
        { id: "50.7", name: "SQL 执行与 AI 风险检测", description: "SA/DEV 执行 SQL，AI 进行 SQL 风险检测（缺索引/锁表/不可回滚）", responsibleRoles: [Role.SA, Role.DEV, Role.AI], dependsOn: ["50.6"], capabilities: [ai(AIAssistantType.SQL_RISK_CHECK), hei(1)] },
        { id: "50.8", name: "Magento 发布与 AI 风险评估", description: "SA 执行发布，AI 进行发布风险预评估", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["50.7"], capabilities: [ai(AIAssistantType.RELEASE_RISK_ASSESSMENT)] },
        { id: "50.9", name: "回归测试", description: "QA 进行回归测试", responsibleRoles: [Role.QA], dependsOn: ["50.8"] },
        { id: "50.10", name: "AB 有效性验证和分支合并", description: "PM 验证 AB Test 有效性，合并 Prod 分支到 Dev", responsibleRoles: [Role.PM], dependsOn: ["50.9"] },
      ],
    },
    {
      phase: Phase.MAINTENANCE,
      label: "维护",
      phaseId: PhaseId("maint"),
      entryCriteria: ["部署阶段已完成"],
      exitCriteria: ["监控完成"],
      steps: [
        { id: "60.1", name: "AI 技术债务量化", description: "AI 量化技术债务（代码复杂度/重复率/依赖老化评分，生成还债优先级列表）", responsibleRoles: [Role.AI], dependsOn: [], capabilities: [ai(AIAssistantType.TECH_DEBT_QUANTIFICATION)] },
        { id: "60.2", name: "监控服务", description: "DEV 监控服务（1d/1w/1y）", responsibleRoles: [Role.DEV], dependsOn: ["60.1"], capabilities: [svc("monitoring", "registerAlert")] },
      ],
    },
  ],
}

/** 获取当前工作流规格（预留：未来可支持自定义 spec 注入） */
export function getWorkflowSpec(): WorkflowSpec {
  return DEFAULT_WORKFLOW_SPEC
}

/** 获取某阶段规格 */
export function getPhaseSpec(phase: Phase, spec: WorkflowSpec = DEFAULT_WORKFLOW_SPEC): PhaseSpec {
  const found = spec.phases.find((p) => p.phase === phase)
  if (!found) {
    throw new Error(`未知阶段: ${phase}`)
  }
  return found
}

/** 获取某阶段的所有步骤（含 capabilities） */
export function getSteps(phase: Phase, spec: WorkflowSpec = DEFAULT_WORKFLOW_SPEC): readonly StepSpec[] {
  return getPhaseSpec(phase, spec).steps
}

/** 在整个 spec 中按 id 查找步骤 */
export function findStepSpec(stepId: string, spec: WorkflowSpec = DEFAULT_WORKFLOW_SPEC): StepSpec | undefined {
  for (const phase of spec.phases) {
    const step = phase.steps.find((s) => s.id === stepId)
    if (step) return step
  }
  return undefined
}

// ── 向后兼容适配器：保持 PHASE_DEFS / getPhaseDef / getStages 语义 ──

/** 阶段定义映射（由 spec 派生；StepSpec 结构兼容 StageDef） */
export const PHASE_DEFS: Record<Phase, PhaseDef> = Object.fromEntries(
  DEFAULT_WORKFLOW_SPEC.phases.map((p) => [
    p.phase,
    {
      phase: p.phase,
      label: p.label,
      phaseId: p.phaseId,
      stages: p.steps,
      entryCriteria: p.entryCriteria,
      exitCriteria: p.exitCriteria,
    } satisfies PhaseDef,
  ]),
) as Record<Phase, PhaseDef>

/** 获取阶段定义 */
export function getPhaseDef(phase: Phase): PhaseDef {
  return PHASE_DEFS[phase]
}

/** 根据阶段获取所有步骤（StageDef 视图） */
export function getStages(phase: Phase): readonly StageDef[] {
  return PHASE_DEFS[phase].stages
}
