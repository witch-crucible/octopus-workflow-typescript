/**
 * Electron 主进程 —— 加载 Octopus 引擎并向渲染进程暴露 IPC。
 *
 * 桌面端复用与 CLI 相同的引擎：`loadConfig` + `createWorkflowEngineFromConfig`。
 * 项目状态持久化到 Electron 的 userData 目录，避免污染工作目录。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, dialog, ipcMain, shell, Notification } from "electron"
import { getIdentity, loadConfig, saveIdentity } from "@octopus/context/config.js"
import { getWorkflowWorkspace } from "@octopus/context/workflow.js"
import { createWorkflowEngineFromConfig } from "@octopus/workflow-engine/index.js"
import type { WorkflowEngine } from "@octopus/workflow-engine/index.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

let engine: WorkflowEngine

function listRequirements(): string[] {
  return engine.listRequirements()
}

function registerIpc(): void {
  ipcMain.handle("octopus:canInit", () => true)

  ipcMain.handle("octopus:listProjects", () => engine.listProjects())
  ipcMain.handle("octopus:listProjectSummaries", () => engine.listProjectSummaries())
  ipcMain.handle("octopus:createProject", (_e, name: string, description?: string) => {
    const project = engine.createProject(name, description)
    return {
      projectId: project.projectId,
      name: project.name,
      description: project.description,
      updatedAt: project.updatedAt,
    }
  })
  ipcMain.handle("octopus:getProject", (_e, projectId: string) => engine.getProject(projectId))
  ipcMain.handle("octopus:updateProjectMeta", (_e, projectId: string, patch: { name?: string; description?: string }) => {
    const project = engine.updateProjectMeta(projectId, patch ?? {})
    return {
      projectId: project.projectId,
      name: project.name,
      description: project.description,
    }
  })
  ipcMain.handle("octopus:deleteProject", (_e, projectId: string) => {
    engine.deleteProject(projectId)
    return { deleted: true, projectId }
  })
  ipcMain.handle(
    "octopus:bindProjectTeambition",
    (_e, projectId: string, opts: { projectId?: string; prefix?: string }) =>
      engine.bindProjectTeambition(projectId, opts ?? {}),
  )
  ipcMain.handle("octopus:unbindProjectTeambition", (_e, projectId: string) =>
    engine.unbindProjectTeambition(projectId))
  ipcMain.handle("octopus:listTeambitionCardStatuses", (_e, projectId: string) =>
    engine.listTeambitionCardStatuses(projectId))

  ipcMain.handle("octopus:listRequirements", (_e, projectId?: string) => engine.listRequirements(projectId))
  ipcMain.handle("octopus:listRequirementSummaries", (_e, projectId?: string) =>
    engine.listRequirementSummaries(projectId))
  ipcMain.handle(
    "octopus:initRequirement",
    (_e, projectId: string, name: string, description?: string, projectRoot?: string) => {
      const state = engine.initRequirement(
        projectId,
        name,
        description,
        projectRoot ?? app.getPath("documents"),
      )
      return {
        projectId: state.projectId,
        requirementId: state.requirementId,
        requirementName: state.requirementName,
        currentPhase: state.currentPhase,
        taskCount: state.steps.length,
      }
    },
  )
  ipcMain.handle(
    "octopus:updateRequirement",
    (_e, requirementId: string, patch: { name?: string; description?: string; owner?: string | null }) => {
      const state = engine.updateRequirement(requirementId, patch ?? {})
      return {
        projectId: state.projectId,
        requirementId: state.requirementId,
        requirementName: state.requirementName,
        description: state.description,
      }
    },
  )
  ipcMain.handle("octopus:deleteRequirement", (_e, requirementId: string) => {
    engine.deleteRequirement(requirementId)
    return { deleted: true, requirementId }
  })
  ipcMain.handle("octopus:getRequirementStatus", (_e, requirementId: string) =>
    engine.getRequirementStatus(requirementId))
  ipcMain.handle("octopus:getState", (_e, requirementId: string) => engine.getState(requirementId))
  ipcMain.handle("octopus:getWorkflowDefinition", (_e, requirementId: string) =>
    engine.getWorkflowDefinition(requirementId))
  ipcMain.handle("octopus:getExecutionSnapshot", (_e, requirementId: string) =>
    engine.getExecutionSnapshot(requirementId))
  ipcMain.handle(
    "octopus:updateNodeSchedule",
    (_e, requirementId: string, nodeId: string, schedule: { plannedStart?: string | null; plannedEnd?: string | null }) => {
      const state = engine.updateNodeSchedule(requirementId, nodeId, schedule ?? {})
      const step = state.steps.find((item) => item.id === nodeId)
      return {
        requirementId: state.requirementId,
        nodeId,
        plannedStart: step?.plannedStart ?? null,
        plannedEnd: step?.plannedEnd ?? null,
      }
    },
  )
  ipcMain.handle(
    "octopus:updateRequirementSchedule",
    (_e, requirementId: string, schedule: { plannedStart?: string | null; plannedEnd?: string | null }) => {
      const state = engine.updateRequirementSchedule(requirementId, schedule ?? {})
      return {
        requirementId: state.requirementId,
        plannedStart: state.plannedStart ?? null,
        plannedEnd: state.plannedEnd ?? null,
      }
    },
  )
  ipcMain.handle(
    "octopus:moveRequirementPhase",
    (_e, requirementId: string, toPhase: string) => {
      const state = engine.moveRequirementPhase(requirementId, toPhase as never)
      return {
        requirementId: state.requirementId,
        currentPhase: state.currentPhase,
      }
    },
  )
  ipcMain.handle("octopus:listMilestones", (_e, requirementId: string) =>
    engine.listMilestones(requirementId))
  ipcMain.handle("octopus:listProjectMilestones", (_e, projectId: string) =>
    engine.listProjectMilestones(projectId))
  ipcMain.handle(
    "octopus:addMilestone",
    (_e, requirementId: string, input: { name: string; date: string; phase?: string; nodeId?: string; note?: string }) =>
      engine.addMilestone(requirementId, input as never),
  )
  ipcMain.handle(
    "octopus:updateMilestone",
    (
      _e,
      requirementId: string,
      milestoneId: string,
      patch: { name?: string; date?: string | null; phase?: string | null; nodeId?: string | null; note?: string | null },
    ) => engine.updateMilestone(requirementId, milestoneId, patch as never),
  )
  ipcMain.handle("octopus:reachMilestone", (_e, requirementId: string, milestoneId: string) =>
    engine.reachMilestone(requirementId, milestoneId))
  ipcMain.handle("octopus:unreachMilestone", (_e, requirementId: string, milestoneId: string) =>
    engine.unreachMilestone(requirementId, milestoneId))
  ipcMain.handle("octopus:deleteMilestone", (_e, requirementId: string, milestoneId: string) => {
    engine.deleteMilestone(requirementId, milestoneId)
    return { deleted: true, milestoneId }
  })
  ipcMain.handle("octopus:runNode", (_e, requirementId: string, nodeId: string, force?: boolean) =>
    engine.execution.runNode(requirementId, nodeId, force === undefined ? {} : { force }))
  ipcMain.handle("octopus:runWorkflow", (_e, requirementId: string, force?: boolean, maxParallel?: number) =>
    engine.runWorkflow(requirementId, {
      ...(force === undefined ? {} : { force }),
      ...(maxParallel === undefined ? {} : { maxParallel }),
    }))
  ipcMain.handle("octopus:completeNode", (_e, requirementId: string, nodeId: string, force?: boolean) =>
    engine.execution.completeManualNode(requirementId, nodeId, force === true))
  ipcMain.handle("octopus:cancelRun", (_e, requirementId: string, runId: string) =>
    engine.execution.cancelRun(requirementId, runId))
  ipcMain.handle("octopus:retryRun", (_e, requirementId: string, runId: string, force?: boolean) =>
    engine.execution.retryRun(requirementId, runId, force === undefined ? {} : { force }))
  ipcMain.handle("octopus:runs", (_e, requirementId: string, nodeId?: string) =>
    engine.execution.listRuns(requirementId, nodeId))
  ipcMain.handle("octopus:events", (_e, requirementId: string, sequence?: number) =>
    engine.execution.eventsAfter(requirementId, sequence ?? 0))
  ipcMain.handle(
    "octopus:bindRequirementTask",
    (_e, requirementId: string, opts: { taskRef?: string; taskId?: string }) =>
      engine.bindRequirementTask(requirementId, opts ?? {}),
  )
  ipcMain.handle("octopus:unbindRequirementTask", (_e, requirementId: string) =>
    engine.unbindRequirementTask(requirementId))
  ipcMain.handle("octopus:getRequirementTeambitionStatus", (_e, requirementId: string) =>
    engine.getRequirementTeambitionStatus(requirementId))
  ipcMain.handle(
    "octopus:updateRequirementTeambitionStatus",
    (_e, requirementId: string, statusId: string, operatorId?: string) =>
      engine.updateRequirementTeambitionStatus(requirementId, statusId, operatorId),
  )

  ipcMain.handle("octopus:health", () => engine.checkIntegrationHealth())
  ipcMain.handle("octopus:resolveNodeWorkspace", (_e, requirementId: string, nodeId: string) => {
    const state = engine.getState(requirementId)
    if (!state.projectRoot) throw new Error("需求没有源码根目录")
    const nodeKey = engine.resolveNodeKey(requirementId, nodeId)
    const path = getWorkflowWorkspace(state.projectRoot).nodePath(nodeKey)
    return { nodeKey, path, exists: existsSync(path) }
  })

  ipcMain.handle("octopus:openNodeDirectory", async (_e, requirementId: string, nodeId: string) => {
    const state = engine.getState(requirementId)
    if (!state.projectRoot) throw new Error("需求没有源码根目录")
    const path = getWorkflowWorkspace(state.projectRoot).nodePath(engine.resolveNodeKey(requirementId, nodeId))
    return shell.openPath(path)
  })

  ipcMain.handle("octopus:exportTasks", async (_e, requirementId: string) => {
    const document = engine.exportTasks(requirementId)
    const selected = await dialog.showSaveDialog({
      title: "导出任务",
      defaultPath: `${requirementId}-tasks.json`,
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

  ipcMain.handle("octopus:importTasks", async (_e, requirementId: string) => {
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
      message: `将 ${basename(inputPath)} 的任务进度合并到需求 ${requirementId}？`,
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
      ...engine.importTasks(requirementId, document),
    }
  })

  // ── OmniPlan IPC ──

  ipcMain.handle("octopus:exportProjectOmniPlan", (_e, projectId: string, opts?: { fileName?: string; rootDir?: string }) => {
    return engine.exportProjectOmniPlan(projectId, opts ?? {})
  })

  ipcMain.handle("octopus:importProjectOmniPlan", (_e, projectId: string, opts?: { fileName?: string; path?: string; rootDir?: string }) => {
    return engine.importProjectOmniPlan(projectId, opts ?? {})
  })

  ipcMain.handle("octopus:setProjectOmniPlanMeta", (_e, projectId: string, patch: { omniplanFolder?: string; omniplanIdMap?: string; omniplanFileName?: string }) => {
    return engine.setProjectOmniPlanMeta(projectId, patch ?? {})
  })

  ipcMain.handle("octopus:setProjectDefaultColor", (_e, projectId: string, color: string | null) => {
    return engine.setProjectDefaultColor(projectId, color ?? null)
  })

  ipcMain.handle("octopus:bindProjectTeambitionRepo", (_e, projectId: string, opts: { repoId: string; pluginId?: string; tbProjectId?: string; name?: string }) =>
    engine.bindProjectTeambitionRepo(projectId, opts))
  ipcMain.handle("octopus:unbindProjectTeambitionRepo", (_e, projectId: string) => engine.unbindProjectTeambitionRepo(projectId))
  ipcMain.handle("octopus:listProjectVersions", (_e, projectId: string, opts?: { refresh?: boolean }) =>
    engine.listProjectVersions(projectId, opts))
  ipcMain.handle("octopus:syncProjectVersions", (_e, projectId: string) => engine.syncProjectVersions(projectId))
  ipcMain.handle("octopus:getProjectVersion", (_e, projectId: string, versionId: string) => engine.getProjectVersion(projectId, versionId))
  ipcMain.handle("octopus:setProjectDefaultVersion", (_e, projectId: string, versionId: string | null) =>
    engine.setProjectDefaultVersion(projectId, versionId ?? null))
  ipcMain.handle("octopus:bindRequirementVersion", (_e, requirementId: string, versionId: string) =>
    engine.bindRequirementVersion(requirementId, versionId))
  ipcMain.handle("octopus:unbindRequirementVersion", (_e, requirementId: string) => engine.unbindRequirementVersion(requirementId))
  ipcMain.handle("octopus:getRequirementVersionBinding", (_e, requirementId: string) => engine.getRequirementVersionBinding(requirementId))
  ipcMain.handle("octopus:listVersionRequirements", (_e, projectId: string, versionId?: string) =>
    engine.listVersionRequirements(projectId, versionId))
  ipcMain.handle("octopus:updateVersionNote", (_e, projectId: string, versionId: string, note: string) =>
    engine.updateVersionNote(projectId, versionId, note))

  ipcMain.handle("octopus:getProjectBrdDesignConfig", (_e, projectId: string) => {
    return engine.getProjectBrdDesignConfig(projectId)
  })
  ipcMain.handle("octopus:setProjectBrdDesignConfig", (_e, projectId: string, patch: Record<string, unknown>) => {
    return engine.setProjectBrdDesignConfig(projectId, patch as never)
  })
  ipcMain.handle(
    "octopus:previewBrdPrompts",
    (_e, projectId: string, requirementId: string, opts?: { mode?: "generate" | "check" | "all"; includeSummarize?: boolean }) => {
      return engine.previewBrdPrompts(projectId, requirementId, opts ?? {})
    },
  )

  ipcMain.handle("octopus:assignNode", (_e, requirementId: string, nodeId: string, assignedTo: string | null) => {
    const state = engine.assignNode(requirementId, nodeId, assignedTo ?? null)
    const step = state.steps.find((item) => item.id === nodeId)
    return { requirementId: state.requirementId, nodeId, assignedTo: step?.assignedTo ?? null }
  })
  ipcMain.handle("octopus:listMyWork", (_e, identity: string, projectId?: string) => engine.listMyWork(identity, projectId))
  ipcMain.handle("octopus:getProjectOverview", (_e, projectId: string) => engine.getProjectOverview(projectId))
  ipcMain.handle("octopus:getIdentity", () => ({ name: getIdentity(join(app.getPath("userData"), "store")) ?? null }))
  ipcMain.handle("octopus:setIdentity", (_e, name: string | null) => {
    const storeDir = join(app.getPath("userData"), "store")
    const normalized = name === null || name === "" ? null : name
    saveIdentity(storeDir, normalized)
    return { name: normalized }
  })
}

function createWindow(): void {
  const icon = join(__dirname, "renderer", "app-icon.png")
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    icon,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  void win.loadFile(join(__dirname, "renderer", "index.html"))
}

app.whenReady().then(async () => {
  const config = loadConfig(join(app.getPath("userData"), "store"))
  engine = await createWorkflowEngineFromConfig(config)
  registerIpc()
  createWindow()

  // 窗口打开期间由主进程轮询失败事件，避免渲染进程自行访问文件系统。
  const notifiedEvents = new Set<number>()
  setInterval(() => {
    for (const requirementId of listRequirements()) {
      const events = engine.execution.eventsAfter(requirementId, 0)
      for (const event of events) {
        if (event.type === "RUN_FAILED" && !notifiedEvents.has(event.sequence) && Notification.isSupported()) {
          notifiedEvents.add(event.sequence)
          new Notification({
            title: "Octopus 节点执行失败",
            body: String(event.payload["error"] ?? event.nodeId ?? "未知错误"),
            icon: join(__dirname, "renderer", "app-icon.png"),
          }).show()
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
