// 渲染进程只通过 preload / 浏览器 API 获取状态；图形使用原生 SVG，避免离线依赖。

const projectsEl = document.getElementById("projects")
const graphEl = document.getElementById("graph")
const graphScalerEl = document.getElementById("graphScaler")
const summaryEl = document.getElementById("summary")
const detailsEl = document.getElementById("details")
const emptyEl = document.getElementById("empty")
const statusEl = document.getElementById("workflowStatus")
const projectLabelEl = document.getElementById("projectLabel")
const flowHintEl = document.getElementById("flowHint")
const zoomLabelEl = document.getElementById("zoomLabel")
const roleLegendEl = document.getElementById("roleLegend")

let selectedProject
let selectedNode
let currentState
let currentSnapshot
let currentStatus
let currentRuns = []
const projectMeta = new Map()
/** 流程图缩放比例（默认放大，避免文字过小发糊） */
let graphZoom = 1.4

/** 阶段顺序 */
const PHASE_ORDER = [
  "RequirementsAnalysis",
  "Design",
  "Development",
  "Testing",
  "Deployment",
  "Maintenance",
]

/** 角色泳道顺序 */
const ROLE_ORDER = ["PM", "BA", "SA", "AI", "DEV", "QA", "OP", "HEI"]

/** 角色色条 */
const ROLE_COLORS = {
  PM: "#55a7ff",
  BA: "#47d7a1",
  SA: "#7dd3fc",
  AI: "#c4b5fd",
  DEV: "#fbbf24",
  QA: "#fb7185",
  OP: "#94a3b8",
  HEI: "#f0abfc",
}

/** 阶段中文名 */
const PHASE_LABELS = {
  RequirementsAnalysis: "需求分析",
  Design: "设计",
  Development: "开发",
  Testing: "测试",
  Deployment: "部署",
  Maintenance: "维护",
}

/** 阶段说明 */
const PHASE_HINTS = {
  RequirementsAnalysis: "梳理需求、PRD 与估时",
  Design: "排期、对齐与技术设计",
  Development: "开发实现与联调",
  Testing: "测试验证与验收",
  Deployment: "发布、合并与上线检查",
  Maintenance: "监控与技术债务",
}

/** 节点状态中文名 */
const STATUS_LABELS = {
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
  const node = currentState?.steps?.find((step) => step.id === nodeId)
  return node ? nodeNameZh(node) : nodeId
}

async function refreshProjects(selectId) {
  const ids = await window.octopus.listProjects()
  projectsEl.innerHTML = ""
  if (!ids.length) {
    projectsEl.innerHTML = `<div class="empty-state">暂无项目。请在上方创建，或使用 CLI：<br /><code>node packages/cli/dist/index.js init "项目名" --root .</code></div>`
    projectLabelEl.textContent = "未选择项目"
    statusEl.textContent = "未选择项目"
    statusEl.className = "badge"
    summaryEl.innerHTML = ""
    graphEl.replaceChildren()
    return
  }

  for (const id of ids) {
    let meta = projectMeta.get(id)
    if (!meta) {
      try {
        const status = await window.octopus.status(id)
        meta = { projectName: status.projectName, currentPhase: status.currentPhase }
        projectMeta.set(id, meta)
      } catch {
        meta = { projectName: id, currentPhase: "" }
      }
    }
    const div = document.createElement("div")
    div.className = `project${id === selectId || (!selectId && id === ids[0]) ? " active" : ""}`
    div.dataset.projectId = id
    div.innerHTML = `<div class="name">${escapeHtml(meta.projectName || id)}</div><div class="meta">${escapeHtml(id)}${meta.currentPhase ? ` · ${escapeHtml(phaseLabel(meta.currentPhase))}` : ""}</div>`
    div.onclick = () => showProject(id)
    projectsEl.appendChild(div)
  }
  await showProject(selectId || ids[0])
}

async function showProject(id) {
  if (!id) return
  selectedProject = id
  currentState = await window.octopus.state(id)
  currentSnapshot = await window.octopus.snapshot(id)
  try {
    currentStatus = await window.octopus.status(id)
    projectMeta.set(id, {
      projectName: currentStatus.projectName,
      currentPhase: currentStatus.currentPhase,
    })
  } catch {
    currentStatus = undefined
  }

  for (const el of projectsEl.querySelectorAll(".project")) {
    el.classList.toggle("active", el.dataset.projectId === id)
  }

  const projectName = currentState.projectName || currentStatus?.projectName || id
  projectLabelEl.textContent = `${projectName} · ${phaseLabel(currentState.currentPhase)}`
  renderSummary()
  renderGraph()
  if (selectedNode) await showNode(selectedNode)
}

