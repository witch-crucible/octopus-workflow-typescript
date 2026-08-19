// 预加载脚本（CJS）—— 通过 contextBridge 暴露受限的 octopus API。
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("octopus", {
  canInit: () => ipcRenderer.invoke("octopus:canInit"),

  // Project
  listProjects: () => ipcRenderer.invoke("octopus:listProjects"),
  listProjectSummaries: () => ipcRenderer.invoke("octopus:listProjectSummaries"),
  createProject: (name, description) => ipcRenderer.invoke("octopus:createProject", name, description),
  getProject: (projectId) => ipcRenderer.invoke("octopus:getProject", projectId),
  updateProjectMeta: (projectId, patch) => ipcRenderer.invoke("octopus:updateProjectMeta", projectId, patch),
  deleteProject: (projectId) => ipcRenderer.invoke("octopus:deleteProject", projectId),
  bindProjectTeambition: (projectId, opts) => ipcRenderer.invoke("octopus:bindProjectTeambition", projectId, opts),
  unbindProjectTeambition: (projectId) => ipcRenderer.invoke("octopus:unbindProjectTeambition", projectId),
  listTeambitionCardStatuses: (projectId) => ipcRenderer.invoke("octopus:listTeambitionCardStatuses", projectId),

  // Requirement
  listRequirements: (projectId) => ipcRenderer.invoke("octopus:listRequirements", projectId),
  listRequirementSummaries: (projectId) => ipcRenderer.invoke("octopus:listRequirementSummaries", projectId),
  initRequirement: (projectId, name, description, projectRoot) =>
    ipcRenderer.invoke("octopus:initRequirement", projectId, name, description, projectRoot),
  updateRequirement: (requirementId, patch) => ipcRenderer.invoke("octopus:updateRequirement", requirementId, patch),
  deleteRequirement: (requirementId) => ipcRenderer.invoke("octopus:deleteRequirement", requirementId),
  getRequirementStatus: (requirementId) => ipcRenderer.invoke("octopus:getRequirementStatus", requirementId),
  getState: (requirementId) => ipcRenderer.invoke("octopus:getState", requirementId),
  getExecutionSnapshot: (requirementId) => ipcRenderer.invoke("octopus:getExecutionSnapshot", requirementId),
  updateNodeSchedule: (requirementId, nodeId, schedule) =>
    ipcRenderer.invoke("octopus:updateNodeSchedule", requirementId, nodeId, schedule),
  runNode: (requirementId, nodeId, force) => ipcRenderer.invoke("octopus:runNode", requirementId, nodeId, force),
  runWorkflow: (requirementId, force, maxParallel) =>
    ipcRenderer.invoke("octopus:runWorkflow", requirementId, force, maxParallel),
  completeNode: (requirementId, nodeId, force) =>
    ipcRenderer.invoke("octopus:completeNode", requirementId, nodeId, force),
  cancelRun: (requirementId, runId) => ipcRenderer.invoke("octopus:cancelRun", requirementId, runId),
  retryRun: (requirementId, runId, force) => ipcRenderer.invoke("octopus:retryRun", requirementId, runId, force),
  runs: (requirementId, nodeId) => ipcRenderer.invoke("octopus:runs", requirementId, nodeId),
  events: (requirementId, sequence) => ipcRenderer.invoke("octopus:events", requirementId, sequence),
  bindRequirementTask: (requirementId, opts) =>
    ipcRenderer.invoke("octopus:bindRequirementTask", requirementId, opts),
  unbindRequirementTask: (requirementId) => ipcRenderer.invoke("octopus:unbindRequirementTask", requirementId),
  getRequirementTeambitionStatus: (requirementId) =>
    ipcRenderer.invoke("octopus:getRequirementTeambitionStatus", requirementId),
  updateRequirementTeambitionStatus: (requirementId, statusId, operatorId) =>
    ipcRenderer.invoke("octopus:updateRequirementTeambitionStatus", requirementId, statusId, operatorId),

  health: () => ipcRenderer.invoke("octopus:health"),
  resolveNodeWorkspace: (requirementId, nodeId) =>
    ipcRenderer.invoke("octopus:resolveNodeWorkspace", requirementId, nodeId),
  openNodeDirectory: (requirementId, nodeId) =>
    ipcRenderer.invoke("octopus:openNodeDirectory", requirementId, nodeId),
  exportTasks: (requirementId) => ipcRenderer.invoke("octopus:exportTasks", requirementId),
  importTasks: (requirementId) => ipcRenderer.invoke("octopus:importTasks", requirementId),
})
