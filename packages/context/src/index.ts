/**
 * Context 包 —— 工作流状态持久化层。
 *
 * 将 WorkflowState 以 JSON 文件形式存储到项目根目录的 .octo/ 目录。
 * 支持原子写入（写 tmp → copy + unlink）避免并发写导致的数据损坏。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs"
import { join, dirname, isAbsolute, resolve } from "node:path"
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
  /** 列出所有项目 */
  listProjects(): string[]
  /** 创建新项目 */
  createProject(name: string, description?: string): WorkflowState
  /** 删除项目 */
  deleteProject(projectId: string): void
  /** 获取存储路径 */
  getStorePath(): string
}

/** 创建默认状态存储实例 */
export function createStateStore(config?: Partial<StoreConfig>): StateStore {
  const storeDir = config?.storeDir ?? DEFAULT_STORE_DIR
  return new JsonFileStateStore(storeDir)
}

/**
 * 基于 JSON 文件的状态存储实现。
 *
 * 结构：
 *   {storeDir}/
 *     index.json           —— 项目索引 { projectId -> projectName }
 *     projects/
 *       {projectId}.json   —— 项目状态
 */
class JsonFileStateStore implements StateStore {
  private readonly originalStoreDir: string
  private readonly storeDir: string
  private readonly projectsDir: string
  private readonly indexFile: string

  constructor(storeDir: string) {
    this.originalStoreDir = storeDir
    this.storeDir = isAbsolute(storeDir) ? storeDir : resolve(storeDir)
    this.projectsDir = join(this.storeDir, "projects")
    this.indexFile = join(this.storeDir, "index.json")
    this.ensureDirectories()
  }

  private ensureDirectories(): void {
    if (!existsSync(this.storeDir)) {
      mkdirSync(this.storeDir, { recursive: true })
    }
    if (!existsSync(this.projectsDir)) {
      mkdirSync(this.projectsDir, { recursive: true })
    }
  }

  private ensureParentDir(filePath: string): void {
    const parent = dirname(filePath)
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true })
    }
  }

  private readIndex(): Record<string, string> {
    try {
      if (!existsSync(this.indexFile)) return {}
      const raw = readFileSync(this.indexFile, "utf-8")
      return JSON.parse(raw) as Record<string, string>
    } catch {
      return {}
    }
  }

  private writeIndex(index: Record<string, string>): void {
    this.atomicWrite(this.indexFile, JSON.stringify(index, null, 2))
  }

  private atomicWrite(filePath: string, data: string): void {
    try {
      this.ensureParentDir(filePath)
      writeFileSync(filePath, data, "utf-8")
    } catch (cause) {
      throw new StoreError("STORE_SAVE_FAILED", `无法写入 ${filePath}`, cause)
    }
  }

  getStorePath(): string {
    return this.originalStoreDir
  }

  load(projectId: string): WorkflowState {
    const filePath = join(this.projectsDir, `${projectId}.json`)
    try {
      const raw = readFileSync(filePath, "utf-8")
      // 迁移旧版（v1: tasks[]+stages{}）状态到统一 steps 模型
      return migrateWorkflowState(JSON.parse(raw))
    } catch (cause) {
      throw new StoreError("STORE_LOAD_FAILED", `无法加载项目 ${projectId}`, cause)
    }
  }

  save(state: WorkflowState): void {
    const filePath = join(this.projectsDir, `${state.projectId}.json`)
    const data = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)
    this.atomicWrite(filePath, data)
  }

  listProjects(): string[] {
    const index = this.readIndex()
    return Object.keys(index)
  }

  createProject(name: string, description?: string): WorkflowState {
    const projectId = ProjectId(`proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
    const state = createEmptyState(projectId, name, description ?? "")

    // 注册到索引
    const index = this.readIndex()
    index[projectId] = name
    this.writeIndex(index)

    // 保存初始状态
    this.save(state)
    return state
  }

  deleteProject(projectId: string): void {
    const filePath = join(this.projectsDir, `${projectId}.json`)
    try {
      if (existsSync(filePath)) {
        renameSync(filePath, `${filePath}.deleted`)
      }
    } catch (cause) {
      throw new StoreError("STORE_SAVE_FAILED", `无法删除项目 ${projectId}`, cause)
    }

    const index = this.readIndex()
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete index[projectId]
    this.writeIndex(index)
  }
}

export { ProjectId, Phase }
