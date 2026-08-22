/** UI label maps and pure display helpers extracted from renderer.js. */

export const PHASE_ORDER = [
  "Intention",
  "Research",
  "Design",
  "Implementation",
  "Testing",
  "UAT",
  "Release",
  "Maintenance",
  "Completed",
] as const

export const ROLE_ORDER = ["PM", "BA", "SA", "AI", "DEV", "QA", "OP", "HEI"] as const

export const ROLE_COLORS = {
  PM: "#4f86c6",
  BA: "#67c23a",
  SA: "#36cfc9",
  AI: "#7b8fa8",
  DEV: "#e6a23c",
  QA: "#f56c6c",
  OP: "#909399",
  HEI: "#c45656",
} as const

export const PHASE_LABELS = {
  Intention: "意向",
  Research: "调研",
  Design: "设计",
  Implementation: "实现",
  Testing: "测试",
  UAT: "UAT",
  Release: "发布",
  Maintenance: "维护",
  Completed: "完结",
} as const

export const PHASE_HINTS = {
  Intention: "立项意向与 BRD 初稿",
  Research: "可行性、工期与成本调研",
  Design: "排期、对齐与技术设计",
  Implementation: "开发实现与联调",
  Testing: "功能与性能测试",
  UAT: "用户验收与发布计划",
  Release: "发布、合并与上线检查",
  Maintenance: "监控与技术债务",
  Completed: "项目已收尾",
} as const

export const STATUS_LABELS = {
  LOCKED: "未激活",
  PENDING: "待处理",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  BLOCKED: "已阻塞",
  SKIPPED: "已跳过",
} as const

export const SCHEDULER_LABELS = {
  IDLE: "空闲",
  RUNNING: "运行中",
  PAUSED: "已暂停",
  COMPLETED: "已完成",
  BLOCKED: "已阻塞",
} as const

export const ROLE_LABELS = {
  PM: "产品经理",
  BA: "业务分析",
  SA: "系统架构",
  AI: "AI 助手",
  DEV: "开发",
  QA: "测试",
  OP: "运维",
  HEI: "海因里希审计",
} as const

export const RUN_STATUS_LABELS = {
  QUEUED: "排队中",
  RUNNING: "执行中",
  SUCCEEDED: "成功",
  FAILED: "失败",
  CANCELED: "已取消",
  TIMED_OUT: "超时",
  INTERRUPTED: "已中断",
} as const

export const NODE_NAME_ZH: Readonly<Record<string, string>> = {
  "Requirements Analysis and BRD Design": "需求分析与 BRD 设计",
  "BRD Walkthrough": "BRD 宣讲",
  "Requirements Research": "需求调研",
  "PRD and Boundary Design": "PRD 与边界设计",
  "PRD Walkthrough": "PRD 宣讲",
  "AI Meeting Minutes": "AI 会议纪要",
  "PRD Review and Feature Breakdown": "PRD 评审与功能拆解",
  "PRD Effort Estimation": "PRD 工作量评估",
  "AI Requirements Analysis": "AI 需求分析",
  "AI Effort Summary": "AI 估时汇总",
  "Effort Estimate Sync": "估时同步",
  "Developer Effort Confirmation": "开发估时确认",
  "Requirements Scheduling": "需求排期",
  "Kickoff Review": "启动评审",
  "AI Kickoff Summary": "AI 启动纪要",
  "Requirements Walkthrough": "需求宣讲",
  "Developer PRD Recap": "开发 PRD 复盘",
  "Teambition Task Breakdown": "Teambition 任务拆解",
  "Impact Scope Assessment": "影响范围评估",
  "Frontend and Backend Alignment": "前后端对齐",
  "Technical Design Authoring": "技术方案编写",
  "Technical Design Consolidation": "技术方案整合",
  "AI Setup Checklist Validation": "AI 清单校验",
  "Technical Design Review Chain": "技术方案评审链",
  "AI Technical Design Review": "AI 技术方案审核",
  "Test Case Design and Review": "测试用例设计与评审",
  "Data and API Design": "数据与 API 设计",
  "Feature Development": "功能开发",
  "Checklist Update and Integration": "清单更新与联调",
  "Environment Validation and AI Documentation": "环境验证与 AI 文档",
  "Self-Test and Code Quality": "自测与代码质量",
  "Weekly Feature Demo": "周功能演示",
  "Smoke Demo Validation": "冒烟演示验证",
  "Functional and Performance Testing": "功能与性能测试",
  "UAT and User Acceptance": "UAT 与用户验收",
  "Release Plan Creation": "发布计划制定",
  "Environment Deployment": "环境部署",
  "Branch Merge": "分支合并",
  "AI Checklist Recommendation": "AI 清单建议",
  "Sonar and Code Review": "Sonar 与代码评审",
  "AI Code Review": "AI 代码评审",
  "Postman and Test Script Generation": "Postman 与测试脚本生成",
  "SQL Execution and Risk Check": "SQL 执行与风险检查",
  "Magento Release Risk Assessment": "Magento 发布风险评估",
  "Regression Testing": "回归测试",
  "AB Validation and Branch Merge": "A/B 验证与分支合并",
  "AI Technical Debt Quantification": "AI 技术债务量化",
  "Service Monitoring": "服务监控",
  "Generate Documentation": "生成文档",
}

