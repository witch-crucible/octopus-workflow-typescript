/**
 * Integration 包 —— 外部系统集成层。
 *
 * 负责与外部工具和服务的集成：
 * - SonarQube 代码质量
 * - Git 分支操作
 * - Postman API 测试
 * - 监控系统
 * - 第三方部署平台
 *
 * 当前为适配器接口定义层，具体实现由集成方按需接入。
 */

import type { WorkflowState } from "@octopus/core/workflow.js"

/** 集成服务通用接口 */
export interface IntegrationService {
  /** 服务名称 */
  readonly name: string
  /** 健康检查 */
  healthCheck(): Promise<IntegrationResult>
}

/** 集成操作结果 */
export interface IntegrationResult {
  success: boolean
  message: string
  data?: unknown
  error?: string
}

/** 代码质量检查结果 */
export interface CodeQualityResult {
  passed: boolean
  score?: number
  issues: Array<{
    severity: "BLOCKER" | "CRITICAL" | "MAJOR" | "MINOR" | "INFO"
    message: string
    file?: string
    line?: number
  }>
}

/** SonarQube 集成接口 */
export interface SonarQubeIntegration extends IntegrationService {
  /** 运行代码质量扫描 */
  runScan(projectKey: string): Promise<CodeQualityResult>
  /** 获取质量阈状态 */
  getQualityGateStatus(projectKey: string): Promise<"PASSED" | "FAILED" | "NONE">
}

/** Git 操作接口 */
export interface GitIntegration extends IntegrationService {
  /** 创建发布分支 */
  createReleaseBranch(baseBranch: string, releaseVersion: string): Promise<IntegrationResult>
  /** 合并分支 */
  mergeBranches(source: string, target: string): Promise<IntegrationResult>
  /** 检查分支是否存在 */
  branchExists(name: string): boolean
}

/** Postman 集成接口 */
export interface PostmanIntegration extends IntegrationService {
  /** 运行集合测试 */
  runCollection(collectionId: string, environmentId?: string): Promise<IntegrationResult>
}

/** 监控集成接口 */
export interface MonitoringIntegration extends IntegrationService {
  /** 注册监控 */
  registerAlert(serviceName: string, duration: "1d" | "1w" | "1y"): Promise<IntegrationResult>
}

/** Teambition 集成接口 */
export interface TeambitionIntegration extends IntegrationService {
  /** 任务编号 → 任务详情 */
  resolveTask(ref: string, projectId?: string): Promise<IntegrationResult>
  /** 项目编号前缀 → 项目信息 */
  resolveProject(prefix: string): Promise<IntegrationResult>
  /** 更新任务字段（最多 4 个独立 PUT） */
  updateTask(update: import("./teambition.js").TaskUpdate): Promise<IntegrationResult>
  /** 查任务参与者及父任务参与者 */
  taskParticipants(taskId: string): Promise<IntegrationResult>
  /** 我的待办任务列表 */
  myTasks(userId: string, projectId?: string): Promise<IntegrationResult>
  /** 子任务列表 */
  taskChildren(parentTaskId: string): Promise<IntegrationResult>
  /** 项目工作流状态列表 */
  projectStatuses(projectId: string): Promise<IntegrationResult>
  /** 按关键字搜索成员 */
  searchMembers(query: string): Promise<IntegrationResult>
  /** 通过邮箱或名称解析成员 */
  resolveMember(emailOrName: string): Promise<IntegrationResult>
}

/** 环境部署检查清单 —— 映射 PlantUML 中部署阶段的详细检查项 */
export interface DeploymentChecklist {
  domain: {
    configured: boolean
    cdn: boolean
    waf: boolean
    slb: boolean
   备案: boolean
  }
  server: {
    diskMounted: boolean
    mediaDir: boolean
    logDir: boolean
    exportDir: boolean
    monitoring: boolean
  }
  nginx: {
    clientMaxBodySize: string
    uploadSizeConfigured: boolean
  }
  php: {
    uploadMaxFilesize: string
  }
  services: {
    email: boolean
    wechatTemplate: boolean
    payment: boolean
    thirdPartyInterfaces: string[]
  }
  magento?: {
    orderPrefixConfigured: boolean
    outOfStockDisplay: boolean
    imageNoCompression: boolean
    cacheConfigured: boolean
    cronJobsConfigured: boolean
    attributesGlobal: boolean
  }
}

/** 创建部署检查清单 */
export function createDeploymentChecklist(): DeploymentChecklist {
  return {
    domain: { configured: false, cdn: false, waf: false, slb: false, 备案: false },
    server: { diskMounted: false, mediaDir: false, logDir: false, exportDir: false, monitoring: false },
    nginx: { clientMaxBodySize: "10M", uploadSizeConfigured: false },
    php: { uploadMaxFilesize: "10M" },
    services: { email: false, wechatTemplate: false, payment: false, thirdPartyInterfaces: [] },
  }
}

export { GitClient, createGitClient } from "./git.js"
export type { GitIntegrationConfig } from "./git.js"
export { TeambitionClient, createTeambitionClient } from "./teambition.js"
export type { TeambitionIntegrationConfig, TbTask, WorkflowStatus, ChildTask, TbMember, TaskUpdate } from "./teambition.js"
export { SecurityWatchClient, createSecurityWatchClient } from "./security-watch.js"
export type { SecurityWatchConfig } from "./security-watch.js"

// OmniPlan
export {
  parseOmniPlanActual,
  buildOmniPlanActual,
  buildTocXml,
  packOplx,
  unpackOplx,
  escapeXml,
  dateToOmniPlanIso,
  omniPlanIsoToDate,
  slugifyProjectName,
  validateOmniPlanName,
  stableTaskId,
  resolveOmniPlanFolder,
  resolveOmniPlanFileName,
} from "./omniplan.js"
export type {
  OmniPlanDocument,
  OmniPlanTask,
  OmniPlanBuildInput,
  OmniPlanImportResult,
  PackedOplx,
} from "./omniplan.js"
export { readZip, writeZip } from "./zip-store.js"
