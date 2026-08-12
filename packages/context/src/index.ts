/**
 * Context 包 —— 工作流状态持久化层。
 *
 * 将 WorkflowState 以 JSON 聚合存储在 SQLite 的 WAL 数据库中。
 * 每次更新使用事务，确保后台 worker 与桌面端并发写入不会互相覆盖。
 */

import { existsSync, mkdirSync } from "node:fs"
import { join, isAbsolute, resolve } from "node:path"
import Database from "better-sqlite3"
import type { WorkflowState } from "@octopus/core/workflow.js"
import { ProjectId } from "@octopus/core/branded-ids.js"
import { createEmptyState, migrateWorkflowState } from "@octopus/core/workflow.js"
import { Phase } from "@octopus/core/phase.js"
import { StoreError } from "@octopus/core/errors.js"

/** 默认状态存储目录 */
const DEFAULT_STORE_DIR = ".octo"

/** 状态存储配置 */
export interface StoreConfig {
  /** 存储目录路径（绝对或相对 cwd） */
  storeDir: string
}

/** 状态存储接口 */
export interface StateStore {
  /** 加载项目状态 */
  load(projectId: string): WorkflowState
  /** 保存项目状态 */
  save(state: WorkflowState): void
  /** 在单个 SQLite 事务中读取并更新项目状态，避免并行 worker 覆盖彼此修改。 */
  update(projectId: string, updater: (state: WorkflowState) => WorkflowState): WorkflowState
  /** 列出所有项目 */
  listProjects(): string[]
  /** 创建新项目 */
  createProject(name: string, description?: string, projectRoot?: string): WorkflowState
  /** 删除项目 */
  deleteProject(projectId: string): void
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

  private initialize(db: Database.Database): void {
    // WAL 让桌面端读状态与后台 worker 写状态可以并发进行。
    db.pragma("journal_mode = WAL")
    db.pragma("busy_timeout = 5000")
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        project_name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `)
  }

  private withDatabase<T>(callback: (db: Database.Database) => T): T {
    const db = new Database(this.databasePath)
    try {
      this.initialize(db)
      return callback(db)
    } finally {
      db.close()
    }
  }

  private saveInTransaction(db: Database.Database, state: WorkflowState): WorkflowState {
    const updatedAt = new Date().toISOString()
    state.updatedAt = updatedAt
    db.prepare(
      `INSERT INTO projects(project_id, project_name, state_json, updated_at)
       VALUES (@projectId, @projectName, @stateJson, @updatedAt)
       ON CONFLICT(project_id) DO UPDATE SET
         project_name = excluded.project_name,
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    ).run({
      projectId: state.projectId,
      projectName: state.projectName,
      stateJson: JSON.stringify(state),
      updatedAt,
    })
    return state
  }

  getStorePath(): string {
    return this.originalStoreDir
  }

  load(projectId: string): WorkflowState {
    return this.withDatabase((db) => {
      const row = db.prepare("SELECT state_json FROM projects WHERE project_id = ?").get(projectId) as
        | { state_json: string }
        | undefined
      if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载项目 ${projectId}`)
      return migrateWorkflowState(JSON.parse(row.state_json))
    })
  }

  save(state: WorkflowState): void {
    this.withDatabase((db) => {
      const transaction = db.transaction(() => this.saveInTransaction(db, state))
      transaction()
    })
  }

  update(projectId: string, updater: (state: WorkflowState) => WorkflowState): WorkflowState {
    return this.withDatabase((db) => {
      const transaction = db.transaction(() => {
        const row = db.prepare("SELECT state_json FROM projects WHERE project_id = ?").get(projectId) as
          | { state_json: string }
          | undefined
        if (!row) throw new StoreError("STORE_LOAD_FAILED", `无法加载项目 ${projectId}`)
        const current = migrateWorkflowState(JSON.parse(row.state_json))
        return this.saveInTransaction(db, updater(current))
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

  createProject(name: string, description?: string, projectRoot?: string): WorkflowState {
    const projectId = ProjectId(`proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    const state = createEmptyState(projectId, name, description ?? "", projectRoot)
    this.withDatabase((db) => {
      const transaction = db.transaction(() => this.saveInTransaction(db, state))
      transaction()
    })
    return state
  }

  deleteProject(projectId: string): void {
    this.withDatabase((db) => {
      db.prepare("DELETE FROM projects WHERE project_id = ?").run(projectId)
    })
  }
}

export { ProjectId, Phase }
export * from "./workflow.js"
export * from "./execution.js"
