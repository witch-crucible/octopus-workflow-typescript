// 渲染进程只通过 preload / 浏览器 API 获取状态；图形使用原生 SVG，避免离线依赖。

const projectsEl = document.getElementById("projects")
const graphEl = document.getElementById("graph")
const graphScalerEl = document.getElementById("graphScaler")
const graphWrapEl = document.getElementById("graphWrap")
const graphFullscreenRootEl = document.getElementById("graphFullscreenRoot")
const summaryEl = document.getElementById("summary")
const detailsEl = document.getElementById("details")
const emptyEl = document.getElementById("empty")
const statusEl = document.getElementById("workflowStatus")
const projectLabelEl = document.getElementById("projectLabel")
const flowHintEl = document.getElementById("flowHint")
const zoomLabelEl = document.getElementById("zoomLabel")
const roleLegendEl = document.getElementById("roleLegend")
const nodeLocatorEl = document.getElementById("nodeLocator")
const themeToggleEl = document.getElementById("themeToggle")
const fullscreenGraphEl = document.getElementById("fullscreenGraph")
const hubViewEl = document.getElementById("hubView")
const projectViewEl = document.getElementById("projectView")
const workspaceViewEl = document.getElementById("workspaceView")
const hubCardsEl = document.getElementById("hubCards")
const hubEmptyEl = document.getElementById("hubEmpty")
const hubFilterEl = document.getElementById("hubFilter")
const requirementCardsEl = document.getElementById("requirementCards")
const projectEmptyEl = document.getElementById("projectEmpty")
const projectFilterEl = document.getElementById("projectFilter")
const projectPageTitleEl = document.getElementById("projectPageTitle")
const backToHubEl = document.getElementById("backToHub")
const backToProjectEl = document.getElementById("backToProject")
const sidebarToHubEl = document.getElementById("sidebarToHub")
const sidebarToProjectEl = document.getElementById("sidebarToProject")
const toggleSidebarEl = document.getElementById("toggleSidebar")
const toggleInspectorEl = document.getElementById("toggleInspector")
const viewPulseEl = document.getElementById("viewPulse")
const viewSubtitleEl = document.getElementById("viewSubtitle")
const graphPaneEl = document.getElementById("graphPane")
const hubGanttParkEl = document.getElementById("hubGanttPark")
const hubGanttHostEl = document.getElementById("hubGanttHost")
const projectGanttHostEl = document.getElementById("projectGanttHost")
const requirementTbLabelEl = document.getElementById("requirementTbLabel")
const requirementVersionLabelEl = document.getElementById("requirementVersionLabel")
const requirementVersionSelectEl = document.getElementById("requirementVersionSelect")
const tbTaskRefEl = document.getElementById("tbTaskRef")
const tbStatusSelectEl = document.getElementById("tbStatusSelect")
const tbBindInfoEl = document.getElementById("tbBindInfo")
const tbStatusListEl = document.getElementById("tbStatusList")
const milestoneChipsEl = document.getElementById("milestoneChips")
const milestoneFormEl = document.getElementById("milestoneForm")
const milestoneEditIdEl = document.getElementById("milestoneEditId")
const milestoneNameEl = document.getElementById("milestoneName")
const milestoneDateEl = document.getElementById("milestoneDate")
const milestonePhaseEl = document.getElementById("milestonePhase")
const milestoneNodeEl = document.getElementById("milestoneNode")
const milestoneNoteEl = document.getElementById("milestoneNote")
const toggleReachedMilestonesEl = document.getElementById("toggleReachedMilestones")
const addMilestoneEl = document.getElementById("addMilestone")
const reachMilestoneEl = document.getElementById("reachMilestone")
const unreachMilestoneEl = document.getElementById("unreachMilestone")
const deleteMilestoneEl = document.getElementById("deleteMilestone")
const cancelMilestoneEl = document.getElementById("cancelMilestone")

let selectedRequirement
let selectedProjectId
let selectedNode
let currentState
let currentSnapshot
let currentStatus
let currentRuns = []
let currentView = "hub"
let hubFilter = ""
let projectFilter = ""
let lastCreatedProjectId = ""
let lastCreatedRequirementId = ""
let projectSummaries = []
let requirementSummaries = []
let currentProject = null
let currentGraphNodes = []
let cardStatusesCache = []
const requirementMeta = new Map()
/** 流程图缩放比例（宽屏默认放大，避免文字过小发糊；窄屏自动降低） */
let graphZoom = window.innerWidth < 900 ? 1 : 1.4
/** 上次自动滚入视口的当前节点集合签名，避免轮询刷新打断用户滚动 */
let lastScrolledCurrentKey = ""
/** 项目页当前展开排期的需求；空字符串表示未展开 */
let projectTab = "board"
let projectTableSort = { key: "phase", dir: "asc" }
let brdPromptConfig = {}
let brdPromptDrafts = {}
let brdPromptClearIds = new Set()
let expandedScheduleId = ""
/** 日志监控页筛选与选中状态 */
let logsFilterRequirementId = ""
let logsFilterNodeId = ""
let logsFilterStatus = ""
let logsSelectedRequirementId = ""
let logsSelectedRunId = ""
let logsDetailTab = "stdout"
let logsAutoRefresh = false
let logsPollTimer = null
let logsPendingFocus = null
let logsLoadedEvents = []
let logsSlice = null
let logsRenderToken = 0
let hubGanttSelectedNode = ""
let hubGanttState
let hubGanttMounted = false
let projectGanttMounted = false
let projectGanttSelectedReq = ""
let workspaceMilestones = []
let showReachedMilestones = false
/** 泳道图画布拖拽平移状态 */
let graphPan = null
/** 工作台左右栏收起状态 */
let sidebarCollapsed = false
let inspectorCollapsed = false

const THEME_STORAGE_KEY = "octopus.ui.theme"
const PANEL_STORAGE_KEY = "octopus.ui.workspacePanels"
const ACCENT = "#4f86c6"

const BRD_PROMPT_IDS = ["generate", "check", "summarize-sources"]
const BRD_PROMPT_META = {
  generate: { name: "生成 BRD", description: "根据需求、规范与项目源摘要生成完整 BRD。" },
  check: { name: "检查 BRD", description: "检查已有 BRD 的完整性、可验收性与项目一致性。" },
  "summarize-sources": { name: "归纳项目源", description: "在生成 BRD 前提炼代码、产物与展示信息。" },
}

function collectBrdPromptPatch(drafts, clearedIds) {
  const prompts = {}
  for (const id of BRD_PROMPT_IDS) {
    if (clearedIds.includes(id)) {
      prompts[id] = null
      continue
    }
    const draft = drafts[id]
    if (!draft) continue
    const hasSystem = draft.system.trim() !== ""
    const hasUser = draft.user.trim() !== ""
    if (!hasSystem || !hasUser) return { prompts, invalid: { id, hasSystem, hasUser } }
    prompts[id] = draft
  }
  return { prompts }
}

/** 阶段顺序 */
const PHASE_ORDER = [
  "Intention",
  "Research",
  "Design",
  "Implementation",
  "Testing",
  "UAT",
  "Release",
  "Maintenance",
  "Completed",
]

/** 角色泳道顺序 */
const ROLE_ORDER = ["PM", "BA", "SA", "AI", "DEV", "QA", "OP", "HEI"]

/** 角色色条（贴近 Element Plus 语义色） */
const ROLE_COLORS = {
  PM: "#4f86c6",
  BA: "#67c23a",
  SA: "#36cfc9",
  AI: "#7b8fa8",
  DEV: "#e6a23c",
  QA: "#f56c6c",
  OP: "#909399",
  HEI: "#c45656",
}

/** 阶段中文名 */
const PHASE_LABELS = {
  Intention: "意向",
  Research: "调研",
  Design: "设计",
  Implementation: "实现",
  Testing: "测试",
  UAT: "UAT",
  Release: "发布",
  Maintenance: "维护",
  Completed: "完结",
}

/** 阶段说明 */
const PHASE_HINTS = {
  Intention: "立项意向与 BRD 初稿",
  Research: "可行性、工期与成本调研",
  Design: "排期、对齐与技术设计",
  Implementation: "开发实现与联调",
  Testing: "功能与性能测试",
  UAT: "用户验收与发布计划",
  Release: "发布、合并与上线检查",
  Maintenance: "监控与技术债务",
  Completed: "项目已收尾",
}

/** 节点状态中文名 */
const STATUS_LABELS = {
  LOCKED: "未激活",
  PENDING: "待处理",
  IN_PROGRESS: "进行中",
  COMPLETED: "已完成",
  BLOCKED: "已阻塞",
  SKIPPED: "已跳过",
}

/** 调度器状态中文名 */
const SCHEDULER_LABELS = {
  IDLE: "空闲",
  RUNNING: "运行中",
  PAUSED: "已暂停",
  COMPLETED: "已完成",
  BLOCKED: "已阻塞",
}

/** 角色中文名 */
const ROLE_LABELS = {
  PM: "产品经理",
  BA: "业务分析",
  SA: "系统架构",
  AI: "AI 助手",
  DEV: "开发",
  QA: "测试",
  OP: "运维",
  HEI: "海因里希审计",
}

/** 运行记录状态中文名 */
const RUN_STATUS_LABELS = {
  QUEUED: "排队中",
  RUNNING: "执行中",
  SUCCEEDED: "成功",
  FAILED: "失败",
  CANCELED: "已取消",
  TIMED_OUT: "超时",
  INTERRUPTED: "已中断",
}

/** 内置节点中文名称（按英文 name 匹配） */
const NODE_NAME_ZH = {
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

/** 内置节点中文说明（按英文 name 匹配；无匹配时回退 description） */
const NODE_DESC_ZH = {
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

const ACTION_TYPE_LABELS = {
  manual: "手动",
  command: "命令",
  ai: "AI",
  heinrich: "海因里希",
  integration: "外部集成",
  custom: "自定义",
}

function phaseLabel(phase) {
  return PHASE_LABELS[phase] || phase || "未知阶段"
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未知"
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role || "未指定"
}

function schedulerLabel(status) {
  return SCHEDULER_LABELS[status] || status || "未知"
}

function runStatusLabel(status) {
  return RUN_STATUS_LABELS[status] || status || "未知"
}

function nodeNameZh(node) {
  return NODE_NAME_ZH[node.name] || node.name
}

function nodeDescZh(node) {
  return NODE_DESC_ZH[node.name] || node.description || "暂无说明"
}

function actionLabel(action) {
  if (!action || typeof action !== "object") return "未知动作"
  const type = ACTION_TYPE_LABELS[action.type] || action.type
  if (action.type === "manual") return action.instructions ? `手动：${action.instructions}` : "手动操作"
  if (action.type === "command") return `命令：${action.executable || ""}${(action.args || []).length ? " " + action.args.join(" ") : ""}`.trim()
  if (action.type === "ai") return `AI：${action.assistant || "未指定助手"}`
  if (action.type === "heinrich") return `海因里希：Δ${action.delta ?? 1}${action.level ? ` / ${action.level}` : ""}`
  if (action.type === "integration") return `集成：${action.service || action.name || ""}`
  if (action.type === "custom") return `自定义：${action.name || ""}`
  return type
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char])
}

function truncate(text, max) {
  const value = String(text || "")
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function nodeDisplayState(node) {
  if (node.activated === false || node.status === "LOCKED") return "locked"
  const classes = []
  if (currentSnapshot?.currentNodeIds?.includes(node.id)) classes.push("current")
  if (currentSnapshot?.readyNodeIds?.includes(node.id)) classes.push("ready")
  else if (currentSnapshot?.waitingNodeIds?.includes(node.id) && node.status === "PENDING") classes.push("waiting")
  else classes.push(String(node.status || "PENDING").toLowerCase())
  return classes.join(" ")
}

function isCurrentNode(nodeId) {
  return Boolean(currentSnapshot?.currentNodeIds?.includes(nodeId))
}

function findNodeName(nodeId) {
  const node = currentGraphNodes.find((step) => step.id === nodeId)
  return node ? nodeNameZh(node) : nodeId
}

function nodeRoles(node) {
  const roles = Array.isArray(node?.responsibleRoles) && node.responsibleRoles.length
    ? node.responsibleRoles
    : [node?.responsibleRole || "DEV"]
  return [...new Set(roles.filter(Boolean))]
}

function buildWorkflowGraphNodes(state, definition) {
  const runtimeNodes = state?.steps || []
  if (!Array.isArray(definition?.nodes) || !definition.nodeIdMapping) {
    return runtimeNodes.map((node) => ({
      ...node,
      responsibleRoles: nodeRoles(node),
      activated: true,
    }))
  }

  const runtimeById = new Map(runtimeNodes.map((node) => [node.id, node]))
  const nodes = definition.nodes.flatMap((spec) => {
    const id = definition.nodeIdMapping[spec.key]
    if (!id) return []
    const runtime = runtimeById.get(id)
    const responsibleRoles = nodeRoles(spec)
    return [{
      ...runtime,
      id,
      key: spec.key,
      phase: spec.phase,
      name: spec.name,
      description: spec.description,
      responsibleRole: responsibleRoles[0] || runtime?.responsibleRole || "DEV",
      responsibleRoles,
      dependsOn: spec.dependsOn.map((key) => definition.nodeIdMapping[key]).filter(Boolean),
      actions: runtime?.actions || spec.actions || [],
      status: runtime?.status || "LOCKED",
      activated: Boolean(runtime),
    }]
  })

  const knownIds = new Set(nodes.map((node) => node.id))
  for (const runtime of runtimeNodes) {
    if (knownIds.has(runtime.id)) continue
    nodes.push({
      ...runtime,
      responsibleRoles: nodeRoles(runtime),
      activated: true,
    })
  }
  return nodes
}

function preferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    if (saved === "light" || saved === "dark") return saved
  } catch {
    // ignore storage errors（隐私模式等）
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function applyTheme(theme) {
  const next = theme === "dark" ? "dark" : "light"
  document.documentElement.setAttribute("data-theme", next)
  document.documentElement.style.colorScheme = next
  if (themeToggleEl) {
    themeToggleEl.textContent = next === "dark" ? "☀" : "☾"
    themeToggleEl.setAttribute("aria-pressed", next === "dark" ? "true" : "false")
    themeToggleEl.title = next === "dark" ? "切换为白昼主题" : "切换为黑夜主题"
    themeToggleEl.setAttribute("aria-label", themeToggleEl.title)
  }
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next)
  } catch {
    // ignore
  }
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"
  applyTheme(current === "dark" ? "light" : "dark")
}

function preferredWorkspacePanels() {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY)
    if (!raw) return { sidebarCollapsed: false, inspectorCollapsed: false }
    const parsed = JSON.parse(raw)
    return {
      sidebarCollapsed: Boolean(parsed?.sidebarCollapsed),
      inspectorCollapsed: Boolean(parsed?.inspectorCollapsed),
    }
  } catch {
    return { sidebarCollapsed: false, inspectorCollapsed: false }
  }
}

function persistWorkspacePanels() {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({
      sidebarCollapsed,
      inspectorCollapsed,
    }))
  } catch {
    // ignore storage errors
  }
}

function syncWorkspacePanelButtons() {
  if (workspaceViewEl) {
    workspaceViewEl.classList.toggle("sidebar-collapsed", sidebarCollapsed)
    workspaceViewEl.classList.toggle("inspector-collapsed", inspectorCollapsed)
  }
  if (toggleSidebarEl) {
    toggleSidebarEl.setAttribute("aria-pressed", sidebarCollapsed ? "true" : "false")
    toggleSidebarEl.textContent = sidebarCollapsed ? "›" : "‹"
    toggleSidebarEl.title = sidebarCollapsed ? "展开左侧需求栏" : "收起左侧需求栏"
    toggleSidebarEl.setAttribute("aria-label", toggleSidebarEl.title)
  }
  if (toggleInspectorEl) {
    toggleInspectorEl.setAttribute("aria-pressed", inspectorCollapsed ? "true" : "false")
    toggleInspectorEl.textContent = inspectorCollapsed ? "‹" : "›"
    toggleInspectorEl.title = inspectorCollapsed ? "展开右侧详情栏" : "收起右侧详情栏"
    toggleInspectorEl.setAttribute("aria-label", toggleInspectorEl.title)
  }
}

function setWorkspacePanel(side, collapsed) {
  if (side === "sidebar") sidebarCollapsed = Boolean(collapsed)
  else inspectorCollapsed = Boolean(collapsed)
  syncWorkspacePanelButtons()
  persistWorkspacePanels()
}

function toggleWorkspacePanel(side) {
  if (side === "sidebar") setWorkspacePanel("sidebar", !sidebarCollapsed)
  else setWorkspacePanel("inspector", !inspectorCollapsed)
}

function isNativeFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement)
}

function isCssFullscreen() {
  return Boolean(graphFullscreenRootEl?.classList.contains("is-expanded"))
}

function isGraphFullscreen() {
  return isNativeFullscreen() || isCssFullscreen()
}

function setCssFullscreen(active) {
  if (!graphFullscreenRootEl) return
  graphFullscreenRootEl.classList.toggle("is-expanded", active)
  document.body.classList.toggle("graph-expanded", active)
}

function syncFullscreenButton() {
  if (!fullscreenGraphEl) return
  const active = isGraphFullscreen()
  fullscreenGraphEl.setAttribute("aria-pressed", active ? "true" : "false")
  fullscreenGraphEl.textContent = active ? "⛶ 退出全屏" : "⛶ 全屏"
  fullscreenGraphEl.title = active ? "退出全屏（Esc）" : "全屏查看泳道图"
}

async function toggleGraphFullscreen() {
  const target = graphFullscreenRootEl || graphWrapEl
  if (!target) return
  try {
    if (isNativeFullscreen()) {
      if (document.exitFullscreen) await document.exitFullscreen()
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen()
      setCssFullscreen(false)
    } else if (isCssFullscreen()) {
      setCssFullscreen(false)
    } else {
      try {
        if (target.requestFullscreen) await target.requestFullscreen()
        else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen()
        else setCssFullscreen(true)
      } catch {
        // 浏览器拒绝 Fullscreen API 时回退为 CSS 铺满
        setCssFullscreen(true)
      }
    }
  } catch (error) {
    showError(error)
  } finally {
    syncFullscreenButton()
  }
}

function scrollCurrentNodeIntoView() {
  if (!graphWrapEl || !graphEl || graphPan) return
  const currentGroup = graphEl.querySelector(".node.current")
  if (!currentGroup) return
  const transform = currentGroup.getAttribute("transform") || ""
  const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transform)
  if (!match) return
  const x = Number(match[1]) * graphZoom
  const y = Number(match[2]) * graphZoom
  const pad = 48
  const viewLeft = graphWrapEl.scrollLeft
  const viewTop = graphWrapEl.scrollTop
  const viewRight = viewLeft + graphWrapEl.clientWidth
  const viewBottom = viewTop + graphWrapEl.clientHeight
  if (x < viewLeft + pad || x > viewRight - pad) {
    graphWrapEl.scrollLeft = Math.max(0, x - graphWrapEl.clientWidth / 3)
  }
  if (y < viewTop + pad || y > viewBottom - pad) {
    graphWrapEl.scrollTop = Math.max(0, y - graphWrapEl.clientHeight / 3)
  }
}

function canStartGraphPan(event) {
  if (!graphWrapEl) return false
  if (event.button === 1) return true
  if (event.button !== 0) return false
  const target = event.target
  if (!(target instanceof Element)) return true
  if (target.closest(".node")) return false
  if (target.closest("button, a, input, textarea, select, label")) return false
  return true
}

function endGraphPan() {
  if (!graphPan) return
  const active = graphPan
  graphPan = null
  graphWrapEl?.classList.remove("is-panning")
  window.removeEventListener("pointermove", active.onMove)
  window.removeEventListener("pointerup", active.onUp)
  window.removeEventListener("pointercancel", active.onUp)
}

function setupGraphPan() {
  if (!graphWrapEl) return

  graphWrapEl.addEventListener("pointerdown", (event) => {
    if (!canStartGraphPan(event)) return
    if (graphPan) endGraphPan()
    event.preventDefault()

    const onMove = (moveEvent) => {
      if (!graphPan || moveEvent.pointerId !== graphPan.pointerId) return
      const dx = moveEvent.clientX - graphPan.x
      const dy = moveEvent.clientY - graphPan.y
      if (!graphPan.moved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) graphPan.moved = true
      graphWrapEl.scrollLeft = graphPan.scrollLeft - dx
      graphWrapEl.scrollTop = graphPan.scrollTop - dy
      moveEvent.preventDefault()
    }
    const onUp = (upEvent) => {
      if (!graphPan || upEvent.pointerId !== graphPan.pointerId) return
      endGraphPan()
    }

    graphPan = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: graphWrapEl.scrollLeft,
      scrollTop: graphWrapEl.scrollTop,
      moved: false,
      onMove,
      onUp,
    }
    graphWrapEl.classList.add("is-panning")
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  })

  // 中键点击默认会触发自动滚动，禁用以保留拖拽平移
  graphWrapEl.addEventListener("auxclick", (event) => {
    if (event.button === 1) event.preventDefault()
  })
  graphWrapEl.addEventListener("dragstart", (event) => event.preventDefault())
}

