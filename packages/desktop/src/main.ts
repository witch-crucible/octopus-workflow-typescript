/**
 * Electron 主进程 —— 加载 Octopus 引擎并向渲染进程暴露 IPC。
 *
 * 桌面端复用与 CLI 相同的引擎：`loadConfig` + `createWorkflowEngineFromConfig`。
 * 项目状态持久化到 Electron 的 userData 目录，避免污染工作目录。
 */

import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, ipcMain } from "electron"
import { loadConfig } from "@octopus/context/config.js"
import { createWorkflowEngineFromConfig } from "@octopus/workflow-engine/index.js"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

let engine: WorkflowEngine

/** 读取项目 ID 列表（与 CLI status 命令使用同一入口）。 */
function listProjects(): string[] {
  return (engine as unknown as { store: { listProjects(): string[] } }).store.listProjects()
}

function registerIpc(): void {
  ipcMain.handle("octopus:listProjects", () => listProjects())

  ipcMain.handle("octopus:init", (_e, name: string, description?: string) => {
    const state = engine.initProject(name, description)
    return {
      projectId: state.projectId,
      projectName: state.projectName,
      currentPhase: state.currentPhase,
      taskCount: state.steps.length,
    }
  })

  ipcMain.handle("octopus:status", (_e, projectId: string) => engine.getProjectStatus(projectId))
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    webPreferences: {
      preload: join(__dirname, "..", "src", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  void win.loadFile(join(__dirname, "..", "src", "renderer", "index.html"))
}

app.whenReady().then(async () => {
  const config = loadConfig(join(app.getPath("userData"), "store"))
  engine = await createWorkflowEngineFromConfig(config)
  registerIpc()
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  // macOS 习惯：保留应用直至用户显式退出（Cmd+Q）。
  if (process.platform !== "darwin") app.quit()
})
