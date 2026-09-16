/**
 * 版本发布计划 —— 挂在 TB 版本上的上线 Checklist 执行状态。
 *
 * 把线下「上线计划」Excel 的流程串起来：版本已挂需求 → 功能预演 →
 * 发布前置条件/发版影响评估门控 → 上线 Checklist 执行 → 上线收尾 →
 * 维护/数据监控。纯类型与纯函数，不依赖 IO；Excel 读写见
 * `@octopus/integration` 的 `release-checklist-xlsx.ts`。
 */

import { Phase } from "./phase.js"

/** Checklist 行状态，与 Excel 数据验证 `To do,Ongoing,Done,Close` 对应 */
export const ReleaseItemStatus = {
  TODO: "TODO",
  ONGOING: "ONGOING",
  DONE: "DONE",
  CLOSE: "CLOSE",
} as const

export type ReleaseItemStatus = (typeof ReleaseItemStatus)[keyof typeof ReleaseItemStatus]

/** 已完成的行状态（不再计入阻塞项） */
const COMPLETED_STATUSES: readonly ReleaseItemStatus[] = [
  ReleaseItemStatus.DONE,
  ReleaseItemStatus.CLOSE,
]

/** 门控行（发布前置条件 / 发版影响评估）的 Yes/No 应答 */
export interface ReleaseGateFlag {
  /** 稳定 key，按出现顺序生成 `gate_1`, `gate_2`, ... */
  key: string
  group: "precondition" | "impact"
  label: string
  /** null = 未答（模板导入后的初始状态） */
  value: boolean | null
}

/** 上线 Checklist 单行 */
export interface ReleasePlanItem {
  id: string
  /** 分组（Excel B 列，纵向合并后前向填充） */
  group: string
  task: string
  remark?: string
  /** 当前执行内容/状态文本（Excel E 列） */
  content?: string
  /** 导入模板时的 E 列快照，对应「上线计划-检查」sheet；偏差比对基准 */
  plannedContent?: string
  status: ReleaseItemStatus
  owner?: string
  dependency?: string
  durationMin?: number
  plannedStart?: string
  plannedEnd?: string
  actualStart?: string
  actualEnd?: string
  /** 仅门控行有值，指向对应 ReleaseGateFlag.key */
  gateKey?: string
  /** content 与 plannedContent 是否已产生偏差 */
  deviation?: boolean
  /** 该行偏差已记 Heinrich 观测的时间；用于去重 */
  heinrichLoggedAt?: string
}

export const RehearsalResult = {
  TODO: "TODO",
  PASS: "PASS",
  FAIL: "FAIL",
} as const

export type RehearsalResult = (typeof RehearsalResult)[keyof typeof RehearsalResult]

/** 功能预演行，来自版本已挂需求 */
export interface ReleaseRehearsal {
  requirementId: string
  requirementName: string
  owner?: string
  result: RehearsalResult
  note?: string
}

/** 项目级 Setup 清单单行（一次性环境准备，不随版本变化） */
export interface SetupChecklistItem {
  id: string
  type: string
  task: string
  command?: string
  handler?: string
  finishDate?: string
  status?: string
  checkDate?: string
  inspector?: string
}

/** 模板中的 Checklist 行（未实例化：无 id/status/deviation） */
export type ReleaseTemplateItem = Omit<
  ReleasePlanItem,
  "id" | "status" | "deviation" | "heinrichLoggedAt"
> & { status?: ReleaseItemStatus }

/** 导入 Excel 得到的模板，同一项目只保留一份 */
export interface ReleaseChecklistTemplate {
  name: string
  importedAt: string
  items: ReleaseTemplateItem[]
  setup: Array<Omit<SetupChecklistItem, "id">>
}

/** 一个 TB 版本对应的发布计划实例 */
export interface ReleasePlan {
  versionId: string
  versionName?: string
  templateName: string
  createdAt: string
  updatedAt: string
  flags: ReleaseGateFlag[]
  items: ReleasePlanItem[]
  rehearsals: ReleaseRehearsal[]
}