function routeFromHash() {
  const raw = location.hash.replace(/^#/, "")
  if (raw === "hub" || raw === "" || raw === "/") return { view: "hub" }
  if (raw === "hub/mine") return { view: "mine" }
  const projectTabMatch = /^project\/([^/]+)\/(board|list|table|gantt|versions|logs|overview|settings)$/.exec(raw)
  if (projectTabMatch) {
    const requestedTab = projectTabMatch[2] === "list" ? "table" : projectTabMatch[2]
    if (projectTabMatch[2] === "list") {
      const canonical = `project/${encodeURIComponent(decodeURIComponent(projectTabMatch[1]))}/table`
      if (typeof history !== "undefined" && location.hash !== `#${canonical}`) history.replaceState(null, "", `#${canonical}`)
    }
    return {
      view: "project",
      projectId: decodeURIComponent(projectTabMatch[1]),
      projectTab: typeof history === "undefined" && projectTabMatch[2] === "list" ? "list" : requestedTab,
    }
  }
  const projectMatch = /^project\/([^/]+)$/.exec(raw)
  if (projectMatch) {
    return { view: "project", projectId: decodeURIComponent(projectMatch[1]), projectTab: "board" }
  }
  const requirementMatch = /^requirement\/([^/]+)$/.exec(raw)
  if (requirementMatch) {
    return {
      view: "workspace",
      requirementId: decodeURIComponent(requirementMatch[1]),
    }
  }
  return { view: "hub" }
}

function setHash(hash, replace) {
  const next = hash.startsWith("#") ? hash : `#${hash}`
  if (replace) history.replaceState(null, "", next)
  else if (location.hash !== next) location.hash = next
}

function goToHub() {
  setHash("hub")
}

function goToProject(projectId, tab) {
  const suffix = tab && tab !== "board" ? `/${tab}` : ""
  setHash(`project/${encodeURIComponent(projectId)}${suffix}`)
}

function goToRequirement(requirementId) {
  setHash(`requirement/${encodeURIComponent(requirementId)}`)
}

function setWorkspaceChrome() {
  if (graphPaneEl) graphPaneEl.hidden = false
  if (viewPulseEl) viewPulseEl.textContent = "实时监控"
  if (viewSubtitleEl) viewSubtitleEl.textContent = "软件交付工作流 · 角色泳道图"
  document.title = "Octopus Workflow · 需求工作区"
}

function ganttLabels() {
  return {
    phaseOrder: PHASE_ORDER,
    phaseLabel,
    roleLabel,
    statusLabel,
    nodeName: nodeNameZh,
  }
}

function parkHubGantt() {
  if (hubGanttHostEl && hubGanttParkEl && hubGanttHostEl.parentElement !== hubGanttParkEl) {
    hubGanttParkEl.appendChild(hubGanttHostEl)
  }
  if (hubGanttHostEl) hubGanttHostEl.hidden = true
}

function collapseHubSchedule() {
  expandedScheduleId = ""
  hubGanttSelectedNode = ""
  hubGanttState = undefined
  parkHubGantt()
}

function ensureHubGanttMounted() {
  if (hubGanttMounted || !hubGanttHostEl || !window.OctopusGantt) return
  window.OctopusGantt.mount(hubGanttHostEl, {
    onSelectNode: (nodeId) => {
      hubGanttSelectedNode = nodeId
      renderHubGantt()
    },
    onSchedule: (id, schedule, kind) => {
      if (kind === "milestone") {
        window.octopus.updateMilestone(expandedScheduleId, id, { date: schedule.date })
          .then(async () => {
            statusEl.textContent = "里程碑日期已保存"
            statusEl.className = "badge good"
            await loadRequirementSummaries(selectedProjectId)
            renderProjectPage()
            await loadHubGantt(expandedScheduleId)
          })
          .catch(showError)
        return
      }
      updateHubNodeSchedule(id, schedule).catch(showError)
    },
    onReach: (requirementId, milestoneId) => {
      window.octopus.reachMilestone(requirementId, milestoneId)
        .then(async () => {
          statusEl.textContent = "里程碑已达成"
          statusEl.className = "badge good"
          await loadRequirementSummaries(selectedProjectId)
          renderProjectPage()
          await loadHubGantt(requirementId)
        })
        .catch(showError)
    },
    onSelectMilestone: (milestoneId) => {
      if (!hubGanttState?.milestones) return
      const m = hubGanttState.milestones.find((item) => item.id === milestoneId)
      if (m) openWorkspace(expandedScheduleId).then(() => openMilestoneForm(m))
    },
    onAddMilestone: () => {
      openWorkspace(expandedScheduleId).then(() => openMilestoneForm())
    },
    onError: (message) => {
      statusEl.textContent = message
      statusEl.className = "badge warn"
    },
  })
  hubGanttMounted = true
}

function renderHubGantt() {
  if (!window.OctopusGantt || !hubGanttState) return
  ensureHubGanttMounted()
  window.OctopusGantt.render({
    steps: hubGanttState.steps || [],
    runs: hubGanttState.runs || [],
    snapshot: hubGanttState.snapshot || {},
    selectedNodeId: hubGanttSelectedNode,
    labels: ganttLabels(),
    milestones: hubGanttState.milestones || [],
    requirementId: hubGanttState.requirementId || "",
  })
}

async function loadHubGantt(requirementId) {
  if (!requirementId) return
  if (window.OctopusGantt?.isDragging?.()) return
  const state = await window.octopus.getState(requirementId)
  let snapshot = {}
  try {
    snapshot = await window.octopus.getExecutionSnapshot(requirementId)
  } catch {
    snapshot = {}
  }
  let runs = []
  try {
    runs = await window.octopus.runs(requirementId)
  } catch {
    runs = []
  }
  if (expandedScheduleId !== requirementId) return
  hubGanttState = {
    requirementId,
    steps: state.steps || [],
    snapshot,
    runs,
    milestones: state.milestones || [],
  }
  renderHubGantt()
}

function parkProjectGantt() {
  if (projectGanttHostEl) projectGanttHostEl.hidden = true
}

function unmountProjectGantt() {
  if (projectGanttMounted && window.OctopusGantt) {
    window.OctopusGantt.unmount()
  }
  projectGanttMounted = false
  projectGanttSelectedReq = ""
}

function ensureProjectGanttMounted() {
  if (projectGanttMounted || !projectGanttHostEl || !window.OctopusGantt) return
  projectGanttHostEl.hidden = false
  window.OctopusGantt.mount(projectGanttHostEl, {
    onSelectNode: (nodeId) => {
      const req = requirementSummaries.find((item) => {
        return currentState?.steps?.some((step) => step.id === nodeId)
      })
      if (req) goToRequirement(req.requirementId)
    },
    onSelectRequirement: (reqId) => {
      goToRequirement(reqId)
    },
    onSchedule: (id, schedule, kind) => {
      if (kind === "requirement") {
        window.octopus.updateRequirementSchedule(id, schedule)
          .then(async () => {
            statusEl.textContent = schedule.plannedStart ? "需求排期已保存" : "已清除需求排期"
            statusEl.className = "badge good"
            await loadRequirementSummaries(selectedProjectId)
            renderProjectGantt()
          })
          .catch(showError)
      } else {
        const req = requirementSummaries.find((item) => item.requirementId === id || item.steps?.some?.((s) => s.id === id))
        const reqId = req?.requirementId || selectedRequirement || ""
        if (reqId && window.octopus.updateNodeSchedule) {
          window.octopus.updateNodeSchedule(reqId, id, schedule)
            .then(async () => {
              statusEl.textContent = schedule.plannedStart ? "节点排期已保存" : "已清除节点排期"
              statusEl.className = "badge good"
              await loadRequirementSummaries(selectedProjectId)
              renderProjectGantt()
            })
            .catch(showError)
        }
      }
    },
    onExportOmniPlan: () => {
      if (!selectedProjectId) return
      window.octopus.exportProjectOmniPlan(selectedProjectId)
        .then(async (result) => {
          statusEl.textContent = `已导出：${result.path}`
          statusEl.className = "badge good"
        })
        .catch(showError)
    },
    onImportOmniPlan: async () => {
      if (!selectedProjectId) return
      if (!await confirmAction("导入 OmniPlan 将合并日期到当前项目的需求和节点。\n继续？", "导入 OmniPlan")) return
      window.octopus.importProjectOmniPlan(selectedProjectId)
        .then(async (result) => {
          const parts = []
          if (result.updatedRequirements) parts.push(`${result.updatedRequirements} 个需求`)
          if (result.updatedNodes) parts.push(`${result.updatedNodes} 个节点`)
          if (result.unmatched?.length) parts.push(`${result.unmatched.length} 个未匹配`)
          statusEl.textContent = parts.length ? `已导入：${parts.join("、")}` : "导入完成（无变更）"
          statusEl.className = "badge good"
          await loadRequirementSummaries(selectedProjectId)
          renderProjectGantt()
        })
        .catch(showError)
    },
    onAddMilestone: () => {},
    onSelectMilestone: () => {},
    onReach: () => {},
    onError: (message) => {
      statusEl.textContent = message
      statusEl.className = "badge warn"
    },
  })
  projectGanttMounted = true
}

async function renderProjectGantt() {
  if (!projectGanttMounted || !projectGanttHostEl || projectGanttHostEl.hidden) return
  if (window.OctopusGantt?.isDragging?.()) return
  await loadRequirementSummaries(selectedProjectId)
  const requirements = []
  for (const item of requirementSummaries) {
    let steps = []
    try {
      const state = await window.octopus.getState(item.requirementId)
      steps = (state.steps || []).map((step) => ({
        id: step.id,
        name: step.name || step.id,
        phase: step.phase,
        plannedStart: step.plannedStart,
        plannedEnd: step.plannedEnd,
        status: step.status,
        responsibleRole: step.responsibleRole || "",
        dependsOn: step.dependsOn || [],
      }))
    } catch {
      steps = []
    }
    requirements.push({
      id: item.requirementId,
      name: item.requirementName || item.requirementId,
      phase: item.currentPhase || "",
      plannedStart: item.plannedStart,
      plannedEnd: item.plannedEnd,
      statusLabel: phaseLabel(item.currentPhase),
      progress: item.totalTasks ? (item.completedTasks || 0) / item.totalTasks : 0,
      teambitionStatusName: item.teambitionStatusName || "",
      steps,
    })
  }
  ensureProjectGanttMounted()
  window.OctopusGantt.render({
    mode: "requirements",
    requirements,
    selectedId: projectGanttSelectedReq,
    labels: {
      phaseOrder: PHASE_ORDER,
      phaseLabel,
      roleLabel,
      statusLabel,
      nodeName: nodeNameZh,
    },
  })
}

async function loadProjectGanttData() {
  if (!selectedProjectId) return
  if (window.OctopusGantt?.isDragging?.()) return
  await renderProjectGantt()
}

async function updateHubNodeSchedule(nodeId, schedule) {
  if (!expandedScheduleId || !window.octopus.updateNodeSchedule) return
  await window.octopus.updateNodeSchedule(expandedScheduleId, nodeId, schedule)
  statusEl.textContent = schedule.plannedStart ? "排期已保存" : "已清除排期"
  statusEl.className = "badge good"
  await loadRequirementSummaries(selectedProjectId)
  renderProjectPage()
  await loadHubGantt(expandedScheduleId)
}

async function toggleHubSchedule(requirementId) {
  if (expandedScheduleId === requirementId) {
    collapseHubSchedule()
    renderProjectPage()
    return
  }
  expandedScheduleId = requirementId
  hubGanttSelectedNode = ""
  hubGanttState = undefined
  if (window.OctopusGantt?.setUiState) {
    window.OctopusGantt.setUiState({ collapsed: [], scrollLeft: 0, scrollTop: 0 })
  }
  renderProjectPage()
  await loadHubGantt(requirementId)
}

function setChrome(view) {
  currentView = view
  if (hubViewEl) hubViewEl.hidden = view !== "hub"
  if (projectViewEl) projectViewEl.hidden = view !== "project"
  if (workspaceViewEl) workspaceViewEl.hidden = view !== "workspace"
  if (backToHubEl) backToHubEl.hidden = view === "hub"
  if (backToProjectEl) backToProjectEl.hidden = view !== "workspace"
  if (view === "hub") {
    if (viewPulseEl) viewPulseEl.textContent = "项目管理"
    if (viewSubtitleEl) viewSubtitleEl.textContent = "统一管理状态库中的项目"
    document.title = "Octopus Workflow · 项目管理中心"
  } else if (view === "project") {
    if (viewPulseEl) viewPulseEl.textContent = "需求管理"
    if (viewSubtitleEl) viewSubtitleEl.textContent = "看板 · 列表 · 甘特 · 设置"
    document.title = "Octopus Workflow · 项目需求"
  } else {
    setWorkspaceChrome()
  }
}

function formatUpdatedAt(value) {
  if (!value) return ""
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN")
}

function readableError(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/未配置 Teambition|integrations\.teambition|凭据/.test(message)) {
    return message.includes("未配置") ? message : `未配置 Teambition 凭据：${message}`
  }
  return message
}

async function loadProjectSummaries() {
  projectSummaries = await window.octopus.listProjectSummaries()
}

async function loadRequirementSummaries(projectId) {
  requirementSummaries = projectId
    ? await window.octopus.listRequirementSummaries(projectId)
    : []
  for (const item of requirementSummaries) {
    requirementMeta.set(item.requirementId, {
      requirementName: item.requirementName,
      currentPhase: item.currentPhase,
      projectId: item.projectId,
    })
  }
}

function renderSidebar(selectId) {
  projectsEl.innerHTML = ""
  if (!requirementSummaries.length) {
    projectsEl.innerHTML = `<div class="empty-state">暂无需求。请返回项目页创建。</div>`
    return
  }
  for (const item of requirementSummaries) {
    const div = document.createElement("div")
    div.className = `project${item.requirementId === selectId ? " active" : ""}`
    div.dataset.requirementId = item.requirementId
    div.innerHTML = `<div class="name">${escapeHtml(item.requirementName || item.requirementId)}</div><div class="meta">${escapeHtml(item.requirementId)}${item.currentPhase ? ` · ${escapeHtml(phaseLabel(item.currentPhase))}` : ""}</div>`
    div.onclick = () => goToRequirement(item.requirementId)
    projectsEl.appendChild(div)
  }
}

/** 将项目摘要列表纯变换为中心页卡片墙 HTML（空 / 无匹配 / 卡片网格）。 */
function buildHubCardsMarkup(items, options = {}) {
  const filter = String(options.filter || "")
  const createdId = options.lastCreatedId || ""
  const query = filter.trim().toLowerCase()
  const filtered = items.filter((item) => {
    if (!query) return true
    return [item.name, item.projectId, item.description]
      .some((field) => String(field || "").toLowerCase().includes(query))
  })
  if (!items.length) {
    return { kind: "empty", filtered, html: "" }
  }
  if (!filtered.length) {
    return {
      kind: "nomatch",
      filtered,
      html: `<div class="empty-state">没有匹配「${escapeHtml(filter)}」的项目</div>`,
    }
  }
  const html = filtered.map((item) => `
    <article class="hub-card${item.projectId === createdId ? " highlight" : ""}" data-project-id="${escapeHtml(item.projectId)}">
      <div class="name">${escapeHtml(item.name || item.projectId)}</div>
      <p class="desc">${escapeHtml(item.description || "暂无描述")}</p>
      <div class="progress">需求 ${item.requirementCount ?? 0} 个</div>
      ${item.teambitionProjectId
        ? `<span class="tb-badge">已绑定 TB · ${escapeHtml(item.teambitionProjectId)}</span>`
        : `<span class="tb-badge unbound">未绑定 Teambition</span>`}
      <div class="meta">${escapeHtml(item.projectId)}${item.updatedAt ? `<br />更新于 ${escapeHtml(formatUpdatedAt(item.updatedAt))}` : ""}</div>
      <div class="hub-card-edit" hidden>
        <input class="edit-name" value="${escapeHtml(item.name || "")}" placeholder="项目名称" />
        <input class="edit-desc" value="${escapeHtml(item.description || "")}" placeholder="项目描述" />
        <div class="hub-card-actions">
          <button type="button" data-save>保存</button>
          <button type="button" class="secondary" data-cancel-edit>取消</button>
        </div>
      </div>
      <div class="hub-card-actions hub-card-main-actions">
        <button type="button" data-open>打开项目</button>
        <button type="button" class="secondary" data-edit>编辑</button>
        <button type="button" class="danger" data-delete>删除</button>
      </div>
    </article>
  `).join("")
  return { kind: "cards", filtered, html }
}

function formatMilestoneDate(value) {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""))
  return matched ? `${matched[2]}-${matched[3]}` : String(value || "")
}

function milestoneBadgeHtml(item) {
  if (!item.milestoneCount) return ""
  if (item.nextMilestone) {
    const overdue = item.nextMilestone.overdue ? " is-overdue" : ""
    return `<span class="ms-badge${overdue}">里程碑 ${escapeHtml(formatMilestoneDate(item.nextMilestone.date))} ${escapeHtml(item.nextMilestone.name)}</span>`
  }
  return `<span class="ms-badge is-done">里程碑已全部达成</span>`
}

function versionBadgeHtml(item) {
  if (!item.teambitionVersionId && !item.teambitionVersionName) return ""
  const stale = item.teambitionVersionStale ? " unbound" : ""
  return `<span class="tb-badge${stale}">版本 · ${escapeHtml(item.teambitionVersionName || item.teambitionVersionId)}${item.teambitionVersionStale ? "（已失效）" : ""}</span>`
}

function buildKanbanMarkup(items, options = {}) {
  const versionBadge = (item) => {
    if (!item.teambitionVersionId && !item.teambitionVersionName) return ""
    const stale = item.teambitionVersionStale ? " unbound" : ""
    return `<span class="tb-badge${stale}">版本 · ${escapeHtml(item.teambitionVersionName || item.teambitionVersionId)}${item.teambitionVersionStale ? "（已失效）" : ""}</span>`
  }
  const filter = String(options.filter || "")
  const createdId = options.lastCreatedId || ""
  const query = filter.trim().toLowerCase()
  const filtered = items.filter((item) => {
    if (!query) return true
    return [item.requirementName, item.requirementId, item.description]
      .some((field) => String(field || "").toLowerCase().includes(query))
  })
  const columns = PHASE_ORDER.map((phase) => {
    const cards = filtered.filter((item) => item.currentPhase === phase)
    return { phase, cards }
  })
  if (!items.length) {
    return { kind: "empty", filtered, html: "" }
  }
  if (!filtered.length) {
    return {
      kind: "nomatch",
      filtered,
      html: `<div class="empty-state">没有匹配「${escapeHtml(filter)}」的需求</div>`,
    }
  }
  const html = `<div class="kanban-board">${columns.map(({ phase, cards }) => `
    <div class="kanban-column" data-phase="${escapeHtml(phase)}">
      <div class="kanban-column-header">${escapeHtml(phaseLabel(phase))} <span class="kanban-column-count">${cards.length}</span></div>
      <div class="kanban-column-body">${cards.map((item) => {
        const scheduleText = item.plannedStart && item.plannedEnd
          ? `${escapeHtml(item.plannedStart.slice(5))} → ${escapeHtml(item.plannedEnd.slice(5))}`
          : "未排期"
        const tbBadge = item.teambitionTaskId || item.teambitionStatusName
          ? `<span class="tb-badge">TB${item.teambitionStatusName ? ` · ${escapeHtml(item.teambitionStatusName)}` : ""}</span>`
          : `<span class="tb-badge unbound">未绑定任务</span>`
        const selectHtml = item.teambitionTaskId
          ? `<select class="kanban-tb-status" data-requirement-id="${escapeHtml(item.requirementId)}" onclick="event.stopPropagation()" onmousedown="event.stopPropagation()" draggable="false">${(options.tbStatuses || []).map((s) => `<option value="${escapeHtml(s.id || s.statusId || "")}"${item.teambitionStatusId === (s.id || s.statusId) ? " selected" : ""}>${escapeHtml(s.name || s.statusName || s.id || s.statusId || "")}</option>`).join("")}</select>`
          : ""
        return `
      <article class="kanban-card${item.requirementId === createdId ? " highlight" : ""}" draggable="true" data-requirement-id="${escapeHtml(item.requirementId)}" data-phase="${escapeHtml(phase)}">
        <div class="kanban-card-header">
          <span class="kanban-card-title">${escapeHtml(item.requirementName || item.requirementId)}</span>
          ${tbBadge}
          ${versionBadge(item)}
        </div>
        <p class="kanban-card-desc">${escapeHtml(item.description || "")}</p>
        <div class="kanban-card-meta">
          <span class="kanban-card-nodes">节点 ${item.completedTasks ?? 0}/${item.totalTasks ?? 0}</span>
          <span class="kanban-card-schedule">${scheduleText}</span>
          ${item.updatedAt ? `<span class="kanban-card-updated">${escapeHtml(formatUpdatedAt(item.updatedAt))}</span>` : ""}
        </div>
        ${selectHtml}
        <div class="kanban-card-actions">
          <button type="button" data-open>打开</button>
          <button type="button" class="secondary" data-edit>编辑</button>
          <button type="button" class="danger" data-delete>删除</button>
        </div>
      </article>`
      }).join("")}</div>
    </div>`).join("")}</div>`
  return { kind: "cards", filtered, html }
}

