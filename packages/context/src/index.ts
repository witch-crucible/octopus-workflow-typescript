/**
 * Context 包 —— 工作流状态持久化层。
 *
 * Project（容器）与 Requirement（工作流状态）分层存储在 SQLite WAL 数据库中。
 * 每次更新使用事务，确保后台 worker 与桌面端并发写入不会互相覆盖。
 */

import { existsSync, mkdirSync } from "node:fs"
import { join, isAbsolute, resolve } from "node:path"
import Database from "better-sqlite3"
import type { WorkflowState } from "@octopus/core/workflow.js"
import type { Project } from "@octopus/core/project.js"
import { ProjectId, RequirementId } from "@octopus/core/branded-ids.js"
import { createEmptyState, migrateWorkflowState } from "@octopus/core/workflow.js"
import { createEmptyProject } from "@octopus/core/project.js"
import { Phase } from "@octopus/core/phase.js"
import { StoreError } from "@octopus/core/errors.js"
import { ensureStoreSchema } from "./schema.js"

/** 默认状态存储目录 */
const DEFAULT_STORE_DIR = ".octo"

/** 状态存储配置 */
export interface StoreConfig {
  /** 存储目录路径（绝对或相对 cwd） */
  storeDir: string
}

/** 状态存储接口 */
export interface StateStore {
  /** 加载需求状态 */
  load(requirementId: string): WorkflowState
  /** 保存需求状态 */
  save(state: WorkflowState): void
  /** 在单个 SQLite 事务中读取并更新需求状态 */
  update(requirementId: string, updater: (state: WorkflowState) => WorkflowState): WorkflowState

  /** 列出全部项目 ID */
  listProjects(): string[]
  /** 加载项目 */
  loadProject(projectId: string): Project
  /** 保存项目 */
  saveProject(project: Project): void
  /** 更新项目 */
  updateProject(projectId: string, updater: (project: Project) => Project): Project
  /** 创建项目容器 */
  createProject(name: string, description?: string): Project
  /** 删除项目（级联删除其下需求与执行记录） */
  deleteProject(projectId: string): void

  /** 列出需求 ID；可按项目过滤 */
  listRequirements(projectId?: string): string[]
  /** 创建需求（隶属于项目） */
  createRequirement(
    projectId: string,
    name: string,
    description?: string,
    projectRoot?: string,
  ): WorkflowState
  /** 删除需求 */
  deleteRequirement(requirementId: string): void

  /** 获取存储路径 */
  getStorePath(): string
}

/** 创建默认状态存储实例 */
export function createStateStore(config?: Partial<StoreConfig>): StateStore {
  const storeDir = config?.storeDir ?? DEFAULT_STORE_DIR
  return new SqliteStateStore(storeDir)
}

/**
 * SQLite 状态存储。
 *
 * 状态主体仍以 JSON 保存以保持领域模型的聚合语义，执行运行记录和事件由
 * executor 单独写入扩展表。事务化 update 是跨进程节点执行的并发写入边界。
 */
class SqliteStateStore implements StateStore {
  private readonly originalStoreDir: string
  private readonly storeDir: string
  private readonly databasePath: string

  constructor(storeDir: string) {
    this.originalStoreDir = storeDir
    this.storeDir = isAbsolute(storeDir) ? storeDir : resolve(storeDir)
    this.databasePath = join(this.storeDir, "state.sqlite")
    if (!existsSync(this.storeDir)) mkdirSync(this.storeDir, { recursive: true })
    this.withDatabase(() => undefined)
  }

  private withDatabase<T>(callback: (db: Database.Database) => T): T {
    const db = new Database(this.databasePath)
    try {
      ensureStoreSchema(db)
      return callback(db)
    } finally {
      db.close()
    }
  }

