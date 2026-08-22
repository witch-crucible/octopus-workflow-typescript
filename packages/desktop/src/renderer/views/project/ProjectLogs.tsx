import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { readableError, showError } from "@/lib/feedback"
import { runStatusLabel } from "@/lib/labels"
import { getOctopus, type RequirementSummary } from "@/lib/octopus"
import { cn } from "@/lib/utils"

type LogRun = {
  id: string
  requirementId: string
  requirementName: string
  nodeId?: string
  status?: string
  forced?: boolean
  startedAt?: string
  finishedAt?: string
  heartbeatAt?: string
  error?: string
}

type LogSlice = {
  exists?: boolean
  content?: string
  size?: number
  truncated?: boolean
  nextOffset?: number
  offset?: number
}

type DetailTab = "stdout" | "stderr" | "events"

export type ProjectLogsProps = {
  projectId: string
  requirements: RequirementSummary[]
}

function formatLogsTime(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString("zh-CN")
}

function runKey(requirementId: string, runId: string): string {
  return `${requirementId}::${runId}`
}

function normalizeRun(raw: Record<string, unknown>, requirementName: string): LogRun | null {
  const id = String(raw.id ?? raw.runId ?? "")
  const requirementId = String(raw.requirementId ?? "")
  if (!id || !requirementId) return null
  return {
    id,
    requirementId,
    requirementName,
    ...(typeof raw.nodeId === "string" ? { nodeId: raw.nodeId } : {}),
    ...(typeof raw.status === "string" ? { status: raw.status } : {}),
    ...(typeof raw.forced === "boolean" ? { forced: raw.forced } : {}),
    ...(typeof raw.startedAt === "string" ? { startedAt: raw.startedAt } : {}),
    ...(typeof raw.finishedAt === "string" ? { finishedAt: raw.finishedAt } : {}),
    ...(typeof raw.heartbeatAt === "string" ? { heartbeatAt: raw.heartbeatAt } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
  }
}

export function ProjectLogs({ requirements }: ProjectLogsProps) {
  const [filterRequirementId, setFilterRequirementId] = useState("")
  const [filterNodeId, setFilterNodeId] = useState("")
  const [filterStatus, setFilterStatus] = useState("")
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [runs, setRuns] = useState<LogRun[]>([])
  const [selectedRequirementId, setSelectedRequirementId] = useState("")
  const [selectedRunId, setSelectedRunId] = useState("")
  const [detailTab, setDetailTab] = useState<DetailTab>("stdout")
  const [slice, setSlice] = useState<LogSlice | null>(null)
  const [events, setEvents] = useState<unknown[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const tokenRef = useRef(0)
  const consoleRef = useRef<HTMLPreElement | null>(null)
  const selectedRef = useRef({ requirementId: "", runId: "" })
  const detailTabRef = useRef<DetailTab>(detailTab)
  const filterRef = useRef({ requirementId: "", nodeId: "", status: "" })

  selectedRef.current = {
    requirementId: selectedRequirementId,
    runId: selectedRunId,
  }
  detailTabRef.current = detailTab
  filterRef.current = {
    requirementId: filterRequirementId,
    nodeId: filterNodeId,
    status: filterStatus,
  }

  const nameById = useMemo(
    () => new Map(requirements.map((item) => [item.requirementId, item.requirementName || item.requirementId])),
    [requirements],
  )

  const load = useCallback(
    async (silent = false) => {
      const token = ++tokenRef.current
      if (!silent) setLoading(true)
      const filters = filterRef.current
      const currentDetailTab = detailTabRef.current
      try {
        const api = getOctopus()
        const requirementIds = filters.requirementId
          ? [filters.requirementId]
          : requirements.map((item) => item.requirementId)
        const collected: LogRun[] = []
        for (const requirementId of requirementIds) {
          try {
            const list = await api.runs(requirementId)
            for (const entry of list || []) {
              const normalized = normalizeRun(
                entry as unknown as Record<string, unknown>,
                nameById.get(requirementId) || requirementId,
              )
              if (normalized) collected.push(normalized)
            }
          } catch {
            // 单个需求失败不阻断整页
          }
        }
        collected.sort((a, b) => {
          const aTime = Date.parse(a.startedAt || a.finishedAt || a.heartbeatAt || "") || 0
          const bTime = Date.parse(b.startedAt || b.finishedAt || b.heartbeatAt || "") || 0
          return bTime - aTime
        })
        if (token !== tokenRef.current) return

        const filtered = collected.filter((run) => {
          if (filters.nodeId && run.nodeId !== filters.nodeId) return false
          if (filters.status && run.status !== filters.status) return false
          return true
        })
        setRuns(filtered)

        let nextReq = selectedRef.current.requirementId
        let nextRun = selectedRef.current.runId
        if (nextRun) {
          const selected =
            filtered.find((run) => run.id === nextRun && (!nextReq || run.requirementId === nextReq)) ||
            collected.find((run) => run.id === nextRun)
          if (selected) {
            nextReq = selected.requirementId
            nextRun = selected.id
          } else if (!silent) {
            nextRun = ""
            nextReq = filters.requirementId || ""
          }
        }
        if (!nextRun && filtered[0]) {
          nextReq = filtered[0].requirementId
          nextRun = filtered[0].id
        }
        selectedRef.current = { requirementId: nextReq, runId: nextRun }
        setSelectedRequirementId(nextReq)
        setSelectedRunId(nextRun)

        const eventsRequirementId = nextReq || filters.requirementId
        const loadedEvents = eventsRequirementId ? await api.events(eventsRequirementId, 0) : []
        if (token !== tokenRef.current) return
        setEvents(Array.isArray(loadedEvents) ? loadedEvents : [])

        if (nextRun && nextReq && (currentDetailTab === "stdout" || currentDetailTab === "stderr")) {
          const nextSlice = (await api.readRunLogs(nextReq, nextRun, {
            stream: currentDetailTab,
            maxBytes: 262144,
          } as { offset?: number; limit?: number })) as LogSlice
          if (token !== tokenRef.current) return
          setSlice(nextSlice)
        } else {
          setSlice(null)
        }
        setError(null)
      } catch (err) {
        if (token !== tokenRef.current) return
        setError(readableError(err))
      } finally {
        if (token === tokenRef.current && !silent) setLoading(false)
      }
    },
    [nameById, requirements],
  )

  useEffect(() => {
    void load(false)
  }, [filterRequirementId, filterNodeId, filterStatus, detailTab, requirements, load])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      void load(true)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, load])

  const nodeIds = useMemo(
    () =>
      [...new Set(runs.map((run) => run.nodeId).filter((value): value is string => Boolean(value)))].sort(),
    [runs],
  )
  const statusIds = useMemo(
    () => [...new Set(runs.map((run) => run.status).filter((value): value is string => Boolean(value)))],
    [runs],
  )

  let detailBody: ReactNode
  if (!selectedRunId) {
    detailBody = <p className="text-sm text-muted-foreground">选择左侧运行记录以查看日志。</p>
  } else if (detailTab === "events") {
    detailBody =
      events.length === 0 ? (
        <p className="text-sm text-muted-foreground">该需求暂无执行事件。</p>
      ) : (
        <div className="space-y-2">
          {[...events].reverse().map((event, index) => {
            const item = event as {
              type?: string
              createdAt?: string
              nodeId?: string
              runId?: string
              payload?: unknown
            }
            return (
              <div key={`${item.runId || ""}-${index}`} className="rounded-md border p-2 text-xs">
                <div className="mb-1 flex flex-wrap gap-2">
                  <Badge variant="secondary">{item.type || "event"}</Badge>
                  <span className="text-muted-foreground">{formatLogsTime(item.createdAt)}</span>
                  {item.nodeId ? <span className="text-muted-foreground">{item.nodeId}</span> : null}
                  {item.runId ? <span className="text-muted-foreground">{item.runId}</span> : null}
                </div>
                <code className="whitespace-pre-wrap break-all">
                  {JSON.stringify(item.payload || {})}
                </code>
              </div>
            )
          })}
        </div>
      )
  } else if (!slice?.exists) {
    detailBody = <p className="text-sm text-muted-foreground">日志尚未产生。</p>
  } else {
    detailBody = (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {detailTab} · {slice.size ?? 0} 字节{slice.truncated ? " · 已截断，可加载更多" : ""}
        </p>
        <pre
          ref={consoleRef}
          className="max-h-[480px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words"
        >
          {slice.content || ""}
        </pre>
        <div className="flex gap-2">
          {slice.truncated ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                if (!selectedRequirementId || !selectedRunId || !slice) return
                void (async () => {
                  try {
                    const more = (await getOctopus().readRunLogs(selectedRequirementId, selectedRunId, {
                      stream: detailTab === "stderr" ? "stderr" : "stdout",
                      offset: slice.nextOffset,
                      maxBytes: 262144,
                    } as { offset?: number; limit?: number })) as LogSlice
                    setSlice({
                      ...more,
                      content: `${slice.content || ""}${more.content || ""}`,
                      ...(slice.offset !== undefined ? { offset: slice.offset } : {}),
                    })
                  } catch (err) {
                    showError(err)
                  }
                })()
              }}
            >
              加载更多
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              if (!selectedRequirementId || !selectedRunId) return
              void (async () => {
                try {
                  const api = getOctopus()
                  const probe = (await api.readRunLogs(selectedRequirementId, selectedRunId, {
                    stream: detailTab === "stderr" ? "stderr" : "stdout",
                    offset: 0,
                    maxBytes: 1,
                  } as { offset?: number; limit?: number })) as LogSlice
                  const start = Math.max(0, (probe.size ?? 0) - 262144)
                  const next = (await api.readRunLogs(selectedRequirementId, selectedRunId, {
                    stream: detailTab === "stderr" ? "stderr" : "stdout",
                    offset: start,
                    maxBytes: 262144,
                  } as { offset?: number; limit?: number })) as LogSlice
                  setSlice(next)
                  requestAnimationFrame(() => {
                    if (consoleRef.current) {
                      consoleRef.current.scrollTop = consoleRef.current.scrollHeight
                    }
                  })
                } catch (err) {
                  showError(err)
                }
              })()
            }}
          >
            跳到末尾
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Card className="logs-panel">
      <CardHeader>
        <CardTitle>日志监控</CardTitle>
        <p className="text-sm text-muted-foreground">
          聚合项目内节点运行记录与 stdout/stderr，支持按需求/节点筛选与自动刷新。
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label>需求</Label>
            <Select
              value={filterRequirementId || "__all__"}
              onValueChange={(value) => {
                setFilterRequirementId(value === "__all__" ? "" : value)
                setFilterNodeId("")
              }}
            >
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="全部需求" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部需求</SelectItem>
                {requirements.map((item) => (
                  <SelectItem key={item.requirementId} value={item.requirementId}>
                    {item.requirementName || item.requirementId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>节点</Label>
            <Select
              value={filterNodeId || "__all__"}
              onValueChange={(value) => setFilterNodeId(value === "__all__" ? "" : value)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="全部节点" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部节点</SelectItem>
                {nodeIds.map((nodeId) => (
                  <SelectItem key={nodeId} value={nodeId}>
                    {nodeId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>状态</Label>
            <Select
              value={filterStatus || "__all__"}
              onValueChange={(value) => setFilterStatus(value === "__all__" ? "" : value)}
            >
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="全部状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部状态</SelectItem>
                {statusIds.map((status) => (
                  <SelectItem key={status} value={status}>
                    {runStatusLabel(status)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-3 pb-1">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={autoRefresh}
                onCheckedChange={(checked) => setAutoRefresh(checked === true)}
              />
              自动刷新
            </label>
            <Button type="button" size="sm" variant="secondary" onClick={() => void load(false)}>
              刷新
            </Button>
          </div>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {loading ? <p className="text-sm text-muted-foreground">加载运行记录…</p> : null}

        <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
          <div>
            <div className="mb-2 text-sm font-medium">运行列表 · {runs.length}</div>
            <div className="max-h-[640px] space-y-2 overflow-auto">
              {runs.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  暂无匹配的运行记录。
                </div>
              ) : (
                runs.map((run) => {
                  const selected =
                    run.id === selectedRunId && run.requirementId === selectedRequirementId
                  const bad =
                    run.status === "FAILED" ||
                    run.status === "TIMED_OUT" ||
                    run.status === "INTERRUPTED"
                  return (
                    <button
                      key={runKey(run.requirementId, run.id)}
                      type="button"
                      className={cn(
                        "w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted/40",
                        selected && "border-primary bg-muted/50",
                      )}
                      onClick={() => {
                        selectedRef.current = {
                          requirementId: run.requirementId,
                          runId: run.id,
                        }
                        setSelectedRequirementId(run.requirementId)
                        setSelectedRunId(run.id)
                        void load(true)
                      }}
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <Badge variant={bad ? "destructive" : run.status === "SUCCEEDED" ? "default" : "secondary"}>
                          {runStatusLabel(run.status)}
                        </Badge>
                        {run.forced ? <Badge variant="outline">强制</Badge> : null}
                        <span className="text-xs text-muted-foreground">
                          {formatLogsTime(run.startedAt || run.finishedAt || run.heartbeatAt)}
                        </span>
                      </div>
                      <div className="text-sm font-medium whitespace-normal">
                        {run.requirementName || run.requirementId}
                      </div>
                      {run.nodeId ? (
                        <div className="text-xs text-muted-foreground">节点 · {run.nodeId}</div>
                      ) : null}
                      <div className="text-xs text-muted-foreground">{run.id}</div>
                      {run.error ? (
                        <div className="mt-1 text-xs text-destructive whitespace-normal">{run.error}</div>
                      ) : null}
                    </button>
                  )
                })
              )}
            </div>
          </div>
          <div>
            <div className="mb-2 text-sm font-medium">详情</div>
            {selectedRunId ? (
              <p className="mb-2 text-xs text-muted-foreground">{selectedRunId}</p>
            ) : null}
            <div className="mb-3 flex gap-2">
              {(["stdout", "stderr", "events"] as const).map((tab) => (
                <Button
                  key={tab}
                  type="button"
                  size="sm"
                  variant={detailTab === tab ? "default" : "secondary"}
                  onClick={() => setDetailTab(tab)}
                >
                  {tab === "events" ? "事件" : tab}
                </Button>
              ))}
            </div>
            {detailBody}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
