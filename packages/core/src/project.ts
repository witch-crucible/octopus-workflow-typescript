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

/** 项目实体 */
export interface Project {
  projectId: ProjectId
  name: string
  description: string
  createdAt: string
  updatedAt: string
  teambition?: ProjectTeambitionBinding
  metadata?: Record<string, string>
}

/** 项目列表摘要 */
export interface ProjectSummary {
  projectId: ProjectId
  name: string
  description: string
  requirementCount: number
  teambitionProjectId?: string
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
