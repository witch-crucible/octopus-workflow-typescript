// 浏览器 transport：Electron 中由 preload 提供 window.octopus，浏览器中改用同源 HTTP API。
if (!window.octopus) {
  async function invoke(method, ...args) {
    const response = await fetch("/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, args }),
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`)
    return payload.result
  }

  async function chooseJsonFile() {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input")
      input.type = "file"
      input.accept = "application/json,.json"
      input.onchange = async () => {
        try {
          const file = input.files?.[0]
          resolve(file ? JSON.parse(await file.text()) : undefined)
        } catch (error) {
          reject(error)
        }
      }
      input.oncancel = () => resolve(undefined)
      input.click()
    })
  }

  window.octopus = {
    canInit: () => invoke("canInit"),
    listProjects: () => invoke("listProjects"),
    listProjectSummaries: () => invoke("listProjectSummaries"),
    init: (name, description, projectRoot) => invoke("init", name, description, projectRoot),
    updateProject: (projectId, patch) => invoke("updateProject", projectId, patch),
    updateNodeSchedule: (projectId, nodeId, schedule) => invoke("updateNodeSchedule", projectId, nodeId, schedule),
    deleteProject: (projectId) => invoke("deleteProject", projectId),
    status: (projectId) => invoke("status", projectId),
    snapshot: (projectId) => invoke("snapshot", projectId),
    state: (projectId) => invoke("state", projectId),
    runNode: (projectId, nodeId, force) => invoke("runNode", projectId, nodeId, force),
    runWorkflow: (projectId, force, maxParallel) => invoke("runWorkflow", projectId, force, maxParallel),
    completeNode: (projectId, nodeId, force) => invoke("completeNode", projectId, nodeId, force),
    cancelRun: (projectId, runId) => invoke("cancelRun", projectId, runId),
    retryRun: (projectId, runId, force) => invoke("retryRun", projectId, runId, force),
    runs: (projectId, nodeId) => invoke("runs", projectId, nodeId),
    events: (projectId, sequence) => invoke("events", projectId, sequence),
    health: () => invoke("health"),
    exportTasks: async (projectId) => {
      const result = await invoke("exportTasks", projectId)
      const blob = new Blob([`${JSON.stringify(result.document, null, 2)}\n`], { type: "application/json" })
      const link = document.createElement("a")
      link.href = URL.createObjectURL(blob)
      link.download = `${projectId}-tasks.json`
      link.click()
      URL.revokeObjectURL(link.href)
      return { canceled: false, taskCount: result.taskCount }
    },
    importTasks: async (projectId) => {
      const document = await chooseJsonFile()
      if (!document) return { canceled: true }
      if (!window.confirm(`将所选任务进度合并到项目 ${projectId}？`)) return { canceled: true }
      return { canceled: false, ...await invoke("importTasks", projectId, document) }
    },
  }
  window.octopusRuntime = "web"
}
