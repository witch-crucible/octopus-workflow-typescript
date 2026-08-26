/** Context 包：PostgreSQL 核心状态与执行记录持久化。 */

import type { Project } from "@octopus/core/project.js"
import type { WorkflowState } from "@octopus/core/workflow.js"
import { ProjectId, RequirementId } from "@octopus/core/branded-ids.js"
import { Phase } from "@octopus/core/phase.js"

export interface StoreConfig {
  /** 配置、日志和 worker 运行文件目录；不再包含核心状态数据库。 */
  storeDir: string
}

export interface StateStore {
  load(requirementId: string): Promise<WorkflowState>
  save(state: WorkflowState): Promise<void>
  update(
    requirementId: string,
    updater: (state: WorkflowState) => WorkflowState,
  ): Promise<WorkflowState>

  listProjects(): Promise<string[]>
  loadProject(projectId: string): Promise<Project>
  saveProject(project: Project): Promise<void>
  updateProject(projectId: string, updater: (project: Project) => Project): Promise<Project>
  createProject(name: string, description?: string): Promise<Project>
  deleteProject(projectId: string): Promise<void>

  listRequirements(projectId?: string): Promise<string[]>
  createRequirement(
    projectId: string,
    name: string,
    description?: string,
    projectRoot?: string,
  ): Promise<WorkflowState>
  deleteRequirement(requirementId: string): Promise<void>

  /** 同步返回配置与日志目录，绝不指向 state.sqlite。 */
  getStorePath(): string
}

export { ProjectId, RequirementId, Phase }
export * from "./workflow.js"
export * from "./execution.js"
export * from "./persistence.js"
export * from "./database-config.js"
