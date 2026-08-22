import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { useWorkspacePanels } from "@/hooks/useWorkspacePanels"
import { confirmAction, readableError, showError, showMessage, showSuccess } from "@/lib/feedback"
import { buildWorkflowGraphNodes, nodeRoles, type GraphDisplayNode } from "@/lib/graph-model"
import { projectHash, requirementHash } from "@/lib/hash-route"
import {
  PHASE_HINTS,
  PHASE_ORDER,
  ROLE_COLORS,
  actionLabel,
  nodeDescZh,
  nodeNameZh,
  phaseLabel,
  roleLabel,
  runStatusLabel,
  schedulerLabel,
  statusLabel,
} from "@/lib/labels"
import {
  getOctopus,
  type ExecutionSnapshot,
  type RequirementState,
  type RequirementSummary,
  type RunRecord,
  type TbStatus,
} from "@/lib/octopus"
import {
  persistMetaCollapsed,
  preferredMetaCollapsed,
} from "@/lib/theme"
import { formatMilestoneDate } from "@/lib/view-models"
import { cn } from "@/lib/utils"
import { WorkflowGraph } from "@/visualizations/WorkflowGraph"

export type WorkspaceViewProps = {
  requirementId: string
  onProjectKnown?: (projectId: string) => void
}

type WorkspaceMilestone = {
  id: string
  name: string
  date: string
  status: "planned" | "reached"
  phase?: string
  nodeId?: string
  note?: string
}

type ProjectVersion = {
  versionId: string
  name: string
}

type NodeWorkspaceInfo = {
  nodeKey?: string
  path?: string
  exists?: boolean
}

type MilestoneFormState = {
  id: string
  name: string
  date: string
  phase: string
  nodeId: string
  note: string
}

