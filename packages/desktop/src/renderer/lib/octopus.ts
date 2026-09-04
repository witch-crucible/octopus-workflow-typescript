/** 类型化的 window.octopus 客户端（Electron preload / Web browser-api）。 */

export type OctopusApi = {
  canInit: () => Promise<boolean>
  listProjects: () => Promise<unknown[]>
  listProjectSummaries: () => Promise<ProjectSummary[]>
  createProject: (name: string, description?: string) => Promise<{ projectId: string; name: string }>
  getProject: (projectId: string) => Promise<Project>
  updateProjectMeta: (
    projectId: string,
    patch: { name?: string; description?: string },
  ) => Promise<{ projectId: string; name: string; description?: string }>
  setProjectDefaultColor: (projectId: string, color: string | null) => Promise<Project>
  deleteProject: (projectId: string) => Promise<{ deleted: boolean; projectId: string }>
  bindProjectTeambition: (
    projectId: string,
    opts: { projectId?: string; prefix?: string },
  ) => Promise<Project>
  unbindProjectTeambition: (projectId: string) => Promise<Project>
  bindProjectTeambitionRepo?: (
    projectId: string,
    opts: Record<string, unknown>,
  ) => Promise<Project>
  unbindProjectTeambitionRepo?: (projectId: string) => Promise<Project>
  listTeambitionCardStatuses: (projectId: string) => Promise<TbStatus[]>
  listProjectVersions: (projectId: string, opts?: unknown) => Promise<unknown[]>
  syncProjectVersions: (projectId: string) => Promise<unknown>
  setProjectDefaultVersion: (projectId: string, versionId: string | null) => Promise<Project>
  updateVersionNote: (projectId: string, versionId: string, note: string) => Promise<unknown>
  listRequirements: (projectId?: string) => Promise<string[]>
  listRequirementSummaries: (projectId?: string) => Promise<RequirementSummary[]>
  initRequirement: (
    projectId: string,
    name: string,
    description?: string,
    projectRoot?: string,
  ) => Promise<{ requirementId: string }>
  updateRequirement: (
    requirementId: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>
  deleteRequirement: (requirementId: string) => Promise<unknown>
  getRequirementStatus: (requirementId: string) => Promise<unknown>
  getState: (requirementId: string) => Promise<RequirementState>
  listSubtasks: (requirementId: string) => Promise<Subtask[]>
  addSubtask: (requirementId: string, input: { title: string; description?: string; assignedTo?: string }) => Promise<Subtask>
  setSubtaskStatus: (requirementId: string, subtaskId: string, status: string) => Promise<Subtask>
  deleteSubtask: (requirementId: string, subtaskId: string) => Promise<unknown>
  getWorkflowDefinition?: (requirementId: string) => Promise<WorkflowDefinition | undefined>
  getExecutionSnapshot: (requirementId: string) => Promise<ExecutionSnapshot>
  updateNodeSchedule: (
    requirementId: string,
    nodeId: string,
    schedule: SchedulePatch,
  ) => Promise<unknown>
  updateRequirementSchedule: (requirementId: string, schedule: SchedulePatch) => Promise<unknown>
  moveRequirementPhase: (requirementId: string, toPhase: string) => Promise<unknown>
  listMilestones: (requirementId: string) => Promise<Milestone[]>
  listProjectMilestones: (projectId: string) => Promise<Milestone[]>
  addMilestone: (requirementId: string, input: Record<string, unknown>) => Promise<unknown>
  updateMilestone: (
    requirementId: string,
    milestoneId: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>
  reachMilestone: (requirementId: string, milestoneId: string) => Promise<unknown>
  unreachMilestone: (requirementId: string, milestoneId: string) => Promise<unknown>
  deleteMilestone: (requirementId: string, milestoneId: string) => Promise<unknown>
  bindRequirementTask: (requirementId: string, opts: Record<string, unknown>) => Promise<unknown>
  unbindRequirementTask: (requirementId: string) => Promise<unknown>
  getRequirementTeambitionStatus: (requirementId: string) => Promise<unknown>
  updateRequirementTeambitionStatus: (requirementId: string, statusId: string) => Promise<unknown>
  bindRequirementVersion: (requirementId: string, versionId: string) => Promise<unknown>
  unbindRequirementVersion: (requirementId: string) => Promise<unknown>
  runNode: (requirementId: string, nodeId: string, force?: boolean) => Promise<unknown>
  completeNode: (requirementId: string, nodeId: string, force?: boolean) => Promise<unknown>
  runWorkflow: (requirementId: string) => Promise<unknown>
  runs: (requirementId: string, nodeId?: string) => Promise<RunRecord[]>
  retryRun: (requirementId: string, runId: string) => Promise<unknown>
  cancelRun: (requirementId: string, runId: string) => Promise<unknown>
  readRunLogs: (
    requirementId: string,
    runId: string,
    opts?: { offset?: number; limit?: number },
  ) => Promise<{ text?: string; nextOffset?: number; done?: boolean }>
  events: (requirementId: string, after: number) => Promise<unknown[]>
  exportTasks: (requirementId: string) => Promise<unknown>
  importTasks: (requirementId: string) => Promise<unknown>
  health: () => Promise<unknown>
  assignNode: (requirementId: string, nodeId: string, assignedTo: string | null) => Promise<unknown>
  resolveNodeWorkspace?: (
    requirementId: string,
    nodeId: string,
  ) => Promise<{ path?: string } | undefined>
  openNodeDirectory?: (requirementId: string, nodeId: string) => Promise<unknown>
  exportProjectOmniPlan: (projectId: string) => Promise<unknown>
  importProjectOmniPlan: (projectId: string) => Promise<unknown>
  setProjectOmniPlanMeta?: (projectId: string, meta: Record<string, unknown>) => Promise<unknown>
  getProjectBrdDesignConfig?: (projectId: string) => Promise<BrdConfig>
  setProjectBrdDesignConfig?: (projectId: string, config: Record<string, unknown>) => Promise<unknown>
  previewBrdPrompts?: (
    projectId: string,
    requirementId: string | null,
    opts: Record<string, unknown>,
  ) => Promise<unknown>
  getProjectOverview: (projectId: string) => Promise<ProjectOverview>
  listMyWork: (identity: string, filter?: string) => Promise<MyWorkList>
  getIdentity: () => Promise<{ name: string | null }>
  setIdentity: (name: string | null) => Promise<{ name: string | null }>
}

export type ProjectSummary = {
  projectId: string
  name: string
  description?: string
  requirementCount?: number
  teambitionProjectId?: string
  updatedAt?: string
}

export type Project = {
  projectId: string
  name: string
  description?: string
  teambitionProjectId?: string
  defaultColor?: string | null
  defaultVersionId?: string | null
  [key: string]: unknown
}

export type RequirementSummary = {
  requirementId: string
  requirementName?: string
  description?: string
  currentPhase?: string
  projectId?: string
  projectRoot?: string
  completedTasks?: number
  totalTasks?: number
  plannedStart?: string
  plannedEnd?: string
  owner?: string | null
  teambitionTaskId?: string
  teambitionStatusId?: string
  teambitionStatusName?: string
  teambitionVersionId?: string
  teambitionVersionName?: string
  teambitionVersionStale?: boolean
  milestoneCount?: number
  nextMilestone?: { date: string; name: string; overdue?: boolean }
  updatedAt?: string
}

export type RequirementState = {
  requirementId: string
  projectId: string
  currentPhase?: string
  steps?: GraphNode[]
  [key: string]: unknown
}

export type Subtask = {
  id: string
  requirementId: string
  title: string
  description: string
  status: string
  assignedTo?: string
  createdAt: string
  completedAt?: string
}

export type WorkflowDefinition = {
  nodes?: Array<{
    key: string
    phase: string
    name: string
    description?: string
    responsibleRole?: string
    responsibleRoles?: string[]
    dependsOn: string[]
    actions?: unknown[]
  }>
  nodeIdMapping?: Record<string, string>
}

export type GraphNode = {
  id: string
  key?: string
  phase?: string
  name?: string
  description?: string
  status?: string
  activated?: boolean
  responsibleRole?: string
  responsibleRoles?: string[]
  dependsOn?: string[]
  actions?: unknown[]
  assignedTo?: string | null
  plannedStart?: string
  plannedEnd?: string
  [key: string]: unknown
}

export type ExecutionSnapshot = {
  currentNodeIds?: string[]
  readyNodeIds?: string[]
  waitingNodeIds?: string[]
  [key: string]: unknown
}

export type SchedulePatch = {
  plannedStart?: string | null
  plannedEnd?: string | null
  date?: string
}

export type Milestone = {
  id: string
  name: string
  date: string
  reached?: boolean
  phase?: string
  nodeId?: string
  note?: string
  requirementId?: string
}

export type TbStatus = {
  id?: string
  statusId?: string
  name?: string
  statusName?: string
}

export type RunRecord = {
  runId: string
  nodeId?: string
  status?: string
  startedAt?: string
  finishedAt?: string
  [key: string]: unknown
}

export type ProjectOverview = {
  requirementCount?: number
  phaseCounts?: Record<string, number>
  [key: string]: unknown
}

export type MyWorkItem = {
  kind: "requirement" | "node"
  projectId: string
  projectName: string
  requirementId: string
  requirementName: string
  phase: string
  owner?: string
  nextMilestone?: { date: string; name: string; overdue?: boolean }
  plannedEnd?: string
  nodeId?: string
  nodeName?: string
  status?: string
  assignedTo?: string
  overdue: boolean
}

export type MyWorkList = {
  identity: string
  requirements: MyWorkItem[]
  nodes: MyWorkItem[]
}

export type BrdConfig = {
  prompts?: Record<string, { system?: string; user?: string } | null>
  [key: string]: unknown
}

declare global {
  interface Window {
    octopus: OctopusApi
    octopusRuntime?: "web" | "electron"
  }
}

export function getOctopus(): OctopusApi {
  if (!window.octopus) {
    throw new Error("window.octopus 未注入（preload 或 browser-api 未加载）")
  }
  return window.octopus
}