function renderSummary() {
  const active = currentSnapshot.activeRuns.length
  const ready = currentSnapshot.readyNodeIds.length
  const waiting = currentSnapshot.waitingNodeIds.length
  const completed = currentState.steps.filter((step) => step.status === "COMPLETED").length
  const total = currentState.steps.length
  const blocked = currentState.steps.filter((step) => step.status === "BLOCKED").length

  summaryEl.innerHTML = [
    metric(active, "活动运行", "正在执行的节点实例"),
    metric(ready, "可运行节点", "依赖已满足，可立即启动"),
    metric(waiting, "等待处理", "需手动完成或等待依赖"),
    metric(`${completed}/${total}`, "节点进度", blocked ? `其中 ${blocked} 个已阻塞` : "当前阶段已激活节点"),
  ].join("")

  const scheduler = currentSnapshot.schedulerStatus
  statusEl.textContent = `调度：${schedulerLabel(scheduler)}`
  statusEl.className = `badge ${scheduler === "BLOCKED" ? "bad" : scheduler === "COMPLETED" ? "good" : scheduler === "RUNNING" ? "info" : "warn"}`
  document.getElementById("lastUpdate").textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`

  const phase = phaseLabel(currentState.currentPhase)
  const phaseHint = PHASE_HINTS[currentState.currentPhase] || ""
  flowHintEl.textContent = `当前阶段：${phase}${phaseHint ? `（${phaseHint}）` : ""}（整行高亮）。上方=角色（人），左侧=阶段；当前/可运行节点加粗描边。`
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
}

function setGraphZoom(next) {
  graphZoom = Math.min(2.2, Math.max(0.9, Math.round(next * 100) / 100))
  applyGraphZoom()
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
    const color = ROLE_COLORS[role] || "#6f84a5"
    return `<span class="role-chip"><span class="swatch" style="background:${color}"></span>${escapeHtml(roleLabel(role))}（${escapeHtml(role)}）</span>`
  }).join("")
}

function renderGraph() {
  graphEl.replaceChildren()
  const nodes = currentState?.steps || []
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
  const nodeH = 112
  const nodeGapY = 18
  const phaseHeaderW = 156
  const roleHeaderH = 72
  const cellPadX = 20
  const cellPadY = 18
  const margin = 20

  const presentRoles = new Set(nodes.map((node) => node.responsibleRole || "DEV"))
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
  marker.appendChild(svgEl("path", { d: "M 0 0 L 12 6 L 0 12 z", fill: "#6f8eb3" }))
  const markerActive = svgEl("marker", {
    id: "arrow-active",
    viewBox: "0 0 12 12",
    refX: "10",
    refY: "6",
    markerWidth: "9",
    markerHeight: "9",
    orient: "auto-start-reverse",
  })
  markerActive.appendChild(svgEl("path", { d: "M 0 0 L 12 6 L 0 12 z", fill: "#55a7ff" }))
  defs.appendChild(marker)
  defs.appendChild(markerActive)
  graphEl.appendChild(defs)

  const originX = margin
  const originY = margin
  const currentPhase = currentState.currentPhase
  const currentRoleSet = new Set(
    nodes
      .filter((node) => isCurrentNode(node.id) || currentSnapshot.readyNodeIds.includes(node.id))
      .map((node) => node.responsibleRole || "DEV"),
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
    const color = ROLE_COLORS[role] || "#6f84a5"
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
        x, y: originY + roleHeaderH - 3, width: roleColW, height: 3, fill: "#55a7ff",
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
        x: originX, y: phaseY, width: 6, height: h, fill: "#55a7ff",
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
      const x1 = source.x + source.w / 2
      const y1 = source.y + source.h
      const x2 = target.x + target.w / 2
      const y2 = target.y
      const dy = Math.max(28, Math.abs(y2 - y1) * 0.4)
      // 同列纵向 或 跨角色：用曲线连接
      const sameCol = Math.abs(source.x - target.x) < 4
      const d = sameCol
        ? `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
        : `M ${source.x + source.w} ${source.y + source.h / 2} C ${source.x + source.w + 40} ${source.y + source.h / 2}, ${target.x - 40} ${target.y + target.h / 2}, ${target.x} ${target.y + target.h / 2}`
      edgeLayer.appendChild(svgEl("path", {
        d,
        class: `edge${active ? " active" : ""}`,
        "marker-end": active ? "url(#arrow-active)" : "url(#arrow)",
      }))
    }
  }

  for (const node of nodes) {
    const pos = positions.get(node.id)
    if (pos) addNode(node, pos.x, pos.y, pos.w, pos.h, pos.roleColor)
  }

  renderRoleLegend(roles)
  applyGraphZoom()
}