function todayYmd(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${d}`
}

function runIdentity(run: RunRecord): string {
  const raw = run as RunRecord & { id?: string }
  return String(raw.id || raw.runId || "")
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null
}

function emptyMilestoneForm(): MilestoneFormState {
  return { id: "", name: "", date: "", phase: "", nodeId: "", note: "" }
}

function Metric({
  value,
  label,
  tip,
}: {
  value: string | number
  label: string
  tip?: string
}) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2 shadow-xs" title={tip}>
      <div className="text-lg font-semibold leading-none">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  )
}

function RequirementList({
  requirements,
  selectedId,
  onSelect,
}: {
  requirements: RequirementSummary[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  if (!requirements.length) {
    return <p className="text-sm text-muted-foreground">暂无需求</p>
  }
  return (
    <div className="flex flex-col gap-1">
      {requirements.map((item) => {
        const active = item.requirementId === selectedId
        return (
          <button
            key={item.requirementId}
            type="button"
            className={cn(
              "rounded-md border px-3 py-2 text-left text-sm transition-colors",
              active
                ? "border-primary bg-primary/10 text-foreground"
                : "border-transparent hover:bg-muted",
            )}
            onClick={() => onSelect(item.requirementId)}
          >
            <div className="font-medium">
              {item.requirementName || item.requirementId}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {phaseLabel(item.currentPhase)} · {item.completedTasks ?? 0}/{item.totalTasks ?? 0}
            </div>
          </button>
        )
      })}
    </div>
  )
}

function HelpGuide() {
  return (
    <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
      <li>项目管理中心可创建 / 编辑 / 删除项目</li>
      <li>项目页管理需求，并可绑定 Teambition 项目</li>
      <li>需求工作区查看角色泳道图；顶栏可绑定任务、改状态并管理里程碑</li>
      <li>拖拽空白处平移；Ctrl/⌘+滚轮缩放；两侧按钮收起 / 展开侧栏</li>
      <li>节点详情可打开 / 复制脚本目录；Ctrl/⌘+单击节点亦可跳转</li>
      <li>项目页需求卡片可展开甘特图排期</li>
    </ol>
  )
}

export function WorkspaceView({ requirementId, onProjectKnown }: WorkspaceViewProps) {
  const octopus = getOctopus()
  const {
    sidebarCollapsed,
    inspectorCollapsed,
    isCompact,
    setSidebarCollapsed,
    setInspectorCollapsed,
    toggleSidebar,
    toggleInspector,
  } = useWorkspacePanels()

  const [state, setState] = useState<RequirementState | null>(null)
  const [snapshot, setSnapshot] = useState<ExecutionSnapshot>({
    currentNodeIds: [],
    readyNodeIds: [],
    waitingNodeIds: [],
  })
  const [requirements, setRequirements] = useState<RequirementSummary[]>([])
  const [nodes, setNodes] = useState<GraphDisplayNode[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [workspaceInfo, setWorkspaceInfo] = useState<NodeWorkspaceInfo | null>(null)
  const [assignedTo, setAssignedTo] = useState("")
  const [milestones, setMilestones] = useState<WorkspaceMilestone[]>([])
  const [showReachedMilestones, setShowReachedMilestones] = useState(false)
  const [milestoneFormOpen, setMilestoneFormOpen] = useState(false)
  const [milestoneForm, setMilestoneForm] = useState<MilestoneFormState>(emptyMilestoneForm)
  const [versions, setVersions] = useState<ProjectVersion[]>([])
  const [tbStatuses, setTbStatuses] = useState<TbStatus[]>([])
  const [tbTaskRef, setTbTaskRef] = useState("")
  const [tbStatusId, setTbStatusId] = useState("")
  const [versionId, setVersionId] = useState("")
  const [owner, setOwner] = useState("")
  const [statusText, setStatusText] = useState("加载中…")
  const [statusTone, setStatusTone] = useState<"default" | "good" | "bad" | "warn" | "info">("default")
  const [lastUpdate, setLastUpdate] = useState("")
  const [metaCollapsed, setMetaCollapsed] = useState(() => preferredMetaCollapsed() ?? false)
  const [zoom, setZoom] = useState(() => (typeof window !== "undefined" && window.innerWidth < 1100 ? 1 : 1.4))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sidebarSheetOpen, setSidebarSheetOpen] = useState(false)
  const [inspectorSheetOpen, setInspectorSheetOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const contentRef = useRef<HTMLElement | null>(null)
  const graphHostRef = useRef<HTMLDivElement | null>(null)
  const selectedNodeIdRef = useRef<string | null>(null)
  const loadSeq = useRef(0)

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId
  }, [selectedNodeId])

  const setStatus = useCallback((text: string, tone: typeof statusTone = "default") => {
    setStatusText(text)
    setStatusTone(tone)
  }, [])

  const navigateRequirement = useCallback((id: string) => {
    location.hash = `#${requirementHash(id)}`
  }, [])

  const goProject = useCallback(() => {
    const projectId = state?.projectId
    if (projectId) location.hash = `#${projectHash(projectId)}`
    else location.hash = "#hub"
  }, [state?.projectId])

  const goHub = useCallback(() => {
    location.hash = "#hub"
  }, [])

  const resolveNodeWorkspace = useCallback(
    async (nodeId: string): Promise<NodeWorkspaceInfo> => {
      if (octopus.resolveNodeWorkspace) {
        const info = await octopus.resolveNodeWorkspace(requirementId, nodeId)
        const path = info?.path
        return {
          nodeKey: String(asRecord(info)?.nodeKey || nodeId),
          exists: Boolean(asRecord(info)?.exists),
          ...(path ? { path } : {}),
        }
      }
      const root = typeof state?.projectRoot === "string" ? state.projectRoot : ""
      if (!root) throw new Error("项目没有源码根目录")
      return {
        nodeKey: nodeId,
        path: `${root}/workflow/nodes/${nodeId}`,
        exists: false,
      }
    },
    [octopus, requirementId, state?.projectRoot],
  )

  const openNodeDirectory = useCallback(
    async (nodeId: string) => {
      try {
        const info = await resolveNodeWorkspace(nodeId)
        if (octopus.openNodeDirectory) {
          const result = await octopus.openNodeDirectory(requirementId, nodeId)
          if (typeof result === "string" && result) throw new Error(result)
          setStatus(`已打开脚本目录：${info.nodeKey || nodeId}`, "info")
          return
        }
        if (info.path) {
          try {
            await navigator.clipboard.writeText(info.path)
            setStatus(`已复制脚本目录：${info.path}`, "info")
          } catch {
            setStatus(`脚本目录：${info.path}`, "warn")
          }
          const vscodeUrl = `vscode://file${info.path.startsWith("/") ? info.path : `/${info.path}`}`
          const probe = document.createElement("a")
          probe.href = vscodeUrl
          probe.style.display = "none"
          document.body.appendChild(probe)
          probe.click()
          probe.remove()
        }
      } catch (err) {
        showError(err)
        setStatus(readableError(err), "bad")
      }
    },
    [octopus, requirementId, resolveNodeWorkspace, setStatus],
  )

  const loadNodeDetails = useCallback(
    async (nodeId: string, graphNodes: GraphDisplayNode[], reqId: string) => {
      const node = graphNodes.find((item) => item.id === nodeId)
      if (!node) {
        setRuns([])
        setWorkspaceInfo(null)
        return
      }
      setAssignedTo(typeof node.assignedTo === "string" ? node.assignedTo : "")
      const activated = node.activated !== false
      try {
        const nextRuns = activated ? await octopus.runs(reqId, nodeId) : []
        setRuns(nextRuns)
      } catch {
        setRuns([])
      }
      try {
        setWorkspaceInfo(await resolveNodeWorkspace(nodeId))
      } catch {
        const root = typeof state?.projectRoot === "string" ? state.projectRoot : ""
        setWorkspaceInfo(
          root
            ? { nodeKey: nodeId, path: `${root}/workflow/nodes/${nodeId}`, exists: false }
            : null,
        )
      }
    },
    [octopus, resolveNodeWorkspace, state?.projectRoot],
  )

  const loadWorkspace = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const [nextState, nextSnapshot] = await Promise.all([
        octopus.getState(requirementId),
        octopus.getExecutionSnapshot(requirementId),
      ])
      if (seq !== loadSeq.current) return

      let nextDefinition: Parameters<typeof buildWorkflowGraphNodes>[1]
      try {
        nextDefinition = (await octopus.getWorkflowDefinition?.(requirementId)) as
          | Parameters<typeof buildWorkflowGraphNodes>[1]
          | undefined
      } catch {
        nextDefinition = undefined
      }
      if (seq !== loadSeq.current) return

      const graphNodes = buildWorkflowGraphNodes(nextState, nextDefinition)
      setState(nextState)
      setSnapshot(nextSnapshot)
      setNodes(graphNodes)
      onProjectKnown?.(nextState.projectId)
      setOwner(typeof nextState.owner === "string" ? nextState.owner : "")

      const tb = asRecord(nextState.teambition)
      const taskRef = typeof tb?.taskRef === "string" ? tb.taskRef : typeof tb?.taskId === "string" ? tb.taskId : ""
      setTbTaskRef((prev) => (prev ? prev : taskRef))
      if (typeof tb?.statusId === "string") setTbStatusId(tb.statusId)

      const versionBinding = asRecord(nextState.teambitionVersion)
      if (typeof versionBinding?.versionId === "string") {
        setVersionId(versionBinding.versionId)
      }

      try {
        const summaries = await octopus.listRequirementSummaries(nextState.projectId)
        if (seq !== loadSeq.current) return
        setRequirements(summaries)
      } catch {
        setRequirements([])
      }

      try {
        const list = (await octopus.listMilestones(requirementId)) as Array<
          WorkspaceMilestone & { reached?: boolean }
        >
        if (seq !== loadSeq.current) return
        setMilestones(
          list.map((item) => ({
            id: item.id,
            name: item.name,
            date: item.date,
            status: item.status === "reached" || item.reached ? "reached" : "planned",
            ...(item.phase ? { phase: item.phase } : {}),
            ...(item.nodeId ? { nodeId: item.nodeId } : {}),
            ...(item.note ? { note: item.note } : {}),
          })),
        )
      } catch {
        setMilestones([])
      }

      try {
        const versionList = (await octopus.listProjectVersions(nextState.projectId)) as ProjectVersion[]
        if (seq !== loadSeq.current) return
        setVersions(
          versionList
            .map((item) => ({
              versionId: String(item.versionId || ""),
              name: String(item.name || item.versionId || ""),
            }))
            .filter((item) => item.versionId),
        )
      } catch {
        setVersions([])
      }

      try {
        const statuses = await octopus.listTeambitionCardStatuses(nextState.projectId)
        if (seq !== loadSeq.current) return
        setTbStatuses(statuses)
      } catch {
        // credentials may be missing; surface on button actions
      }

      const scheduler = String(nextSnapshot.schedulerStatus || "IDLE")
      setStatus(
        `调度：${schedulerLabel(scheduler)}`,
        scheduler === "BLOCKED"
          ? "bad"
          : scheduler === "COMPLETED"
            ? "good"
            : scheduler === "RUNNING"
              ? "info"
              : "warn",
      )
      setLastUpdate(`更新于 ${new Date().toLocaleTimeString("zh-CN")}`)
      setError(null)
      setLoading(false)

      const keepSelected = selectedNodeIdRef.current
      if (keepSelected && graphNodes.some((node) => node.id === keepSelected)) {
        await loadNodeDetails(keepSelected, graphNodes, requirementId)
      }
    } catch (err) {
      if (seq !== loadSeq.current) return
      const message = readableError(err)
      setError(message)
      setStatus(message, "bad")
      setLoading(false)
    }
  }, [loadNodeDetails, octopus, requirementId, setStatus])

  useEffect(() => {
    setLoading(true)
    setSelectedNodeId(null)
    setRuns([])
    setWorkspaceInfo(null)
    void loadWorkspace()
  }, [loadWorkspace])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadWorkspace()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [loadWorkspace])

  useEffect(() => {
    const pref = preferredMetaCollapsed()
    if (isCompact) {
      setMetaCollapsed(pref === null ? true : pref)
    } else if (pref !== null) {
      setMetaCollapsed(pref)
    } else {
      setMetaCollapsed(false)
    }
  }, [isCompact])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (isFullscreen) {
        void toggleFullscreen(false)
        return
      }
      if (isCompact) {
        setSidebarSheetOpen(false)
        setInspectorSheetOpen(false)
        setSidebarCollapsed(true, false)
        setInspectorCollapsed(true, false)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // toggleFullscreen declared below; effect rebinds when isCompact/fullscreen/panels change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompact, isFullscreen, setInspectorCollapsed, setSidebarCollapsed])

  useEffect(() => {
    const onFs = () => {
      setIsFullscreen(Boolean(document.fullscreenElement))
    }
    document.addEventListener("fullscreenchange", onFs)
    return () => document.removeEventListener("fullscreenchange", onFs)
  }, [])

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  )

  const metrics = useMemo(() => {
    const activeRuns = Array.isArray(snapshot.activeRuns) ? snapshot.activeRuns.length : 0
    const ready = snapshot.readyNodeIds?.length ?? 0
    const waiting = snapshot.waitingNodeIds?.length ?? 0
    const completed = (state?.steps || []).filter((step) => step.status === "COMPLETED").length
    const total = nodes.length || (state?.steps || []).length
    const blocked = (state?.steps || []).filter((step) => step.status === "BLOCKED").length
    return { activeRuns, ready, waiting, completed, total, blocked }
  }, [nodes.length, snapshot, state?.steps])

  const tbLabel = useMemo(() => {
    const tb = asRecord(state?.teambition)
    if (!tb?.taskId && !tb?.taskRef) return "Teambition 任务未绑定"
    const ref = String(tb.taskRef || tb.taskId || "")
    const statusName = typeof tb.statusName === "string" ? tb.statusName : ""
    return statusName ? `TB：${ref} · ${statusName}` : `TB：${ref}`
  }, [state?.teambition])

  const versionLabel = useMemo(() => {
    const binding = asRecord(state?.teambitionVersion)
    const name = typeof binding?.versionName === "string" ? binding.versionName : ""
    return name ? `版本：${name}` : "版本未绑定"
  }, [state?.teambitionVersion])

  const requirementTitle = useMemo(() => {
    const name =
      (typeof state?.requirementName === "string" && state.requirementName) ||
      requirements.find((item) => item.requirementId === requirementId)?.requirementName ||
      requirementId
    return `${name} · ${phaseLabel(state?.currentPhase)}`
  }, [requirementId, requirements, state?.currentPhase, state?.requirementName])

  const phaseHint = state?.currentPhase
    ? PHASE_HINTS[state.currentPhase as keyof typeof PHASE_HINTS] || ""
    : ""

  const selectNode = useCallback(
    async (nodeId: string) => {
      setSelectedNodeId(nodeId)
      if (isCompact) setInspectorSheetOpen(true)
      else setInspectorCollapsed(false)
      await loadNodeDetails(nodeId, nodes, requirementId)
    },
    [isCompact, loadNodeDetails, nodes, requirementId, setInspectorCollapsed],
  )

  const applyZoom = useCallback((next: number, anchor?: { clientX: number; clientY: number }) => {
    setZoom((before) => {
      const clamped = Math.min(5, Math.max(0.2, Math.round(next * 100) / 100))
      if (clamped === before) return before
      const wrap = graphHostRef.current?.querySelector(".wf-graph-wrap") as HTMLElement | null
      if (wrap && anchor && before > 0) {
        const rect = wrap.getBoundingClientRect()
        const offsetX = anchor.clientX - rect.left + wrap.scrollLeft
        const offsetY = anchor.clientY - rect.top + wrap.scrollTop
        const ratio = clamped / before
        requestAnimationFrame(() => {
          wrap.scrollLeft = offsetX * ratio - (anchor.clientX - rect.left)
          wrap.scrollTop = offsetY * ratio - (anchor.clientY - rect.top)
        })
      }
      return clamped
    })
  }, [])

  useEffect(() => {
    const host = graphHostRef.current
    if (!host) return
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const intensity = Math.min(0.35, Math.abs(event.deltaY) / 240)
      const direction = event.deltaY > 0 ? -1 : 1
      applyZoom(
        direction > 0
          ? zoom * (1 + Math.max(0.08, intensity))
          : zoom / (1 + Math.max(0.08, intensity)),
        { clientX: event.clientX, clientY: event.clientY },
      )
    }
    host.addEventListener("wheel", onWheel, { passive: false })
    return () => host.removeEventListener("wheel", onWheel)
  }, [applyZoom, zoom])

  async function toggleFullscreen(force?: boolean) {
    const target = contentRef.current
    if (!target) return
    const active = Boolean(document.fullscreenElement) || target.classList.contains("is-expanded")
    const next = force === undefined ? !active : force
    try {
      if (!next) {
        if (document.fullscreenElement) await document.exitFullscreen()
        target.classList.remove("is-expanded")
        document.body.classList.remove("graph-expanded")
        setIsFullscreen(false)
        return
      }
      try {
        await target.requestFullscreen()
        setIsFullscreen(true)
      } catch {
        target.classList.add("is-expanded")
        document.body.classList.add("graph-expanded")
        setIsFullscreen(true)
      }
    } catch (err) {
      showError(err)
    }
  }

  async function runWorkflow() {
    try {
      await octopus.runWorkflow(requirementId)
      showSuccess("已启动可运行节点")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function runHealth() {
    try {
      const result = await octopus.health()
      showMessage(typeof result === "string" ? result : "健康检查完成", "info")
      setStatus("健康检查完成", "info")
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function exportTasks() {
    try {
      const result = asRecord(await octopus.exportTasks(requirementId))
      if (result?.canceled) {
        setStatus("已取消导出", "warn")
        return
      }
      setStatus(`已导出 ${String(result?.taskCount ?? "")} 个任务`, "good")
      showSuccess("任务已导出")
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function importTasks() {
    try {
      const result = asRecord(await octopus.importTasks(requirementId))
      if (result?.canceled) {
        setStatus("已取消导入", "warn")
        return
      }
      setStatus("任务已导入", "good")
      showSuccess("任务已导入")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function runSelected() {
    if (!selectedNodeId) return
    try {
      await octopus.runNode(requirementId, selectedNodeId, false)
      showSuccess("节点已启动")
      await loadWorkspace()
      await loadNodeDetails(selectedNodeId, nodes, requirementId)
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function completeSelected() {
    if (!selectedNodeId) return
    try {
      await octopus.completeNode(requirementId, selectedNodeId, false)
      showSuccess("节点已标记完成")
      await loadWorkspace()
      await loadNodeDetails(selectedNodeId, nodes, requirementId)
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function saveAssignedTo() {
    if (!selectedNodeId) return
    try {
      await octopus.assignNode(requirementId, selectedNodeId, assignedTo.trim() || null)
      showSuccess("节点负责人已保存")
      setStatus("节点负责人已保存", "good")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function copyNodePath() {
    if (!selectedNodeId) return
    try {
      const info = await resolveNodeWorkspace(selectedNodeId)
      if (!info.path) throw new Error("未配置源码根目录")
      await navigator.clipboard.writeText(info.path)
      setStatus(`已复制：${info.path}`, "info")
      showSuccess("路径已复制")
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function retryRun(runId: string) {
    try {
      await octopus.retryRun(requirementId, runId)
      await loadWorkspace()
      if (selectedNodeId) await loadNodeDetails(selectedNodeId, nodes, requirementId)
    } catch (err) {
      showError(err)
    }
  }

  async function cancelRun(runId: string) {
    try {
      await octopus.cancelRun(requirementId, runId)
      await loadWorkspace()
      if (selectedNodeId) await loadNodeDetails(selectedNodeId, nodes, requirementId)
    } catch (err) {
      showError(err)
    }
  }

  async function bindTb() {
    const raw = tbTaskRef.trim()
    if (!raw) {
      setStatus("请填写任务编号或 ID", "warn")
      return
    }
    try {
      const opts =
        raw.includes("-") || /[A-Za-z]/.test(raw)
          ? { taskRef: raw }
          : { taskId: raw, taskRef: raw }
      await octopus.bindRequirementTask(requirementId, opts)
      showSuccess("已绑定 Teambition 任务")
      setStatus("已绑定 Teambition 任务", "good")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function unbindTb() {
    try {
      await octopus.unbindRequirementTask(requirementId)
      setTbTaskRef("")
      showSuccess("已解除任务绑定")
      setStatus("已解除任务绑定", "good")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function refreshTbStatus() {
    try {
      const binding = asRecord(await octopus.getRequirementTeambitionStatus(requirementId))
      const name = typeof binding?.statusName === "string" ? binding.statusName : ""
      setStatus(name ? `状态已刷新：${name}` : "状态已刷新", "good")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function updateTbStatus() {
    if (!tbStatusId) {
      setStatus("请选择要更新的状态", "warn")
      return
    }
    try {
      await octopus.updateRequirementTeambitionStatus(requirementId, tbStatusId)
      showSuccess("Teambition 状态已更新")
      setStatus("Teambition 状态已更新", "good")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function bindVersion() {
    if (!versionId) return
    try {
      await octopus.bindRequirementVersion(requirementId, versionId)
      showSuccess("需求版本已绑定")
      setStatus("需求版本已绑定", "good")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function unbindVersion() {
    try {
      await octopus.unbindRequirementVersion(requirementId)
      setVersionId("")
      showSuccess("需求版本已解绑")
      setStatus("需求版本已解绑", "good")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function saveOwner() {
    try {
      await octopus.updateRequirement(requirementId, { owner: owner.trim() || null })
      showSuccess("需求负责人已保存")
      setStatus("需求负责人已保存", "good")
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  function openMilestoneForm(item?: WorkspaceMilestone) {
    if (metaCollapsed) {
      setMetaCollapsed(false)
      persistMetaCollapsed(false)
    }
    setMilestoneForm(
      item
        ? {
            id: item.id,
            name: item.name,
            date: item.date,
            phase: item.phase || "",
            nodeId: item.nodeId || "",
            note: item.note || "",
          }
        : emptyMilestoneForm(),
    )
    setMilestoneFormOpen(true)
  }

  async function submitMilestone(event: FormEvent) {
    event.preventDefault()
    const payload: Record<string, unknown> = {
      name: milestoneForm.name.trim(),
      date: milestoneForm.date,
    }
    if (milestoneForm.phase) payload.phase = milestoneForm.phase
    else if (milestoneForm.id) payload.phase = null
    if (milestoneForm.nodeId) payload.nodeId = milestoneForm.nodeId
    else if (milestoneForm.id) payload.nodeId = null
    if (milestoneForm.note) payload.note = milestoneForm.note
    else if (milestoneForm.id) payload.note = null
    try {
      if (milestoneForm.id) {
        await octopus.updateMilestone(requirementId, milestoneForm.id, payload)
        setStatus("里程碑已更新", "good")
      } else {
        await octopus.addMilestone(requirementId, payload)
        setStatus("里程碑已添加", "good")
      }
      setMilestoneFormOpen(false)
      setMilestoneForm(emptyMilestoneForm())
      await loadWorkspace()
    } catch (err) {
      showError(err)
      setStatus(readableError(err), "bad")
    }
  }

  async function reachMilestone() {
    if (!milestoneForm.id) return
    try {
      await octopus.reachMilestone(requirementId, milestoneForm.id)
      setStatus("已标记达成（不会改变需求阶段）", "good")
      setMilestoneFormOpen(false)
      await loadWorkspace()
    } catch (err) {
      showError(err)
    }
  }

  async function unreachMilestone() {
    if (!milestoneForm.id) return
    try {
      await octopus.unreachMilestone(requirementId, milestoneForm.id)
      setStatus("已取消达成", "good")
      setMilestoneFormOpen(false)
      await loadWorkspace()
    } catch (err) {
      showError(err)
    }
  }

  async function deleteMilestone() {
    if (!milestoneForm.id) return
    const ok = await confirmAction(
      `删除里程碑「${milestoneForm.name || milestoneForm.id}」？此操作不可恢复。`,
      "删除里程碑",
      "error",
    )
    if (!ok) return
    try {
      await octopus.deleteMilestone(requirementId, milestoneForm.id)
      setStatus("里程碑已删除", "good")
      setMilestoneFormOpen(false)
      await loadWorkspace()
    } catch (err) {
      showError(err)
    }
  }

  const plannedMilestones = milestones.filter((item) => item.status === "planned")
  const reachedMilestones = milestones.filter((item) => item.status === "reached")
  const visibleMilestones = showReachedMilestones
    ? [...plannedMilestones, ...reachedMilestones]
    : plannedMilestones.slice(0, 3)
  const extraMilestones =
    !showReachedMilestones && plannedMilestones.length > 3 ? plannedMilestones.length - 3 : 0
  const today = todayYmd()

  const sidebarBody = (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      <div className="flex flex-col gap-2">
        <Button variant="secondary" size="sm" onClick={goProject}>
          返回项目
        </Button>
        <Button variant="outline" size="sm" onClick={goHub}>
          全部项目
        </Button>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">需求列表</h3>
        <RequirementList
          requirements={requirements}
          selectedId={requirementId}
          onSelect={navigateRequirement}
        />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">使用说明</h3>
        <HelpGuide />
      </div>
    </div>
  )

  const inspectorBody = (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4">
      <h2 className="text-base font-semibold">节点详情</h2>
      {!selectedNode ? (
        <p className="text-sm text-muted-foreground">
          点击泳道图中的节点，可查看中英文说明、负责角色、依赖关系，打开脚本目录，并执行运行 / 手动完成等操作。
        </p>
      ) : (
        <NodeInspector
          node={selectedNode}
          nodes={nodes}
          snapshot={snapshot}
          runs={runs}
          workspaceInfo={workspaceInfo}
          assignedTo={assignedTo}
          onAssignedToChange={setAssignedTo}
          onSaveAssignedTo={() => void saveAssignedTo()}
          onRun={() => void runSelected()}
          onComplete={() => void completeSelected()}
          onOpenDirectory={() => void openNodeDirectory(selectedNode.id)}
          onCopyPath={() => void copyNodePath()}
          onRetry={(runId) => void retryRun(runId)}
          onCancel={(runId) => void cancelRun(runId)}
        />
      )}
    </div>
  )

  const showSidebarColumn = !isCompact && !sidebarCollapsed
  const showInspectorColumn = !isCompact && !inspectorCollapsed

  return (
    <div
      className={cn(
        "workspace-view relative grid min-h-0 flex-1",
        isCompact
          ? "grid-cols-1"
          : cn(
              showSidebarColumn && showInspectorColumn && "grid-cols-[minmax(250px,280px)_minmax(0,1fr)_minmax(300px,340px)]",
              showSidebarColumn && !showInspectorColumn && "grid-cols-[minmax(250px,280px)_minmax(0,1fr)]",
              !showSidebarColumn && showInspectorColumn && "grid-cols-[minmax(0,1fr)_minmax(300px,340px)]",
              !showSidebarColumn && !showInspectorColumn && "grid-cols-1",
            ),
      )}
    >
      {showSidebarColumn ? (
        <aside className="min-h-0 overflow-hidden border-r bg-card">{sidebarBody}</aside>
      ) : null}

      <section
        ref={contentRef}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-muted/30",
          isFullscreen && "is-expanded",
        )}
      >
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          className="panel-rail left absolute top-1/2 left-0 z-20 -translate-y-1/2 rounded-l-none"
          title={isCompact || sidebarCollapsed ? "展开左侧需求栏" : "收起左侧需求栏"}
          aria-pressed={isCompact ? sidebarSheetOpen : !sidebarCollapsed}
          onClick={() => {
            if (isCompact) setSidebarSheetOpen(true)
            else toggleSidebar()
          }}
        >
          {isCompact || sidebarCollapsed ? "›" : "‹"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          className="panel-rail right absolute top-1/2 right-0 z-20 -translate-y-1/2 rounded-r-none"
          title={isCompact || inspectorCollapsed ? "展开右侧详情栏" : "收起右侧详情栏"}
          aria-pressed={isCompact ? inspectorSheetOpen : !inspectorCollapsed}
          onClick={() => {
            if (isCompact) setInspectorSheetOpen(true)
            else toggleInspector()
          }}
        >
          {isCompact || inspectorCollapsed ? "‹" : "›"}
        </Button>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3 pt-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold">{requirementTitle}</h1>
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </div>
            <Badge
              variant={
                statusTone === "bad"
                  ? "destructive"
                  : statusTone === "good"
                    ? "default"
                    : "secondary"
              }
            >
              {statusText}
            </Badge>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 justify-between px-2"
            aria-expanded={!metaCollapsed}
            onClick={() => {
              const next = !metaCollapsed
              setMetaCollapsed(next)
              persistMetaCollapsed(next)
            }}
          >
            <span>绑定、负责人与里程碑</span>
            <span className="text-muted-foreground">{metaCollapsed ? "展开" : "收起"}</span>
          </Button>

          {!metaCollapsed ? (
            <div className="space-y-2 rounded-lg border bg-card p-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{tbLabel}</span>
                <Input
                  className="h-8 w-40"
                  value={tbTaskRef}
                  placeholder="任务编号或 ID"
                  onChange={(event) => setTbTaskRef(event.target.value)}
                />
                <Button size="sm" onClick={() => void bindTb()}>
                  绑定任务
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void unbindTb()}>
                  解绑
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void refreshTbStatus()}>
                  刷新状态
                </Button>
                <Select
                  {...(tbStatusId ? { value: tbStatusId } : {})}
                  onValueChange={setTbStatusId}
                >
                  <SelectTrigger size="sm" className="w-40">
                    <SelectValue placeholder="选择状态…" />
                  </SelectTrigger>
                  <SelectContent>
                    {tbStatuses.map((item) => {
                      const id = String(item.statusId || item.id || "")
                      const name = String(item.statusName || item.name || id)
                      if (!id) return null
                      return (
                        <SelectItem key={id} value={id}>
                          {name}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="secondary" onClick={() => void updateTbStatus()}>
                  改状态
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{versionLabel}</span>
                <Select
                  {...(versionId ? { value: versionId } : {})}
                  onValueChange={setVersionId}
                >
                  <SelectTrigger size="sm" className="w-44">
                    <SelectValue placeholder="选择版本…" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((item) => (
                      <SelectItem key={item.versionId} value={item.versionId}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" onClick={() => void bindVersion()}>
                  绑定版本
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void unbindVersion()}>
                  解绑
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">需求负责人</span>
                <Input
                  className="h-8 w-40"
                  value={owner}
                  placeholder="未设置"
                  onChange={(event) => setOwner(event.target.value)}
                />
                <Button size="sm" variant="secondary" onClick={() => void saveOwner()}>
                  保存负责人
                </Button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">里程碑</span>
                <div className="flex flex-wrap gap-1">
                  {visibleMilestones.map((item) => {
                    const overdue = item.status === "planned" && item.date < today
                    return (
                      <Button
                        key={item.id}
                        type="button"
                        size="xs"
                        variant={overdue ? "destructive" : "outline"}
                        onClick={() => openMilestoneForm(item)}
                      >
                        {item.name} {formatMilestoneDate(item.date)}
                        {overdue ? "（逾期）" : item.status === "reached" ? "（已达成）" : ""}
                      </Button>
                    )
                  })}
                  {!milestones.length ? (
                    <span className="text-xs text-muted-foreground">尚未添加</span>
                  ) : null}
                  {extraMilestones > 0 ? (
                    <span className="text-xs text-muted-foreground">还有 {extraMilestones} 个</span>
                  ) : null}
                </div>
                {reachedMilestones.length ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setShowReachedMilestones((value) => !value)}
                  >
                    {showReachedMilestones ? "收起已达成" : `已达成 ${reachedMilestones.length}`}
                  </Button>
                ) : null}
                <Button size="sm" variant="secondary" onClick={() => openMilestoneForm()}>
                  + 添加
                </Button>
              </div>

              {milestoneFormOpen ? (
                <form className="grid gap-2 rounded-md border p-2 md:grid-cols-2" onSubmit={(event) => void submitMilestone(event)}>
                  <div className="space-y-1">
                    <Label htmlFor="milestoneName">名称</Label>
                    <Input
                      id="milestoneName"
                      required
                      maxLength={80}
                      value={milestoneForm.name}
                      onChange={(event) =>
                        setMilestoneForm((prev) => ({ ...prev, name: event.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="milestoneDate">日期</Label>
                    <Input
                      id="milestoneDate"
                      type="date"
                      required
                      value={milestoneForm.date}
                      onChange={(event) =>
                        setMilestoneForm((prev) => ({ ...prev, date: event.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>挂钩阶段（可选）</Label>
                    <Select
                      value={milestoneForm.phase || "__none__"}
                      onValueChange={(value) =>
                        setMilestoneForm((prev) => ({
                          ...prev,
                          phase: value === "__none__" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger size="sm">
                        <SelectValue placeholder="不挂钩" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">不挂钩</SelectItem>
                        {PHASE_ORDER.map((phase) => (
                          <SelectItem key={phase} value={phase}>
                            {phaseLabel(phase)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label>挂钩节点（可选）</Label>
                    <Select
                      value={milestoneForm.nodeId || "__none__"}
                      onValueChange={(value) =>
                        setMilestoneForm((prev) => ({
                          ...prev,
                          nodeId: value === "__none__" ? "" : value,
                        }))
                      }
                    >
                      <SelectTrigger size="sm">
                        <SelectValue placeholder="不挂钩" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">不挂钩</SelectItem>
                        {(state?.steps || []).map((step) => (
                          <SelectItem key={step.id} value={step.id}>
                            {step.name || step.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1 md:col-span-2">
                    <Label htmlFor="milestoneNote">备注（可选）</Label>
                    <Input
                      id="milestoneNote"
                      maxLength={500}
                      value={milestoneForm.note}
                      placeholder="不会改变需求阶段"
                      onChange={(event) =>
                        setMilestoneForm((prev) => ({ ...prev, note: event.target.value }))
                      }
                    />
                  </div>
                  <div className="flex flex-wrap gap-2 md:col-span-2">
                    <Button type="submit" size="sm">
                      保存
                    </Button>
                    {milestoneForm.id && milestoneForm.id && milestones.find((m) => m.id === milestoneForm.id)?.status !== "reached" ? (
                      <Button type="button" size="sm" variant="secondary" onClick={() => void reachMilestone()}>
                        标记达成
                      </Button>
                    ) : null}
                    {milestones.find((m) => m.id === milestoneForm.id)?.status === "reached" ? (
                      <Button type="button" size="sm" variant="secondary" onClick={() => void unreachMilestone()}>
                        取消达成
                      </Button>
                    ) : null}
                    {milestoneForm.id ? (
                      <Button type="button" size="sm" variant="destructive" onClick={() => void deleteMilestone()}>
                        删除
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setMilestoneFormOpen(false)
                        setMilestoneForm(emptyMilestoneForm())
                      }}
                    >
                      取消
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground md:col-span-2">
                    标记达成不会改变需求阶段。
                  </p>
                </form>
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void runWorkflow()} title="并行启动所有依赖已满足的节点">
              ▶ 运行可运行节点
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void runHealth()}>
              健康检查
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void exportTasks()}>
              导出任务
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void importTasks()}>
              导入任务
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void loadWorkspace()}>
              刷新
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-pressed={isFullscreen}
              onClick={() => void toggleFullscreen()}
            >
              {isFullscreen ? "⛶ 退出全屏" : "⛶ 全屏"}
            </Button>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="secondary" aria-label="缩小" onClick={() => applyZoom(zoom / 1.15)}>
                −
              </Button>
              <span className="min-w-12 text-center text-xs text-muted-foreground">
                {Math.round(zoom * 100)}%
              </span>
              <Button size="sm" variant="secondary" aria-label="放大" onClick={() => applyZoom(zoom * 1.15)}>
                +
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => applyZoom(typeof window !== "undefined" && window.innerWidth < 1100 ? 1 : 1.4)}
              >
                重置
              </Button>
            </div>
            <Select
              {...(selectedNodeId ? { value: selectedNodeId } : {})}
              onValueChange={(value) => void selectNode(value)}
              disabled={!nodes.length}
            >
              <SelectTrigger size="sm" className="min-w-56">
                <SelectValue placeholder={nodes.length ? `快速定位节点（${nodes.length}）` : "暂无可定位节点"} />
              </SelectTrigger>
              <SelectContent>
                {[...nodes]
                  .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                  .map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {node.id} · {nodeNameZh(node)} · {statusLabel(node.status)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <span className="ml-auto text-xs text-muted-foreground">{lastUpdate}</span>
          </div>

          <p className="text-xs text-muted-foreground">
            当前阶段：{phaseLabel(state?.currentPhase)}
            {phaseHint ? `（${phaseHint}）` : ""}
            （整行高亮）。上方=角色（人），左侧=阶段；灰色节点尚未激活，多角色显示在卡片底部；拖拽空白处平移，Ctrl/⌘+滚轮缩放。
          </p>

          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric value={metrics.activeRuns} label="活动运行" tip="正在执行的节点实例" />
            <Metric value={metrics.ready} label="可运行节点" tip="依赖已满足，可立即启动" />
            <Metric value={metrics.waiting} label="等待处理" tip="需手动完成或等待依赖" />
            <Metric
              value={`${metrics.completed}/${metrics.total}`}
              label="节点进度"
              tip={metrics.blocked ? `其中 ${metrics.blocked} 个已阻塞` : "完整需求流程节点"}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <LegendDot className="bg-primary" label="当前节点" />
            <LegendDot className="bg-sky-500" label="可运行" />
            <LegendDot className="bg-violet-500" label="进行中" />
            <LegendDot className="bg-emerald-500" label="已完成" />
            <LegendDot className="bg-amber-500" label="等待中" />
            <LegendDot className="bg-red-500" label="已阻塞" />
            <LegendDot className="bg-slate-400" label="未激活" />
            <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
              {nodes.length
                ? [...new Set(nodes.flatMap((node) => nodeRoles(node)))].map((role) => {
                    const color = ROLE_COLORS[role as keyof typeof ROLE_COLORS] || "#64748b"
                    return (
                      <span key={role} className="inline-flex items-center gap-1">
                        <span
                          className="inline-block size-2.5 rounded-sm"
                          style={{ background: color }}
                        />
                        {roleLabel(role)}（{role}）
                      </span>
                    )
                  })
                : "暂无角色列"}
            </span>
          </div>

          <div ref={graphHostRef} className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-[var(--graph-surface-inner)]">
            {loading && !state ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                加载工作区…
              </div>
            ) : (
              <WorkflowGraph
                nodes={nodes}
                snapshot={snapshot}
                selectedNodeId={selectedNodeId}
                zoom={zoom}
                {...(state?.currentPhase ? { currentPhase: state.currentPhase } : {})}
                onSelectNode={(nodeId) => void selectNode(nodeId)}
                onOpenDirectory={(nodeId) => void openNodeDirectory(nodeId)}
              />
            )}
          </div>
        </div>
      </section>

      {showInspectorColumn ? (
        <aside className="min-h-0 overflow-hidden border-l bg-card">{inspectorBody}</aside>
      ) : null}

      {isCompact ? (
        <>
          <Sheet open={sidebarSheetOpen} onOpenChange={setSidebarSheetOpen}>
            <SheetContent side="left" className="w-[min(92vw,320px)] p-0 sm:max-w-sm">
              <SheetHeader className="sr-only">
                <SheetTitle>需求列表</SheetTitle>
                <SheetDescription>切换需求或返回项目</SheetDescription>
              </SheetHeader>
              {sidebarBody}
            </SheetContent>
          </Sheet>
          <Sheet open={inspectorSheetOpen} onOpenChange={setInspectorSheetOpen}>
            <SheetContent side="right" className="w-[min(92vw,360px)] p-0 sm:max-w-md">
              <SheetHeader className="sr-only">
                <SheetTitle>节点详情</SheetTitle>
                <SheetDescription>查看并操作选中节点</SheetDescription>
              </SheetHeader>
              {inspectorBody}
            </SheetContent>
          </Sheet>
        </>
      ) : null}
    </div>
  )
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn("inline-block size-2.5 rounded-full", className)} />
      {label}
    </span>
  )
}

function NodeInspector({
  node,
  nodes,
  snapshot,
  runs,
  workspaceInfo,
  assignedTo,
  onAssignedToChange,
  onSaveAssignedTo,
  onRun,
  onComplete,
  onOpenDirectory,
  onCopyPath,
  onRetry,
  onCancel,
}: {
  node: GraphDisplayNode
  nodes: GraphDisplayNode[]
  snapshot: ExecutionSnapshot
  runs: RunRecord[]
  workspaceInfo: NodeWorkspaceInfo | null
  assignedTo: string
  onAssignedToChange: (value: string) => void
  onSaveAssignedTo: () => void
  onRun: () => void
  onComplete: () => void
  onOpenDirectory: () => void
  onCopyPath: () => void
  onRetry: (runId: string) => void
  onCancel: (runId: string) => void
}) {
  const activated = node.activated !== false
  const roles = nodeRoles(node)
  const zhName = nodeNameZh(node)
  const zhDesc = nodeDescZh(node)
  const englishDesc =
    node.description && node.description !== zhDesc ? String(node.description) : ""
  const isReady = Boolean(snapshot.readyNodeIds?.includes(node.id))
  const isWaiting = Boolean(snapshot.waitingNodeIds?.includes(node.id))
  const current = Boolean(snapshot.currentNodeIds?.includes(node.id))
  const deps =
    (node.dependsOn || []).length > 0
      ? (node.dependsOn || [])
          .map((id) => {
            const dep = nodes.find((item) => item.id === id)
            return dep ? nodeNameZh(dep) : id
          })
          .join("、")
      : "无（起始节点）"
  const actions =
    (node.actions || [])
      .map((action) => actionLabel(action as Parameters<typeof actionLabel>[0]))
      .join("\n") || "未配置动作"

  return (
    <Card className="gap-3 py-4 shadow-none">
      <CardHeader className="px-4 pb-0">
        <CardTitle className="text-base">{zhName}</CardTitle>
        {node.name && node.name !== zhName ? (
          <p className="text-sm text-muted-foreground">{node.name}</p>
        ) : null}
        <p className="text-sm">{zhDesc}</p>
        {englishDesc ? <p className="text-xs text-muted-foreground">{englishDesc}</p> : null}
        <div className="flex flex-wrap gap-1 pt-1">
          {current ? <Badge>● 当前节点</Badge> : null}
          <Badge
            variant={
              node.status === "COMPLETED"
                ? "default"
                : node.status === "BLOCKED"
                  ? "destructive"
                  : "secondary"
            }
          >
            {statusLabel(node.status)}
            {isReady ? " · 可运行" : isWaiting ? " · 等待中" : ""}
          </Badge>
          <Badge variant="outline">{phaseLabel(node.phase)}</Badge>
          {roles.map((role, index) => (
            <Badge key={role} variant={index === 0 ? "secondary" : "outline"}>
              {index === 0 ? "负责：" : "参与："}
              {roleLabel(role)}
            </Badge>
          ))}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
          <dt className="text-muted-foreground">节点 ID</dt>
          <dd className="break-all">{node.id}</dd>
          <dt className="text-muted-foreground">英文 Key</dt>
          <dd className="break-all">{workspaceInfo?.nodeKey || "未知"}</dd>
          <dt className="text-muted-foreground">英文名称</dt>
          <dd>{node.name || "—"}</dd>
          <dt className="text-muted-foreground">依赖节点</dt>
          <dd>{deps}</dd>
          <dt className="text-muted-foreground">执行动作</dt>
          <dd className="whitespace-pre-wrap">{actions}</dd>
          {activated ? (
            <>
              <dt className="text-muted-foreground">节点负责人</dt>
              <dd className="flex gap-2">
                <Input
                  className="h-8"
                  value={assignedTo}
                  placeholder="未设置"
                  onChange={(event) => onAssignedToChange(event.target.value)}
                />
                <Button size="sm" variant="secondary" onClick={onSaveAssignedTo}>
                  保存
                </Button>
              </dd>
            </>
          ) : (
            <>
              <dt className="text-muted-foreground">激活条件</dt>
              <dd>推进到「{phaseLabel(node.phase)}」阶段后进入运行态</dd>
            </>
          )}
          <dt className="text-muted-foreground">脚本目录</dt>
          <dd className="break-all">
            <code className="text-xs">{workspaceInfo?.path || "未配置源码根目录"}</code>
            {workspaceInfo?.exists === false ? (
              <Badge variant="outline" className="ml-2">
                目录尚未创建
              </Badge>
            ) : null}
          </dd>
        </dl>

        <div className="flex flex-wrap gap-2">
          {activated ? (
            <>
              <Button size="sm" onClick={onRun}>
                ▶ 运行节点
              </Button>
              <Button size="sm" variant="secondary" onClick={onComplete}>
                ✓ 手动完成
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="secondary" onClick={onOpenDirectory}>
            打开脚本目录
          </Button>
          {workspaceInfo?.path ? (
            <Button size="sm" variant="secondary" onClick={onCopyPath}>
              复制路径
            </Button>
          ) : null}
        </div>

        <div>
          <div className="mb-2 font-medium">运行历史</div>
          {!runs.length ? (
            <p className="text-sm text-muted-foreground">
              {activated
                ? "暂无运行记录。点击「运行节点」开始执行。"
                : "节点尚未激活，暂无运行记录。"}
            </p>
          ) : (
            <div className="space-y-2">
              {runs.slice(0, 6).map((run) => {
                const id = runIdentity(run)
                const forced = Boolean((run as RunRecord & { forced?: boolean }).forced)
                const error = typeof run.error === "string" ? run.error : ""
                return (
                  <div key={id || JSON.stringify(run)} className="rounded-md border p-2">
                    <div className="mb-1 flex flex-wrap gap-1">
                      <Badge
                        variant={
                          run.status === "SUCCEEDED"
                            ? "default"
                            : run.status === "FAILED" || run.status === "TIMED_OUT"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {runStatusLabel(run.status)}
                      </Badge>
                      {forced ? <Badge variant="outline">强制执行</Badge> : null}
                    </div>
                    <div className="break-all font-mono text-xs text-muted-foreground">{id}</div>
                    {error ? <div className="mt-1 text-xs text-destructive">{error}</div> : null}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" onClick={() => onRetry(id)} disabled={!id}>
                        重试
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => onCancel(id)}
                        disabled={!id}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
