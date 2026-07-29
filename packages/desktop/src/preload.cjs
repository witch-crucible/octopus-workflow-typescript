// 预加载脚本（CJS）—— 通过 contextBridge 暴露受限的 octopus API。
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("octopus", {
  listProjects: () => ipcRenderer.invoke("octopus:listProjects"),
  init: (name, description) => ipcRenderer.invoke("octopus:init", name, description),
  status: (projectId) => ipcRenderer.invoke("octopus:status", projectId),
})
