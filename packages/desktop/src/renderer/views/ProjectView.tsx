import {
  BarChart3,
  ClipboardList,
  FileClock,
  FolderKanban,
  GanttChartSquare,
  LayoutDashboard,
  ListFilter,
  type LucideIcon,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Table2,
  Tags,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { showError, showSuccess, showWarning } from "@/lib/feedback"
import { getOctopus, type Project, type RequirementSummary, type TbStatus } from "@/lib/octopus"
import { cn } from "@/lib/utils"
import { GanttHost } from "@/visualizations/GanttHost"
import { KanbanBoard } from "./project/KanbanBoard"
import { ProjectLogs } from "./project/ProjectLogs"
import { ProjectOverviewPanel } from "./project/ProjectOverview"
import { ProjectSettings } from "./project/ProjectSettings"
import { ProjectVersions } from "./project/ProjectVersions"
import { RequirementTable } from "./project/RequirementTable"

const TAB_TITLES: Record<string, string> = {
  board: "看板",
  table: "表格",
  gantt: "甘特",
  versions: "版本",
  logs: "日志",
  overview: "概览",
  settings: "设置",
}

const PROJECT_TABS = [
  "board",
  "table",
  "gantt",
  "versions",
  "logs",
  "overview",
  "settings",
] as const

const PROJECT_TAB_ICONS: Record<(typeof PROJECT_TABS)[number], LucideIcon> = {
  board: LayoutDashboard,
  table: Table2,
  gantt: GanttChartSquare,
  versions: Tags,
  logs: FileClock,
  overview: BarChart3,
  settings: Settings,
}

export type ProjectViewProps = {
  projectId: string
  projectTab: string
}

function normalizeTab(tab: string): string {
  return tab === "list" ? "table" : tab
}

export function ProjectView({ projectId, projectTab }: ProjectViewProps) {
  const tab = normalizeTab(projectTab)
  const [project, setProject] = useState<Project | null>(null)
  const [requirements, setRequirements] = useState<RequirementSummary[]>([])
  const [tbStatuses, setTbStatuses] = useState<TbStatus[]>([])
  const [filter, setFilter] = useState("")
  const [lastCreatedId, setLastCreatedId] = useState("")
  const [loading, setLoading] = useState(true)
  const [reqName, setReqName] = useState("")
  const [reqDesc, setReqDesc] = useState("")
  const [reqRoot, setReqRoot] = useState("")
  const [createOpen, setCreateOpen] = useState(false)

  const wideLayout = tab === "logs" || tab === "table"
  const canCreateRequirement = !["settings", "versions", "logs", "table", "overview"].includes(tab)
  const showFilter = tab === "board" || tab === "table"

  const reload = useCallback(async () => {
    const api = getOctopus()
    const [nextProject, nextRequirements] = await Promise.all([
      api.getProject(projectId),
      api.listRequirementSummaries(projectId),
    ])
    setProject(nextProject)
    setRequirements(nextRequirements)
    const bound = Boolean(
      (nextProject.teambition as { projectId?: string } | undefined)?.projectId ||
        nextProject.teambitionProjectId,
    )
    if (bound) {
      try {
        setTbStatuses(await api.listTeambitionCardStatuses(projectId))
      } catch {
        setTbStatuses([])
      }
    } else {
      setTbStatuses([])
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        await reload()
      } catch (error) {
        if (!cancelled) showError(error)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reload])

  const setTab = (nextTab: string) => {
    const canonical = normalizeTab(nextTab)
    location.hash = `#project/${encodeURIComponent(projectId)}/${canonical}`
  }

  const ganttInput = useMemo(() => {
    if (tab !== "gantt") return null
    return {
      mode: "requirements" as const,
      requirements: requirements.map((item) => {
        const row: {
          id: string
          requirementId: string
          name?: string
          requirementName?: string
          phase?: string
          currentPhase?: string
          plannedStart?: string
          plannedEnd?: string
          owner?: string | null
          completedTasks?: number
          totalTasks?: number
          teambitionStatusName?: string
        } = {
          id: item.requirementId,
          requirementId: item.requirementId,
        }
        if (item.requirementName) {
          row.name = item.requirementName
          row.requirementName = item.requirementName
        }
        if (item.currentPhase) {
          row.phase = item.currentPhase
          row.currentPhase = item.currentPhase
        }
        if (item.plannedStart) row.plannedStart = item.plannedStart
        if (item.plannedEnd) row.plannedEnd = item.plannedEnd
        if (item.owner !== undefined) row.owner = item.owner
        if (item.completedTasks !== undefined) row.completedTasks = item.completedTasks
        if (item.totalTasks !== undefined) row.totalTasks = item.totalTasks
        if (item.teambitionStatusName) row.teambitionStatusName = item.teambitionStatusName
        return row
      }),
    }
  }, [tab, requirements])

  const ganttCallbacks = useMemo(
    () => ({
      onSchedule: async (
        id: string,
        schedule: { plannedStart?: string | null; plannedEnd?: string | null },
        kind?: string,
      ) => {
        try {
          if (kind === "requirement" || !kind) {
            await getOctopus().updateRequirementSchedule(id, schedule)
          }
          await reload()
        } catch (error) {
          showError(error)
        }
      },
      onSelectRequirement: (id: string) => {
        location.hash = `#requirement/${encodeURIComponent(id)}`
      },
      onExportOmniPlan: async () => {
        try {
          await getOctopus().exportProjectOmniPlan(projectId)
          showSuccess("已导出 OmniPlan")
        } catch (error) {
          showError(error)
        }
      },
      onImportOmniPlan: async () => {
        try {
          await getOctopus().importProjectOmniPlan(projectId)
          showSuccess("已导入 OmniPlan")
          await reload()
        } catch (error) {
          showError(error)
        }
      },
    }),
    [projectId, reload],
  )

  const title = project
    ? `${project.name || project.projectId} · ${TAB_TITLES[tab] || "看板"}`
    : "项目需求"

  const createRequirement = async () => {
    const name = reqName.trim()
    if (!name) {
      showWarning("请填写需求名称")
      return
    }
    try {
      const description = reqDesc.trim() || undefined
      const root = reqRoot.trim() || undefined
      const result = await getOctopus().initRequirement(projectId, name, description, root)
      setReqName("")
      setReqDesc("")
      setReqRoot("")
      setLastCreatedId(result.requirementId)
      setCreateOpen(false)
      await reload()
      showSuccess("需求已创建")
    } catch (error) {
      showError(error)
    }
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-slate-50/70 dark:bg-background">
      <div className="flex min-h-[64px] shrink-0 items-center justify-between gap-4 border-b bg-card px-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300">
            <FolderKanban className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{project?.name || projectId}</h2>
            <p className="truncate text-xs text-muted-foreground">
              {project?.description || "项目需求与交付流程"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden text-xs text-muted-foreground md:inline">
            {requirements.length} 个需求
          </span>
          {canCreateRequirement && !wideLayout ? (
            <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus />
              创建需求
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col border-r bg-card lg:flex">
          {showFilter ? (
            <div className="border-b p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  className="h-8 bg-muted/45 pl-8 text-xs"
                  placeholder="搜索名称、ID、描述或负责人"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
            </div>
          ) : null}
          <nav className="flex-1 p-3">
            <div className="mb-2 flex items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              <span>项目视图</span>
              <SlidersHorizontal className="size-3.5" />
            </div>
            <div className="space-y-1">
              {PROJECT_TABS.map((key) => {
                const Icon = PROJECT_TAB_ICONS[key]
                return (
                  <button
                    key={key}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      tab === key
                        ? "bg-sky-50 font-medium text-sky-700 dark:bg-sky-950/35 dark:text-sky-300"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                    onClick={() => setTab(key)}
                  >
                    <Icon className="size-4" />
                    <span>{TAB_TITLES[key]}</span>
                    {key === "board" ? (
                      <span className="ml-auto text-xs text-muted-foreground">
                        {requirements.length}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </nav>
          <div className="border-t p-4 text-xs leading-5 text-muted-foreground">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
              <ClipboardList className="size-4 text-primary" />
              工作流状态库
            </div>
            拖动卡片即可更新需求阶段。
          </div>
        </aside>

        <main className="min-w-0 flex-1 overflow-auto">
          <Tabs value={tab} onValueChange={setTab} className="min-h-full">
            <div className="flex min-h-[52px] items-center justify-between gap-3 border-b bg-card px-4 md:px-5">
              <div className="flex min-w-0 items-center gap-2">
                <ListFilter className="size-4 text-muted-foreground" />
                <h3 className="truncate text-sm font-semibold">{title}</h3>
              </div>
              {showFilter ? (
                <div className="relative hidden w-64 md:block lg:hidden xl:block">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="search"
                    className="h-8 pl-8 text-xs"
                    placeholder="按名称、ID、描述或负责人筛选"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </div>
              ) : null}
            </div>

            <TabsList className="m-3 flex h-auto justify-start overflow-x-auto lg:hidden">
              {PROJECT_TABS.map((key) => (
                <TabsTrigger key={key} value={key}>
                  {TAB_TITLES[key]}
                </TabsTrigger>
              ))}
            </TabsList>

            {loading ? (
              <p className="p-5 text-sm text-muted-foreground">加载项目…</p>
            ) : (
              <div className="p-3 md:p-4">
                <TabsContent value="board" className="mt-0">
                  <KanbanBoard
                    items={requirements}
                    filter={filter}
                    lastCreatedId={lastCreatedId}
                    tbStatuses={tbStatuses}
                    onReload={reload}
                  />
                </TabsContent>

                <TabsContent value="table" className="mt-0">
                  <RequirementTable items={requirements} filter={filter} onReload={reload} />
                </TabsContent>

                <TabsContent value="gantt" className="mt-0">
                  <GanttHost
                    mode="requirements"
                    className="w-full"
                    input={ganttInput}
                    callbacks={ganttCallbacks}
                  />
                </TabsContent>

                <TabsContent value="versions" className="mt-0">
                  <ProjectVersions
                    projectId={projectId}
                    project={project}
                    onProjectChange={setProject}
                  />
                </TabsContent>

                <TabsContent value="logs" className="mt-0">
                  <ProjectLogs projectId={projectId} requirements={requirements} />
                </TabsContent>

                <TabsContent value="overview" className="mt-0">
                  <ProjectOverviewPanel projectId={projectId} />
                </TabsContent>

                <TabsContent value="settings" className="mt-0">
                  {project ? (
                    <ProjectSettings
                      projectId={projectId}
                      project={project}
                      requirements={requirements}
                      onProjectChange={setProject}
                    />
                  ) : null}
                </TabsContent>
              </div>
            )}
          </Tabs>
        </main>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>创建需求</DialogTitle>
            <p className="text-sm text-muted-foreground">
              在源码根目录生成 <code>workflow.yaml</code>
              （已有文件不会覆盖），并写入该需求的工作流状态。
            </p>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="reqName">需求名称</Label>
              <Input
                id="reqName"
                placeholder="例如：支付页改版"
                value={reqName}
                onChange={(event) => setReqName(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="reqDesc">需求描述（可选）</Label>
              <Textarea
                id="reqDesc"
                placeholder="简要说明需求目标"
                value={reqDesc}
                onChange={(event) => setReqDesc(event.target.value)}
                rows={3}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="reqRoot">源码根目录（可选）</Label>
              <Input
                id="reqRoot"
                placeholder="默认使用当前仓库根目录"
                value={reqRoot}
                onChange={(event) => setReqRoot(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={() => void createRequirement()}>
              创建需求
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