function buildRequirementCardsMarkup(items, options = {}) {
  const versionBadge = (item) => {
    if (!item.teambitionVersionId && !item.teambitionVersionName) return ""
    const stale = item.teambitionVersionStale ? " unbound" : ""
    return `<span class="tb-badge${stale}">版本 · ${escapeHtml(item.teambitionVersionName || item.teambitionVersionId)}${item.teambitionVersionStale ? "（已失效）" : ""}</span>`
  }
  const filter = String(options.filter || "")
  const createdId = options.lastCreatedId || ""
  const scheduleId = options.expandedScheduleId || ""
  const query = filter.trim().toLowerCase()
  const filtered = items.filter((item) => {
    if (!query) return true
    return [item.requirementName, item.requirementId, item.description, item.projectRoot]
      .some((field) => String(field || "").toLowerCase().includes(query))
  })
  if (!items.length) {
    return { kind: "empty", filtered, html: "" }
  }
  if (!filtered.length) {
    return {
      kind: "nomatch",
      filtered,
      html: `<div class="empty-state">没有匹配「${escapeHtml(filter)}」的需求</div>`,
    }
  }
  const html = filtered.map((item) => `
    <article class="hub-card${item.requirementId === createdId ? " highlight" : ""}${item.requirementId === scheduleId ? " is-expanded" : ""}" data-requirement-id="${escapeHtml(item.requirementId)}">
      <div class="name">${escapeHtml(item.requirementName || item.requirementId)}</div>
      <p class="desc">${escapeHtml(item.description || "暂无描述")}</p>
      <div class="progress">${escapeHtml(phaseLabel(item.currentPhase))} · 节点 ${item.completedTasks}/${item.totalTasks}</div>
      ${item.teambitionTaskId || item.teambitionStatusName
        ? `<span class="tb-badge">TB 任务${item.teambitionStatusName ? ` · ${escapeHtml(item.teambitionStatusName)}` : ""}</span>`
        : `<span class="tb-badge unbound">未绑定任务</span>`}
      ${versionBadge(item)}
      ${milestoneBadgeHtml(item)}
      <div class="meta">${escapeHtml(item.requirementId)}${item.projectRoot ? `<br />${escapeHtml(item.projectRoot)}` : ""}${item.updatedAt ? `<br />更新于 ${escapeHtml(formatUpdatedAt(item.updatedAt))}` : ""}</div>
      <div class="hub-card-edit" hidden>
        <input class="edit-name" value="${escapeHtml(item.requirementName || "")}" placeholder="需求名称" />
        <input class="edit-desc" value="${escapeHtml(item.description || "")}" placeholder="需求描述" />
        <div class="hub-card-actions">
          <button type="button" data-save>保存</button>
          <button type="button" class="secondary" data-cancel-edit>取消</button>
        </div>
      </div>
      <div class="hub-card-actions hub-card-main-actions">
        <button type="button" data-open>打开需求</button>
        <button type="button" class="secondary" data-schedule aria-expanded="${item.requirementId === scheduleId ? "true" : "false"}">${item.requirementId === scheduleId ? "收起排期" : "排期"}</button>
        <button type="button" class="secondary" data-edit>编辑</button>
        <button type="button" class="danger" data-delete>删除</button>
      </div>
    </article>
  `).join("")
  return { kind: "cards", filtered, html }
}

function renderHub() {
  if (!hubCardsEl || !hubEmptyEl) return
  hubCardsEl.hidden = false
  const built = buildHubCardsMarkup(projectSummaries, {
    filter: hubFilter,
    lastCreatedId: lastCreatedProjectId,
  })
  if (built.kind === "empty") {
    hubEmptyEl.hidden = false
    hubCardsEl.innerHTML = ""
    return
  }
  hubEmptyEl.hidden = true
  hubCardsEl.innerHTML = built.html
  if (built.kind !== "cards") return

  for (const card of hubCardsEl.querySelectorAll(".hub-card")) {
    const projectId = card.dataset.projectId
    const editPanel = card.querySelector(".hub-card-edit")
    const actions = card.querySelector(".hub-card-main-actions")
    card.querySelector("[data-open]").onclick = () => goToProject(projectId)
    card.querySelector("[data-edit]").onclick = () => {
      editPanel.hidden = false
      if (actions) actions.hidden = true
    }
    card.querySelector("[data-cancel-edit]").onclick = () => {
      editPanel.hidden = true
      if (actions) actions.hidden = false
    }
    card.querySelector("[data-save]").onclick = async () => {
      const name = card.querySelector(".edit-name").value.trim()
      const description = card.querySelector(".edit-desc").value
      if (!name) {
        statusEl.textContent = "项目名称不能为空"
        statusEl.className = "badge warn"
        return
      }
      try {
        await window.octopus.updateProjectMeta(projectId, { name, description })
        statusEl.textContent = "项目已更新"
        statusEl.className = "badge good"
        await showHub()
      } catch (error) {
        showError(error)
      }
    }
    card.querySelector("[data-delete]").onclick = async () => {
      const item = projectSummaries.find((entry) => entry.projectId === projectId)
      const label = item?.name || projectId
      if (!await confirmAction(`删除项目「${label}」及其下全部需求状态？\n只删除状态库记录，不会删除源码目录或 workflow.yaml。此操作不可恢复。`, "删除项目", "error")) {
        return
      }
      try {
        await window.octopus.deleteProject(projectId)
        if (lastCreatedProjectId === projectId) lastCreatedProjectId = ""
        if (selectedProjectId === projectId) selectedProjectId = undefined
        statusEl.textContent = "项目已删除"
        statusEl.className = "badge good"
        if (currentView !== "hub") goToHub()
        else await showHub()
      } catch (error) {
        showError(error)
      }
    }
  }
}

async function renderMine() {
  const mineEl = document.getElementById("mineView")
  if (!mineEl) return
  const identity = (await window.octopus.getIdentity())?.name || ""
  if (!identity) {
    mineEl.innerHTML = `<div class="panel-card"><h3>我的工作</h3><p class="help">尚未设置身份。请在下方填写名称。</p><div class="field"><label for="mineIdentity">我是</label><input id="mineIdentity" placeholder="例如：张三" /></div><button id="saveMineIdentity" type="button">保存身份</button></div>`
    document.getElementById("saveMineIdentity")?.addEventListener("click", async () => {
      const name = document.getElementById("mineIdentity")?.value.trim() || ""
      if (!name) return
      await window.octopus.setIdentity(name)
      await renderMine()
    })
    return
  }
  const list = await window.octopus.listMyWork(identity)
  const row = (item) => `<tr data-requirement-id="${escapeHtml(item.requirementId)}"><td>${escapeHtml(item.projectName)}</td><td><button class="link-btn" data-open-mine>${escapeHtml(item.requirementName)}</button></td><td>${escapeHtml(item.nodeName || "需求负责人")}</td><td>${escapeHtml(phaseLabel(item.phase))}</td><td>${escapeHtml(item.plannedEnd || item.nextMilestone?.date || "未排期")}</td><td class="${item.overdue ? "is-overdue" : ""}">${item.overdue ? "逾期" : ""}</td></tr>`
  mineEl.innerHTML = `<div class="panel-card"><div class="tb-actions"><h3>我的工作（${escapeHtml(identity)}）</h3><button id="clearMineIdentity" class="secondary" type="button">清除身份</button></div><h4>我负责的需求</h4><div class="table-scroll"><table><thead><tr><th>项目</th><th>需求</th><th>负责人</th><th>阶段</th><th>截止/里程碑</th><th>状态</th></tr></thead><tbody>${list.requirements.map(row).join("") || `<tr><td colspan="6">暂无负责的需求</td></tr>`}</tbody></table></div><h4>指派给我的节点</h4><div class="table-scroll"><table><thead><tr><th>项目</th><th>需求</th><th>节点</th><th>阶段</th><th>截止/里程碑</th><th>状态</th></tr></thead><tbody>${list.nodes.map(row).join("") || `<tr><td colspan="6">暂无指派节点</td></tr>`}</tbody></table></div></div>`
  for (const button of mineEl.querySelectorAll("[data-open-mine]")) button.onclick = () => goToRequirement(button.closest("tr")?.dataset.requirementId)
  document.getElementById("clearMineIdentity")?.addEventListener("click", async () => { await window.octopus.setIdentity(null); await renderMine() })
}

function renderRequirementTable() {
  const host = document.getElementById("requirementTable")
  if (!host) return
  const phaseIndex = (value) => PHASE_ORDER.indexOf(value)
  const items = [...requirementSummaries].filter((item) => {
    const q = projectFilter.trim().toLowerCase()
    return !q || [item.requirementName, item.requirementId, item.description, item.owner].some((v) => String(v || "").toLowerCase().includes(q))
  }).sort((a, b) => {
    const av = projectTableSort.key === "phase" ? phaseIndex(a.currentPhase) : String(a[projectTableSort.key] || "")
    const bv = projectTableSort.key === "phase" ? phaseIndex(b.currentPhase) : String(b[projectTableSort.key] || "")
    return (av < bv ? -1 : av > bv ? 1 : 0) * (projectTableSort.dir === "asc" ? 1 : -1)
  })
  const headers = [["requirementName", "名称"], ["currentPhase", "阶段"], ["owner", "负责人"], ["plannedStart", "开始"], ["plannedEnd", "结束"]]
  host.innerHTML = `<div class="panel-card"><div class="table-scroll"><table><thead><tr>${headers.map(([key, label]) => `<th><button class="table-sort" data-sort="${key}" type="button">${label}</button></th>`).join("")}<th>里程碑</th><th>进度</th><th>TB</th><th>操作</th></tr></thead><tbody>${items.map((item) => `<tr data-requirement-id="${escapeHtml(item.requirementId)}"><td><button class="link-btn" data-open>${escapeHtml(item.requirementName)}</button><div class="muted">${escapeHtml(item.requirementId)}</div></td><td><select data-phase>${PHASE_ORDER.map((phase) => `<option value="${phase}"${phase === item.currentPhase ? " selected" : ""}>${escapeHtml(phaseLabel(phase))}</option>`).join("")}</select></td><td><input data-owner value="${escapeHtml(item.owner || "")}" placeholder="未设置" /></td><td><input data-start type="date" value="${escapeHtml(item.plannedStart || "")}" /></td><td><input data-end type="date" value="${escapeHtml(item.plannedEnd || "")}" /></td><td>${item.nextMilestone ? `${escapeHtml(item.nextMilestone.name)} · ${escapeHtml(item.nextMilestone.date)}` : "—"}</td><td>${item.totalTasks ? `${item.completedTasks}/${item.totalTasks}` : "—"}</td><td>${escapeHtml(item.teambitionStatusName || "—")}</td><td><button data-save class="secondary" type="button">保存</button><button data-edit class="secondary" type="button">编辑</button><button data-delete class="secondary" type="button">删除</button></td></tr>`).join("") || `<tr><td colspan="9">暂无需求</td></tr>`}</tbody></table></div></div>`
  for (const btn of host.querySelectorAll(".table-sort")) btn.onclick = () => { const key = btn.dataset.sort; projectTableSort = { key, dir: projectTableSort.key === key && projectTableSort.dir === "asc" ? "desc" : "asc" }; renderRequirementTable() }
  for (const row of host.querySelectorAll("tbody tr[data-requirement-id]")) {
    const id = row.dataset.requirementId
    row.querySelector("[data-open]").onclick = () => goToRequirement(id)
    row.querySelector("[data-phase]").onchange = async (event) => { try { await window.octopus.moveRequirementPhase(id, event.target.value); statusEl.textContent = "阶段已更新"; statusEl.className = "badge good"; await loadRequirementSummaries(selectedProjectId); renderRequirementTable() } catch (error) { showError(error); renderRequirementTable() } }
    row.querySelector("[data-save]").onclick = async () => {
      const start = row.querySelector("[data-start]").value || null, end = row.querySelector("[data-end]").value || null
      if ((start && !end) || (!start && end)) { statusEl.textContent = "起止日期必须成对"; statusEl.className = "badge warn"; return }
      try { await window.octopus.updateRequirement(id, { owner: row.querySelector("[data-owner]").value.trim() || null }); await window.octopus.updateRequirementSchedule(id, { plannedStart: start, plannedEnd: end }); await loadRequirementSummaries(selectedProjectId); statusEl.textContent = "需求已保存"; statusEl.className = "badge good"; renderRequirementTable() } catch (error) { showError(error) }
    }
    row.querySelector("[data-edit]").onclick = async () => {
      const item = requirementSummaries.find((entry) => entry.requirementId === id)
      if (!item) return
      const name = window.prompt("需求名称", item.requirementName)
      if (name === null || !name.trim()) return
      const description = window.prompt("需求描述", item.description || "")
      if (description === null) return
      try { await window.octopus.updateRequirement(id, { name: name.trim(), description }); await loadRequirementSummaries(selectedProjectId); renderRequirementTable() } catch (error) { showError(error) }
    }
    row.querySelector("[data-delete]").onclick = async () => {
      if (!await confirmAction("确认删除该需求？此操作不可恢复。", "删除需求", "error")) return
      try { await window.octopus.deleteRequirement(id); await loadRequirementSummaries(selectedProjectId); renderRequirementTable() } catch (error) { showError(error) }
    }
  }
}

async function renderProjectOverview() {
  const host = document.getElementById("projectOverview")
  if (!host || !selectedProjectId) return
  try {
    const overview = await window.octopus.getProjectOverview(selectedProjectId)
    host.innerHTML = `<div class="panel-card"><h3>${escapeHtml(overview.projectName)} · 概览</h3><div class="metrics"><div class="metric"><strong>${overview.requirementCount}</strong><small>需求</small></div><div class="metric"><strong>${overview.unscheduledCount}</strong><small>未排期</small></div><div class="metric"><strong>${overview.unboundTbCount}</strong><small>未绑 TB</small></div><div class="metric"><strong>${overview.ownerlessCount}</strong><small>无负责人</small></div><div class="metric"><strong>${overview.readyNodeCount}</strong><small>可运行节点</small></div><div class="metric"><strong>${overview.waitingNodeCount}</strong><small>等待节点</small></div></div><h4>里程碑</h4><p>计划中 ${overview.milestonePlanned} · 已达成 ${overview.milestoneReached} · 逾期 ${overview.milestoneOverdue}</p><h4>Heinrich</h4><p>Major ${overview.heinrich.major} · Minor ${overview.heinrich.minor} · Trivial ${overview.heinrich.trivial}</p><h4>阶段分布</h4><table><thead><tr><th>阶段</th><th>需求数</th></tr></thead><tbody>${overview.byPhase.map((item) => `<tr><td>${escapeHtml(phaseLabel(item.phase))}</td><td>${item.count}</td></tr>`).join("")}</tbody></table></div>`
  } catch (error) { host.innerHTML = `<div class="panel-card"><p class="bad">${escapeHtml(readableError(error))}</p></div>` }
}

function renderProjectTbPanel() {
  if (!tbBindInfoEl) return
  const binding = currentProject?.teambition
  if (binding?.projectId) {
    tbBindInfoEl.textContent = `已绑定：${binding.name || binding.projectId}${binding.uniqueIdPrefix ? `（前缀 ${binding.uniqueIdPrefix}）` : ""}`
    if (document.getElementById("tbProjectId")) {
      document.getElementById("tbProjectId").value = binding.projectId || ""
    }
    if (document.getElementById("tbPrefix")) {
      document.getElementById("tbPrefix").value = binding.uniqueIdPrefix || ""
    }
  } else {
    tbBindInfoEl.textContent = "尚未绑定 Teambition 项目"
  }
}

function syncProjectTabs() {
  const tabBtns = document.querySelectorAll(".project-tab-btn")
  for (const btn of tabBtns) {
    const isActive = btn.dataset.tab === projectTab
    btn.classList.toggle("active", isActive)
    btn.setAttribute("aria-selected", isActive ? "true" : "false")
  }
}

function renderKanbanBoard() {
  const kanbanBoardEl = document.getElementById("kanbanBoard")
  const kanbanEmptyEl = document.getElementById("kanbanEmpty")
  if (!kanbanBoardEl) return
  const built = buildKanbanMarkup(requirementSummaries, {
    filter: projectFilter,
    lastCreatedId: lastCreatedRequirementId,
    tbStatuses: cardStatusesCache,
  })
  if (built.kind === "empty") {
    if (kanbanEmptyEl) kanbanEmptyEl.hidden = false
    kanbanBoardEl.innerHTML = ""
    return
  }
  if (kanbanEmptyEl) kanbanEmptyEl.hidden = true
  kanbanBoardEl.innerHTML = built.html
  if (built.kind !== "cards") return
  setupKanbanDragDrop(kanbanBoardEl)
  for (const card of kanbanBoardEl.querySelectorAll(".kanban-card")) {
    const requirementId = card.dataset.requirementId
    card.querySelector("[data-open]").onclick = (e) => { e.stopPropagation(); goToRequirement(requirementId) }
    card.querySelector("[data-edit]").onclick = (e) => { e.stopPropagation(); goToRequirement(requirementId) }
    card.querySelector("[data-delete]").onclick = async (e) => {
      e.stopPropagation()
      const item = requirementSummaries.find((entry) => entry.requirementId === requirementId)
      const label = item?.requirementName || requirementId
      if (!await confirmAction(`删除需求「${label}」的状态？\n只删除状态库记录，不会删除源码目录。此操作不可恢复。`, "删除需求", "error")) return
      try {
        await window.octopus.deleteRequirement(requirementId)
        if (lastCreatedRequirementId === requirementId) lastCreatedRequirementId = ""
        if (selectedRequirement === requirementId) selectedRequirement = undefined
        if (expandedScheduleId === requirementId) collapseHubSchedule()
        statusEl.textContent = "需求已删除"
        statusEl.className = "badge good"
        await showProjectPage(selectedProjectId)
      } catch (error) {
        showError(error)
      }
    }
    const tbSelect = card.querySelector(".kanban-tb-status")
    if (tbSelect) {
      tbSelect.onchange = async () => {
        const statusId = tbSelect.value
        if (!statusId) return
        try {
          await window.octopus.updateRequirementTeambitionStatus(requirementId, statusId)
          statusEl.textContent = "Teambition 状态已更新"
          statusEl.className = "badge good"
          await loadRequirementSummaries(selectedProjectId)
          renderProjectPage()
        } catch (error) {
          showError(error)
        }
      }
    }
    card.onclick = () => goToRequirement(requirementId)
  }
}

