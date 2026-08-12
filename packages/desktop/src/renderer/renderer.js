// 渲染进程只通过 preload API 获取状态；图形使用原生 SVG，避免引入无法离线安装的运行时依赖。
const projectsEl = document.getElementById("projects")
const graphEl = document.getElementById("graph")
const summaryEl = document.getElementById("summary")
const detailsEl = document.getElementById("details")
const emptyEl = document.getElementById("empty")
const statusEl = document.getElementById("workflowStatus")
let selectedProject
let selectedNode
let currentState
let currentSnapshot
let currentRuns = []

async function refreshProjects(selectId) {
  const ids = await window.octopus.listProjects()
  projectsEl.innerHTML = ""
  if (!ids.length) {
    projectsEl.textContent = "暂无项目"
    return
  }
  for (const id of ids) {
    const div = document.createElement("div")
    div.className = `project${id === selectId ? " active" : ""}`
    div.textContent = id
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
  renderSummary()
  renderGraph()
  if (selectedNode) await showNode(selectedNode)
}

function renderSummary() {
  const active = currentSnapshot.activeRuns.length
  summaryEl.innerHTML = [
    metric(active, "活动运行"), metric(currentSnapshot.readyNodeIds.length, "可运行节点"),
    metric(currentSnapshot.waitingNodeIds.length, "等待手动"), metric(`${currentState.steps.filter((s) => s.status === "COMPLETED").length}/${currentState.steps.length}`, "节点进度"),
  ].join("")
  statusEl.textContent = currentSnapshot.schedulerStatus
  statusEl.className = `badge ${currentSnapshot.schedulerStatus === "BLOCKED" ? "bad" : currentSnapshot.schedulerStatus === "COMPLETED" ? "good" : "warn"}`
  document.getElementById("lastUpdate").textContent = `更新于 ${new Date().toLocaleTimeString()}`
}

function metric(value, label) { return `<div class="metric"><strong>${escapeHtml(value)}</strong><small>${escapeHtml(label)}</small></div>` }

function renderGraph() {
  graphEl.replaceChildren()
  const nodes = currentState.steps
  const positions = new Map()
  const phases = [...new Set(nodes.map((node) => node.phase))]
  const width = Math.max(1100, phases.reduce((total, phase) => total + Math.max(230, nodes.filter((node) => node.phase === phase).length * 120), 0))
  graphEl.setAttribute("viewBox", `0 0 ${width} 720`)
  let x = 40
  for (const phase of phases) {
    const phaseNodes = nodes.filter((node) => node.phase === phase)
    addText(x, 35, phase, "phase-label")
    phaseNodes.forEach((node, index) => positions.set(node.id, { x: x + (index % 2) * 108, y: 90 + Math.floor(index / 2) * 110 }))
    x += Math.max(230, phaseNodes.length * 60)
  }
  for (const node of nodes) {
    const target = positions.get(node.id)
    if (!target) continue
    for (const dep of node.dependsOn) {
      const source = positions.get(dep)
      if (source) addLine(source.x + 88, source.y + 25, target.x, target.y + 25, currentSnapshot.currentNodeIds.includes(node.id))
    }
  }
  for (const node of nodes) {
    const position = positions.get(node.id)
    if (position) addNode(node, position.x, position.y)
  }
}

function addText(x, y, text, className) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "text")
  el.setAttribute("x", x); el.setAttribute("y", y); el.setAttribute("class", className); el.textContent = text; graphEl.appendChild(el)
}

function addLine(x1, y1, x2, y2, active) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "line")
  el.setAttribute("x1", x1); el.setAttribute("y1", y1); el.setAttribute("x2", x2); el.setAttribute("y2", y2); el.setAttribute("class", `edge${active ? " active" : ""}`); graphEl.appendChild(el)
}

function addNode(node, x, y) {
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g")
  const status = node.status.toLowerCase()
  const isReady = currentSnapshot.readyNodeIds.includes(node.id)
  group.setAttribute("class", `node ${status}${isReady ? " ready" : ""}${selectedNode === node.id ? " selected" : ""}`)
  group.setAttribute("transform", `translate(${x},${y})`)
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect")
  rect.setAttribute("width", "88"); rect.setAttribute("height", "52"); rect.setAttribute("rx", "10")
  group.appendChild(rect)
  const id = document.createElementNS("http://www.w3.org/2000/svg", "text")
  id.setAttribute("x", "8"); id.setAttribute("y", "17"); id.setAttribute("class", "id"); id.textContent = node.id; group.appendChild(id)
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text")
  label.setAttribute("x", "8"); label.setAttribute("y", "36"); label.textContent = node.name.slice(0, 10); group.appendChild(label)
  group.onclick = () => showNode(node.id)
  graphEl.appendChild(group)
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]) }

