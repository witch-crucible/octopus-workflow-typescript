/**
 * 清单模型 —— 各阶段的质量核查清单。
 *
 * 映射 PlantUML 中海因里希三角的 CheckList 管理机制。
 * 清单项可以被继承到后续阶段，并支持 AI 推荐新增项。
 */

import type { ChecklistItemId } from "./branded-ids.js"
import { Phase } from "./phase.js"
import { Role } from "./role.js"

/** 清单项核验状态 */
export enum ChecklistItemStatus {
  /** 待核验 */
  PENDING = "PENDING",
  /** 已核验通过 */
  VERIFIED = "VERIFIED",
  /** 不适用 */
  NA = "NA",
}

/** 清单项状态标签映射 */
export const CHECKLIST_ITEM_STATUS_LABELS: Record<ChecklistItemStatus, string> = {
  [ChecklistItemStatus.PENDING]: "待核验",
  [ChecklistItemStatus.VERIFIED]: "已核验",
  [ChecklistItemStatus.NA]: "不适用",
}

/** 清单项 */
export interface ChecklistItem {
  /** 项唯一 ID */
  id: ChecklistItemId
  /** 分类（如 "部署", "配置", "安全"） */
  category: string
  /** 描述 */
  description: string
  /** 核验状态 */
  status: ChecklistItemStatus
  /** 核验人角色 */
  verifiedBy?: Role
  /** 核验时间 */
  verifiedAt?: string
  /** 备注 */
  notes?: string
  /** 是否从上一阶段继承 */
  inherited?: boolean
}

/** 阶段清单 */
export interface Checklist {
  /** 所属阶段 */
  phase: Phase
  /** 清单项列表 */
  items: ChecklistItem[]
}

/** 创建空清单 */
export function createEmptyChecklist(phase: Phase): Checklist {
  return { phase, items: [] }
}