function renderProjectSettings() {
  const projectSettingsEl = document.getElementById("projectSettings")
  if (!projectSettingsEl) return
  const binding = currentProject?.teambition
  const omniplanFolder = currentProject?.metadata?.omniplanFolder || ""
  const omniplanFileName = currentProject?.metadata?.omniplanFileName || ""
  const defaultColor = currentProject?.metadata?.defaultColor || "#4f86c6"
  const versionBinding = currentProject?.teambitionVersion
  projectSettingsEl.innerHTML = `
    <div class="panel-card">
      <h3>Teambition 版本仓库</h3>
      <p class="help">版本端点未确认时会显示明确的不可用状态，不会伪造空列表。</p>
      <div class="field"><label for="settingsVersionRepoId">仓库 ID</label><input id="settingsVersionRepoId" value="${escapeHtml(versionBinding?.repoId || "")}" placeholder="repoId" /></div>
      <div class="field"><label for="settingsVersionPluginId">插件 ID（可选）</label><input id="settingsVersionPluginId" value="${escapeHtml(versionBinding?.pluginId || "")}" /></div>
      <div class="field"><label for="settingsVersionTbProjectId">TB 项目 ID（可选）</label><input id="settingsVersionTbProjectId" value="${escapeHtml(versionBinding?.tbProjectId || "")}" /></div>
      <div class="tb-actions"><button id="settingsBindVersionRepo" type="button">绑定版本仓库</button><button id="settingsUnbindVersionRepo" class="secondary" type="button">解绑</button></div>
    </div>
    <div class="panel-card">
      <h3>Teambition 绑定</h3>
      <p class="help">填写 Teambition 项目 ID，或用任务编号前缀解析。未配置凭据时会显示可读错误。</p>
      <div class="field">
        <label for="settingsTbProjectId">Teambition 项目 ID</label>
        <input id="settingsTbProjectId" value="${escapeHtml(binding?.projectId || "")}" placeholder="可选" />
      </div>
      <div class="field">
        <label for="settingsTbPrefix">前缀（prefix）</label>
        <input id="settingsTbPrefix" value="${escapeHtml(binding?.uniqueIdPrefix || "")}" placeholder="例如：ACME" />
      </div>
      <div class="tb-actions">
        <button id="settingsBindTb" type="button">绑定</button>
        <button id="settingsUnbindTb" class="secondary" type="button">解绑</button>
        <button id="settingsLoadTbStatuses" class="secondary" type="button">查看卡片状态</button>
      </div>
      <div id="settingsTbBindInfo" class="muted" style="margin-top:8px">${binding?.projectId ? `已绑定：${binding.name || binding.projectId}` : "尚未绑定 Teambition 项目"}</div>
      <div id="settingsTbStatusList" class="tb-status-list" hidden></div>
    </div>
    <div class="panel-card">
      <h3>OmniPlan</h3>
      <p class="help">OmniPlan 文件夹名用于导出/导入甘特图。根目录来自配置。</p>
      <div class="field">
        <label for="settingsOmniplanFolder">文件夹名</label>
        <input id="settingsOmniplanFolder" value="${escapeHtml(omniplanFolder)}" placeholder="例如：cdc-dior" />
      </div>
      <div class="field">
        <label for="settingsOmniplanFileName">目标文件名（可选）</label>
        <input id="settingsOmniplanFileName" value="${escapeHtml(omniplanFileName)}" placeholder="默认使用项目名" />
      </div>
      <button id="settingsSaveOmniplan" type="button">保存 OmniPlan 设置</button>
    </div>
    <div class="panel-card">
      <h3>默认颜色</h3>
      <p class="help">项目级默认颜色，暂用于后续扩展；未设置时不影响现有界面。</p>
      <div class="field">
        <label for="settingsDefaultColor">默认颜色</label>
        <input id="settingsDefaultColor" type="color" value="${escapeHtml(defaultColor)}" />
      </div>
      <div class="tb-actions">
        <button id="settingsSaveColor" type="button">保存默认颜色</button>
        <button id="settingsClearColor" class="secondary" type="button">清除</button>
      </div>
    </div>
    <div class="panel-card" id="settingsBrdCard">
      <h3>BRD 设计</h3>
      <p class="help">按项目配置小程序/官网/前后端代码与展示信息，供 AI 生成或检查 BRD。提示词可用 CLI <code>octopus brd prompt-set</code> 覆盖。</p>
      <div class="field"><label for="brdMiniprogram">小程序代码路径</label><input id="brdMiniprogram" placeholder="相对项目根或绝对路径" /></div>
      <div class="field"><label for="brdWebsiteCode">官网代码路径</label><input id="brdWebsiteCode" /></div>
      <div class="field"><label for="brdFrontend">前端代码路径</label><input id="brdFrontend" /></div>
      <div class="field"><label for="brdBackend">后端代码路径</label><input id="brdBackend" /></div>
      <div class="field"><label for="brdMiniArtifact">小程序编译产物</label><input id="brdMiniArtifact" /></div>
      <div class="field"><label for="brdWebsiteUrl">官网展示域名</label><input id="brdWebsiteUrl" placeholder="https://..." /></div>
      <div class="field"><label for="brdSpecPath">BRD 规范路径</label><input id="brdSpecPath" /></div>
      <div class="field"><label for="brdOutputPath">BRD 产出路径</label><input id="brdOutputPath" placeholder="默认节点目录 brd.md" /></div>
      <details class="brd-prompts-editor" open><summary><span>提示词编辑</span><span class="muted">3 类模板</span></summary>
        <div class="brd-prompt-editor-body">
          <p class="help">项目只保存自定义内容；未自定义的类型继续使用内置默认提示词。模板支持 <code>{{requirementName}}</code>、<code>{{sourcesSummary}}</code> 等变量。</p>
          <div class="brd-prompt-tabs" role="tablist" aria-label="BRD 提示词类型">
            ${BRD_PROMPT_IDS.map((id, index) => `<button type="button" class="brd-prompt-tab${index === 0 ? " active" : ""}" role="tab" aria-selected="${index === 0 ? "true" : "false"}" data-prompt-id="${id}">${escapeHtml(BRD_PROMPT_META[id].name)} <code>${id}</code></button>`).join("")}
          </div>
          <div class="brd-prompt-editor-heading">
            <div><h4 id="brdPromptTitle">生成 BRD</h4><p id="brdPromptDescription" class="muted"></p></div>
            <span id="brdPromptState" class="badge">使用内置默认</span>
          </div>
          <div class="brd-prompt-fields">
            <div class="field brd-prompt-field">
              <label for="brdPromptSystem"><span class="brd-prompt-field-label">系统提示词 <code>system</code></span><span id="brdPromptSystemCount" class="brd-prompt-count">0 字</span></label>
              <textarea id="brdPromptSystem" class="brd-prompt-textarea" rows="7" spellcheck="false" placeholder="未自定义，运行时使用内置 system 提示词"></textarea>
            </div>
            <div class="field brd-prompt-field">
              <label for="brdPromptUser"><span class="brd-prompt-field-label">用户提示词 <code>user</code></span><span id="brdPromptUserCount" class="brd-prompt-count">0 字</span></label>
              <textarea id="brdPromptUser" class="brd-prompt-textarea" rows="7" spellcheck="false" placeholder="未自定义，运行时使用内置 user 提示词"></textarea>
            </div>
          </div>
          <div class="brd-prompt-actions">
            <span class="muted">system 与 user 需同时填写；切换类型不会丢失未保存内容。</span>
            <button id="brdPromptUseDefault" class="secondary" type="button">恢复内置默认</button>
          </div>
        </div>
      </details>
      <div class="tb-actions brd-prompt-actions">
        <label class="brd-preview-context" for="settingsBrdPreviewRequirement">预览需求
          <select id="settingsBrdPreviewRequirement">
            ${requirementSummaries.length
              ? requirementSummaries.map((item) => `<option value="${escapeHtml(item.requirementId)}">${escapeHtml(item.requirementName || item.requirementId)}</option>`).join("")
              : `<option value="">暂无需求</option>`}
          </select>
        </label>
        <div class="brd-prompt-button-group">
          <button id="settingsSaveBrd" type="button">保存 BRD 设置</button>
          <button id="settingsPreviewBrdPrompts" class="secondary" type="button"${requirementSummaries.length ? "" : " disabled"}>预览已保存提示词</button>
        </div>
      </div>
      <section id="settingsBrdPromptPreview" class="brd-prompt-preview" aria-live="polite" hidden></section>
    </div>
  `
  brdPromptConfig = {}
  brdPromptDrafts = {}
  brdPromptClearIds = new Set()
  let activePromptId = "generate"
  const promptValue = (id) => brdPromptClearIds.has(id)
    ? { system: "", user: "" }
    : (brdPromptDrafts[id] || brdPromptConfig[id] || { system: "", user: "" })
  const updatePromptEditorState = () => {
    const item = promptValue(activePromptId)
    const meta = BRD_PROMPT_META[activePromptId]
    const state = document.getElementById("brdPromptState")
    const title = document.getElementById("brdPromptTitle")
    const description = document.getElementById("brdPromptDescription")
    const systemCount = document.getElementById("brdPromptSystemCount")
    const userCount = document.getElementById("brdPromptUserCount")
    if (title) title.textContent = meta.name
    if (description) description.textContent = meta.description
    if (systemCount) systemCount.textContent = `${item.system.length} 字`
    if (userCount) userCount.textContent = `${item.user.length} 字`
    if (state) {
      state.className = "badge"
      if (brdPromptClearIds.has(activePromptId)) {
        state.textContent = "保存后使用默认"
        state.classList.add("warn")
      } else if (brdPromptDrafts[activePromptId]) {
        state.textContent = "有未保存修改"
        state.classList.add("warn")
      } else if (brdPromptConfig[activePromptId]) {
        state.textContent = "已自定义"
        state.classList.add("info")
      } else {
        state.textContent = "使用内置默认"
      }
    }
    for (const tab of document.querySelectorAll(".brd-prompt-tab")) {
      const id = tab.dataset.promptId
      const selected = id === activePromptId
      tab.classList.toggle("active", selected)
      tab.classList.toggle("is-custom", Boolean(brdPromptConfig[id]) && !brdPromptClearIds.has(id))
      tab.classList.toggle("has-pending", Boolean(brdPromptDrafts[id]) || brdPromptClearIds.has(id))
      tab.setAttribute("aria-selected", String(selected))
    }
  }
  const loadPromptEditor = () => {
    const item = promptValue(activePromptId)
    const system = document.getElementById("brdPromptSystem")
    const user = document.getElementById("brdPromptUser")
    if (system) system.value = item?.system || ""
    if (user) user.value = item?.user || ""
    updatePromptEditorState()
  }
  const syncPromptEditor = (markEdited = false) => {
    const system = document.getElementById("brdPromptSystem")
    const user = document.getElementById("brdPromptUser")
    if (!system || !user) return
    if (markEdited) brdPromptClearIds.delete(activePromptId)
    if (brdPromptClearIds.has(activePromptId)) return
    const base = brdPromptConfig[activePromptId] || { system: "", user: "" }
    if (system.value === base.system && user.value === base.user) {
      delete brdPromptDrafts[activePromptId]
    } else {
      brdPromptDrafts[activePromptId] = { system: system.value, user: user.value }
    }
    updatePromptEditorState()
  }
  for (const tab of document.querySelectorAll(".brd-prompt-tab")) {
    tab.addEventListener("click", () => {
      syncPromptEditor()
      activePromptId = tab.dataset.promptId || "generate"
      loadPromptEditor()
    })
  }
  document.getElementById("brdPromptSystem")?.addEventListener("input", () => syncPromptEditor(true))
  document.getElementById("brdPromptUser")?.addEventListener("input", () => syncPromptEditor(true))
  document.getElementById("brdPromptUseDefault")?.addEventListener("click", () => {
    delete brdPromptDrafts[activePromptId]
    if (brdPromptConfig[activePromptId]) brdPromptClearIds.add(activePromptId)
    else brdPromptClearIds.delete(activePromptId)
    loadPromptEditor()
  })
  document.getElementById("settingsBindTb")?.addEventListener("click", async () => {
    if (!selectedProjectId) return
    const tbProjectId = document.getElementById("settingsTbProjectId")?.value.trim() || undefined
    const prefix = document.getElementById("settingsTbPrefix")?.value.trim() || undefined
    try {
      currentProject = await window.octopus.bindProjectTeambition(selectedProjectId, {
        ...(tbProjectId ? { projectId: tbProjectId } : {}),
        ...(prefix ? { prefix } : {}),
      })
      cardStatusesCache = []
      statusEl.textContent = "已绑定 Teambition 项目"
      statusEl.className = "badge good"
      await loadProjectSummaries()
      renderProjectPage()
    } catch (error) {
      statusEl.textContent = readableError(error)
      statusEl.className = "badge bad"
    }
  })
  document.getElementById("settingsBindVersionRepo")?.addEventListener("click", async () => {
    if (!selectedProjectId || !window.octopus.bindProjectTeambitionRepo) return
    const repoId = document.getElementById("settingsVersionRepoId")?.value.trim() || ""
    if (!repoId) { statusEl.textContent = "请填写版本仓库 ID"; statusEl.className = "badge bad"; return }
    try {
      currentProject = await window.octopus.bindProjectTeambitionRepo(selectedProjectId, {
        repoId,
        ...(document.getElementById("settingsVersionPluginId")?.value.trim() ? { pluginId: document.getElementById("settingsVersionPluginId").value.trim() } : {}),
        ...(document.getElementById("settingsVersionTbProjectId")?.value.trim() ? { tbProjectId: document.getElementById("settingsVersionTbProjectId").value.trim() } : {}),
      })
      statusEl.textContent = "版本仓库已绑定"
      statusEl.className = "badge good"
    } catch (error) { statusEl.textContent = readableError(error); statusEl.className = "badge bad" }
  })
  document.getElementById("settingsUnbindVersionRepo")?.addEventListener("click", async () => {
    if (!selectedProjectId || !window.octopus.unbindProjectTeambitionRepo) return
    try {
      currentProject = await window.octopus.unbindProjectTeambitionRepo(selectedProjectId)
      statusEl.textContent = "版本仓库绑定已解除"
      statusEl.className = "badge good"
    } catch (error) { statusEl.textContent = readableError(error); statusEl.className = "badge bad" }
  })
  document.getElementById("settingsUnbindTb")?.addEventListener("click", async () => {
    if (!selectedProjectId) return
    try {
      currentProject = await window.octopus.unbindProjectTeambition(selectedProjectId)
      cardStatusesCache = []
      const statusList = document.getElementById("settingsTbStatusList")
      if (statusList) { statusList.hidden = true; statusList.innerHTML = "" }
      statusEl.textContent = "已解除 Teambition 项目绑定"
      statusEl.className = "badge good"
      await loadProjectSummaries()
      renderProjectPage()
    } catch (error) {
      statusEl.textContent = readableError(error)
      statusEl.className = "badge bad"
    }
  })
  document.getElementById("settingsLoadTbStatuses")?.addEventListener("click", async () => {
    if (!selectedProjectId) return
    try {
      cardStatusesCache = await window.octopus.listTeambitionCardStatuses(selectedProjectId)
      const statusList = document.getElementById("settingsTbStatusList")
      if (statusList) {
        statusList.hidden = false
        statusList.innerHTML = cardStatusesCache.length
          ? cardStatusesCache.map((item) => `<div>${escapeHtml(item.name || item.id)} <span class="muted">${escapeHtml(item.id || "")}</span></div>`).join("")
          : `<div class="muted">暂无卡片状态</div>`
      }
      statusEl.textContent = `已加载 ${cardStatusesCache.length} 个卡片状态`
      statusEl.className = "badge good"
    } catch (error) {
      statusEl.textContent = readableError(error)
      statusEl.className = "badge bad"
    }
  })
  document.getElementById("settingsSaveOmniplan")?.addEventListener("click", async () => {
    if (!selectedProjectId || !window.octopus.setProjectOmniPlanMeta) return
    const folder = document.getElementById("settingsOmniplanFolder")?.value.trim() || ""
    const fileName = document.getElementById("settingsOmniplanFileName")?.value.trim() || ""
    try {
      await window.octopus.setProjectOmniPlanMeta(selectedProjectId, {
        ...(folder ? { omniplanFolder: folder } : {}),
        ...(fileName ? { omniplanFileName: fileName } : {}),
      })
      currentProject = await window.octopus.getProject(selectedProjectId)
      statusEl.textContent = "OmniPlan 设置已保存"
      statusEl.className = "badge good"
    } catch (error) {
      showError(error)
    }
  })
  document.getElementById("settingsSaveColor")?.addEventListener("click", async () => {
    if (!selectedProjectId || !window.octopus.setProjectDefaultColor) return
    const color = document.getElementById("settingsDefaultColor")?.value || ""
    try {
      currentProject = await window.octopus.setProjectDefaultColor(selectedProjectId, color)
      statusEl.textContent = "默认颜色已保存"
      statusEl.className = "badge good"
    } catch (error) {
      statusEl.textContent = readableError(error)
      statusEl.className = "badge bad"
    }
  })
  document.getElementById("settingsClearColor")?.addEventListener("click", async () => {
    if (!selectedProjectId || !window.octopus.setProjectDefaultColor) return
    try {
      currentProject = await window.octopus.setProjectDefaultColor(selectedProjectId, null)
      const input = document.getElementById("settingsDefaultColor")
      if (input) input.value = "#4f86c6"
      statusEl.textContent = "已清除默认颜色"
      statusEl.className = "badge good"
    } catch (error) {
      statusEl.textContent = readableError(error)
      statusEl.className = "badge bad"
    }
  })
  document.getElementById("settingsSaveBrd")?.addEventListener("click", async () => {
    if (!selectedProjectId || !window.octopus.setProjectBrdDesignConfig) return
    try {
      syncPromptEditor()
      const promptPatch = collectBrdPromptPatch(brdPromptDrafts, [...brdPromptClearIds])
      if (promptPatch.invalid) {
        const { id, hasSystem, hasUser } = promptPatch.invalid
        activePromptId = id
        loadPromptEditor()
        statusEl.textContent = hasSystem || hasUser
          ? `${BRD_PROMPT_META[id].name}的 system 与 user 需同时填写`
          : `${BRD_PROMPT_META[id].name}如需清空，请使用“恢复内置默认”`
        statusEl.className = "badge bad"
        return
      }
      await window.octopus.setProjectBrdDesignConfig(selectedProjectId, {
        sources: {
          miniprogramCodePath: document.getElementById("brdMiniprogram")?.value ?? "",
          websiteCodePath: document.getElementById("brdWebsiteCode")?.value ?? "",
          frontendCodePath: document.getElementById("brdFrontend")?.value ?? "",
          backendCodePath: document.getElementById("brdBackend")?.value ?? "",
          miniprogramBuildArtifact: document.getElementById("brdMiniArtifact")?.value ?? "",
          websiteUrl: document.getElementById("brdWebsiteUrl")?.value ?? "",
        },
        brdSpecPath: document.getElementById("brdSpecPath")?.value ?? "",
        brdOutputPath: document.getElementById("brdOutputPath")?.value ?? "",
        prompts: promptPatch.prompts,
      })
      currentProject = await window.octopus.getProject(selectedProjectId)
      const savedConfig = await window.octopus.getProjectBrdDesignConfig(selectedProjectId)
      brdPromptConfig = savedConfig.prompts || {}
      brdPromptDrafts = {}
      brdPromptClearIds.clear()
      loadPromptEditor()
      const previewEl = document.getElementById("settingsBrdPromptPreview")
      if (previewEl) previewEl.hidden = true
      statusEl.textContent = "BRD 设置已保存"
      statusEl.className = "badge good"
    } catch (error) {
      showError(error)
    }
  })
  document.getElementById("settingsPreviewBrdPrompts")?.addEventListener("click", async () => {
    if (!selectedProjectId || !window.octopus.previewBrdPrompts) return
    const requirementId = document.getElementById("settingsBrdPreviewRequirement")?.value
    if (!requirementId) {
      statusEl.textContent = "请先在本项目下创建需求后再预览提示词"
      statusEl.className = "badge bad"
      return
    }
    try {
      const preview = await window.octopus.previewBrdPrompts(selectedProjectId, requirementId, {
        mode: "all",
        includeSummarize: true,
      })
      const previewEl = document.getElementById("settingsBrdPromptPreview")
      if (previewEl) {
        previewEl.hidden = false
        renderBrdPromptPreview(previewEl, preview)
      }
      statusEl.textContent = `已预览 ${preview.prompts.length} 条提示词`
      statusEl.className = "badge good"
    } catch (error) {
      showError(error)
    }
  })
  void loadBrdSettingsForm(loadPromptEditor)
}

function renderBrdPromptPreview(container, preview) {
  container.replaceChildren()
  const heading = document.createElement("div")
  heading.className = "brd-prompt-preview-heading"
  const headingText = document.createElement("div")
  const title = document.createElement("h4")
  title.textContent = "已保存提示词预览"
  const description = document.createElement("p")
  description.className = "muted"
  description.textContent = `已渲染变量 · 产出路径：${preview.outputPath || "未返回"}`
  headingText.append(title, description)
  const count = document.createElement("span")
  count.className = "badge info"
  count.textContent = `${preview.prompts.length} 条`
  heading.append(headingText, count)
  container.append(heading)

  if (preview.warnings?.length) {
    const warning = document.createElement("p")
    warning.className = "brd-prompt-warning"
    warning.textContent = preview.warnings.join("；")
    container.append(warning)
  }

  const list = document.createElement("div")
  list.className = "brd-prompt-preview-list"
  for (const item of preview.prompts) {
    const card = document.createElement("article")
    card.className = "brd-prompt-preview-card"
    const header = document.createElement("header")
    const name = document.createElement("strong")
    name.textContent = BRD_PROMPT_META[item.id]?.name || item.id
    const id = document.createElement("code")
    id.textContent = item.id
    header.append(name, id)
    card.append(header)
    for (const [label, value] of [["system", item.system], ["user", item.prompt]]) {
      const section = document.createElement("div")
      section.className = "brd-prompt-preview-section"
      const sectionLabel = document.createElement("span")
      sectionLabel.textContent = label
      const content = document.createElement("pre")
      content.textContent = value
      section.append(sectionLabel, content)
      card.append(section)
    }
    list.append(card)
  }
  container.append(list)
}

