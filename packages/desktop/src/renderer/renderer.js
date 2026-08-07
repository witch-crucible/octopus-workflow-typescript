// 渲染进程 —— 通过 preload 暴露的 window.octopus 与主进程通信。
const projectsEl = document.getElementById("projects")
const contentEl = document.getElementById("content")

async function refreshProjects(selectId) {
  const ids = await window.octopus.listProjects()
  projectsEl.innerHTML = ""
  if (ids.length === 0) {
    projectsEl.innerHTML = '<p class="muted">暂无项目</p>'
    return
  }
  for (const id of ids) {
    const div = document.createElement("div")
    div.className = "project" + (id === selectId ? " active" : "")
    div.textContent = id
    div.onclick = () => showStatus(id)
    projectsEl.appendChild(div)
  }
  if (selectId) showStatus(selectId)
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])
}

async function showStatus(id) {
  document.querySelectorAll(".project").forEach((el) => {
    el.classList.toggle("active", el.textContent === id)
  })
  const s = await window.octopus.status(id)
  const phases = s.phaseProgress
    .map((p) => {
      const pct = p.progress.percent
      return `<tr><td>${esc(p.phase)}</td><td class="muted">${esc(p.lock)}</td>
        <td><span class="bar"><span style="width:${pct}%"></span></span> ${pct}%</td></tr>`
    })
    .join("")
  contentEl.innerHTML = `
    <h2>${esc(s.projectName)}</h2>
    <p class="muted">ID: ${esc(s.projectId)} · 当前阶段: ${esc(s.currentPhase)}</p>
    <table>${phases}</table>
    <p style="margin-top:16px">
      任务: ${s.completedTasks}/${s.totalTasks} 已完成 &nbsp;·&nbsp;
      清单: ${s.checklistStats.verified}/${s.checklistStats.total} 已核验
    </p>
    <p>海因里希三角 — 重大: ${s.heinrichSummary.major} · 轻微: ${s.heinrichSummary.minor} · 未遂: ${s.heinrichSummary.trivial}</p>
    <div class="row task-actions">
      <button id="export-tasks">导出任务</button>
      <button id="import-tasks">导入任务</button>
    </div>
    <p id="task-transfer-message" class="muted"></p>
  `

  const exportButton = document.getElementById("export-tasks")
  const importButton = document.getElementById("import-tasks")
  const messageEl = document.getElementById("task-transfer-message")

  exportButton.onclick = async () => {
    exportButton.disabled = true
    messageEl.textContent = "正在导出任务…"
    try {
      const result = await window.octopus.exportTasks(id)
      messageEl.textContent = result.canceled
        ? "已取消导出。"
        : `已导出 ${result.taskCount} 个任务：${result.outputPath}`
    } catch (error) {
      messageEl.textContent = `导出失败：${error.message}`
    } finally {
      exportButton.disabled = false
    }
  }

  importButton.onclick = async () => {
    importButton.disabled = true
    messageEl.textContent = "正在导入任务…"
    try {
      const result = await window.octopus.importTasks(id)
      if (result.canceled) {
        messageEl.textContent = "已取消导入。"
        return
      }
      await showStatus(id)
      document.getElementById("task-transfer-message").textContent =
        `导入完成：匹配 ${result.matched}，更新 ${result.updated}，未变化 ${result.unchanged}`
    } catch (error) {
      messageEl.textContent = `导入失败：${error.message}`
    } finally {
      importButton.disabled = false
    }
  }
}

document.getElementById("create").onclick = async () => {
  const name = document.getElementById("name").value.trim()
  if (!name) return
  const desc = document.getElementById("desc").value.trim() || undefined
  const res = await window.octopus.init(name, desc)
  document.getElementById("name").value = ""
  document.getElementById("desc").value = ""
  refreshProjects(res.projectId)
}

refreshProjects()