  private saveRequirementInTransaction(db: Database.Database, state: WorkflowState): WorkflowState {
    const updatedAt = new Date().toISOString()
    state.updatedAt = updatedAt
    db.prepare(
      `INSERT INTO requirements(requirement_id, parent_project_id, requirement_name, state_json, updated_at)
       VALUES (@requirementId, @parentProjectId, @requirementName, @stateJson, @updatedAt)
       ON CONFLICT(requirement_id) DO UPDATE SET
         parent_project_id = excluded.parent_project_id,
         requirement_name = excluded.requirement_name,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    ).run({
      requirementId: state.requirementId,
      parentProjectId: state.projectId,
      requirementName: state.requirementName,
      stateJson: JSON.stringify(state),
      updatedAt,
    })
    return state
  }

  private saveProjectInTransaction(db: Database.Database, project: Project): Project {
    const updatedAt = new Date().toISOString()
    project.updatedAt = updatedAt
    db.prepare(
      `INSERT INTO projects(project_id, name, description, state_json, updated_at)
       VALUES (@projectId, @name, @description, @stateJson, @updatedAt)
       ON CONFLICT(project_id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    ).run({
      projectId: project.projectId,
      name: project.name,
      description: project.description,
      stateJson: JSON.stringify(project),
      updatedAt,
    })
    return project
  }

  private requireProjectRow(db: Database.Database, projectId: string): Project {
    const row = db.prepare("SELECT state_json FROM projects WHERE project_id = ?").get(projectId) as
      | { state_json: string }
      | undefined
    if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载项目 ${projectId}`)
    return JSON.parse(row.state_json) as Project
  }

  getStorePath(): string {
    return this.originalStoreDir
  }

  load(requirementId: string): WorkflowState {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT state_json, parent_project_id FROM requirements WHERE requirement_id = ?").get(requirementId) as
        | { state_json: string; parent_project_id: string }
        | undefined
      if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载需求 ${requirementId}`)
      return migrateWorkflowState(JSON.parse(row.state_json), {
        projectId: ProjectId(row.parent_project_id),
      })
    })
  }

  save(state: WorkflowState): void {
    this.withDatabase((db) => {
      const transaction = db.transaction(() => this.saveRequirementInTransaction(db, state))
      transaction()
    })
  }

  update(requirementId: string, updater: (state: WorkflowState) => WorkflowState): WorkflowState {
    return this.withDatabase((db) => {
      const transaction = db.transaction(() => {
        const row = db.prepare("SELECT state_json, parent_project_id FROM requirements WHERE requirement_id = ?").get(requirementId) as
          | { state_json: string; parent_project_id: string }
          | undefined
        if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载需求 ${requirementId}`)
        const current = migrateWorkflowState(JSON.parse(row.state_json), {
          projectId: ProjectId(row.parent_project_id),
        })
        return this.saveRequirementInTransaction(db, updater(current))
      })
      return transaction()
    })
  }

  listProjects(): string[] {
    return this.withDatabase((db) => {
      const rows = db.prepare("SELECT project_id FROM projects ORDER BY updated_at DESC").all() as Array<{ project_id: string }>
      return rows.map((row) => row.project_id)
    })
  }

  loadProject(projectId: string): Project {
    return this.withDatabase((db) => this.requireProjectRow(db, projectId))
  }

  saveProject(project: Project): void {
    this.withDatabase((db) => {
      const transaction = db.transaction(() => this.saveProjectInTransaction(db, project))
      transaction()
    })
  }

  updateProject(projectId: string, updater: (project: Project) => Project): Project {
    return this.withDatabase((db) => {
      const transaction = db.transaction(() => {
        const current = this.requireProjectRow(db, projectId)
        return this.saveProjectInTransaction(db, updater(current))
      })
      return transaction()
    })
  }

  createProject(name: string, description?: string): Project {
    const projectId = ProjectId(`proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    const project = createEmptyProject(projectId, name, description ?? "")
    this.withDatabase((db) => {
      const transaction = db.transaction(() => this.saveProjectInTransaction(db, project))
      transaction()
    })
    return project
  }

  deleteProject(projectId: string): void {
    this.withDatabase((db) => {
      const requirementIds = (
        db.prepare("SELECT requirement_id FROM requirements WHERE parent_project_id = ?").all(projectId) as Array<{
          requirement_id: string
        }>
      ).map((row) => row.requirement_id)

      const hasTable = (name: string): boolean =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined

      for (const requirementId of requirementIds) {
        if (hasTable("workflow_runs")) {
          db.prepare("DELETE FROM workflow_runs WHERE requirement_id = ?").run(requirementId)
        }
        if (hasTable("workflow_events")) {
          db.prepare("DELETE FROM workflow_events WHERE requirement_id = ?").run(requirementId)
        }
      }
      db.prepare("DELETE FROM requirements WHERE parent_project_id = ?").run(projectId)
      db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId)
    })
  }

  listRequirements(projectId?: string): string[] {
    return this.withDatabase((db) => {
      const rows = (projectId
        ? db.prepare(
            "SELECT requirement_id FROM requirements WHERE parent_project_id = ? ORDER BY updated_at DESC",
          ).all(projectId)
        : db.prepare("SELECT requirement_id FROM requirements ORDER BY updated_at DESC").all()) as Array<{
        requirement_id: string
      }>
      return rows.map((row) => row.requirement_id)
    })
  }

  createRequirement(
    projectId: string,
    name: string,
    description?: string,
    projectRoot?: string,
  ): WorkflowState {
    return this.withDatabase((db) => {
      const transaction = db.transaction(() => {
        this.requireProjectRow(db, projectId)
        const requirementId = RequirementId(`req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
        const state = createEmptyState(
          ProjectId(projectId),
          requirementId,
          name,
          description ?? "",
          projectRoot,
        )
        return this.saveRequirementInTransaction(db, state)
      })
      return transaction()
    })
  }

  deleteRequirement(requirementId: string): void {
    this.withDatabase((db) => {
      const hasTable = (name: string): boolean =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
      if (hasTable("workflow_runs")) {
        db.prepare("DELETE FROM workflow_runs WHERE requirement_id = ?").run(requirementId)
      }
      if (hasTable("workflow_events")) {
        db.prepare("DELETE FROM workflow_events WHERE requirement_id = ?").run(requirementId)
      }
      db.prepare("DELETE FROM requirements WHERE requirement_id = ?").run(requirementId)
    })
  }
}

export { ProjectId, RequirementId, Phase }
export * from "./workflow.js"
export * from "./execution.js"
export { STORE_SCHEMA_VERSION } from "./schema.js"