async function renderProjectVersions() {
  const host = document.getElementById("projectVersions")
  if (!host || !selectedProjectId) return
  host.innerHTML = `<div class="panel-card"><h3>Teambition 版本计划</h3><p class="muted">加载中…</p></div>`
  try {
    const versions = await window.octopus.listProjectVersions(selectedProjectId)
    const defaultId = currentProject?.teambitionVersion?.defaultVersionId || ""
    host.innerHTML = `
      <div class="panel-card">
        <div class="tb-actions"><button id="refreshProjectVersions" type="button">刷新版本</button><label>默认版本 <select id="projectDefaultVersion"><option value="">未设置</option>${versions.map((v) => `<option value="${escapeHtml(v.versionId)}"${v.versionId === defaultId ? " selected" : ""}>${escapeHtml(v.name)}</option>`).join("")}</select></label></div>
        <div id="projectVersionCards" class="hub-cards" style="margin-top:12px">${versions.length ? versions.map((v) => `<article class="hub-card"><h3>${escapeHtml(v.name)}</h3><div class="muted">${escapeHtml(v.status || "未标注状态")} · ${escapeHtml(v.startDate || "未排期")} → ${escapeHtml(v.endDate || "未排期")}</div><p>${escapeHtml(v.note || "暂无说明")}</p><button type="button" class="secondary version-note-btn" data-version-id="${escapeHtml(v.versionId)}">更新说明</button></article>`).join("") : `<div class="empty-state">暂无版本，或版本列表端点尚未确认。</div>`}</div>
      </div>`
    document.getElementById("refreshProjectVersions")?.addEventListener("click", async () => {
      try { await window.octopus.syncProjectVersions(selectedProjectId); await renderProjectVersions() } catch (error) { statusEl.textContent = readableError(error); statusEl.className = "badge bad" }
    })
    document.getElementById("projectDefaultVersion")?.addEventListener("change", async (event) => {
      try { currentProject = await window.octopus.setProjectDefaultVersion(selectedProjectId, event.target.value || null); statusEl.textContent = "默认版本已更新"; statusEl.className = "badge good" } catch (error) { statusEl.textContent = readableError(error); statusEl.className = "badge bad" }
    })
    for (const button of host.querySelectorAll(".version-note-btn")) button.onclick = async () => {
      const versionId = button.dataset.versionId
      const note = window.prompt("版本说明", versions.find((v) => v.versionId === versionId)?.note || "")
      if (note === null) return
      try { await window.octopus.updateVersionNote(selectedProjectId, versionId, note); await renderProjectVersions() } catch (error) { statusEl.textContent = readableError(error); statusEl.className = "badge bad" }
    }
  } catch (error) {
    host.innerHTML = `<div class="panel-card"><h3>Teambition 版本计划</h3><p class="bad">${escapeHtml(readableError(error))}</p></div>`
  }
}

function stopLogsPolling() {
  if (logsPollTimer) {
    clearInterval(logsPollTimer)
    logsPollTimer = null
  }
}

function ensureLogsPolling() {
  stopLogsPolling()
  if (!logsAutoRefresh || projectTab !== "logs" || currentView !== "project") return
  logsPollTimer = setInterval(() => {
    if (projectTab !== "logs" || currentView !== "project") {
      stopLogsPolling()
      return
    }
    void renderProjectLogs({ silent: true })
  }, 2000)
}

function logsRunKey(requirementId, runId) {
  return `${requirementId}::${runId}`
}

function formatLogsTime(value) {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString("zh-CN")
}

function openLogsForRun(requirementId, runId) {
  const projectId = selectedProjectId || currentState?.projectId
  if (!projectId) {
    statusEl.textContent = "无法定位项目，无法打开日志监控"
    statusEl.className = "badge bad"
    return
  }
  logsPendingFocus = { requirementId, runId }
  logsFilterRequirementId = requirementId
  logsSelectedRequirementId = requirementId
  logsSelectedRunId = runId
  logsDetailTab = "stdout"
  goToProject(projectId, "logs")
}

async function collectProjectLogRuns() {
  const summaries = requirementSummaries || []
  const nameById = new Map(summaries.map((item) => [item.requirementId, item.name || item.requirementId]))
  const requirementIds = logsFilterRequirementId
    ? [logsFilterRequirementId]
    : summaries.map((item) => item.requirementId)
  const collected = []
  for (const requirementId of requirementIds) {
    try {
      const runs = await window.octopus.runs(requirementId)
      for (const run of runs || []) {
        collected.push({
          ...run,
          requirementName: nameById.get(requirementId) || requirementId,
        })
      }
    } catch {
      // 单个需求失败不阻断整页
    }
  }
  collected.sort((a, b) => {
    const aTime = Date.parse(a.startedAt || a.finishedAt || a.heartbeatAt || "") || 0
    const bTime = Date.parse(b.startedAt || b.finishedAt || b.heartbeatAt || "") || 0
    return bTime - aTime
  })
  return collected
}

function filterLogRuns(runs) {
  return runs.filter((run) => {
    if (logsFilterNodeId && run.nodeId !== logsFilterNodeId) return false
    if (logsFilterStatus && run.status !== logsFilterStatus) return false
    return true
  })
}

async function renderProjectLogs(options = {}) {
  const host = document.getElementById("projectLogs")
  if (!host || !selectedProjectId) return
  const silent = options.silent === true
  const token = ++logsRenderToken

  if (logsPendingFocus) {
    logsFilterRequirementId = logsPendingFocus.requirementId
    logsSelectedRequirementId = logsPendingFocus.requirementId
    logsSelectedRunId = logsPendingFocus.runId
    logsPendingFocus = null
  }

  if (!silent) {
    host.innerHTML = `<div class="panel-card"><h3>日志监控</h3><p class="muted">加载运行记录…</p></div>`
  }

  try {
    const allRuns = await collectProjectLogRuns()
    if (token !== logsRenderToken) return
    const filteredRuns = filterLogRuns(allRuns)
    const nodeIds = [...new Set(allRuns.map((run) => run.nodeId).filter(Boolean))].sort()
    const statusIds = [...new Set(allRuns.map((run) => run.status).filter(Boolean))]

    if (logsSelectedRunId) {
      const selected = filteredRuns.find((run) =>
        run.id === logsSelectedRunId && (!logsSelectedRequirementId || run.requirementId === logsSelectedRequirementId))
        || allRuns.find((run) => run.id === logsSelectedRunId)
      if (selected) {
        logsSelectedRequirementId = selected.requirementId
        logsSelectedRunId = selected.id
      } else if (!silent) {
        logsSelectedRunId = ""
        logsSelectedRequirementId = logsFilterRequirementId || ""
      }
    }
    if (!logsSelectedRunId && filteredRuns[0]) {
      logsSelectedRequirementId = filteredRuns[0].requirementId
      logsSelectedRunId = filteredRuns[0].id
    }

    const eventsRequirementId = logsSelectedRequirementId || logsFilterRequirementId
    logsLoadedEvents = eventsRequirementId
      ? await window.octopus.events(eventsRequirementId, 0)
      : []
    if (token !== logsRenderToken) return

    if (logsSelectedRunId && logsSelectedRequirementId && (logsDetailTab === "stdout" || logsDetailTab === "stderr")) {
      logsSlice = await window.octopus.readRunLogs(logsSelectedRequirementId, logsSelectedRunId, {
        stream: logsDetailTab,
        maxBytes: 262144,
      })
    } else {
      logsSlice = null
    }
    if (token !== logsRenderToken) return

    const requirementOptions = [`<option value="">全部需求</option>`]
      .concat((requirementSummaries || []).map((item) =>
        `<option value="${escapeHtml(item.requirementId)}"${item.requirementId === logsFilterRequirementId ? " selected" : ""}>${escapeHtml(item.name || item.requirementId)}</option>`))
      .join("")
    const nodeOptions = [`<option value="">全部节点</option>`]
      .concat(nodeIds.map((nodeId) =>
        `<option value="${escapeHtml(nodeId)}"${nodeId === logsFilterNodeId ? " selected" : ""}>${escapeHtml(nodeId)}</option>`))
      .join("")
    const statusOptions = [`<option value="">全部状态</option>`]
      .concat(statusIds.map((status) =>
        `<option value="${escapeHtml(status)}"${status === logsFilterStatus ? " selected" : ""}>${escapeHtml(runStatusLabel(status))}</option>`))
      .join("")

    const runListMarkup = filteredRuns.length === 0
      ? `<div class="empty-state">暂无匹配的运行记录。</div>`
      : filteredRuns.map((run) => {
        const selected = run.id === logsSelectedRunId && run.requirementId === logsSelectedRequirementId
        return `
          <button type="button" class="logs-run-item${selected ? " is-selected" : ""}" data-logs-run="${escapeHtml(logsRunKey(run.requirementId, run.id))}">
            <div class="logs-run-meta">
              <span class="badge ${run.status === "SUCCEEDED" ? "good" : run.status === "FAILED" || run.status === "TIMED_OUT" || run.status === "INTERRUPTED" ? "bad" : "warn"}">${escapeHtml(runStatusLabel(run.status))}</span>
              ${run.forced ? `<span class="badge warn">强制</span>` : ""}
              <span class="muted">${escapeHtml(formatLogsTime(run.startedAt || run.finishedAt || run.heartbeatAt))}</span>
            </div>
            <div><strong>${escapeHtml(run.requirementName || run.requirementId)}</strong> · ${escapeHtml(run.nodeId)}</div>
            <div class="logs-run-id muted">${escapeHtml(run.id)}</div>
            ${run.error ? `<div class="logs-run-error">${escapeHtml(run.error)}</div>` : ""}
          </button>`
      }).join("")

    let detailBody = ""
    if (!logsSelectedRunId) {
      detailBody = `<p class="muted">选择左侧运行记录以查看日志。</p>`
    } else if (logsDetailTab === "events") {
      detailBody = logsLoadedEvents.length === 0
        ? `<p class="muted">该需求暂无执行事件。</p>`
        : `<div class="logs-events">${logsLoadedEvents.slice().reverse().map((event) => `
            <div class="logs-event">
              <div class="logs-event-head">
                <span class="badge">${escapeHtml(event.type)}</span>
                <span class="muted">${escapeHtml(formatLogsTime(event.createdAt))}</span>
                ${event.nodeId ? `<span class="muted">${escapeHtml(event.nodeId)}</span>` : ""}
                ${event.runId ? `<span class="muted">${escapeHtml(event.runId)}</span>` : ""}
              </div>
              <code>${escapeHtml(JSON.stringify(event.payload || {}))}</code>
            </div>`).join("")}</div>`
    } else if (!logsSlice?.exists) {
      detailBody = `<p class="muted">日志尚未产生。</p>`
    } else {
      detailBody = `
        <p class="logs-hint muted">${escapeHtml(logsDetailTab)} · ${logsSlice.size} 字节${logsSlice.truncated ? " · 已截断，可加载更多" : ""}</p>
        <pre class="logs-console" id="logsConsole">${escapeHtml(logsSlice.content || "")}</pre>
        <div class="logs-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
          ${logsSlice.truncated ? `<button type="button" class="secondary" id="logsLoadMore">加载更多</button>` : ""}
          <button type="button" class="secondary" id="logsJumpEnd">跳到末尾</button>
        </div>`
    }

    host.innerHTML = `
      <div class="panel-card">
        <h3>日志监控</h3>
        <p class="help">聚合项目内节点运行记录与 stdout/stderr，支持按需求/节点筛选与自动刷新。</p>
        <div class="logs-toolbar">
          <div class="field"><label for="logsFilterRequirement">需求</label><select id="logsFilterRequirement">${requirementOptions}</select></div>
          <div class="field"><label for="logsFilterNode">节点</label><select id="logsFilterNode">${nodeOptions}</select></div>
          <div class="field"><label for="logsFilterStatus">状态</label><select id="logsFilterStatus">${statusOptions}</select></div>
          <div class="logs-actions">
            <label><input type="checkbox" id="logsAutoRefresh"${logsAutoRefresh ? " checked" : ""} /> 自动刷新</label>
            <button type="button" id="logsRefresh" class="secondary">刷新</button>
          </div>
        </div>
        <div class="logs-layout">
          <div>
            <div class="detail-section-title">运行列表 · ${filteredRuns.length}</div>
            <div class="logs-run-list">${runListMarkup}</div>
          </div>
          <div>
            <div class="detail-section-title">详情${logsSelectedRunId ? ` · ${escapeHtml(logsSelectedRunId)}` : ""}</div>
            <div class="logs-detail-tabs">
              <button type="button" class="secondary${logsDetailTab === "stdout" ? " active" : ""}" data-logs-tab="stdout">stdout</button>
              <button type="button" class="secondary${logsDetailTab === "stderr" ? " active" : ""}" data-logs-tab="stderr">stderr</button>
              <button type="button" class="secondary${logsDetailTab === "events" ? " active" : ""}" data-logs-tab="events">事件</button>
            </div>
            <div id="logsDetailBody">${detailBody}</div>
          </div>
        </div>
      </div>`

    document.getElementById("logsFilterRequirement")?.addEventListener("change", (event) => {
      logsFilterRequirementId = event.target.value || ""
      logsFilterNodeId = ""
      void renderProjectLogs()
    })
    document.getElementById("logsFilterNode")?.addEventListener("change", (event) => {
      logsFilterNodeId = event.target.value || ""
      void renderProjectLogs()
    })
    document.getElementById("logsFilterStatus")?.addEventListener("change", (event) => {
      logsFilterStatus = event.target.value || ""
      void renderProjectLogs()
    })
    document.getElementById("logsAutoRefresh")?.addEventListener("change", (event) => {
      logsAutoRefresh = Boolean(event.target.checked)
      ensureLogsPolling()
    })
    document.getElementById("logsRefresh")?.addEventListener("click", () => {
      void renderProjectLogs()
    })
    for (const button of host.querySelectorAll("[data-logs-run]")) {
      button.addEventListener("click", () => {
        const key = button.getAttribute("data-logs-run") || ""
        const sep = key.indexOf("::")
        if (sep <= 0) return
        logsSelectedRequirementId = key.slice(0, sep)
        logsSelectedRunId = key.slice(sep + 2)
        void renderProjectLogs()
      })
    }
    for (const button of host.querySelectorAll("[data-logs-tab]")) {
      button.addEventListener("click", () => {
        logsDetailTab = button.getAttribute("data-logs-tab") || "stdout"
        void renderProjectLogs()
      })
    }
    document.getElementById("logsLoadMore")?.addEventListener("click", async () => {
      if (!logsSelectedRequirementId || !logsSelectedRunId || !logsSlice) return
      try {
        const more = await window.octopus.readRunLogs(logsSelectedRequirementId, logsSelectedRunId, {
          stream: logsDetailTab === "stderr" ? "stderr" : "stdout",
          offset: logsSlice.nextOffset,
          maxBytes: 262144,
        })
        logsSlice = {
          ...more,
          content: `${logsSlice.content || ""}${more.content || ""}`,
          offset: logsSlice.offset,
        }
        const consoleEl = document.getElementById("logsConsole")
        if (consoleEl) consoleEl.textContent = logsSlice.content || ""
        const hint = host.querySelector(".logs-hint")
        if (hint) {
          hint.textContent = `${logsDetailTab} · ${more.size} 字节${more.truncated ? " · 已截断，可加载更多" : ""}`
        }
        if (!more.truncated) document.getElementById("logsLoadMore")?.remove()
      } catch (error) {
        showError(error)
      }
    })
    document.getElementById("logsJumpEnd")?.addEventListener("click", async () => {
      if (!logsSelectedRequirementId || !logsSelectedRunId) return
      try {
        const probe = await window.octopus.readRunLogs(logsSelectedRequirementId, logsSelectedRunId, {
          stream: logsDetailTab === "stderr" ? "stderr" : "stdout",
          offset: 0,
          maxBytes: 1,
        })
        const start = Math.max(0, probe.size - 262144)
        logsSlice = await window.octopus.readRunLogs(logsSelectedRequirementId, logsSelectedRunId, {
          stream: logsDetailTab === "stderr" ? "stderr" : "stdout",
          offset: start,
          maxBytes: 262144,
        })
        const consoleEl = document.getElementById("logsConsole")
        if (consoleEl) {
          consoleEl.textContent = logsSlice.content || ""
          consoleEl.scrollTop = consoleEl.scrollHeight
        }
      } catch (error) {
        showError(error)
      }
    })

    ensureLogsPolling()
  } catch (error) {
    if (token !== logsRenderToken) return
    host.innerHTML = `<div class="panel-card"><h3>日志监控</h3><p class="bad">${escapeHtml(readableError(error))}</p></div>`
    stopLogsPolling()
  }
}

async function loadBrdSettingsForm(onPromptsLoaded) {
  if (!selectedProjectId || !window.octopus.getProjectBrdDesignConfig) return
  try {
    const config = await window.octopus.getProjectBrdDesignConfig(selectedProjectId)
    brdPromptConfig = config.prompts || {}
    brdPromptDrafts = {}
    brdPromptClearIds.clear()
    const setValue = (id, value) => {
      const el = document.getElementById(id)
      if (el) el.value = value || ""
    }
    setValue("brdMiniprogram", config.sources?.miniprogramCodePath)
    setValue("brdWebsiteCode", config.sources?.websiteCodePath)
    setValue("brdFrontend", config.sources?.frontendCodePath)
    setValue("brdBackend", config.sources?.backendCodePath)
    setValue("brdMiniArtifact", config.sources?.miniprogramBuildArtifact)
    setValue("brdWebsiteUrl", config.sources?.websiteUrl)
    setValue("brdSpecPath", config.brdSpecPath)
    setValue("brdOutputPath", config.brdOutputPath)
    onPromptsLoaded?.()
  } catch (error) {
    showError(error)
  }
}

let kanbanDragData = null

function setupKanbanDragDrop(boardEl) {
  for (const card of boardEl.querySelectorAll(".kanban-card[draggable]")) {
    card.addEventListener("dragstart", (e) => {
      if (e.target.closest(".kanban-tb-status")) { e.preventDefault(); return }
      kanbanDragData = {
        requirementId: card.dataset.requirementId,
        fromPhase: card.dataset.phase,
      }
      e.dataTransfer.effectAllowed = "move"
      e.dataTransfer.setData("text/plain", card.dataset.requirementId)
      card.classList.add("dragging")
    })
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging")
      kanbanDragData = null
      for (const col of boardEl.querySelectorAll(".kanban-column.drag-over")) {
        col.classList.remove("drag-over")
      }
    })
  }
  for (const column of boardEl.querySelectorAll(".kanban-column")) {
    column.addEventListener("dragover", (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = "move"
      column.classList.add("drag-over")
    })
    column.addEventListener("dragleave", (e) => {
      if (!column.contains(e.relatedTarget)) column.classList.remove("drag-over")
    })
    column.addEventListener("drop", async (e) => {
      e.preventDefault()
      column.classList.remove("drag-over")
      if (!kanbanDragData) return
      const toPhase = column.dataset.phase
      if (kanbanDragData.fromPhase === toPhase) return
      try {
        await window.octopus.moveRequirementPhase(kanbanDragData.requirementId, toPhase)
        statusEl.textContent = `需求已移至「${phaseLabel(toPhase)}」`
        statusEl.className = "badge good"
        await loadRequirementSummaries(selectedProjectId)
        renderProjectPage()
      } catch (error) {
        showError(error)
        await loadRequirementSummaries(selectedProjectId)
        renderProjectPage()
      }
      kanbanDragData = null
    })
  }
}

