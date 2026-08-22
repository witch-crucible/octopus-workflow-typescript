import { useCallback, useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { showError, showSuccess, showWarning } from "@/lib/feedback"
import {
  getOctopus,
  type Project,
  type RequirementSummary,
  type TbStatus,
} from "@/lib/octopus"
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

  const wideLayout = tab === "logs" || tab === "table"
  const showCreateAside = !["settings", "versions", "logs", "table", "overview"].includes(tab)
  const showFilter = tab !== "logs"

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

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div
        className={cn(
          "grid min-h-0 flex-1 gap-4",
          wideLayout ? "grid-cols-1" : "lg:grid-cols-[minmax(0,1fr)_320px]",
        )}
      >
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold">{title}</h2>
            {showFilter ? (
              <Input
                type="search"
                className="max-w-sm"
                placeholder="按需求名称或 ID 筛选"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            ) : null}
          </div>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex h-auto flex-wrap">
              {PROJECT_TABS.map((key) => (
                <TabsTrigger key={key} value={key}>
                  {TAB_TITLES[key]}
                </TabsTrigger>
              ))}
            </TabsList>

            {loading ? (
              <p className="mt-4 text-sm text-muted-foreground">加载项目…</p>
            ) : (
              <>
                <TabsContent value="board" className="mt-4">
                  <KanbanBoard
                    items={requirements}
                    filter={filter}
                    lastCreatedId={lastCreatedId}
                    tbStatuses={tbStatuses}
                    onReload={reload}
                  />
                </TabsContent>

                <TabsContent value="table" className="mt-4">
                  <RequirementTable
                    items={requirements}
                    filter={filter}
                    onReload={reload}
                  />
                </TabsContent>

                <TabsContent value="gantt" className="mt-4">
                  <GanttHost
                    mode="requirements"
                    className="w-full"
                    input={ganttInput}
                    callbacks={ganttCallbacks}
                  />
                </TabsContent>

                <TabsContent value="versions" className="mt-4">
                  <ProjectVersions
                    projectId={projectId}
                    project={project}
                    onProjectChange={setProject}
                  />
                </TabsContent>

                <TabsContent value="logs" className="mt-4">
                  <ProjectLogs projectId={projectId} requirements={requirements} />
                </TabsContent>

                <TabsContent value="overview" className="mt-4">
                  <ProjectOverviewPanel projectId={projectId} />
                </TabsContent>

                <TabsContent value="settings" className="mt-4">
                  {project ? (
                    <ProjectSettings
                      projectId={projectId}
                      project={project}
                      requirements={requirements}
                      onProjectChange={setProject}
                    />
                  ) : null}
                </TabsContent>
              </>
            )}
          </Tabs>
        </div>

        {showCreateAside && !wideLayout ? (
          <aside>
            <Card>
              <CardHeader>
                <CardTitle>创建需求</CardTitle>
                <p className="text-sm text-muted-foreground">
                  在源码根目录生成 <code>workflow.yaml</code>
                  （已有文件不会覆盖），并写入该需求的工作流状态。
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
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
                <Button
                  type="button"
                  className="w-full"
                  onClick={() => {
                    const name = reqName.trim()
                    if (!name) {
                      showWarning("请填写需求名称")
                      return
                    }
                    void (async () => {
                      try {
                        const description = reqDesc.trim() || undefined
                        const root = reqRoot.trim() || undefined
                        const result = await getOctopus().initRequirement(
                          projectId,
                          name,
                          description,
                          root,
                        )
                        setReqName("")
                        setReqDesc("")
                        setReqRoot("")
                        setLastCreatedId(result.requirementId)
                        await reload()
                        showSuccess("需求已创建")
                      } catch (error) {
                        showError(error)
                      }
                    })()
                  }}
                >
                  创建需求
                </Button>
              </CardContent>
            </Card>
          </aside>
        ) : null}
      </div>
    </section>
  )
}