function addNode(node, x, y, width, height, roleColor) {
  const current = isCurrentNode(node.id)
  const ready = currentSnapshot.readyNodeIds.includes(node.id)
  const group = svgEl("g", {
    class: `node ${nodeDisplayState(node)}${selectedNode === node.id ? " selected" : ""}`,
    transform: `translate(${x},${y})`,
    role: "button",
    tabindex: "0",
    "aria-label": `${nodeNameZh(node)}，${roleLabel(node.responsibleRole)}，${statusLabel(node.status)}${current ? "，当前" : ""}`,
  })

  const color = roleColor || ROLE_COLORS[node.responsibleRole] || "#6f84a5"
  group.appendChild(svgEl("rect", {
    x: 0, y: 0, width, height, rx: 14, class: "card",
  }))
  group.appendChild(svgEl("path", {
    d: `M 14 0 H 8 Q 0 0 0 14 V ${height - 14} Q 0 ${height} 8 ${height} H 14 Z`,
    fill: color,
    class: "role-bar",
  }))

  if (current) {
    addSvgText(group, 22, 22, "● 当前", "current-tag")
    addSvgText(group, 78, 22, truncate(node.id, 16), "id")
  } else {
    addSvgText(group, 22, 26, truncate(node.id, 24), "id")
  }

  const titleLines = wrapLabel(nodeNameZh(node), 11, 2)
  const titleStartY = current ? 48 : 52
  titleLines.forEach((line, index) => {
    addSvgText(group, 22, titleStartY + index * 24, line, "name-zh")
  })

  let stateText = statusLabel(node.status)
  if (current && ready) stateText = "当前 · 可运行"
  else if (current) stateText = "当前节点"
  else if (ready) stateText = "可运行"
  const metaY = titleStartY + titleLines.length * 24 + 10
  addSvgText(group, 22, Math.min(metaY, height - 14), `${stateText} · ${roleLabel(node.responsibleRole)}`, "meta")

  group.onclick = () => showNode(node.id)
  group.onkeydown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      showNode(node.id)
    }
  }
  graphEl.appendChild(group)
}

async function showNode(nodeId) {
  selectedNode = nodeId
  const node = currentState.steps.find((candidate) => candidate.id === nodeId)
  if (!node) return

  currentRuns = await window.octopus.runs(selectedProject, nodeId)
  emptyEl.style.display = "none"

  const deps = node.dependsOn.length
    ? node.dependsOn.map((id) => escapeHtml(findNodeName(id))).join("、")
    : "无（起始节点）"
  const actions = (node.actions || []).map((action) => escapeHtml(actionLabel(action))).join("<br />") || "未配置动作"
  const isReady = currentSnapshot.readyNodeIds.includes(node.id)
  const isWaiting = currentSnapshot.waitingNodeIds.includes(node.id)

  detailsEl.innerHTML = `
    <div class="detail">
      <p class="title">${escapeHtml(nodeNameZh(node))}</p>
      <p class="desc">${escapeHtml(nodeDescZh(node))}</p>
      <div class="pill-row">
        <span class="badge ${node.status === "COMPLETED" ? "good" : node.status === "BLOCKED" ? "bad" : isReady ? "info" : "warn"}">${escapeHtml(statusLabel(node.status))}${isReady ? " · 可运行" : isWaiting ? " · 等待中" : ""}</span>
        <span class="badge">${escapeHtml(phaseLabel(node.phase))}</span>
        <span class="badge">${escapeHtml(roleLabel(node.responsibleRole))}</span>
      </div>
      <dl>
        <dt>节点 ID</dt>
        <dd>${escapeHtml(node.id)}</dd>
        <dt>英文名称</dt>
        <dd>${escapeHtml(node.name)}</dd>
        <dt>依赖节点</dt>
        <dd>${deps}</dd>
        <dt>执行动作</dt>
        <dd>${actions}</dd>
        <dt>工作目录</dt>
        <dd>${escapeHtml(currentState.projectRoot ? `${currentState.projectRoot}/workflow/nodes/${node.id}` : "未配置源码根目录")}</dd>
        ${node.notes ? `<dt>备注</dt><dd>${escapeHtml(node.notes)}</dd>` : ""}
        ${node.completedAt ? `<dt>完成时间</dt><dd>${escapeHtml(new Date(node.completedAt).toLocaleString("zh-CN"))}</dd>` : ""}
      </dl>
      <div class="actions">
        <button id="runNode" title="启动该节点">▶ 运行节点</button>
        <button id="completeNode" class="secondary" title="将手动节点标记为完成">✓ 手动完成</button>
        <button id="openNode" class="secondary" title="在文件管理器中打开节点目录">打开目录</button>
      </div>
      <h3 style="margin-top:16px">运行历史</h3>
      ${currentRuns.length === 0
        ? `<p class="muted" style="margin:0">暂无运行记录。点击「运行节点」开始执行。</p>`
        : currentRuns.slice(0, 6).map((run) => `
          <div class="detail run">
            <div class="pill-row">
              <span class="badge ${run.status === "SUCCEEDED" ? "good" : run.status === "FAILED" || run.status === "TIMED_OUT" ? "bad" : "warn"}">${escapeHtml(runStatusLabel(run.status))}</span>
              ${run.forced ? `<span class="badge warn">强制执行</span>` : ""}
            </div>
            <div class="muted" style="font-size:11px;margin-top:6px;font-family:ui-monospace,monospace">${escapeHtml(run.id)}</div>
            ${run.error ? `<div style="color:var(--red);font-size:12px;margin-top:6px">${escapeHtml(run.error)}</div>` : ""}
            <div class="actions">
              <button data-retry="${escapeHtml(run.id)}" class="secondary">重试</button>
              <button data-cancel="${escapeHtml(run.id)}" class="danger">取消</button>
            </div>
          </div>
        `).join("")}
      }
    </div>
  `

  document.getElementById("runNode").onclick = () => runSelected(false)
  document.getElementById("completeNode").onclick = () => completeSelected(false)

  const openNodeButton = document.getElementById("openNode")
  if (window.octopus.openNodeDirectory) {
    openNodeButton.onclick = () => window.octopus.openNodeDirectory(selectedProject, node.id)
  } else {
    openNodeButton.remove()
  }

  detailsEl.querySelectorAll("[data-retry]").forEach((button) => {
    button.onclick = async () => {
      try {
        await window.octopus.retryRun(selectedProject, button.dataset.retry)
        await showProject(selectedProject)
      } catch (error) {
        showError(error)
      }
    }
  })
  detailsEl.querySelectorAll("[data-cancel]").forEach((button) => {
    button.onclick = async () => {
      try {
        await window.octopus.cancelRun(selectedProject, button.dataset.cancel)
        await showProject(selectedProject)
      } catch (error) {
        showError(error)
      }
    }
  })

  renderGraph()
}

