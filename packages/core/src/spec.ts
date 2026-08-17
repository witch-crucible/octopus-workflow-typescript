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
      readonly assistant: string
      readonly input?: string
      readonly outputFile?: string
      readonly ifExists?: "overwrite" | "extend"
    }
  /** 外部集成：调用注册的 IntegrationService（如 sonar/postman） */
  | { readonly kind: "integration"; readonly service: string; readonly op: string }
  /** Heinrich 标记：完成步骤时增加对应条数 */
  | { readonly kind: "heinrich"; readonly delta: number; readonly level?: HeinrichLevel }
  /** 插件注册的自定义能力，按 name 分发 */
  | { readonly kind: "custom"; readonly name: string; readonly input?: Readonly<Record<string, unknown>> }

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
        { id: "10.1", name: "Requirements Analysis and BRD Design", description: "PM analyzes requirements and completes the BRD", responsibleRoles: [Role.PM], dependsOn: [] },
        { id: "10.2", name: "BRD Walkthrough", description: "PM walks BA through the BRD", responsibleRoles: [Role.PM, Role.BA], dependsOn: ["10.1"] },
        { id: "10.3", name: "Requirements Research", description: "SA researches technical feasibility, delivery time, and cost", responsibleRoles: [Role.SA], dependsOn: ["10.2"] },
        { id: "10.4", name: "PRD and Boundary Design", description: "BA designs the PRD and validates boundary cases", responsibleRoles: [Role.BA], dependsOn: ["10.3"] },
        { id: "10.5", name: "PRD Walkthrough", description: "BA walks PM, DEV, and SA through the PRD", responsibleRoles: [Role.BA, Role.PM, Role.DEV, Role.SA], dependsOn: ["10.4"] },
        { id: "10.6", name: "AI Meeting Minutes", description: "AI generates meeting minutes from the recorded discussion", responsibleRoles: [Role.AI], dependsOn: ["10.5"], capabilities: [ai(AIAssistantType.MEETING_MINUTES)] },
        { id: "10.7", name: "PRD Review and Feature Breakdown", description: "SA reviews the PRD and breaks it into feature units", responsibleRoles: [Role.SA], dependsOn: ["10.5"] },
        { id: "10.8", name: "PRD Effort Estimation", description: "SA estimates each feature unit at no more than two hours", responsibleRoles: [Role.SA], dependsOn: ["10.7"] },
        { id: "10.9", name: "AI Requirements Analysis", description: "AI analyzes and decomposes requirements using project code, wiki pages, and mind maps", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["10.7"], capabilities: [ai(AIAssistantType.REQUIREMENTS_ANALYSIS)] },
        { id: "10.10", name: "AI Effort Summary", description: "AI summarizes effort from the detailed Excel estimate", responsibleRoles: [Role.AI], dependsOn: ["10.8"], capabilities: [ai(AIAssistantType.EFFORT_ESTIMATION)] },
        { id: "10.11", name: "Effort Estimate Sync", description: "SA shares the effort estimate with PM and DEV", responsibleRoles: [Role.SA, Role.PM, Role.DEV], dependsOn: ["10.10"] },
        { id: "10.12", name: "Developer Effort Confirmation", description: "DEV confirms the effort estimate", responsibleRoles: [Role.DEV], dependsOn: ["10.11"] },
      ],
    },
    {
      phase: Phase.DESIGN,
      label: "设计",
      phaseId: PhaseId("design"),
      entryCriteria: ["需求分析阶段已完成", "PRD 已定稿"],
      exitCriteria: ["技术方案已审核", "测试用例已评审"],
      steps: [
        { id: "20.1", name: "Requirements Scheduling", description: "PM schedules the approved requirements", responsibleRoles: [Role.PM], dependsOn: [] },
        { id: "20.2", name: "Kickoff Review", description: "The team reviews requirements with a recording and AI summary", responsibleRoles: [Role.PM, Role.BA, Role.SA, Role.DEV, Role.QA], dependsOn: ["20.1"] },
        { id: "20.2a", name: "AI Kickoff Summary", description: "AI summarizes the kickoff recording", responsibleRoles: [Role.AI], dependsOn: ["20.2"], capabilities: [ai(AIAssistantType.MEETING_MINUTES)] },
        { id: "20.3", name: "Requirements Walkthrough", description: "BA explains the requirements to PM, SA, DEV, and QA", responsibleRoles: [Role.BA, Role.PM, Role.SA, Role.DEV, Role.QA], dependsOn: ["20.2"] },
        { id: "20.4", name: "Developer PRD Recap", description: "DEV restates the PRD understanding and reports questions to SA and BA", responsibleRoles: [Role.DEV, Role.SA, Role.BA], dependsOn: ["20.3"] },
        { id: "20.5", name: "Teambition Task Breakdown", description: "PM splits the work into Teambition tasks of no more than four hours", responsibleRoles: [Role.PM], dependsOn: ["20.4"], capabilities: [svc("teambition", "splitTasks")] },
        { id: "20.6", name: "Impact Scope Assessment", description: "DEV assesses the affected scope and shares it with SA and QA", responsibleRoles: [Role.DEV, Role.SA, Role.QA], dependsOn: ["20.5"] },
        { id: "20.7", name: "Frontend and Backend Alignment", description: "DEV aligns frontend and backend implementation plans and records the decisions", responsibleRoles: [Role.DEV], dependsOn: ["20.6"] },
        { id: "20.8", name: "Technical Design Authoring", description: "DEV documents frontend and backend designs, including APIs, ER models, flows, and PDL", responsibleRoles: [Role.DEV], dependsOn: ["20.7"] },
      ],
    },
    {
      phase: Phase.DEVELOPMENT,
      label: "开发",
      phaseId: PhaseId("dev"),
      entryCriteria: ["设计阶段已完成", "技术方案已审核通过"],
      exitCriteria: ["功能开发完成", "自测完成", "Code Review 通过"],
      steps: [
        { id: "30.1", name: "Technical Design Consolidation", description: "DEV consolidates the technical design and verifies the estimate", responsibleRoles: [Role.DEV], dependsOn: [] },
        { id: "30.2", name: "AI Setup Checklist Validation", description: "AI validates domain, Nginx, PHP, payment, and related setup", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["30.1"], capabilities: [ai(AIAssistantType.SETUP_CHECKLIST_CHECK)] },
        { id: "30.3", name: "Technical Design Review Chain", description: "DEV, SA, BA, and PM review the technical design in sequence", responsibleRoles: [Role.DEV, Role.SA, Role.BA, Role.PM], dependsOn: ["30.1"] },
        { id: "30.4", name: "AI Technical Design Review", description: "AI scores architecture quality and predicts security and performance risks", responsibleRoles: [Role.AI], dependsOn: ["30.3"], capabilities: [ai(AIAssistantType.TECH_DESIGN_REVIEW)] },
        { id: "30.5", name: "Test Case Design and Review", description: "QA writes test cases and organizes their review", responsibleRoles: [Role.QA, Role.DEV, Role.SA, Role.PM], dependsOn: ["30.4"] },
        { id: "30.6", name: "Data and API Design", description: "DEV designs data structures, APIs, and user interfaces", responsibleRoles: [Role.DEV, Role.SA], dependsOn: ["30.5"] },
        { id: "30.7", name: "Feature Development", description: "DEV implements the feature and creates its main task branch", responsibleRoles: [Role.DEV], dependsOn: ["30.6"], capabilities: [hei(1)] },
        { id: "30.8", name: "Checklist Update and Integration", description: "DEV updates the checklist and completes integration testing", responsibleRoles: [Role.DEV], dependsOn: ["30.7"] },
        {
          id: "30.9",
          name: "Environment Validation and AI Documentation",
          description: "SA confirms the environment and AI generates or extends the technical documentation",
          responsibleRoles: [Role.SA, Role.AI],
          dependsOn: ["30.8"],
          capabilities: [ai(AIAssistantType.DOCUMENT_SYNC, {
            input: "Generate complete technical documentation from the current project code and changes. Preserve valid existing content and extend changed sections. Return only the complete Markdown document.",
            outputFile: "documentation.md",
            ifExists: "extend",
          })],
        },
        { id: "30.10", name: "Self-Test and Code Quality", description: "DEV completes self-testing, Sonar analysis, vulnerability scanning, and CodeCheck", responsibleRoles: [Role.DEV], dependsOn: ["30.9"], capabilities: [svc("sonar", "runScan"), hei(1)] },
        { id: "30.11", name: "Weekly Feature Demo", description: "SA runs the weekly feature demo and code quality review", responsibleRoles: [Role.SA, Role.DEV], dependsOn: ["30.10"] },
      ],
    },
    {
      phase: Phase.TESTING,
      label: "测试",
      phaseId: PhaseId("test"),
      entryCriteria: ["开发阶段已完成", "冒烟演示已完成"],
      exitCriteria: ["UAT 已通过", "性能测试已完成", "发布计划已创建"],
      steps: [
        { id: "40.1", name: "Smoke Demo Validation", description: "DEV validates the smoke demo with QA", responsibleRoles: [Role.DEV, Role.QA], dependsOn: [], capabilities: [hei(1)] },
        { id: "40.2", name: "Functional and Performance Testing", description: "QA performs functional and performance testing", responsibleRoles: [Role.QA], dependsOn: ["40.1"] },
        { id: "40.3", name: "UAT and User Acceptance", description: "QA prepares UAT cases and OP performs user acceptance testing", responsibleRoles: [Role.QA, Role.OP], dependsOn: ["40.2"] },
        { id: "40.4", name: "Release Plan Creation", description: "OP creates the release plan at least three days in advance", responsibleRoles: [Role.OP], dependsOn: ["40.3"] },
      ],
    },
    {
      phase: Phase.DEPLOYMENT,
      label: "部署",
      phaseId: PhaseId("deploy"),
      entryCriteria: ["测试阶段已完成", "发布计划已创建"],
      exitCriteria: ["部署已完成", "回归测试通过", "Prod 分支已合并回 Dev"],
      steps: [
        { id: "50.1", name: "Environment Deployment", description: "SA deploys the complete domain, CDN, WAF, SLB, ECS, and related environment configuration", responsibleRoles: [Role.SA], dependsOn: [] },
        { id: "50.2", name: "Branch Merge", description: "SA merges the release branches", responsibleRoles: [Role.SA, Role.DEV], dependsOn: ["50.1"], capabilities: [svc("git", "mergeBranches"), hei(1)] },
        { id: "50.3", name: "AI Checklist Recommendation", description: "AI recommends checklist additions for review by SA, BA, DEV, PM, and QA", responsibleRoles: [Role.SA, Role.BA, Role.DEV, Role.PM, Role.QA, Role.AI], dependsOn: ["50.2"], capabilities: [ai(AIAssistantType.CHECKLIST_RECOMMENDATION)] },
        { id: "50.4", name: "Sonar and Code Review", description: "SA runs Sonar and DEV performs code review", responsibleRoles: [Role.SA, Role.DEV], dependsOn: ["50.3"], capabilities: [svc("sonar", "runScan"), hei(1)] },
        { id: "50.5", name: "AI Code Review", description: "AI generates UML sequence diagrams and control-flow graphs, then scores change risk", responsibleRoles: [Role.AI], dependsOn: ["50.4"], capabilities: [ai(AIAssistantType.CODE_REVIEW)] },
        { id: "50.6", name: "Postman and Test Script Generation", description: "SA runs Postman and AI generates automated test scripts", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["50.5"], capabilities: [svc("postman", "runCollection"), ai(AIAssistantType.TEST_SCRIPT_GENERATION), hei(1)] },
        { id: "50.7", name: "SQL Execution and Risk Check", description: "SA and DEV execute SQL while AI detects missing indexes, table locks, and non-reversible changes", responsibleRoles: [Role.SA, Role.DEV, Role.AI], dependsOn: ["50.6"], capabilities: [ai(AIAssistantType.SQL_RISK_CHECK), hei(1)] },
        { id: "50.8", name: "Magento Release Risk Assessment", description: "SA performs the release and AI assesses release risk in advance", responsibleRoles: [Role.SA, Role.AI], dependsOn: ["50.7"], capabilities: [ai(AIAssistantType.RELEASE_RISK_ASSESSMENT)] },
        { id: "50.9", name: "Regression Testing", description: "QA performs regression testing", responsibleRoles: [Role.QA], dependsOn: ["50.8"] },
        { id: "50.10", name: "AB Validation and Branch Merge", description: "PM validates the AB test and merges the production branch back into development", responsibleRoles: [Role.PM], dependsOn: ["50.9"] },
      ],
    },
    {
      phase: Phase.MAINTENANCE,
      label: "维护",
      phaseId: PhaseId("maint"),
      entryCriteria: ["部署阶段已完成"],
      exitCriteria: ["监控完成"],
      steps: [
        { id: "60.1", name: "AI Technical Debt Quantification", description: "AI scores code complexity, duplication, and dependency age to prioritize technical debt", responsibleRoles: [Role.AI], dependsOn: [], capabilities: [ai(AIAssistantType.TECH_DEBT_QUANTIFICATION)] },
        { id: "60.2", name: "Service Monitoring", description: "DEV monitors the service across daily, weekly, and yearly windows", responsibleRoles: [Role.DEV], dependsOn: ["60.1"], capabilities: [svc("monitoring", "registerAlert")] },
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