async function showNode(nodeId) {
  selectedNode = nodeId
  const node = currentState.steps.find((candidate) => candidate.id === nodeId)
  if (!node) return
  currentRuns = await window.octopus.runs(selectedProject, nodeId)
  emptyEl.style.display = "none"
  detailsEl.innerHTML = `<div class="detail"><dl><dt>节点</dt><dd>${escapeHtml(node.id)} · ${escapeHtml(node.name)}</dd><dt>状态</dt><dd>${escapeHtml(node.status)}</dd><dt>依赖</dt><dd>${escapeHtml(node.dependsOn.join(", ") || "无")}</dd><dt>工作目录</dt><dd>${escapeHtml(currentState.projectRoot ? `${currentState.projectRoot}/workflow/nodes/${node.id}` : "未配置")}</dd></dl><div class="actions"><button id="runNode">运行</button><button id="completeNode" class="secondary">手动完成</button><button id="openNode" class="secondary">打开目录</button></div><h3>运行历史</h3>${currentRuns.slice(0, 5).map((run) => `<div class="detail"><span class="badge">${escapeHtml(run.status)}</span> ${escapeHtml(run.id)}<div class="actions"><button data-retry="${escapeHtml(run.id)}" class="secondary">重试</button><button data-cancel="${escapeHtml(run.id)}" class="danger">取消</button></div></div>`).join("")}</div>`
  document.getElementById("runNode").onclick = () => runSelected(false)
  document.getElementById("completeNode").onclick = () => completeSelected(false)
  const openNodeButton = document.getElementById("openNode")
  if (window.octopus.openNodeDirectory) {
    openNodeButton.onclick = () => window.octopus.openNodeDirectory(selectedProject, node.id)
  } else {
    openNodeButton.remove()
  }
  detailsEl.querySelectorAll("[data-retry]").forEach((button) => { button.onclick = () => window.octopus.retryRun(selectedProject, button.dataset.retry).then(() => showProject(selectedProject)) })
  detailsEl.querySelectorAll("[data-cancel]").forEach((button) => { button.onclick = () => window.octopus.cancelRun(selectedProject, button.dataset.cancel).then(() => showProject(selectedProject)) })
  renderGraph()
}

async function runSelected(force) { await window.octopus.runNode(selectedProject, selectedNode, force); await showProject(selectedProject) }
async function completeSelected(force) { await window.octopus.completeNode(selectedProject, selectedNode, force); await showProject(selectedProject) }

document.getElementById("create").onclick = async () => {
  const name = document.getElementById("name").value.trim()
  if (!name) return
  const description = document.getElementById("desc").value.trim() || undefined
  const root = document.getElementById("root").value.trim() || undefined
  const result = await window.octopus.init(name, description, root)
  document.getElementById("name").value = ""; document.getElementById("desc").value = ""
  await configureRuntime()
  await refreshProjects(result.projectId)
}
document.getElementById("refresh").onclick = () => showProject(selectedProject)
document.getElementById("exportTasks").onclick = async () => {
  if (!selectedProject) return
  const result = await window.octopus.exportTasks(selectedProject)
  statusEl.textContent = result.canceled ? "已取消导出" : `已导出 ${result.taskCount} 个任务`
}
document.getElementById("importTasks").onclick = async () => {
  if (!selectedProject) return
  try {
    const result = await window.octopus.importTasks(selectedProject)
    if (!result.canceled) {
      statusEl.textContent = `已更新 ${result.updated} 个任务`
      await showProject(selectedProject)
    }
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : String(error)
    statusEl.className = "badge bad"
  }
}
document.getElementById("health").onclick = async () => {
  try {
    const health = await window.octopus.health()
    const failed = health.filter((item) => !item.healthy)
    statusEl.textContent = health.length === 0 ? "无集成" : failed.length === 0 ? `集成健康 ${health.length}` : `${failed.length} 个集成异常`
    statusEl.className = `badge ${failed.length ? "bad" : "good"}`
  } catch (error) {
    statusEl.textContent = error.message
    statusEl.className = "badge bad"
  }
}
document.getElementById("runWorkflow").onclick = async () => {
  if (!selectedProject) return
  try {
    await window.octopus.runWorkflow(selectedProject)
    await showProject(selectedProject)
  } catch (error) {
    statusEl.textContent = error.message
    statusEl.className = "badge bad"
  }
}

async function configureRuntime() {
  if (window.octopus.canInit && !await window.octopus.canInit()) {
    document.getElementById("initPanel").hidden = true
  }
}

setInterval(() => { if (selectedProject) showProject(selectedProject).catch(() => {}) }, 2000)
configureRuntime().then(() => refreshProjects()).catch((error) => {
  statusEl.textContent = error.message
  statusEl.className = "badge bad"
})