function showError(error) {
  statusEl.textContent = error instanceof Error ? error.message : String(error)
  statusEl.className = "badge bad"
}

async function runSelected(force) {
  try {
    await window.octopus.runNode(selectedProject, selectedNode, force)
    await showProject(selectedProject)
  } catch (error) {
    showError(error)
  }
}

async function completeSelected(force) {
  try {
    await window.octopus.completeNode(selectedProject, selectedNode, force)
    await showProject(selectedProject)
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
  const root = document.getElementById("root").value.trim() || undefined
  try {
    const result = await window.octopus.init(name, description, root)
    document.getElementById("name").value = ""
    document.getElementById("desc").value = ""
    document.getElementById("root").value = ""
    await configureRuntime()
    await refreshProjects(result.projectId)
    statusEl.textContent = "项目已创建"
    statusEl.className = "badge good"
  } catch (error) {
    showError(error)
  }
}

document.getElementById("refresh").onclick = () => {
  if (selectedProject) showProject(selectedProject).catch(showError)
}

document.getElementById("exportTasks").onclick = async () => {
  if (!selectedProject) return
  try {
    const result = await window.octopus.exportTasks(selectedProject)
    statusEl.textContent = result.canceled ? "已取消导出" : `已导出 ${result.taskCount} 个任务`
    statusEl.className = result.canceled ? "badge warn" : "badge good"
  } catch (error) {
    showError(error)
  }
}

document.getElementById("importTasks").onclick = async () => {
  if (!selectedProject) return
  try {
    const result = await window.octopus.importTasks(selectedProject)
    if (!result.canceled) {
      statusEl.textContent = `已更新 ${result.updated} 个任务`
      statusEl.className = "badge good"
      await showProject(selectedProject)
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
  if (!selectedProject) return
  try {
    await window.octopus.runWorkflow(selectedProject)
    statusEl.textContent = "已触发可运行节点"
    statusEl.className = "badge info"
    await showProject(selectedProject)
  } catch (error) {
    showError(error)
  }
}

document.getElementById("zoomIn").onclick = () => setGraphZoom(graphZoom + 0.15)
document.getElementById("zoomOut").onclick = () => setGraphZoom(graphZoom - 0.15)
document.getElementById("zoomReset").onclick = () => setGraphZoom(1.4)

async function configureRuntime() {
  if (window.octopus.canInit && !await window.octopus.canInit()) {
    document.getElementById("initPanel").hidden = true
  } else {
    document.getElementById("initPanel").hidden = false
  }
}

setInterval(() => {
  if (selectedProject) showProject(selectedProject).catch(() => {})
}, 2000)

applyGraphZoom()
configureRuntime().then(() => refreshProjects()).catch((error) => {
  showError(error)
})