function renderProjectPage() {
  if (!requirementCardsEl || !projectEmptyEl) return
  if (window.OctopusGantt?.isDragging?.()) return
  parkHubGantt()
  if (projectTab !== "logs") stopLogsPolling()
  const tabTitles = {
    board: "看板",
    list: "列表",
    table: "表格",
    gantt: "甘特",
    versions: "版本",
    logs: "日志",
    overview: "概览",
    settings: "设置",
  }
  if (projectPageTitleEl) {
    projectPageTitleEl.textContent = currentProject
      ? `${currentProject.name || currentProject.projectId} · ${tabTitles[projectTab] || "看板"}`
      : "项目需求"
  }
  renderProjectTbPanel()
  syncProjectTabs()

  const kanbanBoardEl = document.getElementById("kanbanBoard")
  const kanbanEmptyEl = document.getElementById("kanbanEmpty")
  const projectSettingsEl = document.getElementById("projectSettings")
  const projectVersionsEl = document.getElementById("projectVersions")
  const projectLogsEl = document.getElementById("projectLogs")
  const requirementTableEl = document.getElementById("requirementTable")
  const projectOverviewEl = document.getElementById("projectOverview")
  const createRequirementPanel = document.getElementById("createRequirementPanel")
  const settingsPanel = document.getElementById("settingsPanel")

  if (kanbanBoardEl) kanbanBoardEl.hidden = projectTab !== "board"
  if (kanbanEmptyEl) kanbanEmptyEl.hidden = projectTab !== "board"
  if (requirementCardsEl) requirementCardsEl.hidden = projectTab !== "list"
  if (projectEmptyEl) projectEmptyEl.hidden = ["settings", "gantt", "versions", "logs", "table", "overview"].includes(projectTab)
  if (projectSettingsEl) projectSettingsEl.hidden = projectTab !== "settings"
  if (projectVersionsEl) projectVersionsEl.hidden = projectTab !== "versions"
  if (projectLogsEl) projectLogsEl.hidden = projectTab !== "logs"
  if (requirementTableEl) requirementTableEl.hidden = projectTab !== "table"
  if (projectOverviewEl) projectOverviewEl.hidden = projectTab !== "overview"
  if (projectGanttHostEl) {
    projectGanttHostEl.hidden = projectTab !== "gantt"
    if (projectTab !== "gantt" && projectGanttMounted) unmountProjectGantt()
  }
  if (createRequirementPanel) createRequirementPanel.hidden = ["settings", "versions", "logs", "table", "overview"].includes(projectTab)
  if (settingsPanel) settingsPanel.hidden = projectTab !== "settings"

  if (projectTab === "board") {
    renderKanbanBoard()
    return
  }
  if (projectTab === "gantt") {
    parkHubGantt()
    collapseHubSchedule()
    renderProjectGantt()
    return
  }
  if (projectTab === "settings") {
    renderProjectSettings()
    return
  }
  if (projectTab === "table") {
    renderRequirementTable()
    return
  }
  if (projectTab === "overview") {
    void renderProjectOverview()
    return
  }
  if (projectTab === "versions") {
    void renderProjectVersions()
    return
  }
  if (projectTab === "logs") {
    void renderProjectLogs()
    return
  }

  let built = buildRequirementCardsMarkup(requirementSummaries, {
    filter: projectFilter,
    lastCreatedId: lastCreatedRequirementId,
    expandedScheduleId,
  })
  if (expandedScheduleId && !built.filtered.some((item) => item.requirementId === expandedScheduleId)) {
    collapseHubSchedule()
    built = buildRequirementCardsMarkup(requirementSummaries, {
      filter: projectFilter,
      lastCreatedId: lastCreatedRequirementId,
      expandedScheduleId,
    })
  }
  if (built.kind === "empty") {
    projectEmptyEl.hidden = false
    requirementCardsEl.innerHTML = ""
    return
  }
  projectEmptyEl.hidden = true
  requirementCardsEl.innerHTML = built.html
  if (built.kind !== "cards") return

  for (const card of requirementCardsEl.querySelectorAll(".hub-card")) {
    const requirementId = card.dataset.requirementId
    const editPanel = card.querySelector(".hub-card-edit")
    const actions = card.querySelector(".hub-card-main-actions")
    card.querySelector("[data-open]").onclick = () => goToRequirement(requirementId)
    card.querySelector("[data-schedule]").onclick = () => {
      toggleHubSchedule(requirementId).catch(showError)
    }
    card.querySelector("[data-edit]").onclick = () => {
      editPanel.hidden = false
      if (actions) actions.hidden = true
    }
    card.querySelector("[data-cancel-edit]").onclick = () => {
      editPanel.hidden = true
      if (actions) actions.hidden = false
    }
    card.querySelector("[data-save]").onclick = async () => {
      const name = card.querySelector(".edit-name").value.trim()
      const description = card.querySelector(".edit-desc").value
      if (!name) {
        statusEl.textContent = "需求名称不能为空"
        statusEl.className = "badge warn"
        return
      }
      try {
        await window.octopus.updateRequirement(requirementId, { name, description })
        statusEl.textContent = "需求已更新"
        statusEl.className = "badge good"
        await showProjectPage(selectedProjectId)
      } catch (error) {
        showError(error)
      }
    }
    card.querySelector("[data-delete]").onclick = async () => {
      const item = requirementSummaries.find((entry) => entry.requirementId === requirementId)
      const label = item?.requirementName || requirementId
      if (!await confirmAction(`删除需求「${label}」的状态？\n只删除状态库记录，不会删除源码目录。此操作不可恢复。`, "删除需求", "error")) {
        return
      }
      try {
        await window.octopus.deleteRequirement(requirementId)
        if (lastCreatedRequirementId === requirementId) lastCreatedRequirementId = ""
        if (selectedRequirement === requirementId) selectedRequirement = undefined
        if (expandedScheduleId === requirementId) collapseHubSchedule()
        statusEl.textContent = "需求已删除"
        statusEl.className = "badge good"
        await showProjectPage(selectedProjectId)
      } catch (error) {
        showError(error)
      }
    }
  }

  if (expandedScheduleId) {
    let expandedCard
    for (const card of requirementCardsEl.querySelectorAll(".hub-card")) {
      if (card.dataset.requirementId === expandedScheduleId) {
        expandedCard = card
        break
      }
    }
    if (expandedCard && hubGanttHostEl) {
      expandedCard.appendChild(hubGanttHostEl)
      hubGanttHostEl.hidden = false
      renderHubGantt()
    }
  }
}

async function showHub() {
  selectedRequirement = undefined
  selectedProjectId = undefined
  selectedNode = undefined
  currentProject = null
  collapseHubSchedule()
  unmountProjectGantt()
  await loadProjectSummaries()
  setChrome("hub")
  renderHub()
  const mineEl = document.getElementById("mineView")
  if (mineEl) mineEl.hidden = true
  projectLabelEl.textContent = "项目管理中心"
  statusEl.textContent = projectSummaries.length ? `${projectSummaries.length} 个项目` : "暂无项目"
  statusEl.className = "badge"
}

async function showMine() {
  selectedRequirement = undefined
  selectedProjectId = undefined
  currentProject = null
  collapseHubSchedule()
  unmountProjectGantt()
  await loadProjectSummaries()
  setChrome("hub")
  if (hubEmptyEl) hubEmptyEl.hidden = true
  if (hubCardsEl) hubCardsEl.hidden = true
  const mineEl = document.getElementById("mineView")
  if (mineEl) { mineEl.hidden = false; await renderMine() }
  projectLabelEl.textContent = "我的工作"
  statusEl.textContent = "我的工作"
  statusEl.className = "badge"
}

async function showProjectPage(projectId, tab) {
  selectedRequirement = undefined
  selectedNode = undefined
  projectTab = tab === "list" ? "table" : tab || "board"
  try {
    currentProject = await window.octopus.getProject(projectId)
  } catch {
    // 旧链接可能把需求 ID 当成 project/:id —— 尝试重定向到需求工作区
    try {
      await window.octopus.getState(projectId)
      setHash(`requirement/${encodeURIComponent(projectId)}`, true)
      await openWorkspace(projectId)
      return
    } catch {
      setHash("hub", true)
      await showHub()
      statusEl.textContent = "项目不存在或已删除"
      statusEl.className = "badge warn"
      return
    }
  }
  selectedProjectId = projectId
  await loadRequirementSummaries(projectId)
  setChrome("project")
  renderProjectPage()
  projectLabelEl.textContent = currentProject.name || projectId
  statusEl.textContent = `${requirementSummaries.length} 个需求`
  statusEl.className = "badge"
}

async function openWorkspace(requirementId) {
  let state
  try {
    state = await window.octopus.getState(requirementId)
  } catch {
    setHash("hub", true)
    await showHub()
    statusEl.textContent = "需求不存在或已删除"
    statusEl.className = "badge warn"
    return
  }
  selectedProjectId = state.projectId
  unmountProjectGantt()
  await loadRequirementSummaries(state.projectId)
  try {
    currentProject = await window.octopus.getProject(state.projectId)
  } catch {
    currentProject = { projectId: state.projectId, name: state.projectId }
  }
  setChrome("workspace")
  renderSidebar(requirementId)
  await showRequirement(requirementId)
}

async function applyRoute() {
  const route = routeFromHash()
  if (route.view === "hub") {
    await showHub()
    return
  }
  if (route.view === "mine") { await showMine(); return }
  if (route.view === "project") await showProjectPage(route.projectId, route.projectTab)
  else if (route.view === "workspace") await openWorkspace(route.requirementId)
  else await showHub()
}

function fillTbStatusSelect(statuses, selectedId) {
  if (!tbStatusSelectEl) return
  const options = [`<option value="">选择状态…</option>`]
  for (const status of statuses || []) {
    const id = status.id || status.statusId || ""
    const name = status.name || status.statusName || id
    if (!id) continue
    options.push(`<option value="${escapeHtml(id)}"${selectedId === id ? " selected" : ""}>${escapeHtml(name)}</option>`)
  }
  tbStatusSelectEl.innerHTML = options.join("")
}

async function refreshRequirementTbBar() {
  if (!requirementTbLabelEl) return
  const binding = currentState?.teambition
  if (!binding?.taskId && !binding?.taskRef) {
    requirementTbLabelEl.textContent = "Teambition 任务未绑定"
    if (tbTaskRefEl && !tbTaskRefEl.value) tbTaskRefEl.placeholder = "任务编号或 ID"
    return
  }
  const label = binding.statusName
    ? `TB：${binding.taskRef || binding.taskId} · ${binding.statusName}`
    : `TB：${binding.taskRef || binding.taskId}`
  requirementTbLabelEl.textContent = label
  if (tbTaskRefEl && !tbTaskRefEl.value) {
    tbTaskRefEl.value = binding.taskRef || binding.taskId || ""
  }
  if (selectedProjectId && cardStatusesCache.length === 0) {
    try {
      cardStatusesCache = await window.octopus.listTeambitionCardStatuses(selectedProjectId)
      fillTbStatusSelect(cardStatusesCache, binding.statusId)
    } catch {
      // 凭据缺失等错误在按钮操作时再提示
    }
  } else {
    fillTbStatusSelect(cardStatusesCache, binding?.statusId)
  }
}

async function refreshRequirementVersionBar() {
  if (!requirementVersionLabelEl || !selectedRequirement) return
  const binding = currentState?.teambitionVersion
  requirementVersionLabelEl.textContent = binding?.versionName ? `版本：${binding.versionName}` : "版本未绑定"
  if (!requirementVersionSelectEl) return
  const ownerInput = document.getElementById("requirementOwnerInput")
  if (ownerInput) ownerInput.value = currentState?.owner || ""
  try {
    const versions = await window.octopus.listProjectVersions(selectedProjectId)
    requirementVersionSelectEl.innerHTML = `<option value="">选择版本…</option>${versions.map((v) => `<option value="${escapeHtml(v.versionId)}"${v.versionId === binding?.versionId ? " selected" : ""}>${escapeHtml(v.name)}</option>`).join("")}`
  } catch (error) {
    requirementVersionSelectEl.innerHTML = `<option value="">${escapeHtml(readableError(error))}</option>`
  }
}

function fillMilestoneSelects(selectedPhase, selectedNodeId) {
  if (milestonePhaseEl) {
    const options = [`<option value="">不挂钩</option>`]
    for (const phase of PHASE_ORDER) {
      const selected = phase === selectedPhase ? " selected" : ""
      options.push(`<option value="${escapeHtml(phase)}"${selected}>${escapeHtml(phaseLabel(phase))}</option>`)
    }
    milestonePhaseEl.innerHTML = options.join("")
  }
  if (milestoneNodeEl) {
    const options = [`<option value="">不挂钩</option>`]
    for (const step of currentState?.steps || []) {
      const selected = step.id === selectedNodeId ? " selected" : ""
      options.push(`<option value="${escapeHtml(step.id)}"${selected}>${escapeHtml(step.name || step.id)}</option>`)
    }
    milestoneNodeEl.innerHTML = options.join("")
  }
}

function hideMilestoneForm() {
  if (milestoneFormEl) milestoneFormEl.hidden = true
  if (milestoneEditIdEl) milestoneEditIdEl.value = ""
}

function openMilestoneForm(milestone) {
  if (!milestoneFormEl) return
  fillMilestoneSelects(milestone?.phase, milestone?.nodeId)
  if (milestoneEditIdEl) milestoneEditIdEl.value = milestone?.id || ""
  if (milestoneNameEl) milestoneNameEl.value = milestone?.name || ""
  if (milestoneDateEl) milestoneDateEl.value = milestone?.date || ""
  if (milestoneNoteEl) milestoneNoteEl.value = milestone?.note || ""
  if (reachMilestoneEl) reachMilestoneEl.hidden = !milestone || milestone.status === "reached"
  if (unreachMilestoneEl) unreachMilestoneEl.hidden = !milestone || milestone.status !== "reached"
  if (deleteMilestoneEl) deleteMilestoneEl.hidden = !milestone
  milestoneFormEl.hidden = false
  milestoneNameEl?.focus()
}

function renderRequirementMilestoneBar() {
  if (!milestoneChipsEl) return
  const planned = workspaceMilestones.filter((item) => item.status === "planned")
  const reached = workspaceMilestones.filter((item) => item.status === "reached")
  const visible = showReachedMilestones ? [...planned, ...reached] : planned.slice(0, 3)
  const extra = !showReachedMilestones && planned.length > 3 ? planned.length - 3 : 0
  const today = new Date()
  const todayYmd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`
  const chips = visible.map((item) => {
    const overdue = item.status === "planned" && item.date < todayYmd
    return `<button type="button" class="milestone-chip${overdue ? " is-overdue" : ""}" data-milestone-id="${escapeHtml(item.id)}">${escapeHtml(item.name)} ${escapeHtml(formatMilestoneDate(item.date))}${overdue ? "（逾期）" : item.status === "reached" ? "（已达成）" : ""}</button>`
  })
  if (extra > 0) chips.push(`<span class="muted">还有 ${extra} 个</span>`)
  if (!workspaceMilestones.length) chips.push(`<span class="muted">尚未添加</span>`)
  milestoneChipsEl.innerHTML = chips.join("")
  for (const chip of milestoneChipsEl.querySelectorAll("[data-milestone-id]")) {
    chip.onclick = () => {
      const item = workspaceMilestones.find((entry) => entry.id === chip.dataset.milestoneId)
      if (item) openMilestoneForm(item)
    }
  }
  if (toggleReachedMilestonesEl) {
    toggleReachedMilestonesEl.hidden = reached.length === 0
    toggleReachedMilestonesEl.textContent = showReachedMilestones ? "收起已达成" : `已达成 ${reached.length}`
  }
}

async function refreshRequirementMilestoneBar() {
  if (!selectedRequirement || !window.octopus.listMilestones) {
    workspaceMilestones = []
    renderRequirementMilestoneBar()
    return
  }
  workspaceMilestones = await window.octopus.listMilestones(selectedRequirement)
  renderRequirementMilestoneBar()
}

async function showRequirement(id) {
  if (!id) return
  selectedRequirement = id
  const [state, snapshot] = await Promise.all([
    window.octopus.getState(id),
    window.octopus.getExecutionSnapshot(id),
  ])
  currentState = state
  currentSnapshot = snapshot
  let workflowDefinition
  try {
    workflowDefinition = await window.octopus.getWorkflowDefinition?.(id)
  } catch {
    workflowDefinition = undefined
  }
  currentGraphNodes = buildWorkflowGraphNodes(currentState, workflowDefinition)
  try {
    currentStatus = await window.octopus.getRequirementStatus(id)
    requirementMeta.set(id, {
      requirementName: currentStatus.requirementName,
      currentPhase: currentStatus.currentPhase,
      projectId: currentStatus.projectId,
    })
  } catch {
    currentStatus = undefined
  }

  for (const el of projectsEl.querySelectorAll(".project")) {
    el.classList.toggle("active", el.dataset.requirementId === id)
  }

  const requirementName = currentState.requirementName || currentStatus?.requirementName || id
  projectLabelEl.textContent = `${requirementName} · ${phaseLabel(currentState.currentPhase)}`
  renderSummary()
  renderGraph()
  await refreshRequirementTbBar()
  await refreshRequirementVersionBar()
  await refreshRequirementMilestoneBar()
  if (selectedNode) await showNode(selectedNode)
}

function renderSummary() {
  const active = currentSnapshot.activeRuns.length
  const ready = currentSnapshot.readyNodeIds.length
  const waiting = currentSnapshot.waitingNodeIds.length
  const completed = currentState.steps.filter((step) => step.status === "COMPLETED").length
  const total = currentGraphNodes.length || currentState.steps.length
  const blocked = currentState.steps.filter((step) => step.status === "BLOCKED").length

  summaryEl.innerHTML = [
    metric(active, "活动运行", "正在执行的节点实例"),
    metric(ready, "可运行节点", "依赖已满足，可立即启动"),
    metric(waiting, "等待处理", "需手动完成或等待依赖"),
    metric(`${completed}/${total}`, "节点进度", blocked ? `其中 ${blocked} 个已阻塞` : "完整需求流程节点"),
  ].join("")

  const scheduler = currentSnapshot.schedulerStatus
  statusEl.textContent = `调度：${schedulerLabel(scheduler)}`
  statusEl.className = `badge ${scheduler === "BLOCKED" ? "bad" : scheduler === "COMPLETED" ? "good" : scheduler === "RUNNING" ? "info" : "warn"}`
  document.getElementById("lastUpdate").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`

  const phase = phaseLabel(currentState.currentPhase)
  const phaseHint = PHASE_HINTS[currentState.currentPhase] || ""
  if (flowHintEl) {
    flowHintEl.textContent = `当前阶段：${phase}${phaseHint ? `（${phaseHint}）` : ""}（整行高亮）。上方=角色（人），左侧=阶段；灰色节点尚未激活，多角色显示在卡片底部；拖拽空白处平移，Ctrl/⌘+滚轮缩放。`
  }
  applyGraphZoom()
}

function metric(value, label, tip) {
  return `<div class="metric"><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small>${tip ? `<span class="tip">${escapeHtml(tip)}</span>` : ""}</div>`
}

function applyGraphZoom() {
  if (zoomLabelEl) zoomLabelEl.textContent = `${Math.round(graphZoom * 100)}%`
  if (!graphScalerEl || !graphEl) return
  const width = Number(graphEl.getAttribute("width") || 0)
  const height = Number(graphEl.getAttribute("height") || 0)
  graphScalerEl.style.transform = `scale(${graphZoom})`
  // 放大用 transform，同时撑开布局尺寸，保证滚动条能滚到全部内容
  graphScalerEl.style.width = width ? `${Math.ceil(width * graphZoom)}px` : "auto"
  graphScalerEl.style.height = height ? `${Math.ceil(height * graphZoom)}px` : "auto"
  // 内容小于可视区时居中（减去 wrap 内边距，避免贴死边缘）
  if (graphWrapEl && width > 0 && height > 0) {
    const padX = 16 // 左右 padding
    const padY = 28 // 12(上) + 16(下)
    const centered = width * graphZoom < graphWrapEl.clientWidth - padX ||
      height * graphZoom < graphWrapEl.clientHeight - padY
    graphWrapEl.classList.toggle("is-centered", centered)
  }
}

function setGraphZoom(next, anchor) {
  const before = graphZoom
  const clamped = Math.min(5, Math.max(0.2, Math.round(next * 100) / 100))
  if (clamped === before) {
    applyGraphZoom()
    return
  }
  graphZoom = clamped
  applyGraphZoom()
  if (!graphWrapEl || !anchor || !(before > 0)) return
  const rect = graphWrapEl.getBoundingClientRect()
  const offsetX = anchor.clientX - rect.left + graphWrapEl.scrollLeft
  const offsetY = anchor.clientY - rect.top + graphWrapEl.scrollTop
  const ratio = graphZoom / before
  graphWrapEl.scrollLeft = offsetX * ratio - (anchor.clientX - rect.left)
  graphWrapEl.scrollTop = offsetY * ratio - (anchor.clientY - rect.top)
}

function setupGraphWheelZoom() {
  if (!graphWrapEl) return
  graphWrapEl.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return
    event.preventDefault()
    const intensity = Math.min(0.35, Math.abs(event.deltaY) / 240)
    const direction = event.deltaY > 0 ? -1 : 1
    setGraphZoom(direction > 0
      ? graphZoom * (1 + Math.max(0.08, intensity))
      : graphZoom / (1 + Math.max(0.08, intensity)), {
      clientX: event.clientX,
      clientY: event.clientY,
    })
  }, { passive: false })
}

