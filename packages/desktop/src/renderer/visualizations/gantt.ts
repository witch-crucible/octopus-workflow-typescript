// @ts-nocheck
/** Teambition-style Gantt (native SVG, no React). Ported from gantt.js. */

export type GanttScale = "day" | "week" | "month"

export type SchedulePayload = {
  plannedStart?: string | null
  plannedEnd?: string | null
  date?: string | null
}

export type ScheduleKind = "node" | "requirement" | "milestone"

export type GanttCallbacks = {
  onSelectNode?: (nodeId: string) => void
  onSelectRequirement?: (requirementId: string) => void
  onSelectMilestone?: (milestoneId: string) => void
  onSchedule?: (id: string, schedule: SchedulePayload, kind?: ScheduleKind) => void
  onReach?: (requirementId: string, milestoneId: string) => void
  onAddMilestone?: () => void
  onExportOmniPlan?: () => void
  onImportOmniPlan?: () => void | Promise<void>
  onError?: (message: string) => void
}

export type GanttUiState = {
  scale: GanttScale
  readOnly: boolean
  showDeps: boolean
  collapsed: string[]
  tableWidth: number
  scrollLeft: number
  scrollTop: number
}

export type GanttMountOptions = GanttCallbacks

export type GanttStepLike = {
  id: string
  name?: string
  phase?: string
  plannedStart?: string | null
  plannedEnd?: string | null
  status?: string
  responsibleRole?: string
  dependsOn?: string[]
  completedAt?: string | null
  [key: string]: unknown
}

export type GanttLabels = {
  phaseOrder?: string[]
  phaseLabel?: (phase: string) => string
  roleLabel?: (role: string) => string
  statusLabel?: (status: string) => string
  nodeName?: (step: GanttStepLike) => string
}

export type GanttMilestoneLike = {
  id: string
  name: string
  date: string
  status?: string
  [key: string]: unknown
}

export type GanttRequirementLike = {
  id: string
  name?: string
  phase?: string
  plannedStart?: string | null
  plannedEnd?: string | null
  statusLabel?: string
  progress?: number
  teambitionStatusName?: string
  steps?: GanttStepLike[]
  [key: string]: unknown
}

export type GanttRenderInput = {
  mode?: "nodes" | "requirements"
  steps?: GanttStepLike[]
  runs?: Array<{ nodeId?: string; startedAt?: string; finishedAt?: string; [key: string]: unknown }>
  snapshot?: { readyNodeIds?: string[]; currentNodeIds?: string[]; [key: string]: unknown }
  labels?: GanttLabels
  selectedNodeId?: string
  selectedId?: string
  milestones?: GanttMilestoneLike[]
  requirementId?: string
  requirements?: GanttRequirementLike[]
  [key: string]: unknown
}

export type GanttRow = {
  kind: string
  id: string
  label?: string | undefined
  phase?: string | undefined
  plannedStart?: string | undefined
  plannedEnd?: string | undefined
  date?: string | undefined
  status?: string | undefined
  statusLabel?: string | undefined
  role?: string | undefined
  collapsed?: boolean | undefined
  selected?: boolean | undefined
  childCount?: number | undefined
  progress?: number | undefined
  teambitionStatusName?: string | undefined
  steps?: GanttStepLike[] | undefined
  step?: GanttStepLike | undefined
  milestone?: GanttMilestoneLike | undefined
  overdue?: boolean | undefined
  requirementId?: string | undefined
  actual?: { start: string; end: string } | null | undefined
  ready?: boolean | undefined
  current?: boolean | undefined
  [key: string]: unknown
}

export type GanttViewModel = {
  rows: GanttRow[]
  unscheduled: GanttRow[]
  scheduled: GanttRow[]
  rangeStart: Date
  rangeEnd: Date
  today: Date
  dayCount: number
  px: number
  labels: GanttLabels
  selectedNodeId?: string | undefined
}

export type BuildRequirementsModelOptions = {
  collapsed?: ReadonlySet<string>
  scale?: GanttScale
}

const ROW_H = 36
const BAR_H = 18
const PHASE_BAR_H = 10
const HEADER_H = 56
const SCALE_PX: Record<GanttScale, number> = { day: 24, week: 12, month: 4 }
const MIN_TABLE_W = 220
const DEFAULT_TABLE_W = 420

const STATUS_BAR: Record<string, string> = {
  PENDING: "#c0c4cc",
  IN_PROGRESS: "#4f86c6",
  COMPLETED: "#67c23a",
  BLOCKED: "#f56c6c",
  SKIPPED: "#909399",
}