/** 发布计划派生的宏观阶段 */
export const ReleasePlanStage = {
  PREPARE: "PREPARE",
  REHEARSAL: "REHEARSAL",
  RELEASING: "RELEASING",
  MONITORING: "MONITORING",
  DONE: "DONE",
} as const

export type ReleasePlanStage = (typeof ReleasePlanStage)[keyof typeof ReleasePlanStage]

export interface ReleasePlanBlocker {
  kind: "gate" | "rehearsal" | "deviation" | "setup"
  label: string
  /** gate: flag key；rehearsal: requirementId；deviation: item id；setup: setup item id */
  refId: string
}

export interface ReleasePlanSummary {
  stage: ReleasePlanStage
  total: number
  done: number
  grayed: number
  deviations: number
  byStage: Record<ReleasePlanStage, { total: number; done: number }>
  blockers: ReleasePlanBlocker[]
}

// ── 实例化 ──────────────────────────────────────────

/** 从模板 + 门控行生成初始 flags（value 全部 null，需逐条确认） */
function extractGateFlags(items: readonly ReleaseTemplateItem[]): ReleaseGateFlag[] {
  const flags: ReleaseGateFlag[] = []
  let seq = 0
  for (const item of items) {
    const group = normalizeGroupText(item.group)
    const kind = gateGroupKind(group)
    if (!kind) continue
    seq += 1
    flags.push({
      key: `gate_${seq}`,
      group: kind,
      label: item.remark?.trim() || item.task.trim(),
      value: null,
    })
  }
  return flags
}

function normalizeGroupText(value: string): string {
  return value.trim()
}

function gateGroupKind(group: string): "precondition" | "impact" | undefined {
  if (group.includes("前置条件")) return "precondition"
  if (group.includes("影响评估")) return "impact"
  return undefined
}

/** 基于模板与预演需求实例化一份发布计划。 */
export function instantiateReleasePlan(
  template: ReleaseChecklistTemplate,
  versionId: string,
  rehearsals: readonly Omit<ReleaseRehearsal, "result">[],
  now = new Date().toISOString(),
): ReleasePlan {
  const flags = extractGateFlags(template.items)
  let gateSeq = 0
  const items: ReleasePlanItem[] = template.items.map((templateItem, index) => {
    const group = normalizeGroupText(templateItem.group)
    const kind = gateGroupKind(group)
    let gateKey: string | undefined
    if (kind) {
      gateSeq += 1
      gateKey = `gate_${gateSeq}`
    }
    const item: ReleasePlanItem = {
      id: `ri_${index + 1}`,
      group,
      task: templateItem.task,
      status: templateItem.status ?? ReleaseItemStatus.TODO,
    }
    if (templateItem.remark !== undefined) item.remark = templateItem.remark
    if (templateItem.content !== undefined) item.content = templateItem.content
    if (templateItem.plannedContent !== undefined) item.plannedContent = templateItem.plannedContent
    if (templateItem.owner !== undefined) item.owner = templateItem.owner
    if (templateItem.dependency !== undefined) item.dependency = templateItem.dependency
    if (templateItem.durationMin !== undefined) item.durationMin = templateItem.durationMin
    if (templateItem.plannedStart !== undefined) item.plannedStart = templateItem.plannedStart
    if (templateItem.plannedEnd !== undefined) item.plannedEnd = templateItem.plannedEnd
    if (templateItem.actualStart !== undefined) item.actualStart = templateItem.actualStart
    if (templateItem.actualEnd !== undefined) item.actualEnd = templateItem.actualEnd
    if (gateKey !== undefined) item.gateKey = gateKey
    return item
  })
  return {
    versionId,
    templateName: template.name,
    createdAt: now,
    updatedAt: now,
    flags,
    items,
    rehearsals: rehearsals.map((r) => ({ ...r, result: RehearsalResult.TODO })),
  }
}

// ── 门控 / 灰行 ──────────────────────────────────────

/** 门控行对应 flag 值为 false 时置灰：不计入进度、不可改状态。 */
export function isItemGrayed(plan: Pick<ReleasePlan, "flags">, item: ReleasePlanItem): boolean {
  if (!item.gateKey) return false
  const flag = plan.flags.find((f) => f.key === item.gateKey)
  return flag?.value === false
}