function scrollNodeIntoView(nodeId) {
  if (!graphWrapEl || !graphEl || graphPan) return
  const nodeGroup = [...graphEl.querySelectorAll(".node")]
    .find((element) => element.getAttribute("data-node-id") === nodeId)
  if (!nodeGroup) return
  const transform = nodeGroup.getAttribute("transform") || ""
  const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transform)
  if (!match) return
  const card = nodeGroup.querySelector(".card")
  const nodeWidth = Number(card?.getAttribute("width") || 0) * graphZoom
  const nodeHeight = Number(card?.getAttribute("height") || 0) * graphZoom
  const centerX = Number(match[1]) * graphZoom + nodeWidth / 2
  const centerY = Number(match[2]) * graphZoom + nodeHeight / 2
  graphWrapEl.scrollTo({
    left: Math.max(0, centerX - graphWrapEl.clientWidth / 2),
    top: Math.max(0, centerY - graphWrapEl.clientHeight / 2),
    behavior: "smooth",
  })
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name)
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value))
  }
  return el
}

function addSvgText(parent, x, y, text, className, extra = {}) {
  const el = svgEl("text", { x, y, class: className, ...extra })
  el.textContent = text
  parent.appendChild(el)
  return el
}

function wrapLabel(text, maxChars, maxLines = 2) {
  const value = String(text || "")
  if (value.length <= maxChars) return [value]
  const lines = []
  let rest = value
  while (rest.length && lines.length < maxLines) {
    if (rest.length <= maxChars || lines.length === maxLines - 1) {
      lines.push(truncate(rest, maxChars))
      break
    }
    let cut = maxChars
    const slice = rest.slice(0, maxChars)
    const breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("，"), slice.lastIndexOf("、"), slice.lastIndexOf("/"))
    if (breakAt >= Math.floor(maxChars * 0.45)) cut = breakAt + 1
    lines.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  return lines
}

function renderRoleLegend(roles) {
  if (!roleLegendEl) return
  if (!roles.length) {
    roleLegendEl.textContent = "暂无角色列"
    return
  }
  roleLegendEl.innerHTML = roles.map((role) => {
    const color = ROLE_COLORS[role] || "#64748b"
    return `<span class="role-chip"><span class="swatch" style="background:${color}"></span>${escapeHtml(roleLabel(role))}（${escapeHtml(role)}）</span>`
  }).join("")
}

function renderNodeLocator(nodes) {
  if (!nodeLocatorEl) return
  const options = [document.createElement("option")]
  options[0].value = ""
  options[0].textContent = nodes.length ? `快速定位节点（${nodes.length}）` : "暂无可定位节点"
  for (const node of [...nodes].sort((left, right) => String(left.id).localeCompare(String(right.id)))) {
    const option = document.createElement("option")
    option.value = node.id
    option.textContent = `${node.id} · ${nodeNameZh(node)} · ${statusLabel(node.status)}`
    options.push(option)
  }
  nodeLocatorEl.replaceChildren(...options)
  nodeLocatorEl.disabled = nodes.length === 0
  nodeLocatorEl.value = nodes.some((node) => node.id === selectedNode) ? selectedNode : ""
}

function renderGraph() {
  graphEl.replaceChildren()
  const nodes = currentGraphNodes
  renderNodeLocator(nodes)
  if (!nodes.length) {
    graphEl.setAttribute("width", "960")
    graphEl.setAttribute("height", "280")
    graphEl.setAttribute("viewBox", "0 0 960 280")
    addSvgText(graphEl, 40, 80, "当前阶段暂无节点。推进阶段后会激活后续节点。", "empty-graph-text")
    renderRoleLegend([])
    applyGraphZoom()
    return
  }

  // 上方：角色（人）；左侧：阶段；当前阶段整行高亮
  const nodeW = 250
  const nodeH = 128
  const nodeGapY = 18
  const phaseHeaderW = 156
  const roleHeaderH = 72
  const cellPadX = 20
  const cellPadY = 18
  const margin = 20

  const presentRoles = new Set(nodes.flatMap((node) => nodeRoles(node)))
  const roles = [
    ...ROLE_ORDER.filter((role) => presentRoles.has(role)),
    ...[...presentRoles].filter((role) => !ROLE_ORDER.includes(role)).sort(),
  ]
  const presentPhases = new Set(nodes.map((node) => node.phase))
  const phases = [
    ...PHASE_ORDER.filter((phase) => presentPhases.has(phase)),
    ...[...presentPhases].filter((phase) => !PHASE_ORDER.includes(phase)),
  ]

  // 格子：阶段 × 角色
  const cellMap = new Map()
  for (const node of nodes) {
    const key = `${node.phase}::${node.responsibleRole || "DEV"}`
    if (!cellMap.has(key)) cellMap.set(key, [])
    cellMap.get(key).push(node)
  }
  for (const list of cellMap.values()) {
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }

  // 角色列宽（固定大卡片宽，便于对齐）
  const roleColW = cellPadX * 2 + nodeW
  // 阶段行高 = 该阶段内任一角色格子中节点数（纵向堆叠）
  const phaseHeights = phases.map((phase) => {
    const maxInRole = Math.max(
      1,
      ...roles.map((role) => (cellMap.get(`${phase}::${role}`) || []).length),
    )
    return cellPadY * 2 + maxInRole * nodeH + Math.max(0, maxInRole - 1) * nodeGapY
  })

  const width = margin * 2 + phaseHeaderW + roles.length * roleColW
  const height = margin * 2 + roleHeaderH + phaseHeights.reduce((sum, h) => sum + h, 0)

  graphEl.setAttribute("width", String(width))
  graphEl.setAttribute("height", String(height))
  graphEl.setAttribute("viewBox", `0 0 ${width} ${height}`)

  const defs = svgEl("defs")
  const marker = svgEl("marker", {
    id: "arrow",
    viewBox: "0 0 12 12",
    refX: "10",
    refY: "6",
    markerWidth: "9",
    markerHeight: "9",
    orient: "auto-start-reverse",
  })
  marker.appendChild(svgEl("path", { d: "M 0 0 L 12 6 L 0 12 z", fill: "var(--edge, #c0c4cc)" }))
  const markerActive = svgEl("marker", {
    id: "arrow-active",
    viewBox: "0 0 12 12",
    refX: "10",
    refY: "6",
    markerWidth: "9",
    markerHeight: "9",
    orient: "auto-start-reverse",
  })
  markerActive.appendChild(svgEl("path", { d: "M 0 0 L 12 6 L 0 12 z", fill: ACCENT }))
  defs.appendChild(marker)
  defs.appendChild(markerActive)
  graphEl.appendChild(defs)

  const originX = margin
  const originY = margin
  const currentPhase = currentState.currentPhase
  const currentRoleSet = new Set(
    nodes
      .filter((node) => isCurrentNode(node.id) || currentSnapshot.readyNodeIds.includes(node.id))
      .flatMap((node) => nodeRoles(node)),
  )

  // 左上角说明
  graphEl.appendChild(svgEl("rect", {
    x: originX, y: originY, width: phaseHeaderW, height: roleHeaderH, class: "phase-header",
  }))
  addSvgText(graphEl, originX + 16, originY + 30, "角色（人）→", "corner-label")
  addSvgText(graphEl, originX + 16, originY + 52, "阶段 ↓", "phase-sub")

  // 顶部：角色列头
  const roleBounds = []
  roles.forEach((role, index) => {
    const x = originX + phaseHeaderW + index * roleColW
    const color = ROLE_COLORS[role] || "#64748b"
    const isActiveRole = currentRoleSet.has(role)
    graphEl.appendChild(svgEl("rect", {
      x, y: originY, width: roleColW, height: roleHeaderH,
      class: `role-header${isActiveRole ? " current-role" : ""}`,
    }))
    // 顶部角色色条
    graphEl.appendChild(svgEl("rect", {
      x, y: originY, width: roleColW, height: 6, fill: color,
    }))
    if (isActiveRole) {
      graphEl.appendChild(svgEl("rect", {
        x, y: originY + roleHeaderH - 3, width: roleColW, height: 3, fill: ACCENT,
      }))
    }
    addSvgText(graphEl, x + 16, originY + 34, roleLabel(role), "role-header-text")
    addSvgText(graphEl, x + 16, originY + 54, isActiveRole ? `${role} · 当前` : role, "role-header-sub")
    roleBounds.push({ role, x, width: roleColW, color })
  })

  // 阶段行 + 背景
  const phaseBounds = []
  let phaseY = originY + roleHeaderH
  phases.forEach((phase, phaseIndex) => {
    const h = phaseHeights[phaseIndex]
    const isCurrent = phase === currentPhase
    // 行背景（按角色列斑马纹）
    roleBounds.forEach((roleBound, roleIndex) => {
      const base = roleIndex % 2 === 0 ? "lane-bg" : "lane-bg alt"
      graphEl.appendChild(svgEl("rect", {
        x: roleBound.x, y: phaseY, width: roleBound.width, height: h,
        class: isCurrent ? "lane-bg current" : base,
      }))
    })
    // 左侧阶段标签
    graphEl.appendChild(svgEl("rect", {
      x: originX, y: phaseY, width: phaseHeaderW, height: h,
      class: `phase-header${isCurrent ? " current" : ""}`,
    }))
    if (isCurrent) {
      graphEl.appendChild(svgEl("rect", {
        x: originX, y: phaseY, width: 6, height: h, fill: ACCENT,
      }))
    }
    addSvgText(
      graphEl,
      originX + 18,
      phaseY + 28,
      phaseLabel(phase),
      `phase-label${isCurrent ? " current" : ""}`,
    )
    addSvgText(
      graphEl,
      originX + 18,
      phaseY + 50,
      isCurrent ? `当前 · ${PHASE_HINTS[phase] || phase}` : (PHASE_HINTS[phase] || phase),
      `phase-sub${isCurrent ? " current" : ""}`,
    )
    if (isCurrent) {
      addSvgText(graphEl, originX + 18, phaseY + 72, "● 进行中", "current-badge-text")
      // 当前阶段整行描边
      graphEl.appendChild(svgEl("rect", {
        x: originX + 2,
        y: phaseY + 2,
        width: width - margin * 2 - 4,
        height: h - 4,
        rx: 8,
        class: "current-row-stroke",
      }))
    }
    phaseBounds.push({ phase, y: phaseY, height: h, isCurrent })
    phaseY += h
  })

  // 网格线
  roleBounds.forEach((bound, index) => {
    if (index === 0) return
    graphEl.appendChild(svgEl("line", {
      x1: bound.x, y1: originY, x2: bound.x, y2: height - margin, class: "role-divider",
    }))
  })
  phaseBounds.forEach((bound, index) => {
    if (index === 0) return
    graphEl.appendChild(svgEl("line", {
      x1: originX, y1: bound.y, x2: width - margin, y2: bound.y, class: "lane-divider",
    }))
  })

  // 节点定位：格子内从上到下
  const positions = new Map()
  for (const phaseBound of phaseBounds) {
    for (const roleBound of roleBounds) {
      const list = cellMap.get(`${phaseBound.phase}::${roleBound.role}`) || []
      list.forEach((node, index) => {
        positions.set(node.id, {
          x: roleBound.x + cellPadX,
          y: phaseBound.y + cellPadY + index * (nodeH + nodeGapY),
          w: nodeW,
          h: nodeH,
          roleColor: roleBound.color,
        })
      })
    }
  }

  const edgeLayer = svgEl("g", { class: "edges" })
  graphEl.appendChild(edgeLayer)
  for (const node of nodes) {
    const target = positions.get(node.id)
    if (!target) continue
    for (const dep of node.dependsOn) {
      const source = positions.get(dep)
      if (!source) continue
      const active = isCurrentNode(node.id) || currentSnapshot.readyNodeIds.includes(node.id)
      // 同列按上下方向连接；跨角色按实际左右方向选择卡片边缘，避免反向交接穿过卡片。
      const sameCol = Math.abs(source.x - target.x) < 4
      let d
      if (sameCol) {
        const downward = target.y >= source.y
        const x = source.x + source.w / 2
        const sourceY = downward ? source.y + source.h : source.y
        const targetY = downward ? target.y : target.y + target.h
        const bend = Math.max(28, Math.abs(targetY - sourceY) * 0.4)
        d = `M ${x} ${sourceY} C ${x} ${sourceY + (downward ? bend : -bend)}, ${x} ${targetY + (downward ? -bend : bend)}, ${x} ${targetY}`
      } else {
        const rightward = target.x > source.x
        const sourceX = rightward ? source.x + source.w : source.x
        const targetX = rightward ? target.x : target.x + target.w
        const sourceY = source.y + source.h / 2
        const targetY = target.y + target.h / 2
        const bend = Math.max(36, Math.min(96, Math.abs(targetX - sourceX) * 0.35))
        d = `M ${sourceX} ${sourceY} C ${sourceX + (rightward ? bend : -bend)} ${sourceY}, ${targetX + (rightward ? -bend : bend)} ${targetY}, ${targetX} ${targetY}`
      }
      const edge = svgEl("path", {
        d,
        class: `edge${active ? " active" : ""}`,
        "marker-end": active ? "url(#arrow-active)" : "url(#arrow)",
      })
      const edgeTitle = svgEl("title")
      edgeTitle.textContent = `${findNodeName(dep)} → ${findNodeName(node.id)}`
      edge.appendChild(edgeTitle)
      edgeLayer.appendChild(edge)
    }
  }

  for (const node of nodes) {
    const pos = positions.get(node.id)
    if (pos) addNode(node, pos.x, pos.y, pos.w, pos.h, pos.roleColor)
  }

  renderRoleLegend(roles)
  applyGraphZoom()
  const currentKey = (currentSnapshot?.currentNodeIds || []).slice().sort().join("|")
  if (currentKey && currentKey !== lastScrolledCurrentKey) {
    lastScrolledCurrentKey = currentKey
    requestAnimationFrame(scrollCurrentNodeIntoView)
  }
}

function addNode(node, x, y, width, height, roleColor) {
  const current = isCurrentNode(node.id)
  const ready = currentSnapshot.readyNodeIds.includes(node.id)
  const roles = nodeRoles(node)
  const roleNames = roles.map((role) => roleLabel(role)).join("、")
  const zhName = nodeNameZh(node)
  const showEnglish = Boolean(node.name && node.name !== zhName)
  const group = svgEl("g", {
    class: `node ${nodeDisplayState(node)}${selectedNode === node.id ? " selected" : ""}`,
    transform: `translate(${x},${y})`,
    "data-node-id": node.id,
    role: "button",
    tabindex: "0",
    "aria-label": `${zhName}${showEnglish ? `（${node.name}）` : ""}，参与角色：${roleNames}，${statusLabel(node.status)}${current ? "，当前" : ""}`,
  })

  const color = roleColor || ROLE_COLORS[node.responsibleRole] || "#909399"
  if (current) {
    group.appendChild(svgEl("rect", {
      x: -6, y: -6, width: width + 12, height: height + 12, rx: 14, class: "current-ring",
    }))
  }
  group.appendChild(svgEl("rect", {
    x: 0, y: 0, width, height, rx: 8, class: "card",
  }))
  group.appendChild(svgEl("path", {
    d: `M 12 0 H 8 Q 0 0 0 8 V ${height - 8} Q 0 ${height} 8 ${height} H 12 Z`,
    fill: color,
    class: "role-bar",
  }))

  if (current) {
    addSvgText(group, 22, 20, "● 当前", "current-tag")
    addSvgText(group, 78, 20, truncate(node.id, 16), "id")
  } else {
    addSvgText(group, 22, 22, truncate(node.id, 24), "id")
  }

  const titleLines = wrapLabel(zhName, 11, 2)
  const titleStartY = current ? 42 : 44
  titleLines.forEach((line, index) => {
    addSvgText(group, 22, titleStartY + index * 20, line, "name-zh")
  })

  let cursorY = titleStartY + titleLines.length * 20
  if (showEnglish) {
    cursorY += 2
    addSvgText(group, 22, cursorY, truncate(node.name, 28), "name-en")
    cursorY += 16
  } else {
    cursorY += 4
  }

  let stateText = statusLabel(node.status)
  if (current && ready) stateText = "当前 · 可运行"
  else if (current) stateText = "当前节点"
  else if (ready) stateText = "可运行"
  const roleSummary = roles.map((role) => role).join(" / ")
  addSvgText(group, 22, Math.min(cursorY + 14, height - 12), truncate(`${stateText} · ${roleSummary}`, 30), "meta")

  if (roles.length > 1) {
    const startX = width - 18 - (roles.length - 1) * 13
    roles.forEach((role, index) => {
      group.appendChild(svgEl("circle", {
        cx: startX + index * 13,
        cy: height - 12,
        r: 4,
        fill: ROLE_COLORS[role] || "#909399",
        class: "participant-dot",
      }))
    })
  }

  group.onclick = (event) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      event.stopPropagation()
      jumpToNodeWorkspace(node.id).catch(showError)
      return
    }
    showNode(node.id)
  }
  group.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      showNode(node.id)
    }
  }
  const tip = svgEl("title")
  tip.textContent = "单击查看详情；Ctrl/⌘+单击打开脚本目录"
  group.appendChild(tip)
  graphEl.appendChild(group)
}

async function focusNodeInGraph(nodeId) {
  if (!nodeId || !currentGraphNodes.some((node) => node.id === nodeId)) return
  await showNode(nodeId)
  requestAnimationFrame(() => scrollNodeIntoView(nodeId))
}

async function resolveSelectedNodeWorkspace(nodeId) {
  if (!window.octopus.resolveNodeWorkspace) {
    if (!currentState?.projectRoot) throw new Error("项目没有源码根目录")
    return {
      nodeKey: nodeId,
      path: `${currentState.projectRoot}/workflow/nodes/${nodeId}`,
      exists: false,
    }
  }
  return window.octopus.resolveNodeWorkspace(selectedRequirement, nodeId)
}

async function jumpToNodeWorkspace(nodeId) {
  const info = await resolveSelectedNodeWorkspace(nodeId)
  if (window.octopus.openNodeDirectory) {
    const result = await window.octopus.openNodeDirectory(selectedRequirement, nodeId)
    if (typeof result === "string" && result) throw new Error(result)
    statusEl.textContent = `已打开脚本目录：${info.nodeKey}`
    statusEl.className = "badge info"
    return info
  }

  try {
    await navigator.clipboard.writeText(info.path)
    statusEl.textContent = `已复制脚本目录：${info.path}`
    statusEl.className = "badge info"
  } catch {
    statusEl.textContent = `脚本目录：${info.path}`
    statusEl.className = "badge warn"
  }

  // 浏览器无法直接打开本地目录；尝试唤起 VS Code（若已安装协议处理）
  const vscodeUrl = `vscode://file${info.path.startsWith("/") ? info.path : `/${info.path}`}`
  const probe = document.createElement("a")
  probe.href = vscodeUrl
  probe.style.display = "none"
  document.body.appendChild(probe)
  probe.click()
  probe.remove()
  return info
}

async function copyNodeWorkspacePath(nodeId) {
  const info = await resolveSelectedNodeWorkspace(nodeId)
  await navigator.clipboard.writeText(info.path)
  statusEl.textContent = `已复制：${info.path}`
  statusEl.className = "badge info"
  return info
}

