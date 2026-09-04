/**
 * 浏览器 transport：Electron 中由 preload 提供 window.octopus，
 * 浏览器中改用同源 HTTP API。
 */

import type { OctopusApi } from "./lib/octopus.js"

type ConfirmFn = (message: string, title?: string) => Promise<boolean>

declare global {
  interface Window {
    OctopusConfirm?: ConfirmFn
  }
}

async function invoke(method: string, ...args: unknown[]): Promise<unknown> {
  const response = await fetch("/api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
  })
  const payload = (await response.json()) as { result?: unknown; error?: string }
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`)
  return payload.result
}

async function chooseJsonFile(): Promise<unknown | undefined> {
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

async function confirmImport(message: string): Promise<boolean> {
  if (window.OctopusConfirm) return window.OctopusConfirm(message, "导入任务")
  return window.confirm(message)
}

if (!window.octopus) {
  const api = {
    canInit: () => invoke("canInit"),
    listProjects: () => invoke("listProjects"),
    listProjectSummaries: () => invoke("listProjectSummaries"),
    createProject: (name: string, description?: string) =>
      invoke("createProject", name, description),
    getProject: (projectId: string) => invoke("getProject", projectId),
    updateProjectMeta: (projectId: string, patch: { name?: string; description?: string }) =>
      invoke("updateProjectMeta", projectId, patch),
    setProjectDefaultColor: (projectId: string, color: string | null) =>
      invoke("setProjectDefaultColor", projectId, color),
    deleteProject: (projectId: string) => invoke("deleteProject", projectId),
    bindProjectTeambition: (projectId: string, opts: { projectId?: string; prefix?: string }) =>
      invoke("bindProjectTeambition", projectId, opts),
    unbindProjectTeambition: (projectId: string) => invoke("unbindProjectTeambition", projectId),
    listTeambitionCardStatuses: (projectId: string) =>
      invoke("listTeambitionCardStatuses", projectId),
    listRequirements: (projectId?: string) => invoke("listRequirements", projectId),
    listRequirementSummaries: (projectId?: string) =>
      invoke("listRequirementSummaries", projectId),
    initRequirement: (
      projectId: string,
      name: string,
      description?: string,
      projectRoot?: string,
    ) => invoke("initRequirement", projectId, name, description, projectRoot),
    updateRequirement: (requirementId: string, patch: Record<string, unknown>) =>
      invoke("updateRequirement", requirementId, patch),
    deleteRequirement: (requirementId: string) => invoke("deleteRequirement", requirementId),
    getRequirementStatus: (requirementId: string) => invoke("getRequirementStatus", requirementId),
    getState: (requirementId: string) => invoke("getState", requirementId),
    listSubtasks: (requirementId: string) => invoke("listSubtasks", requirementId),
    addSubtask: (requirementId: string, input: Record<string, unknown>) =>
      invoke("addSubtask", requirementId, input),
    setSubtaskStatus: (requirementId: string, subtaskId: string, status: string) =>
      invoke("setSubtaskStatus", requirementId, subtaskId, status),
    deleteSubtask: (requirementId: string, subtaskId: string) =>
      invoke("deleteSubtask", requirementId, subtaskId),
    getWorkflowDefinition: (requirementId: string) =>
      invoke("getWorkflowDefinition", requirementId),
    getExecutionSnapshot: (requirementId: string) => invoke("getExecutionSnapshot", requirementId),
    updateNodeSchedule: (
      requirementId: string,
      nodeId: string,
      schedule: Record<string, unknown>,
    ) => invoke("updateNodeSchedule", requirementId, nodeId, schedule),
    updateRequirementSchedule: (requirementId: string, schedule: Record<string, unknown>) =>
      invoke("updateRequirementSchedule", requirementId, schedule),
    moveRequirementPhase: (requirementId: string, toPhase: string) =>
      invoke("moveRequirementPhase", requirementId, toPhase),
    listMilestones: (requirementId: string) => invoke("listMilestones", requirementId),
    listProjectMilestones: (projectId: string) => invoke("listProjectMilestones", projectId),
    addMilestone: (requirementId: string, input: Record<string, unknown>) =>
      invoke("addMilestone", requirementId, input),
    updateMilestone: (
      requirementId: string,
      milestoneId: string,
      patch: Record<string, unknown>,
    ) => invoke("updateMilestone", requirementId, milestoneId, patch),
    reachMilestone: (requirementId: string, milestoneId: string) =>
      invoke("reachMilestone", requirementId, milestoneId),
    unreachMilestone: (requirementId: string, milestoneId: string) =>
      invoke("unreachMilestone", requirementId, milestoneId),
    deleteMilestone: (requirementId: string, milestoneId: string) =>
      invoke("deleteMilestone", requirementId, milestoneId),
    runNode: (requirementId: string, nodeId: string, force?: boolean) =>
      invoke("runNode", requirementId, nodeId, force),
    runWorkflow: (requirementId: string, force?: boolean, maxParallel?: number) =>
      invoke("runWorkflow", requirementId, force, maxParallel),
    completeNode: (requirementId: string, nodeId: string, force?: boolean) =>
      invoke("completeNode", requirementId, nodeId, force),
    cancelRun: (requirementId: string, runId: string) => invoke("cancelRun", requirementId, runId),
    retryRun: (requirementId: string, runId: string, force?: boolean) =>
      invoke("retryRun", requirementId, runId, force),
    runs: (requirementId: string, nodeId?: string) => invoke("runs", requirementId, nodeId),
    events: (requirementId: string, sequence: number) => invoke("events", requirementId, sequence),
    readRunLogs: (
      requirementId: string,
      runId: string,
      opts?: { offset?: number; limit?: number },
    ) => invoke("readRunLogs", requirementId, runId, opts),
    bindRequirementTask: (requirementId: string, opts: Record<string, unknown>) =>
      invoke("bindRequirementTask", requirementId, opts),
    unbindRequirementTask: (requirementId: string) =>
      invoke("unbindRequirementTask", requirementId),
    getRequirementTeambitionStatus: (requirementId: string) =>
      invoke("getRequirementTeambitionStatus", requirementId),
    updateRequirementTeambitionStatus: (
      requirementId: string,
      statusId: string,
      operatorId?: string,
    ) => invoke("updateRequirementTeambitionStatus", requirementId, statusId, operatorId),
    health: () => invoke("health"),
    resolveNodeWorkspace: (requirementId: string, nodeId: string) =>
      invoke("resolveNodeWorkspace", requirementId, nodeId),
    exportTasks: async (requirementId: string) => {
      const result = (await invoke("exportTasks", requirementId)) as {
        document: unknown
        taskCount: number
      }
      const blob = new Blob([`${JSON.stringify(result.document, null, 2)}\n`], {
        type: "application/json",
      })
      const link = document.createElement("a")
      link.href = URL.createObjectURL(blob)
      link.download = `${requirementId}-tasks.json`
      link.click()
      URL.revokeObjectURL(link.href)
      return { canceled: false, taskCount: result.taskCount }
    },
    importTasks: async (requirementId: string) => {
      const documentPayload = await chooseJsonFile()
      if (!documentPayload) return { canceled: true }
      const message = `将所选任务进度合并到需求 ${requirementId}？`
      if (!(await confirmImport(message))) return { canceled: true }
      return {
        canceled: false,
        ...((await invoke("importTasks", requirementId, documentPayload)) as object),
      }
    },
    exportProjectOmniPlan: (projectId: string, opts?: unknown) =>
      invoke("exportProjectOmniPlan", projectId, opts),
    importProjectOmniPlan: (projectId: string, opts?: unknown) =>
      invoke("importProjectOmniPlan", projectId, opts),
    setProjectOmniPlanMeta: (projectId: string, patch: Record<string, unknown>) =>
      invoke("setProjectOmniPlanMeta", projectId, patch),
    bindProjectTeambitionRepo: (projectId: string, opts: Record<string, unknown>) =>
      invoke("bindProjectTeambitionRepo", projectId, opts),
    unbindProjectTeambitionRepo: (projectId: string) =>
      invoke("unbindProjectTeambitionRepo", projectId),
    listProjectVersions: (projectId: string, opts?: unknown) =>
      invoke("listProjectVersions", projectId, opts),
    syncProjectVersions: (projectId: string) => invoke("syncProjectVersions", projectId),
    getProjectVersion: (projectId: string, versionId: string) =>
      invoke("getProjectVersion", projectId, versionId),
    setProjectDefaultVersion: (projectId: string, versionId: string | null) =>
      invoke("setProjectDefaultVersion", projectId, versionId),
    bindRequirementVersion: (requirementId: string, versionId: string) =>
      invoke("bindRequirementVersion", requirementId, versionId),
    unbindRequirementVersion: (requirementId: string) =>
      invoke("unbindRequirementVersion", requirementId),
    getRequirementVersionBinding: (requirementId: string) =>
      invoke("getRequirementVersionBinding", requirementId),
    listVersionRequirements: (projectId: string, versionId: string) =>
      invoke("listVersionRequirements", projectId, versionId),
    updateVersionNote: (projectId: string, versionId: string, note: string) =>
      invoke("updateVersionNote", projectId, versionId, note),
    getProjectBrdDesignConfig: (projectId: string) =>
      invoke("getProjectBrdDesignConfig", projectId),
    setProjectBrdDesignConfig: (projectId: string, patch: Record<string, unknown>) =>
      invoke("setProjectBrdDesignConfig", projectId, patch),
    previewBrdPrompts: (
      projectId: string,
      requirementId: string | null,
      opts: Record<string, unknown>,
    ) => invoke("previewBrdPrompts", projectId, requirementId, opts),
    assignNode: (requirementId: string, nodeId: string, assignedTo: string | null) =>
      invoke("assignNode", requirementId, nodeId, assignedTo),
    listMyWork: (identity: string, projectId?: string) =>
      invoke("listMyWork", identity, projectId),
    getProjectOverview: (projectId: string) => invoke("getProjectOverview", projectId),
    getIdentity: () => invoke("getIdentity"),
    setIdentity: (name: string | null) => invoke("setIdentity", name),
  } as OctopusApi

  window.octopus = api
  window.octopusRuntime = "web"
}
