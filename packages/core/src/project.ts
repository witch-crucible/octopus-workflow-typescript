/**
 * 项目容器 —— 位于需求（Requirement / WorkflowState）之上。
 * 一个项目可包含多个需求，并可绑定 Teambition 项目。
 */

import type { ProjectId } from "./branded-ids.js"

/** 项目级 Teambition 绑定 */
export interface ProjectTeambitionBinding {
  /** Teambition 项目 ID */
  projectId: string
  /** Teambition 项目名称（缓存） */
  name?: string
  /** 任务编号前缀，如 ACME */
  uniqueIdPrefix?: string
}

/** 项目级 Teambition 版本仓库绑定（与 ProjectTeambitionBinding 并列） */
export interface ProjectTeambitionVersionBinding {
  /** 版本仓库 ID（必填） */
  repoId: string
  /** 版本管理插件 ID（用于拼链接，可选） */
  pluginId?: string
  /** TB 项目 ID（用于拼 url；缺省可回退 project.teambition.projectId） */
  tbProjectId?: string
  /** 仓库名称（缓存） */
  name?: string
  /** 默认版本 ID */
  defaultVersionId?: string
  /** 最近一次成功 sync 时间（listSyncStatus === "ok"） */
  lastSyncedAt?: string
  /** 版本列表缓存写入时间（仅成功 sync 时写入） */
  versionsCachedAt?: string
  /** 列表同步状态 */
  listSyncStatus?: "ok" | "unconfirmed" | "error"
  /** 版本列表缓存 */
  versionsCache?: Array<{
    versionId: string
    name: string
    status?: string
    startDate?: string
    endDate?: string
    note?: string
    url?: string
  }>
}

/** 项目实体 */
export interface Project {
  projectId: ProjectId
  name: string
  description: string
  createdAt: string
  updatedAt: string
  teambition?: ProjectTeambitionBinding
  teambitionVersion?: ProjectTeambitionVersionBinding
  metadata?: Record<string, string>
}

/** 项目列表摘要 */
export interface ProjectSummary {
  projectId: ProjectId
  name: string
  description: string
  requirementCount: number
  teambitionProjectId?: string
  teambitionRepoId?: string
  updatedAt: string
}

/** 创建空白项目 */
export function createEmptyProject(
  projectId: ProjectId,
  name: string,
  description = "",
): Project {
  const now = new Date().toISOString()
  return {
    projectId,
    name,
    description,
    createdAt: now,
    updatedAt: now,
    metadata: {},
  }
}
