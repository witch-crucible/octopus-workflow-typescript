// 预加载脚本（CJS）—— 通过 contextBridge 暴露受限的 octopus API。
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("octopus", {
  canInit: () => ipcRenderer.invoke("octopus:canInit"),
  listProjects: () => ipcRenderer.invoke("octopus:listProjects"),
  init: (name, description, projectRoot) => ipcRenderer.invoke("octopus:init", name, description, projectRoot),
  status: (projectId) => ipcRenderer.invoke("octopus:status", projectId),
  snapshot: (projectId) => ipcRenderer.invoke("octopus:snapshot", projectId),
  state: (projectId) => ipcRenderer.invoke("octopus:state", projectId),
  runNode: (projectId, nodeId, force) => ipcRenderer.invoke("octopus:runNode", projectId, nodeId, force),
  runWorkflow: (projectId, force, maxParallel) => ipcRenderer.invoke("octopus:runWorkflow", projectId, force, maxParallel),
  completeNode: (projectId, nodeId, force) => ipcRenderer.invoke("octopus:completeNode", projectId, nodeId, force),
  cancelRun: (projectId, runId) => ipcRenderer.invoke("octopus:cancelRun", projectId, runId),
  retryRun: (projectId, runId, force) => ipcRenderer.invoke("octopus:retryRun", projectId, runId, force),
  runs: (projectId, nodeId) => ipcRenderer.invoke("octopus:runs", projectId, nodeId),
  events: (projectId, sequence) => ipcRenderer.invoke("octopus:events", projectId, sequence),
  health: () => ipcRenderer.invoke("octopus:health"),
  openNodeDirectory: (projectId, nodeId) => ipcRenderer.invoke("octopus:openNodeDirectory", projectId, nodeId),
  exportTasks: (projectId) => ipcRenderer.invoke("octopus:exportTasks", projectId),
  importTasks: (projectId) => ipcRenderer.invoke("octopus:importTasks", projectId),
})