// ── 偏差 ──────────────────────────────────────────

/** 执行内容是否偏离导入时的计划值。门控行（Yes/No 应答）不参与偏差判断。 */
export function detectDeviation(
  item: Pick<ReleasePlanItem, "content" | "plannedContent" | "gateKey">,
): boolean {
  if (item.gateKey) return false
  const current = (item.content ?? "").trim()
  const planned = (item.plannedContent ?? "").trim()
  return current !== planned
}

// ── 排期 ──────────────────────────────────────────

/**
 * 按行序累加 durationMin 排期，灰行跳过（不写计划时间，也不占用时长）。
 * 返回新对象，不修改入参。
 */
export function scheduleReleasePlan(plan: ReleasePlan, startIso: string): ReleasePlan {
  let cursor = new Date(startIso).getTime()
  const items = plan.items.map((item) => {
    if (isItemGrayed(plan, item)) return item
    const durationMin = item.durationMin ?? 0
    const plannedStart = new Date(cursor).toISOString()
    cursor += durationMin * 60_000
    const plannedEnd = new Date(cursor).toISOString()
    return { ...item, plannedStart, plannedEnd }
  })
  return { ...plan, items, updatedAt: new Date().toISOString() }
}

// ── 阶段派生 ──────────────────────────────────────────

// 精确匹配的分组名（B 列合并后的完整文本）优先，避免子串误撞（如「维护」
// 与「小程序维护」、「Magento 配置」与「Magento Config 配置」）。
const DONE_GROUPS_EXACT = new Set(["维护", "数据监控", "告警监控"])
const MONITORING_GROUPS_EXACT = new Set(["上线收尾", "DevOps"])
const PREPARE_GROUPS_EXACT = new Set([
  "初始化",
  "发布前置条件",
  "发版影响评估",
  "发版版本准备",
  "代码封版",
])
const REHEARSAL_GROUPS_EXACT = new Set(["开发预演", "模拟上线演练"])

const PREPARE_GROUP_SUBSTRINGS = [
  "代码准备",
  "关闭微信小程序其他支付",
  "小程序提审",
  "联系 IT 支持",
  "新增接口压测",
  "后端兼容测试",
]

const REHEARSAL_GROUP_SUBSTRINGS = ["OpenSearch", "ElasticSearch", "Prod SQL", "Magento 配置"]

/** 分组名 → 宏观阶段，未知分组默认归 RELEASING */
function groupStage(group: string): ReleasePlanStage {
  if (DONE_GROUPS_EXACT.has(group)) return ReleasePlanStage.DONE
  if (MONITORING_GROUPS_EXACT.has(group)) return ReleasePlanStage.MONITORING
  if (PREPARE_GROUPS_EXACT.has(group)) return ReleasePlanStage.PREPARE
  if (REHEARSAL_GROUPS_EXACT.has(group)) return ReleasePlanStage.REHEARSAL
  if (PREPARE_GROUP_SUBSTRINGS.some((k) => group.includes(k))) return ReleasePlanStage.PREPARE
  if (REHEARSAL_GROUP_SUBSTRINGS.some((k) => group.includes(k))) return ReleasePlanStage.REHEARSAL
  return ReleasePlanStage.RELEASING
}

function isItemComplete(item: ReleasePlanItem, plan: ReleasePlan): boolean {
  if (isItemGrayed(plan, item)) return true
  return COMPLETED_STATUSES.includes(item.status)
}

