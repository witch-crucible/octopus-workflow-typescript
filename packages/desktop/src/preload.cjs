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
  setProjectDefaultColor: (projectId, color) => ipcRenderer.invoke("octopus:setProjectDefaultColor", projectId, color),
  bindProjectTeambitionRepo: (projectId, opts) => ipcRenderer.invoke("octopus:bindProjectTeambitionRepo", projectId, opts),
  unbindProjectTeambitionRepo: (projectId) => ipcRenderer.invoke("octopus:unbindProjectTeambitionRepo", projectId),
  listProjectVersions: (projectId, opts) => ipcRenderer.invoke("octopus:listProjectVersions", projectId, opts),
  syncProjectVersions: (projectId) => ipcRenderer.invoke("octopus:syncProjectVersions", projectId),
  getProjectVersion: (projectId, versionId) => ipcRenderer.invoke("octopus:getProjectVersion", projectId, versionId),
  setProjectDefaultVersion: (projectId, versionId) => ipcRenderer.invoke("octopus:setProjectDefaultVersion", projectId, versionId),
  bindRequirementVersion: (requirementId, versionId) => ipcRenderer.invoke("octopus:bindRequirementVersion", requirementId, versionId),
  unbindRequirementVersion: (requirementId) => ipcRenderer.invoke("octopus:unbindRequirementVersion", requirementId),
  getRequirementVersionBinding: (requirementId) => ipcRenderer.invoke("octopus:getRequirementVersionBinding", requirementId),
  listVersionRequirements: (projectId, versionId) => ipcRenderer.invoke("octopus:listVersionRequirements", projectId, versionId),
  updateVersionNote: (projectId, versionId, note) => ipcRenderer.invoke("octopus:updateVersionNote", projectId, versionId, note),
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
  updateRequirementSchedule: (requirementId, schedule) =>
    ipcRenderer.invoke("octopus:updateRequirementSchedule", requirementId, schedule),
  moveRequirementPhase: (requirementId, toPhase) =>
    ipcRenderer.invoke("octopus:moveRequirementPhase", requirementId, toPhase),
  listMilestones: (requirementId) => ipcRenderer.invoke("octopus:listMilestones", requirementId),
  listProjectMilestones: (projectId) => ipcRenderer.invoke("octopus:listProjectMilestones", projectId),
  addMilestone: (requirementId, input) => ipcRenderer.invoke("octopus:addMilestone", requirementId, input),
  updateMilestone: (requirementId, milestoneId, patch) =>
    ipcRenderer.invoke("octopus:updateMilestone", requirementId, milestoneId, patch),
  reachMilestone: (requirementId, milestoneId) =>
    ipcRenderer.invoke("octopus:reachMilestone", requirementId, milestoneId),
  unreachMilestone: (requirementId, milestoneId) =>
    ipcRenderer.invoke("octopus:unreachMilestone", requirementId, milestoneId),
  deleteMilestone: (requirementId, milestoneId) =>
    ipcRenderer.invoke("octopus:deleteMilestone", requirementId, milestoneId),
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

  assignNode: (requirementId, nodeId, assignedTo) => ipcRenderer.invoke("octopus:assignNode", requirementId, nodeId, assignedTo),
  listMyWork: (identity, projectId) => ipcRenderer.invoke("octopus:listMyWork", identity, projectId),
  getProjectOverview: (projectId) => ipcRenderer.invoke("octopus:getProjectOverview", projectId),
  getIdentity: () => ipcRenderer.invoke("octopus:getIdentity"),
  setIdentity: (name) => ipcRenderer.invoke("octopus:setIdentity", name),

  exportProjectOmniPlan: (projectId, opts) => ipcRenderer.invoke("octopus:exportProjectOmniPlan", projectId, opts),
  importProjectOmniPlan: (projectId, opts) => ipcRenderer.invoke("octopus:importProjectOmniPlan", projectId, opts),
  setProjectOmniPlanMeta: (projectId, patch) => ipcRenderer.invoke("octopus:setProjectOmniPlanMeta", projectId, patch),
  getProjectBrdDesignConfig: (projectId) => ipcRenderer.invoke("octopus:getProjectBrdDesignConfig", projectId),
  setProjectBrdDesignConfig: (projectId, patch) => ipcRenderer.invoke("octopus:setProjectBrdDesignConfig", projectId, patch),
  previewBrdPrompts: (projectId, requirementId, opts) =>
    ipcRenderer.invoke("octopus:previewBrdPrompts", projectId, requirementId, opts),
})