async function showNode(nodeId) {
  selectedNode = nodeId
  const node = currentGraphNodes.find((candidate) => candidate.id === nodeId)
  if (!node) return

  const activated = node.activated !== false
  currentRuns = activated ? await window.octopus.runs(selectedRequirement, nodeId) : []
  let workspace = null
  try {
    workspace = await resolveSelectedNodeWorkspace(nodeId)
  } catch {
    workspace = currentState.projectRoot
      ? { nodeKey: nodeId, path: `${currentState.projectRoot}/workflow/nodes/${nodeId}`, exists: false }
      : null
  }
  renderGraph()
  emptyEl.style.display = "none"

  const deps = node.dependsOn.length
    ? node.dependsOn.map((id) => escapeHtml(findNodeName(id))).join("、")
    : "无（起始节点）"
  const actions = (node.actions || []).map((action) => escapeHtml(actionLabel(action))).join("<br />") || "未配置动作"
  const isReady = currentSnapshot.readyNodeIds.includes(node.id)
  const isWaiting = currentSnapshot.waitingNodeIds.includes(node.id)
  const zhDesc = nodeDescZh(node)
  const englishDesc = node.description && node.description !== zhDesc ? node.description : ""

  const current = isCurrentNode(node.id)
  const roles = nodeRoles(node)
  const zhName = nodeNameZh(node)
  detailsEl.innerHTML = `
    <div class="detail">
      <p class="title">${escapeHtml(zhName)}</p>
      ${node.name && node.name !== zhName ? `<p class="title-en">${escapeHtml(node.name)}</p>` : ""}
      <p class="desc">${escapeHtml(zhDesc)}</p>
      ${englishDesc ? `<p class="desc-en">${escapeHtml(englishDesc)}</p>` : ""}
      <div class="pill-row">
        ${current ? `<span class="badge info">● 当前节点</span>` : ""}
        <span class="badge ${node.status === "COMPLETED" ? "good" : node.status === "BLOCKED" ? "bad" : isReady ? "info" : "warn"}">${escapeHtml(statusLabel(node.status))}${isReady ? " · 可运行" : isWaiting ? " · 等待中" : ""}</span>
        <span class="badge">${escapeHtml(phaseLabel(node.phase))}</span>
        ${roles.map((role, index) => `<span class="badge${index === 0 ? "" : " muted-role"}">${index === 0 ? "负责：" : "参与："}${escapeHtml(roleLabel(role))}</span>`).join("")}
      </div>
      <dl>
        <dt>节点 ID</dt>
        <dd>${escapeHtml(node.id)}</dd>
        <dt>英文 Key</dt>
        <dd>${escapeHtml(workspace?.nodeKey || "未知")}</dd>
        <dt>英文名称</dt>
        <dd>${escapeHtml(node.name)}</dd>
        <dt>依赖节点</dt>
        <dd>${deps}</dd>
        <dt>执行动作</dt>
        <dd>${actions}</dd>
        ${activated ? `<dt>节点负责人</dt>
        <dd><input id="nodeAssignedTo" value="${escapeHtml(node.assignedTo || "")}" placeholder="未设置" /><button id="saveNodeAssignedTo" class="secondary" type="button">保存</button></dd>` : `<dt>激活条件</dt><dd>推进到「${escapeHtml(phaseLabel(node.phase))}」阶段后进入运行态</dd>`}
        <dt>脚本目录</dt>
        <dd class="path-row">
          <code class="path-value">${escapeHtml(workspace?.path || "未配置源码根目录")}</code>
          ${workspace?.exists === false ? `<span class="badge warn">目录尚未创建</span>` : ""}
        </dd>
        ${node.notes ? `<dt>备注</dt><dd>${escapeHtml(node.notes)}</dd>` : ""}
        ${node.completedAt ? `<dt>完成时间</dt><dd>${escapeHtml(new Date(node.completedAt).toLocaleString("zh-CN"))}</dd>` : ""}
      </dl>
      <div class="actions">
        ${activated ? `<button id="runNode" title="启动该节点">▶ 运行节点</button>
        <button id="completeNode" class="secondary" title="将手动节点标记为完成">✓ 手动完成</button>` : ""}
        <button id="openNode" class="secondary" title="打开节点脚本目录（桌面端打开文件夹；浏览器复制路径并尝试唤起 VS Code）">打开脚本目录</button>
        <button id="copyNodePath" class="secondary" title="复制脚本目录绝对路径">复制路径</button>
      </div>
      <div class="detail-section-title">运行历史</div>
      ${currentRuns.length === 0
        ? `<p class="muted" style="margin:0">${activated ? "暂无运行记录。点击「运行节点」开始执行。" : "节点尚未激活，暂无运行记录。"}</p>`
        : currentRuns.slice(0, 6).map((run) => `
          <div class="detail run">
            <div class="pill-row">
              <span class="badge ${run.status === "SUCCEEDED" ? "good" : run.status === "FAILED" || run.status === "TIMED_OUT" ? "bad" : "warn"}">${escapeHtml(runStatusLabel(run.status))}</span>
              ${run.forced ? `<span class="badge warn">强制执行</span>` : ""}
            </div>
            <div class="run-id">${escapeHtml(run.id)}</div>
            ${run.error ? `<div class="run-error">${escapeHtml(run.error)}</div>` : ""}
            <div class="actions">
              <button data-view-logs="${escapeHtml(run.id)}" class="secondary">查看日志</button>
              <button data-retry="${escapeHtml(run.id)}" class="secondary">重试</button>
              <button data-cancel="${escapeHtml(run.id)}" class="danger">取消</button>
            </div>
          </div>
        `).join("")}
      }
    </div>
  `

  if (activated) {
    document.getElementById("runNode").onclick = () => runSelected(false)
    document.getElementById("completeNode").onclick = () => completeSelected(false)
    document.getElementById("saveNodeAssignedTo").onclick = async () => {
      try { await window.octopus.assignNode(selectedRequirement, node.id, document.getElementById("nodeAssignedTo").value.trim() || null); await showRequirement(selectedRequirement); statusEl.textContent = "节点负责人已保存"; statusEl.className = "badge good" } catch (error) { showError(error) }
    }
  }
  document.getElementById("openNode").onclick = () => jumpToNodeWorkspace(node.id).catch(showError)
  const copyPathButton = document.getElementById("copyNodePath")
  if (workspace?.path) {
    copyPathButton.onclick = () => copyNodeWorkspacePath(node.id).catch(showError)
  } else {
    copyPathButton.remove()
  }

  detailsEl.querySelectorAll("[data-view-logs]").forEach((button) => {
    button.onclick = () => {
      openLogsForRun(selectedRequirement, button.dataset.viewLogs)
    }
  })
  detailsEl.querySelectorAll("[data-retry]").forEach((button) => {
    button.onclick = async () => {
      try {
        await window.octopus.retryRun(selectedRequirement, button.dataset.retry)
        await showRequirement(selectedRequirement)
      } catch (error) {
        showError(error)
      }
    }
  })
  detailsEl.querySelectorAll("[data-cancel]").forEach((button) => {
    button.onclick = async () => {
      try {
        await window.octopus.cancelRun(selectedRequirement, button.dataset.cancel)
        await showRequirement(selectedRequirement)
      } catch (error) {
        showError(error)
      }
    }
  })

  renderGraph()
}

function showError(error) {
  const message = readableError(error)
  statusEl.textContent = message
  statusEl.className = "badge bad"
  window.OctopusElementPlus?.message(message, "error")
}

async function confirmAction(message, title = "请确认", type = "warning") {
  if (window.OctopusElementPlus?.confirm) {
    return window.OctopusElementPlus.confirm(message, title, type)
  }
  showError(new Error("确认组件未加载，已阻止本次操作，请刷新页面后重试。"))
  return false
}

async function runSelected(force) {
  try {
    await window.octopus.runNode(selectedRequirement, selectedNode, force)
    await showRequirement(selectedRequirement)
  } catch (error) {
    showError(error)
  }
}

async function completeSelected(force) {
  try {
    await window.octopus.completeNode(selectedRequirement, selectedNode, force)
    await showRequirement(selectedRequirement)
  } catch (error) {
    showError(error)
  }
}

document.getElementById("create").onclick = async () => {
  const name = document.getElementById("name").value.trim()
  if (!name) {
    statusEl.textContent = "请填写项目名称"
    statusEl.className = "badge warn"
    return
  }
  const description = document.getElementById("desc").value.trim() || undefined
  try {
    const result = await window.octopus.createProject(name, description)
    document.getElementById("name").value = ""
    document.getElementById("desc").value = ""
    lastCreatedProjectId = result.projectId
    await showHub()
    statusEl.textContent = "项目已创建"
    statusEl.className = "badge good"
  } catch (error) {
    showError(error)
  }
}

document.getElementById("createRequirement").onclick = async () => {
  if (!selectedProjectId) {
    statusEl.textContent = "请先打开一个项目"
    statusEl.className = "badge warn"
    return
  }
  const name = document.getElementById("reqName").value.trim()
  if (!name) {
    statusEl.textContent = "请填写需求名称"
    statusEl.className = "badge warn"
    return
  }
  const description = document.getElementById("reqDesc").value.trim() || undefined
  const root = document.getElementById("reqRoot").value.trim() || undefined
  try {
    const result = await window.octopus.initRequirement(selectedProjectId, name, description, root)
    document.getElementById("reqName").value = ""
    document.getElementById("reqDesc").value = ""
    document.getElementById("reqRoot").value = ""
    lastCreatedRequirementId = result.requirementId
    await showProjectPage(selectedProjectId)
    statusEl.textContent = "需求已创建"
    statusEl.className = "badge good"
  } catch (error) {
    showError(error)
  }
}

document.getElementById("bindTbTask").onclick = async () => {
  if (!selectedRequirement) return
  const raw = tbTaskRefEl?.value.trim()
  if (!raw) {
    statusEl.textContent = "请填写任务编号或 ID"
    statusEl.className = "badge warn"
    return
  }
  try {
    const opts = raw.includes("-") || /[A-Za-z]/.test(raw)
      ? { taskRef: raw }
      : { taskId: raw, taskRef: raw }
    await window.octopus.bindRequirementTask(selectedRequirement, opts)
    statusEl.textContent = "已绑定 Teambition 任务"
    statusEl.className = "badge good"
    await showRequirement(selectedRequirement)
  } catch (error) {
    statusEl.textContent = readableError(error)
    statusEl.className = "badge bad"
  }
}

document.getElementById("unbindTbTask").onclick = async () => {
  if (!selectedRequirement) return
  try {
    await window.octopus.unbindRequirementTask(selectedRequirement)
    if (tbTaskRefEl) tbTaskRefEl.value = ""
    statusEl.textContent = "已解除任务绑定"
    statusEl.className = "badge good"
    await showRequirement(selectedRequirement)
  } catch (error) {
    statusEl.textContent = readableError(error)
    statusEl.className = "badge bad"
  }
}

document.getElementById("refreshTbStatus").onclick = async () => {
  if (!selectedRequirement) return
  try {
    const binding = await window.octopus.getRequirementTeambitionStatus(selectedRequirement)
    statusEl.textContent = binding.statusName
      ? `状态已刷新：${binding.statusName}`
      : "状态已刷新"
    statusEl.className = "badge good"
    await showRequirement(selectedRequirement)
  } catch (error) {
    statusEl.textContent = readableError(error)
    statusEl.className = "badge bad"
  }
}

document.getElementById("updateTbStatus").onclick = async () => {
  if (!selectedRequirement) return
  const statusId = tbStatusSelectEl?.value
  if (!statusId) {
    statusEl.textContent = "请选择要更新的状态"
    statusEl.className = "badge warn"
    return
  }
  try {
    if (!cardStatusesCache.length && selectedProjectId) {
      cardStatusesCache = await window.octopus.listTeambitionCardStatuses(selectedProjectId)
    }
    await window.octopus.updateRequirementTeambitionStatus(selectedRequirement, statusId)
    statusEl.textContent = "Teambition 状态已更新"
    statusEl.className = "badge good"
    await showRequirement(selectedRequirement)
  } catch (error) {
    statusEl.textContent = readableError(error)
    statusEl.className = "badge bad"
  }
}

if (addMilestoneEl) {
  addMilestoneEl.onclick = () => openMilestoneForm()
}
if (toggleReachedMilestonesEl) {
  toggleReachedMilestonesEl.onclick = () => {
    showReachedMilestones = !showReachedMilestones
    renderRequirementMilestoneBar()
  }
}
if (cancelMilestoneEl) {
  cancelMilestoneEl.onclick = () => hideMilestoneForm()
}
if (milestoneFormEl) {
  milestoneFormEl.onsubmit = async (event) => {
    event.preventDefault()
    if (!selectedRequirement) return
    const name = milestoneNameEl?.value.trim() || ""
    const date = milestoneDateEl?.value || ""
    const phase = milestonePhaseEl?.value || ""
    const nodeId = milestoneNodeEl?.value || ""
    const note = milestoneNoteEl?.value || ""
    const milestoneId = milestoneEditIdEl?.value || ""
    const payload = {
      name,
      date,
      ...(phase ? { phase } : milestoneId ? { phase: null } : {}),
      ...(nodeId ? { nodeId } : milestoneId ? { nodeId: null } : {}),
      ...(note ? { note } : milestoneId ? { note: null } : {}),
    }
    try {
      if (milestoneId) {
        await window.octopus.updateMilestone(selectedRequirement, milestoneId, payload)
        statusEl.textContent = "里程碑已更新"
      } else {
        await window.octopus.addMilestone(selectedRequirement, payload)
        statusEl.textContent = "里程碑已添加"
      }
      statusEl.className = "badge good"
      hideMilestoneForm()
      await showRequirement(selectedRequirement)
      if (selectedProjectId) {
        await loadRequirementSummaries(selectedProjectId)
        renderProjectPage()
      }
    } catch (error) {
      showError(error)
    }
  }
}
if (reachMilestoneEl) {
  reachMilestoneEl.onclick = async () => {
    const milestoneId = milestoneEditIdEl?.value
    if (!selectedRequirement || !milestoneId) return
    try {
      await window.octopus.reachMilestone(selectedRequirement, milestoneId)
      statusEl.textContent = "已标记达成（不会改变需求阶段）"
      statusEl.className = "badge good"
      hideMilestoneForm()
      await showRequirement(selectedRequirement)
    } catch (error) {
      showError(error)
    }
  }
}
if (unreachMilestoneEl) {
  unreachMilestoneEl.onclick = async () => {
    const milestoneId = milestoneEditIdEl?.value
    if (!selectedRequirement || !milestoneId) return
    try {
      await window.octopus.unreachMilestone(selectedRequirement, milestoneId)
      statusEl.textContent = "已取消达成"
      statusEl.className = "badge good"
      hideMilestoneForm()
      await showRequirement(selectedRequirement)
    } catch (error) {
      showError(error)
    }
  }
}
if (deleteMilestoneEl) {
  deleteMilestoneEl.onclick = async () => {
    const milestoneId = milestoneEditIdEl?.value
    const item = workspaceMilestones.find((entry) => entry.id === milestoneId)
    if (!selectedRequirement || !milestoneId) return
    if (!await confirmAction(`删除里程碑「${item?.name || milestoneId}」？此操作不可恢复。`, "删除里程碑", "error")) return
    try {
      await window.octopus.deleteMilestone(selectedRequirement, milestoneId)
      statusEl.textContent = "里程碑已删除"
      statusEl.className = "badge good"
      hideMilestoneForm()
      await showRequirement(selectedRequirement)
    } catch (error) {
      showError(error)
    }
  }
}

document.getElementById("bindRequirementVersion")?.addEventListener("click", async () => {
  if (!selectedRequirement) return
  const versionId = requirementVersionSelectEl?.value || ""
  if (!versionId) return
  try { await window.octopus.bindRequirementVersion(selectedRequirement, versionId); await showRequirement(selectedRequirement); statusEl.textContent = "需求版本已绑定"; statusEl.className = "badge good" } catch (error) { statusEl.textContent = readableError(error); statusEl.className = "badge bad" }
})
document.getElementById("unbindRequirementVersion")?.addEventListener("click", async () => {
  if (!selectedRequirement) return
  try { await window.octopus.unbindRequirementVersion(selectedRequirement); await showRequirement(selectedRequirement); statusEl.textContent = "需求版本已解绑"; statusEl.className = "badge good" } catch (error) { statusEl.textContent = readableError(error); statusEl.className = "badge bad" }
})
document.getElementById("saveRequirementOwner")?.addEventListener("click", async () => {
  if (!selectedRequirement) return
  const owner = document.getElementById("requirementOwnerInput")?.value.trim() || null
  try { await window.octopus.updateRequirement(selectedRequirement, { owner }); await showRequirement(selectedRequirement); statusEl.textContent = "需求负责人已保存"; statusEl.className = "badge good" } catch (error) { statusEl.textContent = readableError(error); statusEl.className = "badge bad" }
})

document.getElementById("refresh").onclick = () => {
  if (selectedRequirement) showRequirement(selectedRequirement).catch(showError)
}

document.getElementById("exportTasks").onclick = async () => {
  if (!selectedRequirement) return
  try {
    const result = await window.octopus.exportTasks(selectedRequirement)
    statusEl.textContent = result.canceled ? "已取消导出" : `已导出 ${result.taskCount} 个任务`
    statusEl.className = result.canceled ? "badge warn" : "badge good"
  } catch (error) {
    showError(error)
  }
}

document.getElementById("importTasks").onclick = async () => {
  if (!selectedRequirement) return
  try {
    const result = await window.octopus.importTasks(selectedRequirement)
    if (!result.canceled) {
      statusEl.textContent = `已更新 ${result.updated} 个任务`
      statusEl.className = "badge good"
      await showRequirement(selectedRequirement)
    } else {
      statusEl.textContent = "已取消导入"
      statusEl.className = "badge warn"
    }
  } catch (error) {
    showError(error)
  }
}

document.getElementById("health").onclick = async () => {
  try {
    const health = await window.octopus.health()
    const failed = health.filter((item) => !item.healthy)
    statusEl.textContent = health.length === 0
      ? "暂无外部集成"
      : failed.length === 0
        ? `集成健康（${health.length}）`
        : `${failed.length} 个集成异常`
    statusEl.className = `badge ${failed.length ? "bad" : "good"}`
  } catch (error) {
    showError(error)
  }
}

document.getElementById("runWorkflow").onclick = async () => {
  if (!selectedRequirement) return
  try {
    await window.octopus.runWorkflow(selectedRequirement)
    statusEl.textContent = "已触发可运行节点"
    statusEl.className = "badge info"
    await showRequirement(selectedRequirement)
  } catch (error) {
    showError(error)
  }
}

function defaultGraphZoom() {
  return window.innerWidth < 900 ? 1 : 1.4
}

document.getElementById("zoomIn").onclick = () => setGraphZoom(graphZoom * 1.2)
document.getElementById("zoomOut").onclick = () => setGraphZoom(graphZoom / 1.2)
document.getElementById("zoomReset").onclick = () => setGraphZoom(defaultGraphZoom())
if (nodeLocatorEl) {
  nodeLocatorEl.onchange = () => focusNodeInGraph(nodeLocatorEl.value).catch(showError)
}

if (themeToggleEl) themeToggleEl.onclick = () => toggleTheme()
if (fullscreenGraphEl) fullscreenGraphEl.onclick = () => toggleGraphFullscreen()
if (toggleSidebarEl) toggleSidebarEl.onclick = () => toggleWorkspacePanel("sidebar")
if (toggleInspectorEl) toggleInspectorEl.onclick = () => toggleWorkspacePanel("inspector")
document.addEventListener("fullscreenchange", () => {
  if (!isNativeFullscreen()) setCssFullscreen(false)
  syncFullscreenButton()
})
document.addEventListener("webkitfullscreenchange", () => {
  if (!isNativeFullscreen()) setCssFullscreen(false)
  syncFullscreenButton()
})
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isCssFullscreen()) {
    setCssFullscreen(false)
    syncFullscreenButton()
  }
})

if (hubFilterEl) {
  hubFilterEl.addEventListener("input", () => {
    hubFilter = hubFilterEl.value
    renderHub()
  })
}
document.getElementById("openMine")?.addEventListener("click", () => setHash("hub/mine"))
if (backToHubEl) backToHubEl.onclick = () => goToHub()
if (backToProjectEl) backToProjectEl.onclick = () => {
  if (selectedProjectId) goToProject(selectedProjectId)
  else goToHub()
}
if (sidebarToHubEl) sidebarToHubEl.onclick = () => goToHub()
if (sidebarToProjectEl) sidebarToProjectEl.onclick = () => {
  if (selectedProjectId) goToProject(selectedProjectId)
  else goToHub()
}
if (projectFilterEl) {
  projectFilterEl.addEventListener("input", () => {
    projectFilter = projectFilterEl.value
    renderProjectPage()
  })
}
document.querySelectorAll(".project-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab
    if (tab && selectedProjectId) goToProject(selectedProjectId, tab)
  })
})
window.addEventListener("hashchange", () => {
  applyRoute().catch(showError)
})

setupGraphPan()
setupGraphWheelZoom()

setInterval(() => {
  if (currentView === "workspace" && selectedRequirement) {
    showRequirement(selectedRequirement).catch(() => {})
  } else if (currentView === "project" && expandedScheduleId) {
    loadHubGantt(expandedScheduleId).catch(() => {})
  }
}, 2000)

function syncNarrowGanttLayout() {
  const narrow = window.innerWidth < 900
  document.body.classList.toggle("is-narrow-gantt", narrow)
  if (currentView === "project" && expandedScheduleId && hubGanttState) renderHubGantt()
}
window.addEventListener("resize", syncNarrowGanttLayout)
syncNarrowGanttLayout()

applyTheme(preferredTheme())
const savedPanels = preferredWorkspacePanels()
sidebarCollapsed = savedPanels.sidebarCollapsed
inspectorCollapsed = savedPanels.inspectorCollapsed
syncWorkspacePanelButtons()
syncFullscreenButton()
applyGraphZoom()
if (!location.hash) history.replaceState(null, "", "#hub")
applyRoute().catch((error) => {
  showError(error)
})