export const NODE_DESC_ZH: Readonly<Record<string, string>> = {
  "Requirements Analysis and BRD Design": "产品经理分析业务需求并完成 BRD。",
  "BRD Walkthrough": "产品经理向业务分析讲解 BRD。",
  "Requirements Research": "架构师调研技术可行性、工期与成本。",
  "PRD and Boundary Design": "业务分析设计 PRD，并校验边界场景。",
  "PRD Walkthrough": "业务分析向产品、开发、架构讲解 PRD。",
  "AI Meeting Minutes": "由 AI 整理会议纪要，沉淀讨论结论。",
  "PRD Review and Feature Breakdown": "评审 PRD 并将需求拆为可交付功能。",
  "PRD Effort Estimation": "对 PRD 功能点进行工作量评估。",
  "AI Requirements Analysis": "AI 辅助分析需求完整性与风险点。",
  "AI Effort Summary": "AI 汇总估时结果，便于对齐排期。",
  "Effort Estimate Sync": "将估时结果同步到协作系统。",
  "Developer Effort Confirmation": "开发确认估时是否可落地。",
  "Requirements Scheduling": "根据估时与优先级安排交付计划。",
  "Kickoff Review": "项目启动评审，确认范围与协作方式。",
  "AI Kickoff Summary": "AI 汇总启动会关键结论。",
  "Requirements Walkthrough": "向研发与测试宣讲需求细节。",
  "Developer PRD Recap": "开发复盘 PRD，确认实现理解一致。",
  "Teambition Task Breakdown": "在 Teambition 中拆解可执行任务。",
  "Impact Scope Assessment": "评估改动影响范围与回归面。",
  "Frontend and Backend Alignment": "前后端对齐接口与交互约定。",
  "Technical Design Authoring": "编写技术方案与实现路径。",
  "Technical Design Consolidation": "整合多方技术方案，形成统一设计。",
  "AI Setup Checklist Validation": "AI 校验环境与清单是否齐全。",
  "Technical Design Review Chain": "按角色链路评审技术方案。",
  "AI Technical Design Review": "AI 辅助审核技术方案完备性。",
  "Test Case Design and Review": "设计并评审测试用例。",
  "Data and API Design": "设计数据结构与 API 契约。",
  "Feature Development": "按方案完成功能编码实现。",
  "Checklist Update and Integration": "更新清单并完成联调。",
  "Environment Validation and AI Documentation": "验证环境配置，并由 AI 补充相关文档。",
  "Self-Test and Code Quality": "开发自测并关注代码质量。",
  "Weekly Feature Demo": "按周演示已完成功能。",
  "Smoke Demo Validation": "冒烟测试与演示验证。",
  "Functional and Performance Testing": "执行功能测试与性能测试。",
  "UAT and User Acceptance": "用户验收测试与确认。",
  "Release Plan Creation": "制定发布计划与回滚策略。",
  "Environment Deployment": "将版本部署到目标环境。",
  "Branch Merge": "合并发布相关分支。",
  "AI Checklist Recommendation": "AI 推荐发布检查清单。",
  "Sonar and Code Review": "执行静态扫描与代码评审。",
  "AI Code Review": "AI 辅助代码评审。",
  "Postman and Test Script Generation": "生成接口测试集合与脚本。",
  "SQL Execution and Risk Check": "执行 SQL 并评估数据风险。",
  "Magento Release Risk Assessment": "评估 Magento 发布风险。",
  "Regression Testing": "执行回归测试，确认无引入缺陷。",
  "AB Validation and Branch Merge": "A/B 验证通过后合并分支。",
  "AI Technical Debt Quantification": "AI 量化技术债务规模。",
  "Service Monitoring": "上线后服务监控与告警观察。",
  "Generate Documentation": "基于需求与代码生成技术文档。",
}