/** SVG polygon points for a milestone diamond centered at (cx, cy). */
export function milestoneDiamondPoints(cx: number, cy: number, r = 7): string {
  return `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`
}

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function parseDate(value: string): Date {
  const parts = String(value).split("-").map(Number)
  const y = parts[0] ?? 0
  const m = parts[1] ?? 1
  const d = parts[2] ?? 1
  return new Date(y, m - 1, d)
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, "0")
  const d = String(date.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function toDateOnly(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return formatDate(startOfToday())
  return formatDate(new Date(date.getFullYear(), date.getMonth(), date.getDate()))
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

function deriveActual(
  step: GanttStepLike,
  runs: Array<{ nodeId?: string; startedAt?: string; finishedAt?: string }>,
): { start: string; end: string } | null {
  const nodeRuns = runs.filter((run) => run.nodeId === step.id && run.startedAt)
  if (!nodeRuns.length && !step.completedAt) return null
  const starts = nodeRuns
    .map((run) => run.startedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
  const ends = nodeRuns
    .map((run) => run.finishedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
  const startIso = starts[0] || step.completedAt
  const endIso = step.completedAt || ends[ends.length - 1] || startIso
  if (!startIso) return null
  return { start: toDateOnly(String(startIso)), end: toDateOnly(String(endIso)) }
}

/** Pure requirements-mode model builder (DOM-free). */
export function buildRequirementsModel(
  input: GanttRenderInput | Record<string, unknown>,
  options: BuildRequirementsModelOptions = {},
): GanttViewModel {
  const requirements = (input.requirements as GanttRequirementLike[] | undefined) || []
  const selectedId = input.selectedId as string | undefined
  const labels = (input.labels as GanttLabels | undefined) || {}
  const collapsed = options.collapsed ?? new Set<string>()
  const scale = options.scale ?? "day"

  const rows: GanttRow[] = []
  const scheduled: GanttRow[] = []
  const unscheduled: GanttRow[] = []

  for (const req of requirements) {
    const hasPlan = Boolean(req.plannedStart && req.plannedEnd)
    const reqRow: GanttRow = {
      kind: "requirement",
      id: req.id,
      label: req.name || req.id,
      phase: req.phase || "",
      plannedStart: req.plannedStart ? String(req.plannedStart) : undefined,
      plannedEnd: req.plannedEnd ? String(req.plannedEnd) : undefined,
      statusLabel: req.statusLabel || req.phase || "",
      progress: req.progress ?? 0,
      teambitionStatusName: req.teambitionStatusName || "",
      steps: req.steps || [],
      collapsed: collapsed.has(`req:${req.id}`),
      selected: req.id === selectedId,
      childCount: (req.steps || []).length,
    }
    if (hasPlan) scheduled.push(reqRow)
    else unscheduled.push(reqRow)
    rows.push(reqRow)

    if (!reqRow.collapsed && req.steps && req.steps.length) {
      for (const step of req.steps) {
        const nodeHasPlan = Boolean(step.plannedStart && step.plannedEnd)
        const actual = deriveActual(step, [])
        const nodeRow: GanttRow = {
          kind: "node",
          id: step.id,
          phase: req.phase || "",
          step,
          label: step.name || step.id,
          role: step.responsibleRole || "",
          status: step.status,
          statusLabel: step.status,
          plannedStart: step.plannedStart ? String(step.plannedStart) : undefined,
          plannedEnd: step.plannedEnd ? String(step.plannedEnd) : undefined,
          actual,
          ready: false,
          current: false,
          selected: false,
          requirementId: req.id,
        }
        if (nodeHasPlan) scheduled.push(nodeRow)
        else unscheduled.push(nodeRow)
        rows.push(nodeRow)
      }
    }
  }

  const today = startOfToday()
  let rangeStart = addDays(today, -14)
  let rangeEnd = addDays(today, 14)
  const allDates: Date[] = []
  for (const row of rows) {
    if (row.plannedStart) allDates.push(parseDate(row.plannedStart))
    if (row.plannedEnd) allDates.push(parseDate(row.plannedEnd))
    if (row.actual?.start) allDates.push(parseDate(row.actual.start))
    if (row.actual?.end) allDates.push(parseDate(row.actual.end))
  }
  if (allDates.length) {
    const min = new Date(Math.min(...allDates.map((d) => d.getTime())))
    const max = new Date(Math.max(...allDates.map((d) => d.getTime())))
    rangeStart = addDays(min < today ? min : today, -7)
    rangeEnd = addDays(max > today ? max : today, 21)
  }

  return {
    rows,
    unscheduled,
    scheduled,
    rangeStart,
    rangeEnd,
    today,
    dayCount: Math.max(1, daysBetween(rangeStart, rangeEnd) + 1),
    px: SCALE_PX[scale],
    labels,
    selectedNodeId: selectedId,
  }
}

function htmlAll(root: ParentNode, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(selector)) as HTMLElement[]
}

type DragState = {
  nodeId: string
  kind: string
  mode: string
  originX: number
  start: string
  end: string
  pointerId: number
  previewDate?: string
  previewStart?: string
  previewEnd?: string
}

type GanttEls = {
  toolbar?: HTMLElement
  tablePane?: HTMLElement
  tableScroll?: HTMLElement
  splitter?: HTMLElement
  chartHeaderScroll?: HTMLElement
  chartHeader?: SVGElement
  chartScroll?: HTMLElement
  chartBody?: SVGElement
  unscheduled?: HTMLElement
  unscheduledList?: HTMLElement
  unscheduledCount?: HTMLElement
}

let root: HTMLElement | undefined
let callbacks: GanttCallbacks = {}
const ui: {
  scale: GanttScale
  readOnly: boolean
  showDeps: boolean
  collapsed: Set<string>
  tableWidth: number
  scrollLeft: number
  scrollTop: number
} = {
  scale: "day",
  readOnly: false,
  showDeps: true,
  collapsed: new Set<string>(),
  tableWidth: DEFAULT_TABLE_W,
  scrollLeft: 0,
  scrollTop: 0,
}
let dragging: DragState | null = null
let lastModel: GanttViewModel | null = null
let cachedInput: GanttRenderInput | null = null
let syncingScroll = false

const els: GanttEls = {}

function need<K extends keyof GanttEls>(key: K): NonNullable<GanttEls[K]> {
  const value = els[key]
  if (!value) throw new Error(`Gantt element missing: ${String(key)}`)
  return value
}

function unmount() {
  dragging = null
  lastModel = null
  cachedInput = null
  syncingScroll = false
  if (root) root.innerHTML = ""
  root = undefined
  callbacks = {}
  for (const key of Object.keys(els) as (keyof GanttEls)[]) delete els[key]
}

let currentMode: "nodes" | "requirements" = "nodes"

function mount(el: HTMLElement, opts: GanttMountOptions = {}) {
  if (root) unmount()
  root = el
  callbacks = opts
  root.innerHTML = `
    <div class="gantt-toolbar">
      <div class="gantt-scale" role="group" aria-label="时间刻度">
        <button type="button" data-scale="day">日</button>
        <button type="button" data-scale="week">周</button>
        <button type="button" data-scale="month">月</button>
      </div>
      <button type="button" class="secondary" data-action="today">今天</button>
      <button type="button" class="secondary" data-action="readonly" aria-pressed="false">只读</button>
      <button type="button" class="secondary" data-action="deps" aria-pressed="true">依赖线</button>
      <button type="button" class="secondary" data-action="add-milestone">添加里程碑</button>
      <button type="button" class="secondary" data-action="export-omniplan">导出 OmniPlan</button>
      <button type="button" class="secondary" data-action="import-omniplan">导入 OmniPlan</button>
      <span class="gantt-hint muted">左侧改日期或拖条排期；未排期在底部</span>
    </div>
    <div class="gantt-body">
      <div class="gantt-table-pane" style="width:${ui.tableWidth}px">
        <div class="gantt-table-header">
          <div class="gantt-col gantt-col-name">名称</div>
          <div class="gantt-col gantt-col-role">负责人</div>
          <div class="gantt-col gantt-col-status">状态</div>
          <div class="gantt-col gantt-col-date">开始</div>
          <div class="gantt-col gantt-col-date">结束</div>
        </div>
        <div class="gantt-table-scroll"></div>
      </div>
      <div class="gantt-splitter" title="拖动调整列宽"></div>
      <div class="gantt-chart-pane">
        <div class="gantt-chart-header-scroll">
          <svg class="gantt-chart-header" height="${HEADER_H}"></svg>
        </div>
        <div class="gantt-chart-scroll">
          <svg class="gantt-chart-body"></svg>
        </div>
      </div>
    </div>
    <div class="gantt-unscheduled">
      <div class="gantt-unscheduled-title">未排期 <span class="count">0</span></div>
      <div class="gantt-unscheduled-list"></div>
    </div>
  `

  els.toolbar = root.querySelector(".gantt-toolbar") as HTMLElement
  els.tablePane = root.querySelector(".gantt-table-pane") as HTMLElement
  els.tableScroll = root.querySelector(".gantt-table-scroll") as HTMLElement
  els.splitter = root.querySelector(".gantt-splitter") as HTMLElement
  els.chartHeaderScroll = root.querySelector(".gantt-chart-header-scroll") as HTMLElement
  els.chartHeader = root.querySelector(".gantt-chart-header") as unknown as SVGElement
  els.chartScroll = root.querySelector(".gantt-chart-scroll") as HTMLElement
  els.chartBody = root.querySelector(".gantt-chart-body") as unknown as SVGElement
  els.unscheduled = root.querySelector(".gantt-unscheduled") as HTMLElement
  els.unscheduledList = root.querySelector(".gantt-unscheduled-list") as HTMLElement
  els.unscheduledCount = root.querySelector(".gantt-unscheduled .count") as HTMLElement

  bindToolbar()
  bindSplitter()
  bindScrollSync()
  syncToolbar()
}

function getUiState(): GanttUiState {
  return {
    scale: ui.scale,
    readOnly: ui.readOnly,
    showDeps: ui.showDeps,
    collapsed: [...ui.collapsed],
    tableWidth: ui.tableWidth,
    scrollLeft: els.chartScroll?.scrollLeft ?? ui.scrollLeft,
    scrollTop: els.chartScroll?.scrollTop ?? ui.scrollTop,
  }
}

function setUiState(state: Partial<GanttUiState> | null | undefined) {
  if (!state) return
  if (state.scale === "day" || state.scale === "week" || state.scale === "month")
    ui.scale = state.scale
  if (typeof state.readOnly === "boolean") ui.readOnly = state.readOnly
  if (typeof state.showDeps === "boolean") ui.showDeps = state.showDeps
  if (Array.isArray(state.collapsed)) ui.collapsed = new Set(state.collapsed)
  if (typeof state.tableWidth === "number") ui.tableWidth = Math.max(MIN_TABLE_W, state.tableWidth)
  if (typeof state.scrollLeft === "number") ui.scrollLeft = state.scrollLeft
  if (typeof state.scrollTop === "number") ui.scrollTop = state.scrollTop
  if (els.tablePane) need("tablePane").style.width = `${ui.tableWidth}px`
  syncToolbar()
}

function isDragging() {
  return Boolean(dragging)
}

function scrollToToday() {
  if (!lastModel) return
  const px = SCALE_PX[ui.scale]
  const offset = daysBetween(lastModel.rangeStart, startOfToday()) * px
  const viewW = need("chartScroll").clientWidth
  need("chartScroll").scrollLeft = Math.max(0, offset - viewW / 2)
  ui.scrollLeft = need("chartScroll").scrollLeft
}

function applyNarrowLayout() {
  const narrow = document.body.classList.contains("is-narrow-gantt")
  if (!els.tablePane || !root) return
  const bodyEl = root.querySelector(".gantt-body") as HTMLElement | null
  if (bodyEl) bodyEl.style.flexDirection = narrow ? "column" : "row"
  if (narrow) {
    need("tablePane").style.width = "100%"
    need("tablePane").style.maxHeight = "38%"
    need("tablePane").style.borderRight = "0"
    if (els.splitter) need("splitter").style.display = "none"
  } else {
    need("tablePane").style.width = `${ui.tableWidth}px`
    need("tablePane").style.maxHeight = ""
    need("tablePane").style.borderRight = ""
    if (els.splitter) need("splitter").style.display = ""
  }
}

function render(model: GanttRenderInput | null | undefined) {
  if (!root || !model) return
  if (dragging) return
  cachedInput = model
  currentMode = model.mode === "requirements" ? "requirements" : "nodes"
  lastModel =
    currentMode === "requirements"
      ? buildRequirementsModel(model, { collapsed: ui.collapsed, scale: ui.scale })
      : buildModel(model)
  syncToolbar()
  applyNarrowLayout()
  renderTable(lastModel)
  renderChart(lastModel)
  renderUnscheduled(lastModel)
  restoreScroll()
}

function isMilestoneOverdue(m: GanttMilestoneLike) {
  if (m.status === "reached") return false
  const today = startOfToday()
  const date = parseDate(m.date)
  return date < today
}

function buildModel(input: GanttRenderInput): GanttViewModel {
  const steps = input.steps || []
  const runs = input.runs || []
  const snapshot = input.snapshot || {}
  const labels = input.labels || {}
  const phaseOrder = labels.phaseOrder || []
  const selectedNodeId = input.selectedNodeId
  const milestones = input.milestones || []
  const requirementId = input.requirementId || ""

  const byPhase = new Map<string, GanttStepLike[]>()
  for (const step of steps) {
    const phaseKey = String(step.phase || "")
    let list = byPhase.get(phaseKey)
    if (!list) {
      list = []
      byPhase.set(phaseKey, list)
    }
    list.push(step)
  }
  for (const list of byPhase.values()) {
    list.sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }

  const phases = [
    ...phaseOrder.filter((phase) => byPhase.has(phase)),
    ...[...byPhase.keys()].filter((phase) => !phaseOrder.includes(phase)),
  ]

  const rows: GanttRow[] = []
  const scheduled: GanttRow[] = []
  const unscheduled: GanttRow[] = []

  if (milestones.length) {
    rows.push({
      kind: "milestones",
      id: "milestones",
      label: "里程碑",
      childCount: milestones.length,
    })
    for (const m of milestones) {
      const overdue = isMilestoneOverdue(m)
      const statusLabel = m.status === "reached" ? "已达成" : overdue ? "逾期" : "计划中"
      rows.push({
        kind: "milestone",
        id: m.id,
        milestone: m,
        date: m.date,
        label: m.name,
        status: m.status,
        statusLabel,
        overdue,
        requirementId,
      })
    }
  }

  for (const phase of phases) {
    const children = byPhase.get(phase) || []
    const collapsed = ui.collapsed.has(phase)
    const childRanges = children
      .filter((step) => Boolean(step.plannedStart && step.plannedEnd))
      .map((step) => ({ start: String(step.plannedStart), end: String(step.plannedEnd) }))
    let phaseStart: string | undefined
    let phaseEnd: string | undefined
    for (const range of childRanges) {
      if (!phaseStart || range.start < phaseStart) phaseStart = range.start
      if (!phaseEnd || range.end > phaseEnd) phaseEnd = range.end
    }
    rows.push({
      kind: "phase",
      id: `phase:${phase}`,
      phase,
      label: labels.phaseLabel?.(phase) || phase,
      collapsed,
      plannedStart: phaseStart,
      plannedEnd: phaseEnd,
      childCount: children.length,
    })
    for (const step of children) {
      const hasPlan = Boolean(step.plannedStart && step.plannedEnd)
      const actual = deriveActual(step, runs)
      const row: GanttRow = {
        kind: "node",
        id: step.id,
        phase,
        step,
        label: labels.nodeName?.(step) || step.name,
        role: labels.roleLabel?.(step.responsibleRole || "") || step.responsibleRole || "",
        status: step.status,
        statusLabel: labels.statusLabel?.(step.status || "") || step.status,
        plannedStart: step.plannedStart ? String(step.plannedStart) : undefined,
        plannedEnd: step.plannedEnd ? String(step.plannedEnd) : undefined,
        actual,
        ready: Boolean(snapshot.readyNodeIds?.includes(step.id)),
        current: Boolean(snapshot.currentNodeIds?.includes(step.id)),
        selected: step.id === selectedNodeId,
      }
      if (hasPlan) scheduled.push(row)
      else unscheduled.push(row)
      if (!collapsed) rows.push(row)
    }
  }

  const today = startOfToday()
  let rangeStart = addDays(today, -14)
  let rangeEnd = addDays(today, 14)
  const allDates: Date[] = []
  for (const row of rows) {
    if (row.plannedStart) allDates.push(parseDate(row.plannedStart))
    if (row.plannedEnd) allDates.push(parseDate(row.plannedEnd))
    if (row.actual?.start) allDates.push(parseDate(row.actual.start))
    if (row.actual?.end) allDates.push(parseDate(row.actual.end))
    if (row.kind === "milestone" && row.date) allDates.push(parseDate(row.date))
  }
  if (allDates.length) {
    const min = new Date(Math.min(...allDates.map((d) => d.getTime())))
    const max = new Date(Math.max(...allDates.map((d) => d.getTime())))
    rangeStart = addDays(min < today ? min : today, -7)
    rangeEnd = addDays(max > today ? max : today, 21)
  }

  return {
    rows,
    unscheduled,
    scheduled,
    rangeStart,
    rangeEnd,
    today,
    dayCount: Math.max(1, daysBetween(rangeStart, rangeEnd) + 1),
    px: SCALE_PX[ui.scale],
    labels,
    selectedNodeId,
  }
}

function renderTable(model: GanttViewModel) {
  const html = model.rows
    .map((row: GanttRow) => {
      if (row.kind === "milestones") {
        return `
        <div class="gantt-row gantt-row-milestones" data-row-id="${escapeAttr(row.id)}">
          <div class="gantt-col gantt-col-name">
            <strong>${escapeHtml(row.label)}</strong>
            <span class="muted">· ${row.childCount}</span>
          </div>
          <div class="gantt-col gantt-col-role"></div>
          <div class="gantt-col gantt-col-status"></div>
          <div class="gantt-col gantt-col-date muted">—</div>
          <div class="gantt-col gantt-col-date muted">—</div>
        </div>`
      }
      if (row.kind === "milestone") {
        const statusClass = row.overdue
          ? "is-overdue"
          : row.status === "reached"
            ? "is-reached"
            : "is-planned"
        const reachBtn =
          row.status !== "reached" && !ui.readOnly
            ? ` <button type="button" class="gantt-reach-btn" data-reach-milestone="${escapeAttr(row.id)}" data-reach-req="${escapeAttr(row.requirementId)}" title="标记达成">达成</button>`
            : ""
        return `
        <div class="gantt-row gantt-row-milestone" data-row-id="${escapeAttr(row.id)}" data-milestone-id="${escapeAttr(row.id)}">
          <div class="gantt-col gantt-col-name" title="${escapeAttr(row.label)}">
            <span class="gantt-indent"></span>
            <span class="gantt-name">◇ ${escapeHtml(row.label)}</span>
          </div>
          <div class="gantt-col gantt-col-role"></div>
          <div class="gantt-col gantt-col-status"><span class="gantt-status ${statusClass}">${escapeHtml(row.statusLabel)}</span>${reachBtn}</div>
          <div class="gantt-col gantt-col-date muted">${escapeHtml(row.date)}</div>
          <div class="gantt-col gantt-col-date muted">—</div>
        </div>`
      }
      if (row.kind === "phase") {
        return `
        <div class="gantt-row gantt-row-phase${row.collapsed ? " is-collapsed" : ""}" data-row-id="${escapeAttr(row.id)}" data-phase="${escapeAttr(row.phase)}">
          <div class="gantt-col gantt-col-name">
            <button type="button" class="gantt-twist" data-toggle-phase="${escapeAttr(row.phase)}" aria-label="折叠阶段">${row.collapsed ? "▸" : "▾"}</button>
            <strong>${escapeHtml(row.label)}</strong>
            <span class="muted">· ${row.childCount}</span>
          </div>
          <div class="gantt-col gantt-col-role"></div>
          <div class="gantt-col gantt-col-status"></div>
          <div class="gantt-col gantt-col-date muted">${row.plannedStart || "—"}</div>
          <div class="gantt-col gantt-col-date muted">${row.plannedEnd || "—"}</div>
        </div>`
      }
      if (row.kind === "requirement") {
        const disabled = ui.readOnly ? "disabled" : ""
        const tbText = row.teambitionStatusName ? ` · ${escapeHtml(row.teambitionStatusName)}` : ""
        return `
        <div class="gantt-row gantt-row-requirement${row.selected ? " is-selected" : ""}" data-row-id="${escapeAttr(row.id)}" data-requirement-id="${escapeAttr(row.id)}">
          <div class="gantt-col gantt-col-name" title="${escapeAttr(row.label)}">
            <button type="button" class="gantt-twist" data-toggle-req="${escapeAttr(row.id)}" aria-label="展开需求">${row.collapsed ? "▸" : "▾"}</button>
            <span class="gantt-name">${escapeHtml(row.label)}</span>
            <span class="muted">· ${row.childCount}</span>
          </div>
          <div class="gantt-col gantt-col-role">${tbText ? escapeHtml(tbText) : ""}</div>
          <div class="gantt-col gantt-col-status"><span class="gantt-status status-${escapeAttr(String(row.phase || "").toLowerCase())}">${escapeHtml(row.statusLabel)}</span></div>
          <div class="gantt-col gantt-col-date">
            <input type="date" data-date="start" data-req-id="${escapeAttr(row.id)}" value="${escapeAttr(row.plannedStart || "")}" ${disabled} />
          </div>
          <div class="gantt-col gantt-col-date">
            <input type="date" data-date="end" data-req-id="${escapeAttr(row.id)}" value="${escapeAttr(row.plannedEnd || "")}" ${disabled} />
          </div>
        </div>`
      }
      const disabled = ui.readOnly ? "disabled" : ""
      const isReqNode = Boolean(row.requirementId)
      const dateDataAttr = isReqNode
        ? `data-req-node-id="${escapeAttr(row.id)}"`
        : `data-node-id="${escapeAttr(row.id)}"`
      return `
      <div class="gantt-row gantt-row-node${row.selected ? " is-selected" : ""}${row.current ? " is-current" : ""}${isReqNode ? " is-req-node" : ""}" data-row-id="${escapeAttr(row.id)}" data-node-id="${escapeAttr(row.id)}" ${isReqNode ? `data-requirement-id="${escapeAttr(row.requirementId)}"` : ""}>
        <div class="gantt-col gantt-col-name" title="${escapeAttr(row.label)}">
          <span class="gantt-indent"></span>
          <span class="gantt-name">${escapeHtml(row.label)}</span>
        </div>
        <div class="gantt-col gantt-col-role">${escapeHtml(row.role)}</div>
        <div class="gantt-col gantt-col-status"><span class="gantt-status status-${escapeAttr(String(row.status || "").toLowerCase())}">${escapeHtml(row.statusLabel)}</span></div>
        <div class="gantt-col gantt-col-date">
          <input type="date" data-date="start" ${dateDataAttr} value="${escapeAttr(row.plannedStart || "")}" ${disabled} />
        </div>
        <div class="gantt-col gantt-col-date">
          <input type="date" data-date="end" ${dateDataAttr} value="${escapeAttr(row.plannedEnd || "")}" ${disabled} />
        </div>
      </div>`
    })
    .join("")

  need("tableScroll").innerHTML = html || `<div class="gantt-empty">当前阶段暂无节点</div>`

  for (const button of htmlAll(need("tableScroll"), "[data-toggle-phase]")) {
    button.onclick = (event) => {
      event.stopPropagation()
      const phase = button.getAttribute("data-toggle-phase")
      if (!phase) return
      if (ui.collapsed.has(phase)) ui.collapsed.delete(phase)
      else ui.collapsed.add(phase)
      if (cachedInput) render(cachedInput)
    }
  }

  for (const button of htmlAll(need("tableScroll"), "[data-toggle-req]")) {
    button.onclick = (event) => {
      event.stopPropagation()
      const reqId = button.getAttribute("data-toggle-req")
      if (!reqId) return
      const key = `req:${reqId}`
      if (ui.collapsed.has(key)) ui.collapsed.delete(key)
      else ui.collapsed.add(key)
      if (cachedInput) render(cachedInput)
    }
  }

  for (const rowEl of htmlAll(need("tableScroll"), ".gantt-row-node")) {
    rowEl.onmouseenter = () => highlightRow(rowEl.dataset.nodeId, true)
    rowEl.onmouseleave = () => highlightRow(rowEl.dataset.nodeId, false)
    rowEl.onclick = (event) => {
      if ((event.target as Element | null)?.closest("input,button")) return
      const id = rowEl.dataset.nodeId
      if (id) callbacks.onSelectNode?.(id)
    }
  }

  for (const rowEl of htmlAll(need("tableScroll"), ".gantt-row-requirement")) {
    rowEl.onmouseenter = () => highlightRow(rowEl.dataset.requirementId, true)
    rowEl.onmouseleave = () => highlightRow(rowEl.dataset.requirementId, false)
    rowEl.onclick = (event) => {
      if ((event.target as Element | null)?.closest("input,button")) return
      const id = rowEl.dataset.requirementId
      if (id) callbacks.onSelectRequirement?.(id)
    }
  }

  for (const rowEl of htmlAll(need("tableScroll"), ".gantt-row-milestone")) {
    rowEl.onmouseenter = () => highlightRow(rowEl.dataset.milestoneId, true)
    rowEl.onmouseleave = () => highlightRow(rowEl.dataset.milestoneId, false)
    rowEl.onclick = (event) => {
      if ((event.target as Element | null)?.closest("input,button")) return
      const id = rowEl.dataset.milestoneId
      if (id) callbacks.onSelectMilestone?.(id)
    }
  }

  for (const btn of htmlAll(need("tableScroll"), "[data-reach-milestone]")) {
    btn.onclick = (event) => {
      event.stopPropagation()
      const req = btn.dataset.reachReq
      const mid = btn.dataset.reachMilestone
      if (req && mid) callbacks.onReach?.(req, mid)
    }
  }

  for (const input of htmlAll(need("tableScroll"), "input[type=date]") as HTMLInputElement[]) {
    input.onchange = () => {
      const nodeId = input.dataset.nodeId || input.dataset.reqNodeId
      const reqId = input.dataset.reqId
      if (reqId) {
        const startInput = need("tableScroll").querySelector(
          `input[data-date="start"][data-req-id="${cssEscape(reqId)}"]`,
        ) as HTMLInputElement | null
        const endInput = need("tableScroll").querySelector(
          `input[data-date="end"][data-req-id="${cssEscape(reqId)}"]`,
        ) as HTMLInputElement | null
        const start = startInput?.value || ""
        const end = endInput?.value || ""
        if (!start && !end) {
          callbacks.onSchedule?.(reqId, { plannedStart: null, plannedEnd: null }, "requirement")
          return
        }
        if (!start || !end) {
          callbacks.onError?.("计划起止日期必须成对填写")
          if (cachedInput) render(cachedInput)
          return
        }
        if (end < start) {
          callbacks.onError?.("计划结束日期不能早于开始日期")
          if (cachedInput) render(cachedInput)
          return
        }
        callbacks.onSchedule?.(reqId, { plannedStart: start, plannedEnd: end }, "requirement")
        return
      }
      if (!nodeId) return
      const startInput = need("tableScroll").querySelector(
        `input[data-date="start"][data-node-id="${cssEscape(nodeId)}"]`,
      ) as HTMLInputElement | null
      const endInput = need("tableScroll").querySelector(
        `input[data-date="end"][data-node-id="${cssEscape(nodeId)}"]`,
      ) as HTMLInputElement | null
      const start = startInput?.value || ""
      const end = endInput?.value || ""
      if (!start && !end) {
        callbacks.onSchedule?.(nodeId, { plannedStart: null, plannedEnd: null })
        return
      }
      if (!start || !end) {
        callbacks.onError?.("计划起止日期必须成对填写")
        if (cachedInput) render(cachedInput)
        return
      }
      if (end < start) {
        callbacks.onError?.("计划结束日期不能早于开始日期")
        if (cachedInput) render(cachedInput)
        return
      }
      callbacks.onSchedule?.(nodeId, { plannedStart: start, plannedEnd: end })
    }
  }
}

function renderChart(model: GanttViewModel) {
  const width = model.dayCount * model.px
  const height = Math.max(ROW_H, model.rows.length * ROW_H)
  need("chartHeader").setAttribute("width", String(width))
  need("chartHeader").setAttribute("viewBox", `0 0 ${width} ${HEADER_H}`)
  need("chartBody").setAttribute("width", String(width))
  need("chartBody").setAttribute("height", String(height))
  need("chartBody").setAttribute("viewBox", `0 0 ${width} ${height}`)

  need("chartHeader").replaceChildren()
  need("chartBody").replaceChildren()

  drawTimeHeader(need("chartHeader"), model)
  drawGrid(need("chartBody"), model, height)

  const positions = new Map<string, { row: GanttRow; y: number; index: number }>()
  model.rows.forEach((row: GanttRow, index: number) => {
    const y = index * ROW_H
    positions.set(row.id, { row, y, index })
    const bg = svg("rect", {
      x: 0,
      y,
      width,
      height: ROW_H,
      class: `gantt-lane${index % 2 ? " alt" : ""}${row.selected ? " selected" : ""}`,
      "data-row-id": row.id,
    })
    need("chartBody").appendChild(bg)
  })

  if (ui.showDeps) drawDependencies(need("chartBody"), model, positions)

  for (const [id, pos] of positions) {
    const { row, y } = pos
    if (row.kind === "milestones" || row.kind === "milestone") {
      if (row.kind === "milestone" && row.date) {
        drawDiamond(need("chartBody"), model, {
          id: row.id,
          date: row.date,
          y: y + ROW_H / 2,
          status: row.status,
          overdue: row.overdue,
          interactive: !ui.readOnly,
        })
      }
      continue
    }
    if (row.kind === "phase") {
      if (row.plannedStart && row.plannedEnd) {
        drawBar(need("chartBody"), model, {
          id,
          y: y + (ROW_H - PHASE_BAR_H) / 2,
          h: PHASE_BAR_H,
          start: row.plannedStart,
          end: row.plannedEnd,
          color: "#606266",
          label: "",
          kind: "phase",
          interactive: false,
        })
      }
      continue
    }
    if (row.kind === "requirement") {
      if (row.plannedStart && row.plannedEnd) {
        const color = barColor({ ready: false, status: row.phase || "PENDING" })
        drawBar(need("chartBody"), model, {
          id,
          y: y + (ROW_H - BAR_H) / 2,
          h: BAR_H,
          start: row.plannedStart,
          end: row.plannedEnd,
          color,
          label: row.label || "",
          kind: "requirement",
          interactive: !ui.readOnly,
          selected: row.selected,
          progress: row.progress,
        })
      }
      continue
    }
    if (row.actual) {
      drawBar(need("chartBody"), model, {
        id: `${id}::actual`,
        y: y + ROW_H - 8,
        h: 3,
        start: row.actual.start,
        end: row.actual.end,
        color: "#a8abb2",
        label: "",
        kind: "actual",
        interactive: false,
      })
    }
    if (row.plannedStart && row.plannedEnd) {
      const color = barColor(row)
      drawBar(need("chartBody"), model, {
        id,
        y: y + (ROW_H - BAR_H) / 2,
        h: BAR_H,
        start: row.plannedStart,
        end: row.plannedEnd,
        color,
        label: row.label || "",
        kind: "node",
        interactive: !ui.readOnly,
        selected: row.selected,
        progress: progressFor(row.status),
      })
    }
  }

  const todayX = daysBetween(model.rangeStart, model.today) * model.px + model.px / 2
  need("chartBody").appendChild(
    svg("line", {
      x1: todayX,
      y1: 0,
      x2: todayX,
      y2: height,
      class: "gantt-today-line",
    }),
  )

  for (const lane of htmlAll(need("chartBody"), ".gantt-lane")) {
    const rowId = lane.getAttribute("data-row-id")
    lane.addEventListener("mouseenter", () => highlightRow(rowId, true))
    lane.addEventListener("mouseleave", () => highlightRow(rowId, false))
    lane.addEventListener("click", () => {
      if (!rowId || rowId.startsWith("phase:")) return
      const row = model.rows.find((r) => r.id === rowId)
      if (row?.kind === "requirement") callbacks.onSelectRequirement?.(rowId)
      else callbacks.onSelectNode?.(rowId)
    })
  }
}

function drawTimeHeader(svgRoot: Element, model: GanttViewModel) {
  const { rangeStart, dayCount, px } = model
  let cursor = 0
  while (cursor < dayCount) {
    const date = addDays(rangeStart, cursor)
    let span = 1
    let label = ""
    if (ui.scale === "month") {
      const month = date.getMonth()
      while (cursor + span < dayCount && addDays(rangeStart, cursor + span).getMonth() === month)
        span += 1
      label = `${date.getFullYear()}年${date.getMonth() + 1}月`
    } else if (ui.scale === "week") {
      while (cursor + span < dayCount && addDays(rangeStart, cursor + span).getDay() !== 1)
        span += 1
      label = `${date.getMonth() + 1}/${date.getDate()} 周`
    } else {
      const month = date.getMonth()
      while (cursor + span < dayCount && addDays(rangeStart, cursor + span).getMonth() === month)
        span += 1
      label = `${date.getFullYear()}年${date.getMonth() + 1}月`
    }
    const x = cursor * px
    const w = span * px
    svgRoot.appendChild(
      svg("rect", {
        x,
        y: 0,
        width: w,
        height: HEADER_H / 2,
        class: "gantt-head-top",
      }),
    )
    svgRoot.appendChild(svgText(x + 8, 18, label, "gantt-head-label"))
    cursor += span
  }

  for (let i = 0; i < dayCount; i += 1) {
    const date = addDays(rangeStart, i)
    const x = i * px
    const weekend = date.getDay() === 0 || date.getDay() === 6
    const isToday = formatDate(date) === formatDate(model.today)
    svgRoot.appendChild(
      svg("rect", {
        x,
        y: HEADER_H / 2,
        width: px,
        height: HEADER_H / 2,
        class: `gantt-head-day${weekend ? " weekend" : ""}${isToday ? " today" : ""}`,
      }),
    )
    let text = ""
    if (ui.scale === "day") text = String(date.getDate())
    else if (ui.scale === "week" && (date.getDay() === 1 || i === 0))
      text = `${date.getMonth() + 1}/${date.getDate()}`
    else if (ui.scale === "month" && date.getDate() === 1) text = `${date.getMonth() + 1}月`
    if (text)
      svgRoot.appendChild(svgText(x + px / 2, HEADER_H - 10, text, "gantt-head-day-label", true))
  }
}

function drawGrid(svgRoot: Element, model: GanttViewModel, height: number) {
  for (let i = 0; i < model.dayCount; i += 1) {
    const date = addDays(model.rangeStart, i)
    const x = i * model.px
    const weekend = date.getDay() === 0 || date.getDay() === 6
    const isToday = formatDate(date) === formatDate(model.today)
    if (weekend || isToday) {
      svgRoot.appendChild(
        svg("rect", {
          x,
          y: 0,
          width: model.px,
          height,
          class: `gantt-col-bg${weekend ? " weekend" : ""}${isToday ? " today" : ""}`,
        }),
      )
    }
    svgRoot.appendChild(
      svg("line", {
        x1: x,
        y1: 0,
        x2: x,
        y2: height,
        class: "gantt-grid-line",
      }),
    )
  }
}

function drawDependencies(
  svgRoot: Element,
  model: GanttViewModel,
  positions: Map<string, { row: GanttRow; y: number; index: number }>,
) {
  for (const row of model.rows) {
    if (row.kind !== "node" || !row.plannedStart || !row.step?.dependsOn?.length) continue
    const to = positions.get(row.id)
    if (!to) continue
    for (const depId of row.step.dependsOn) {
      const from = positions.get(depId)
      const fromRow = from?.row
      if (!from || !fromRow?.plannedStart || !fromRow?.plannedEnd) continue
      const x1 = xForDate(model, fromRow.plannedEnd) + model.px
      const y1 = from.y + ROW_H / 2
      const x2 = xForDate(model, row.plannedStart)
      const y2 = to.y + ROW_H / 2
      const mid = Math.max(x1 + 8, Math.min(x2 - 8, (x1 + x2) / 2))
      const active = row.selected || fromRow.selected
      const path = `M ${x1} ${y1} L ${mid} ${y1} L ${mid} ${y2} L ${x2} ${y2}`
      svgRoot.appendChild(
        svg("path", {
          d: path,
          class: `gantt-dep${active ? " active" : ""}`,
          fill: "none",
        }),
      )
      svgRoot.appendChild(
        svg("polygon", {
          points: `${x2},${y2} ${x2 - 6},${y2 - 4} ${x2 - 6},${y2 + 4}`,
          class: `gantt-dep-arrow${active ? " active" : ""}`,
        }),
      )
    }
  }
}

function drawBar(
  svgRoot: Element,
  model: GanttViewModel,
  opts: {
    id: string
    y: number
    h: number
    start: string
    end: string
    color: string
    label: string
    kind: string
    interactive: boolean
    selected?: boolean | undefined
    progress?: number | undefined
  },
) {
  const x = xForDate(model, opts.start)
  const w = Math.max(
    model.px,
    (daysBetween(parseDate(opts.start), parseDate(opts.end)) + 1) * model.px,
  )
  const group = svg("g", {
    class: `gantt-bar gantt-bar-${opts.kind}${opts.selected ? " selected" : ""}`,
    "data-bar-id": opts.id,
  })
  const rect = svg("rect", {
    x,
    y: opts.y,
    width: w,
    height: opts.h,
    rx: 4,
    ry: 4,
    fill: opts.color,
    class: "gantt-bar-rect",
  })
  group.appendChild(rect)
  if ((opts.progress ?? 0) > 0 && opts.kind === "node") {
    group.appendChild(
      svg("rect", {
        x,
        y: opts.y,
        width: Math.max(0, w * (opts.progress ?? 0)),
        height: opts.h,
        rx: 4,
        ry: 4,
        fill: "rgba(0,0,0,0.18)",
        class: "gantt-bar-progress",
      }),
    )
  }
  if (opts.label && opts.kind === "node") {
    const inside = w > 72
    group.appendChild(
      svgText(
        inside ? x + 8 : x + w + 6,
        opts.y + opts.h / 2 + 4,
        truncate(opts.label, inside ? Math.floor(w / 8) : 18),
        inside ? "gantt-bar-label inside" : "gantt-bar-label outside",
      ),
    )
  }
  if (opts.interactive) {
    ;(rect as SVGElement).style.cursor = "grab"
    rect.addEventListener("pointerdown", (event) =>
      startDrag(event as PointerEvent, model, opts, "move"),
    )
    const left = svg("rect", {
      x: x - 3,
      y: opts.y,
      width: 6,
      height: opts.h,
      class: "gantt-handle",
    })
    const right = svg("rect", {
      x: x + w - 3,
      y: opts.y,
      width: 6,
      height: opts.h,
      class: "gantt-handle",
    })
    left.addEventListener("pointerdown", (event) =>
      startDrag(event as PointerEvent, model, opts, "start"),
    )
    right.addEventListener("pointerdown", (event) =>
      startDrag(event as PointerEvent, model, opts, "end"),
    )
    group.appendChild(left)
    group.appendChild(right)
  }
  group.addEventListener("click", (event) => {
    event.stopPropagation()
    if (opts.kind === "requirement") callbacks.onSelectRequirement?.(opts.id)
    else if (opts.kind === "node") callbacks.onSelectNode?.(opts.id)
  })
  svgRoot.appendChild(group)
}

function drawDiamond(
  svgRoot: Element,
  model: GanttViewModel,
  opts: {
    id: string
    date: string
    y: number
    status?: string | undefined
    overdue?: boolean | undefined
    interactive?: boolean | undefined
  },
) {
  const cx = xForDate(model, opts.date) + model.px / 2
  const cy = opts.y
  const r = 7
  const points = milestoneDiamondPoints(cx, cy, r)
  const isReached = opts.status === "reached"
  const fillColor = isReached ? "#4f86c6" : opts.overdue ? "#f56c6c" : "none"
  const strokeColor = opts.overdue ? "#f56c6c" : "#4f86c6"
  const g = svg("g", {
    class: `gantt-diamond gantt-diamond-${isReached ? "reached" : opts.overdue ? "overdue" : "planned"}`,
    "data-bar-id": opts.id,
  })
  g.appendChild(
    svg("polygon", {
      points,
      fill: fillColor,
      stroke: strokeColor,
      "stroke-width": 2,
      class: "gantt-diamond-shape",
    }),
  )
  if (opts.interactive) {
    const hitArea = svg("rect", {
      x: cx - r - 3,
      y: cy - r - 3,
      width: (r + 3) * 2,
      height: (r + 3) * 2,
      fill: "transparent",
      class: "gantt-handle",
    })
    ;(hitArea as SVGElement).style.cursor = "grab"
    hitArea.addEventListener("pointerdown", (event) => {
      startDrag(
        event as PointerEvent,
        model,
        {
          id: opts.id,
          kind: "milestone",
          start: opts.date,
          end: opts.date,
        },
        "move",
      )
    })
    g.appendChild(hitArea)
  }
  g.addEventListener("click", (event) => {
    event.stopPropagation()
    callbacks.onSelectMilestone?.(opts.id)
  })
  svgRoot.appendChild(g)
}

function startDrag(
  event: PointerEvent,
  model: GanttViewModel,
  opts: {
    id: string
    kind: string
    start: string
    end: string
    y?: number
  },
  mode: string,
) {
  if (ui.readOnly) return
  if (opts.kind !== "node" && opts.kind !== "milestone" && opts.kind !== "requirement") return
  event.preventDefault()
  event.stopPropagation()
  const pointerId = event.pointerId
  const originX = event.clientX
  const isMilestone = opts.kind === "milestone"
  dragging = {
    nodeId: opts.id,
    kind: opts.kind,
    mode: isMilestone ? "move" : mode,
    originX,
    start: opts.start,
    end: opts.end,
    pointerId,
  }
  const target = event.currentTarget as Element & { setPointerCapture?: (id: number) => void }
  target.setPointerCapture?.(pointerId)

  const onMove = (moveEvent: PointerEvent) => {
    if (!dragging) return
    const deltaDays = Math.round((moveEvent.clientX - originX) / model.px)
    if (dragging.kind === "milestone") {
      dragging.previewDate = formatDate(addDays(parseDate(dragging.start), deltaDays))
      const bar = need("chartBody").querySelector(`[data-bar-id="${cssEscape(opts.id)}"]`)
      if (bar) {
        const polygon = bar.querySelector(".gantt-diamond-shape")
        if (polygon) {
          const cx = xForDate(model, dragging.previewDate) + model.px / 2
          const cy = opts.y ?? 0
          const r = 7
          polygon.setAttribute("points", milestoneDiamondPoints(cx, cy, r))
        }
      }
      return
    }
    let nextStart = dragging.start
    let nextEnd = dragging.end
    if (mode === "move") {
      nextStart = formatDate(addDays(parseDate(dragging.start), deltaDays))
      nextEnd = formatDate(addDays(parseDate(dragging.end), deltaDays))
    } else if (mode === "start") {
      nextStart = formatDate(addDays(parseDate(dragging.start), deltaDays))
      if (nextStart > nextEnd) nextStart = nextEnd
    } else {
      nextEnd = formatDate(addDays(parseDate(dragging.end), deltaDays))
      if (nextEnd < nextStart) nextEnd = nextStart
    }
    dragging.previewStart = nextStart
    dragging.previewEnd = nextEnd
    const bar = need("chartBody").querySelector(`[data-bar-id="${cssEscape(opts.id)}"]`)
    if (bar) {
      const rect = bar.querySelector(".gantt-bar-rect")
      const progress = bar.querySelector(".gantt-bar-progress")
      const x = xForDate(model, nextStart)
      const w = Math.max(
        model.px,
        (daysBetween(parseDate(nextStart), parseDate(nextEnd)) + 1) * model.px,
      )
      if (rect) {
        rect.setAttribute("x", String(x))
        rect.setAttribute("width", String(w))
      }
      if (progress) {
        progress.setAttribute("x", String(x))
        progress.setAttribute(
          "width",
          String(Math.max(0, w * progressFor(model.rows.find((r) => r.id === opts.id)?.status))),
        )
      }
    }
  }

  const onUp = () => {
    window.removeEventListener("pointermove", onMove)
    window.removeEventListener("pointerup", onUp)
    const result = dragging
    dragging = null
    if (!result) return
    if (result.kind === "milestone") {
      if (!result.previewDate || result.previewDate === result.start) return
      callbacks.onSchedule?.(result.nodeId, { date: result.previewDate }, "milestone")
      return
    }
    if (!result.previewStart || !result.previewEnd) return
    if (result.previewStart === result.start && result.previewEnd === result.end) return
    const kind = result.kind === "requirement" ? "requirement" : "node"
    callbacks.onSchedule?.(
      result.nodeId,
      {
        plannedStart: result.previewStart,
        plannedEnd: result.previewEnd,
      },
      kind,
    )
  }

  window.addEventListener("pointermove", onMove)
  window.addEventListener("pointerup", onUp)
}

function renderUnscheduled(model: GanttViewModel) {
  need("unscheduledCount").textContent = String(model.unscheduled.length)
  if (!model.unscheduled.length) {
    need("unscheduledList").innerHTML =
      `<div class="muted">${currentMode === "requirements" ? "所有需求和节点都已排期" : "所有节点都已排期"}</div>`
    return
  }
  need("unscheduledList").innerHTML = model.unscheduled
    .map((row: GanttRow) => {
      const isReq = row.kind === "requirement"
      return `
    <button type="button" class="gantt-chip${isReq ? " gantt-chip-req" : ""}" data-node-id="${escapeAttr(row.id)}" data-kind="${escapeAttr(row.kind || "node")}" ${isReq ? `data-requirement-id="${escapeAttr(row.id)}"` : ""}>
      <span class="name">${escapeHtml(row.label)}</span>
      <span class="meta">${isReq ? escapeHtml(row.statusLabel) : `${escapeHtml(row.role)} · ${escapeHtml(row.statusLabel)}`}</span>
    </button>`
    })
    .join("")
  for (const chip of htmlAll(need("unscheduledList"), ".gantt-chip")) {
    chip.onclick = () => {
      if (chip.dataset.kind === "requirement") {
        const id = chip.dataset.requirementId || chip.dataset.nodeId
        if (id) callbacks.onSelectRequirement?.(id)
      } else if (chip.dataset.nodeId) {
        callbacks.onSelectNode?.(chip.dataset.nodeId)
      }
    }
  }
}

function bindToolbar() {
  need("toolbar").addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest("button") as HTMLButtonElement | null
    if (!button) return
    if (button.dataset.scale) {
      ui.scale = (button.dataset.scale as GanttScale) || ui.scale
      syncToolbar()
      if (cachedInput) render(cachedInput)
      return
    }
    const action = button.dataset.action
    if (action === "today") scrollToToday()
    if (action === "readonly") {
      ui.readOnly = !ui.readOnly
      syncToolbar()
      if (cachedInput) render(cachedInput)
    }
    if (action === "deps") {
      ui.showDeps = !ui.showDeps
      syncToolbar()
      if (cachedInput) render(cachedInput)
    }
    if (action === "add-milestone") {
      callbacks.onAddMilestone?.()
    }
    if (action === "export-omniplan") {
      callbacks.onExportOmniPlan?.()
    }
    if (action === "import-omniplan") {
      callbacks.onImportOmniPlan?.()
    }
  })
}

function syncToolbar() {
  if (!els.toolbar) return
  for (const button of htmlAll(need("toolbar"), "[data-scale]")) {
    button.classList.toggle("active", button.dataset.scale === ui.scale)
  }
  const readonlyBtn = need("toolbar").querySelector(
    '[data-action="readonly"]',
  ) as HTMLElement | null
  if (readonlyBtn) {
    readonlyBtn.setAttribute("aria-pressed", String(ui.readOnly))
    readonlyBtn.classList.toggle("active", ui.readOnly)
    readonlyBtn.textContent = ui.readOnly ? "只读 · 开" : "只读"
  }
  const depsBtn = need("toolbar").querySelector('[data-action="deps"]') as HTMLElement | null
  if (depsBtn) {
    depsBtn.setAttribute("aria-pressed", String(ui.showDeps))
    depsBtn.classList.toggle("active", ui.showDeps)
  }
}

function bindSplitter() {
  let active: { startX: number; startW: number; pointerId: number } | null = null
  need("splitter").addEventListener("pointerdown", (event) => {
    const ev = event as PointerEvent
    active = { startX: ev.clientX, startW: ui.tableWidth, pointerId: ev.pointerId }
    need("splitter").setPointerCapture?.(ev.pointerId)
  })
  need("splitter").addEventListener("pointermove", (event) => {
    if (!active) return
    const ev = event as PointerEvent
    ui.tableWidth = Math.max(
      MIN_TABLE_W,
      Math.min(560, active.startW + (ev.clientX - active.startX)),
    )
    need("tablePane").style.width = `${ui.tableWidth}px`
  })
  need("splitter").addEventListener("pointerup", () => {
    active = null
  })
}

function bindScrollSync() {
  need("chartScroll").addEventListener("scroll", () => {
    if (syncingScroll) return
    syncingScroll = true
    need("tableScroll").scrollTop = need("chartScroll").scrollTop
    need("chartHeaderScroll").scrollLeft = need("chartScroll").scrollLeft
    ui.scrollLeft = need("chartScroll").scrollLeft
    ui.scrollTop = need("chartScroll").scrollTop
    syncingScroll = false
  })
  need("tableScroll").addEventListener("scroll", () => {
    if (syncingScroll) return
    syncingScroll = true
    need("chartScroll").scrollTop = need("tableScroll").scrollTop
    ui.scrollTop = need("tableScroll").scrollTop
    syncingScroll = false
  })
}

function restoreScroll() {
  need("chartScroll").scrollLeft = ui.scrollLeft
  need("chartScroll").scrollTop = ui.scrollTop
  need("tableScroll").scrollTop = ui.scrollTop
  need("chartHeaderScroll").scrollLeft = ui.scrollLeft
}

function highlightRow(rowId: string | null | undefined, on: boolean) {
  if (!rowId) return
  const tableRow = need("tableScroll").querySelector(`[data-row-id="${cssEscape(rowId)}"]`)
  const lane = need("chartBody").querySelector(`.gantt-lane[data-row-id="${cssEscape(rowId)}"]`)
  tableRow?.classList.toggle("is-hover", on)
  lane?.classList.toggle("hover", on)
}

function barColor(row: { ready?: boolean | undefined; status?: string | undefined }) {
  if (row.ready && row.status === "PENDING") return "#4f86c6"
  return (row.status ? STATUS_BAR[row.status] : undefined) || "#909399"
}

function progressFor(status: string | undefined) {
  if (status === "COMPLETED") return 1
  if (status === "IN_PROGRESS") return 0.5
  return 0
}

function xForDate(model: GanttViewModel, dateText: string) {
  return daysBetween(model.rangeStart, parseDate(dateText)) * model.px
}

function svg(
  name: string,
  attrs: Record<string, string | number | boolean | null | undefined> = {},
): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name)
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) el.setAttribute(key, String(value))
  }
  return el
}

function svgText(
  x: number,
  y: number,
  text: string,
  className: string,
  center?: boolean,
): SVGElement {
  const el = svg("text", {
    x,
    y,
    class: className,
    ...(center ? { "text-anchor": "middle" } : {}),
  })
  el.textContent = text
  return el
}

function escapeHtml(value: unknown): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }
  return String(value ?? "").replace(/[&<>"']/g, (char) => map[char] ?? char)
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value)
}

function cssEscape(value: string): string {
  if (window.CSS?.escape) return window.CSS.escape(value)
  return String(value).replace(/"/g, '\\"')
}

function truncate(text: unknown, max: number): string {
  const value = String(text || "")
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

export const OctopusGantt = {
  mount,
  unmount,
  render,
  isDragging,
  getUiState,
  setUiState,
  scrollToToday,
}
