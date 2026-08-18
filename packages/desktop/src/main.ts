/**
 * Electron 主进程 —— 加载 Octopus 引擎并向渲染进程暴露 IPC。
 *
 * 桌面端复用与 CLI 相同的引擎：`loadConfig` + `createWorkflowEngineFromConfig`。
 * 项目状态持久化到 Electron 的 userData 目录，避免污染工作目录。
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, dialog, ipcMain, shell, Notification } from "electron"
import { loadConfig } from "@octopus/context/config.js"
import { getWorkflowWorkspace } from "@octopus/context/workflow.js"
import { createWorkflowEngineFromConfig } from "@octopus/workflow-engine/index.js"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

let engine: WorkflowEngine

/** 读取项目 ID 列表（与 CLI status 命令使用同一入口）。 */
function listProjects(): string[] {
  return engine.listProjects()
}

function registerIpc(): void {
  ipcMain.handle("octopus:canInit", () => true)
  ipcMain.handle("octopus:listProjects", () => listProjects())
  ipcMain.handle("octopus:listProjectSummaries", () => engine.listProjectSummaries())

  ipcMain.handle("octopus:init", (_e, name: string, description?: string, projectRoot?: string) => {
    const state = engine.initProject(name, description, projectRoot ?? app.getPath("documents"))
    return {
      projectId: state.projectId,
      projectName: state.projectName,
      currentPhase: state.currentPhase,
      taskCount: state.steps.length,
    }
  })

  ipcMain.handle("octopus:updateProject", (_e, projectId: string, patch: { name?: string; description?: string }) => {
    const state = engine.updateProject(projectId, patch ?? {})
    return {
      projectId: state.projectId,
      projectName: state.projectName,
      description: state.description,
    }
  })

  ipcMain.handle(
    "octopus:updateNodeSchedule",
    (_e, projectId: string, nodeId: string, schedule: { plannedStart?: string | null; plannedEnd?: string | null }) => {
      const state = engine.updateNodeSchedule(projectId, nodeId, schedule ?? {})
      const step = state.steps.find((item) => item.id === nodeId)
      return {
        projectId: state.projectId,
        nodeId,
        plannedStart: step?.plannedStart ?? null,
        plannedEnd: step?.plannedEnd ?? null,
      }
    },
  )

  ipcMain.handle("octopus:deleteProject", (_e, projectId: string) => {
    engine.deleteProject(projectId)
    return { deleted: true, projectId }
  })

  ipcMain.handle("octopus:status", (_e, projectId: string) => engine.getProjectStatus(projectId))
  ipcMain.handle("octopus:snapshot", (_e, projectId: string) => engine.getExecutionSnapshot(projectId))
  ipcMain.handle("octopus:state", (_e, projectId: string) => engine.getState(projectId))
  ipcMain.handle("octopus:runNode", (_e, projectId: string, nodeId: string, force?: boolean) => engine.execution.runNode(projectId, nodeId, force === undefined ? {} : { force }))
  ipcMain.handle("octopus:runWorkflow", (_e, projectId: string, force?: boolean, maxParallel?: number) => engine.runWorkflow(projectId, {
    ...(force === undefined ? {} : { force }),
    ...(maxParallel === undefined ? {} : { maxParallel }),
  }))
  ipcMain.handle("octopus:completeNode", (_e, projectId: string, nodeId: string, force?: boolean) => engine.execution.completeManualNode(projectId, nodeId, force === true))
  ipcMain.handle("octopus:cancelRun", (_e, projectId: string, runId: string) => engine.execution.cancelRun(projectId, runId))
  ipcMain.handle("octopus:retryRun", (_e, projectId: string, runId: string, force?: boolean) => engine.execution.retryRun(projectId, runId, force === undefined ? {} : { force }))
  ipcMain.handle("octopus:runs", (_e, projectId: string, nodeId?: string) => engine.execution.listRuns(projectId, nodeId))
  ipcMain.handle("octopus:events", (_e, projectId: string, sequence?: number) => engine.execution.eventsAfter(projectId, sequence ?? 0))
  ipcMain.handle("octopus:health", () => engine.checkIntegrationHealth())
  ipcMain.handle("octopus:openNodeDirectory", async (_e, projectId: string, nodeId: string) => {
    const state = engine.getState(projectId)
    if (!state.projectRoot) throw new Error("项目没有源码根目录")
    const path = getWorkflowWorkspace(state.projectRoot).nodePath(engine.resolveNodeKey(projectId, nodeId))
    return shell.openPath(path)
  })

  ipcMain.handle("octopus:exportTasks", async (_e, projectId: string) => {
    const document = engine.exportTasks(projectId)
    const selected = await dialog.showSaveDialog({
      title: "导出任务",
      defaultPath: `${projectId}-tasks.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    if (selected.canceled || !selected.filePath) {
      return { canceled: true }
    }

    writeFileSync(selected.filePath, `${JSON.stringify(document, null, 2)}\n`, "utf-8")
    return {
      canceled: false,
      outputPath: selected.filePath,
      taskCount: document.tasks.length,
    }
  })

  ipcMain.handle("octopus:importTasks", async (_e, projectId: string) => {
    const selected = await dialog.showOpenDialog({
      title: "导入任务",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    })
    const inputPath = selected.filePaths[0]
    if (selected.canceled || !inputPath) {
      return { canceled: true }
    }

    const confirmation = await dialog.showMessageBox({
      type: "warning",
      title: "确认导入任务",
      message: `将 ${basename(inputPath)} 的任务进度合并到项目 ${projectId}？`,
      detail: "导入会更新匹配任务的状态、实际负责人、备注和完成时间。",
      buttons: ["取消", "导入"],
      defaultId: 1,
      cancelId: 0,
    })
    if (confirmation.response !== 1) {
      return { canceled: true }
    }

    const document = JSON.parse(readFileSync(inputPath, "utf-8")) as unknown
    return {
      canceled: false,
      inputPath,
      ...engine.importTasks(projectId, document),
    }
  })
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

  // 窗口打开期间由主进程轮询失败事件，避免渲染进程自行访问文件系统。
  const notifiedEvents = new Set<number>()
  setInterval(() => {
    for (const projectId of listProjects()) {
      const events = engine.execution.eventsAfter(projectId, 0)
      for (const event of events) {
        if (event.type === "RUN_FAILED" && !notifiedEvents.has(event.sequence) && Notification.isSupported()) {
          notifiedEvents.add(event.sequence)
          new Notification({ title: "Octopus 节点执行失败", body: String(event.payload["error"] ?? event.nodeId ?? "未知错误") }).show()
        }
      }
    }
  }, 5_000)

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  // macOS 习惯：保留应用直至用户显式退出（Cmd+Q）。
  if (process.platform !== "darwin") app.quit()
})