export const ACTION_TYPE_LABELS = {
  manual: "手动",
  command: "命令",
  ai: "AI",
  heinrich: "海因里希",
  integration: "外部集成",
  custom: "自定义",
} as const

export const BRD_PROMPT_IDS = ["generate", "check", "summarize-sources"] as const

export const BRD_PROMPT_META = {
  generate: { name: "生成 BRD", description: "根据需求、规范与项目源摘要生成完整 BRD。" },
  check: { name: "检查 BRD", description: "检查已有 BRD 的完整性、可验收性与项目一致性。" },
  "summarize-sources": { name: "归纳项目源", description: "在生成 BRD 前提炼代码、产物与展示信息。" },
} as const

export const ACCENT = "#4f86c6"

function lookupLabel(map: Readonly<Record<string, string>>, key: string | null | undefined, fallback: string): string {
  if (!key) return fallback
  return map[key] ?? key
}

export function phaseLabel(phase: string | null | undefined): string {
  return lookupLabel(PHASE_LABELS, phase, "未知阶段")
}

export function statusLabel(status: string | null | undefined): string {
  return lookupLabel(STATUS_LABELS, status, "未知")
}

export function roleLabel(role: string | null | undefined): string {
  return lookupLabel(ROLE_LABELS, role, "未指定")
}

export function schedulerLabel(status: string | null | undefined): string {
  return lookupLabel(SCHEDULER_LABELS, status, "未知")
}

export function runStatusLabel(status: string | null | undefined): string {
  return lookupLabel(RUN_STATUS_LABELS, status, "未知")
}

export function nodeNameZh(node: { name?: string | null } | null | undefined): string {
  const name = node?.name ?? ""
  return NODE_NAME_ZH[name] ?? name
}

export function nodeDescZh(node: { name?: string | null; description?: string | null } | null | undefined): string {
  const name = node?.name ?? ""
  return NODE_DESC_ZH[name] ?? node?.description ?? "暂无说明"
}

export type ActionLike = {
  type?: string
  instructions?: string
  executable?: string
  args?: readonly string[]
  assistant?: string
  delta?: number
  level?: string
  service?: string
  name?: string
} | null | undefined

export function actionLabel(action: ActionLike): string {
  if (!action || typeof action !== "object") return "未知动作"
  const type = ACTION_TYPE_LABELS[action.type as keyof typeof ACTION_TYPE_LABELS] ?? action.type
  if (action.type === "manual") return action.instructions ? `手动：${action.instructions}` : "手动操作"
  if (action.type === "command") {
    const args = action.args || []
    return `命令：${action.executable || ""}${args.length ? ` ${args.join(" ")}` : ""}`.trim()
  }
  if (action.type === "ai") return `AI：${action.assistant || "未指定助手"}`
  if (action.type === "heinrich") {
    return `海因里希：Δ${action.delta ?? 1}${action.level ? ` / ${action.level}` : ""}`
  }
  if (action.type === "integration") return `集成：${action.service || action.name || ""}`
  if (action.type === "custom") return `自定义：${action.name || ""}`
  return type || "未知动作"
}

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&#39;"
      default:
        return char
    }
  })
}

export function truncate(text: unknown, max: number): string {
  const value = String(text || "")
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
