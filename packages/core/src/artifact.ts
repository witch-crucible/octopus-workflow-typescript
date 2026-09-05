/**
 * 制品模型 —— 项目流程中各阶段产生的文档/产物。
 *
 * 映射 PlantUML 中提到的各类产出物：
 * BRD, PRD, 技术方案, 测试用例, 会议纪要, 发布计划, SQL 脚本等。
 */

import type { ArtifactId } from "./branded-ids.js"
import { Role } from "./role.js"
import { Phase } from "./phase.js"

/** 制品类型枚举 */
export enum ArtifactType {
  /** 商业需求文档 */
  BRD = "BRD",
  /** 产品需求文档 */
  PRD = "PRD",
  /** 技术设计文档 */
  TECH_DESIGN = "TECH_DESIGN",
  /** 测试用例 */
  TEST_CASE = "TEST_CASE",
  /** 会议纪要 */
  MEETING_MINUTES = "MEETING_MINUTES",
  /** 发布计划 */
  RELEASE_PLAN = "RELEASE_PLAN",
  /** SQL 脚本 */
  SQL_SCRIPT = "SQL_SCRIPT",
  /** 架构图 */
  ARCHITECTURE_DIAGRAM = "ARCHITECTURE_DIAGRAM",
  /** 估时表 */
  ESTIMATION = "ESTIMATION",
  /** 自我测试表 */
  SELF_TEST_REPORT = "SELF_TEST_REPORT",
  /** 技术债务报告 */
  TECH_DEBT_REPORT = "TECH_DEBT_REPORT",
  /** BRD 检查报告 */
  BRD_CHECK_REPORT = "BRD_CHECK_REPORT",
  /** 其它 */
  OTHER = "OTHER",
}

/** 制品类型显示名称映射 */
export const ARTIFACT_TYPE_LABELS: Record<ArtifactType, string> = {
  [ArtifactType.BRD]: "商业需求文档",
  [ArtifactType.PRD]: "产品需求文档",
  [ArtifactType.TECH_DESIGN]: "技术设计文档",
  [ArtifactType.TEST_CASE]: "测试用例",
  [ArtifactType.MEETING_MINUTES]: "会议纪要",
  [ArtifactType.RELEASE_PLAN]: "发布计划",
  [ArtifactType.SQL_SCRIPT]: "SQL 脚本",
  [ArtifactType.ARCHITECTURE_DIAGRAM]: "架构图",
  [ArtifactType.ESTIMATION]: "估时表",
  [ArtifactType.SELF_TEST_REPORT]: "自我测试表",
  [ArtifactType.TECH_DEBT_REPORT]: "技术债务报告",
  [ArtifactType.BRD_CHECK_REPORT]: "BRD 检查报告",
  [ArtifactType.OTHER]: "其它",
}

/** 制品接口 */
export interface Artifact {
  /** 制品唯一 ID */
  id: ArtifactId
  /** 制品类型 */
  type: ArtifactType
  /** 标题 */
  title: string
  /** 描述 */
  description: string
  /** 所属阶段 */
  phase: Phase
  /** 版本号 */
  version: string
  /** 创建者角色 */
  createdBy: Role
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 更新时间（ISO 8601） */
  updatedAt: string
  /** 文件路径（可选） */
  filePath?: string
  /** 内容（可选，文本型制品可直接存储） */
  content?: string
  /** 父制品 ID（版本链，可选） */
  parentArtifactId?: string
  /** 来源追踪信息（可选） */
  source?: {
    /** 来源运行 ID */
    runId?: string
    /** 来源事件序列 */
    eventSequence?: number
    /** 文件 sha256 */
    fileHash?: string
    /** git commit SHA */
    commitSha?: string
    /** Hermes/AI session ID */
    sessionId?: string
  }
}

/** 创建制品的参数 */
export interface CreateArtifactParams {
  type: ArtifactType
  title: string
  description: string
  phase: Phase
  createdBy: Role
  filePath?: string
  content?: string
}
