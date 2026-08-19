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
    createProject: (name, description) => invoke("createProject", name, description),
    getProject: (projectId) => invoke("getProject", projectId),
    updateProjectMeta: (projectId, patch) => invoke("updateProjectMeta", projectId, patch),
    deleteProject: (projectId) => invoke("deleteProject", projectId),
    bindProjectTeambition: (projectId, opts) => invoke("bindProjectTeambition", projectId, opts),
    unbindProjectTeambition: (projectId) => invoke("unbindProjectTeambition", projectId),
    listTeambitionCardStatuses: (projectId) => invoke("listTeambitionCardStatuses", projectId),

    listRequirements: (projectId) => invoke("listRequirements", projectId),
    listRequirementSummaries: (projectId) => invoke("listRequirementSummaries", projectId),
    initRequirement: (projectId, name, description, projectRoot) =>
      invoke("initRequirement", projectId, name, description, projectRoot),
    updateRequirement: (requirementId, patch) => invoke("updateRequirement", requirementId, patch),
    deleteRequirement: (requirementId) => invoke("deleteRequirement", requirementId),
    getRequirementStatus: (requirementId) => invoke("getRequirementStatus", requirementId),
    getState: (requirementId) => invoke("getState", requirementId),
    getExecutionSnapshot: (requirementId) => invoke("getExecutionSnapshot", requirementId),
    updateNodeSchedule: (requirementId, nodeId, schedule) =>
      invoke("updateNodeSchedule", requirementId, nodeId, schedule),
    updateRequirementSchedule: (requirementId, schedule) =>
      invoke("updateRequirementSchedule", requirementId, schedule),
    moveRequirementPhase: (requirementId, toPhase) =>
      invoke("moveRequirementPhase", requirementId, toPhase),
    listMilestones: (requirementId) => invoke("listMilestones", requirementId),
    listProjectMilestones: (projectId) => invoke("listProjectMilestones", projectId),
    addMilestone: (requirementId, input) => invoke("addMilestone", requirementId, input),
    updateMilestone: (requirementId, milestoneId, patch) =>
      invoke("updateMilestone", requirementId, milestoneId, patch),
    reachMilestone: (requirementId, milestoneId) =>
      invoke("reachMilestone", requirementId, milestoneId),
    unreachMilestone: (requirementId, milestoneId) =>
      invoke("unreachMilestone", requirementId, milestoneId),
    deleteMilestone: (requirementId, milestoneId) =>
      invoke("deleteMilestone", requirementId, milestoneId),
    runNode: (requirementId, nodeId, force) => invoke("runNode", requirementId, nodeId, force),
    runWorkflow: (requirementId, force, maxParallel) =>
      invoke("runWorkflow", requirementId, force, maxParallel),
    completeNode: (requirementId, nodeId, force) => invoke("completeNode", requirementId, nodeId, force),
    cancelRun: (requirementId, runId) => invoke("cancelRun", requirementId, runId),
    retryRun: (requirementId, runId, force) => invoke("retryRun", requirementId, runId, force),
    runs: (requirementId, nodeId) => invoke("runs", requirementId, nodeId),
    events: (requirementId, sequence) => invoke("events", requirementId, sequence),
    bindRequirementTask: (requirementId, opts) => invoke("bindRequirementTask", requirementId, opts),
    unbindRequirementTask: (requirementId) => invoke("unbindRequirementTask", requirementId),
    getRequirementTeambitionStatus: (requirementId) => invoke("getRequirementTeambitionStatus", requirementId),
    updateRequirementTeambitionStatus: (requirementId, statusId, operatorId) =>
      invoke("updateRequirementTeambitionStatus", requirementId, statusId, operatorId),

    health: () => invoke("health"),
    resolveNodeWorkspace: (requirementId, nodeId) => invoke("resolveNodeWorkspace", requirementId, nodeId),
    exportTasks: async (requirementId) => {
      const result = await invoke("exportTasks", requirementId)
      const blob = new Blob([`${JSON.stringify(result.document, null, 2)}\n`], { type: "application/json" })
      const link = document.createElement("a")
      link.href = URL.createObjectURL(blob)
      link.download = `${requirementId}-tasks.json`
      link.click()
      URL.revokeObjectURL(link.href)
      return { canceled: false, taskCount: result.taskCount }
    },
    importTasks: async (requirementId) => {
      const document = await chooseJsonFile()
      if (!document) return { canceled: true }
      if (!window.confirm(`将所选任务进度合并到需求 ${requirementId}？`)) return { canceled: true }
      return { canceled: false, ...await invoke("importTasks", requirementId, document) }
    },

    // OmniPlan
    exportProjectOmniPlan: (projectId, opts) => invoke("exportProjectOmniPlan", projectId, opts),
    importProjectOmniPlan: (projectId, opts) => invoke("importProjectOmniPlan", projectId, opts),
    setProjectOmniPlanMeta: (projectId, patch) => invoke("setProjectOmniPlanMeta", projectId, patch),

    // BRD 设计
    getProjectBrdDesignConfig: (projectId) => invoke("getProjectBrdDesignConfig", projectId),
    setProjectBrdDesignConfig: (projectId, patch) => invoke("setProjectBrdDesignConfig", projectId, patch),
    previewBrdPrompts: (projectId, requirementId, opts) =>
      invoke("previewBrdPrompts", projectId, requirementId, opts),

    assignNode: (requirementId, nodeId, assignedTo) => invoke("assignNode", requirementId, nodeId, assignedTo),
    listMyWork: (identity, projectId) => invoke("listMyWork", identity, projectId),
    getProjectOverview: (projectId) => invoke("getProjectOverview", projectId),
    getIdentity: () => invoke("getIdentity"),
    setIdentity: (name) => invoke("setIdentity", name),
  }
  window.octopusRuntime = "web"
}