/** 派生发布计划当前所处的宏观阶段。 */
export function deriveReleasePlanStage(plan: ReleasePlan): ReleasePlanStage {
  if (plan.flags.some((f) => f.value === null)) return ReleasePlanStage.PREPARE

  const byStageItems = groupItemsByStage(plan)
  const prepareIncomplete = byStageItems[ReleasePlanStage.PREPARE].some(
    (item) => !isItemComplete(item, plan),
  )
  if (prepareIncomplete) return ReleasePlanStage.PREPARE

  const rehearsalIncomplete = plan.rehearsals.some((r) => r.result !== RehearsalResult.PASS)
  const rehearsalGroupIncomplete = byStageItems[ReleasePlanStage.REHEARSAL].some(
    (item) => !isItemComplete(item, plan),
  )
  if (rehearsalIncomplete || rehearsalGroupIncomplete) return ReleasePlanStage.REHEARSAL

  const releasingIncomplete = byStageItems[ReleasePlanStage.RELEASING].some(
    (item) => !isItemComplete(item, plan),
  )
  if (releasingIncomplete) return ReleasePlanStage.RELEASING

  const monitoringIncomplete = byStageItems[ReleasePlanStage.MONITORING].some(
    (item) => !isItemComplete(item, plan),
  )
  if (monitoringIncomplete) return ReleasePlanStage.MONITORING

  const doneGroupIncomplete = byStageItems[ReleasePlanStage.DONE].some(
    (item) => !isItemComplete(item, plan),
  )
  if (doneGroupIncomplete) return ReleasePlanStage.MONITORING

  return ReleasePlanStage.DONE
}

function groupItemsByStage(plan: ReleasePlan): Record<ReleasePlanStage, ReleasePlanItem[]> {
  const result: Record<ReleasePlanStage, ReleasePlanItem[]> = {
    [ReleasePlanStage.PREPARE]: [],
    [ReleasePlanStage.REHEARSAL]: [],
    [ReleasePlanStage.RELEASING]: [],
    [ReleasePlanStage.MONITORING]: [],
    [ReleasePlanStage.DONE]: [],
  }
  for (const item of plan.items) {
    result[groupStage(item.group)].push(item)
  }
  return result
}

const SETUP_INCOMPLETE_PATTERN = /未完成|todo|to do|pending/i
const SETUP_COMPLETE_PATTERN = /完成|done|complete/i

/** 「未完成」这类否定词优先判否，避免被「完成」子串误判为已完成。 */
function isSetupItemComplete(item: SetupChecklistItem): boolean {
  const status = item.status?.trim()
  if (!status) return false
  if (SETUP_INCOMPLETE_PATTERN.test(status)) return false
  return SETUP_COMPLETE_PATTERN.test(status)
}

/** 汇总发布计划：阶段、进度计数与阻塞项列表。 */
export function summarizeReleasePlan(
  plan: ReleasePlan,
  setup: readonly SetupChecklistItem[] = [],
): ReleasePlanSummary {
  const stage = deriveReleasePlanStage(plan)
  const byStageItems = groupItemsByStage(plan)
  const byStage = {} as Record<ReleasePlanStage, { total: number; done: number }>
  let total = 0
  let done = 0
  let grayed = 0
  let deviations = 0
  for (const stageKey of Object.values(ReleasePlanStage)) {
    const items = byStageItems[stageKey]
    const stageDone = items.filter((item) => isItemComplete(item, plan)).length
    byStage[stageKey] = { total: items.length, done: stageDone }
    total += items.length
    done += stageDone
  }
  for (const item of plan.items) {
    if (isItemGrayed(plan, item)) grayed += 1
    if (item.deviation) deviations += 1
  }

  const blockers: ReleasePlanBlocker[] = []
  for (const flag of plan.flags) {
    if (flag.value === null) {
      blockers.push({ kind: "gate", label: flag.label, refId: flag.key })
    }
  }
  for (const rehearsal of plan.rehearsals) {
    if (rehearsal.result !== RehearsalResult.PASS) {
      blockers.push({
        kind: "rehearsal",
        label: rehearsal.requirementName,
        refId: rehearsal.requirementId,
      })
    }
  }
  for (const item of plan.items) {
    if (item.deviation) {
      blockers.push({ kind: "deviation", label: `${item.group}/${item.task}`, refId: item.id })
    }
  }
  for (const setupItem of setup) {
    if (!isSetupItemComplete(setupItem)) {
      blockers.push({
        kind: "setup",
        label: `${setupItem.type}/${setupItem.task}`,
        refId: setupItem.id,
      })
    }
  }

  return { stage, total, done, grayed, deviations, byStage, blockers }
}

/** 引擎写偏差观测时使用，避免每处硬编码同一 Phase 常量。 */
export const RELEASE_PLAN_PHASE: Phase = Phase.RELEASE
